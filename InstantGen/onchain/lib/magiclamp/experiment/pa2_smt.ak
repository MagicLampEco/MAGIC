// VENDORED — chép NGUYÊN VĂN, không sửa một byte phần thân, chỉ thêm khối đầu này.
// Nguồn: PhoenixKeyDID/PhoenixKey-Validator @ 8697bf9a321961593c821c591e902b3fb1ff1aef
//        lib/phoenixkey/pa2_smt.ak · blob d43d26f6edf991f5b891a3b09619c94468a16c6c
//        (commit cuối chạm tệp: 81c2e2dd 2026-07-30).
// Mục đích: phép đo thử nghiệm biệt lập cho INV-ONE-PERSON-ONE-VAULT. KHÔNG validator nào
// import tệp này. Nguồn đổi thì tệp này KHÔNG tự đổi theo — đối chiếu lại blob trước khi tin.

// PA2 — Sparse-Merkle-tree accumulator (non-membership native) for the
// PhoenixKey anchor UniquenessThread.
//
// PURPOSE (Anchorme-Math §5.7bis, "PA2 — CHỐT hướng SMT/Merkle-root-in-datum";
// FROST-and-PA2-SMT-Design Phần III): the shard-thread datum keeps a single
// 32-byte accumulator `root`. A genesis (register) or burn (tombstone) of an
// anchor name `key = blake2b_256(did)` must present, in the redeemer, a proof of
// the leaf's CURRENT status at `key` plus the resulting `new_root`. The validator
// re-derives the root from the proof and rejects any transition that is not the
// unique, correct one. Because the accumulator answers "is `key` already live?"
// against a single chained state, it closes the global-uniqueness hole (CID-1,
// Person-over-Person) that no per-tx mint check can close.
//
// HASH CONVENTION — MANDATORY (Anchorme-Math §5.7bis, RFC 6962 domain-sep). The
// on-chain boundary uses ONLY `blake2b_256` (the sole cheap Plutus builtin and
// already the anchor-name function N(did)); the off-chain indexer MUST build the
// tree with the exact same function/domain-sep or roots will not match:
//     H_leaf(d)   = blake2b_256(0x00 ‖ d)
//     H_node(l,r) = blake2b_256(0x01 ‖ l ‖ r)
// An ABSENT leaf hashes to `empty_hash` (32 zero bytes) so empty subtrees collapse
// to fixed per-height defaults; a LIVE / TOMBSTONE leaf hashes its (key,status).
//
// KEY = the full 32-byte anchor name → depth 256 in production, so every distinct
// name occupies its OWN leaf slot (no collisions, no "blocking sibling leaf"
// case). Proof = the `depth` sibling hashes along the key path + the leaf status.
// Inserting/updating a single leaf changes ONLY the hashes along its own path;
// the sibling hashes are invariant → the same sibling list yields both `old_root`
// (with old status) and `new_root` (with new status). That invariant is what lets
// the validator verify the transition with one proof.
//
// ⚠ COST / PRODUCTION NOTE. This reference instantiation carries the FULL `depth`
// siblings (256 for a 32-byte key). That is SOUND but the redeemer/hashing cost is
// O(depth), not O(log N). Population-scale deployment swaps in the audited COMPACT
// SMT primitive from VeData `Stamp` (design Phần IV, [CHỐT-P2]) which omits the
// default siblings (the ones equal to the per-height default), reducing the proof
// to ~log₂N real siblings WITHOUT changing this root semantics or the security
// property. Everything below is written against a `depth` parameter so the swap is
// localised. Do NOT re-derive a bespoke accumulator for production — reuse Stamp.
//
// Aiken 1.1.x / Plutus V3.

use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray

/// 32 zero bytes — the hash of an ABSENT leaf and the base of the per-height
/// default-hash ladder.
pub const empty_hash: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000000"

/// Lifecycle status of a name's leaf in the accumulator.
///   Absent    — never registered (slot empty, hashes to `empty_hash`).
///   Live      — an anchor is currently live for this name (CID-1 guard target).
/// KHÔNG có Tombstone: anchor NFT không burn được — `taad_logic.validate_spend`
/// đòi `find_unique_nft_output` thành công trên MỌI arm (trước cả khi match
/// redeemer), nên NFT luôn phải sống sót ở continuing output ⇒ `GenesisBurn`
/// không có đường chạy. Nhánh burn/tombstone vì thế là code chết, và encoding
/// của nó sẽ bị đóng băng vào hash. Thêm lại CÙNG LÚC với một đường burn thật.
pub type LeafStatus {
  Absent
  Live
}

// ─── Domain-separated hashing ─────────────────────────────────────────────

/// H_leaf(d) = blake2b_256(0x00 ‖ d).
fn h_leaf(payload: ByteArray) -> ByteArray {
  blake2b_256(bytearray.concat(#"00", payload))
}

/// H_node(l,r) = blake2b_256(0x01 ‖ l ‖ r).
pub fn h_node(l: ByteArray, r: ByteArray) -> ByteArray {
  blake2b_256(bytearray.concat(#"01", bytearray.concat(l, r)))
}

/// Leaf hash for a name at a given status. Absent → empty_hash; otherwise the
/// (key,status) are bound so a live and a tombstone leaf are distinct and neither
/// collides with the empty default.
pub fn leaf_hash(key: ByteArray, status: LeafStatus) -> ByteArray {
  when status is {
    Absent -> empty_hash
    Live -> h_leaf(bytearray.concat(key, #"01"))
  }
}

/// Root of an all-ABSENT tree of `depth`: the per-height default ladder
/// D₀ = empty_hash, Dₕ = H_node(Dₕ₋₁, Dₕ₋₁). This is the genesis root a fresh
/// shard-thread is bootstrapped with. Production depth = 256 (32-byte key).
pub fn empty_root(depth: Int) -> ByteArray {
  if depth <= 0 {
    empty_hash
  } else {
    let d = empty_root(depth - 1)
    h_node(d, d)
  }
}

// ─── Bit access (MSB-first over the key bytes) ────────────────────────────

fn pow2_bit(n: Int) -> Int {
  when n is {
    0 -> 1
    1 -> 2
    2 -> 4
    3 -> 8
    4 -> 16
    5 -> 32
    6 -> 64
    _ -> 128
  }
}

/// Bit `i` of `key`, MSB-first: i=0 is the top bit of byte 0.
pub fn key_bit(key: ByteArray, i: Int) -> Int {
  let byte = bytearray.at(key, i / 8)
  byte / pow2_bit(7 - i % 8) % 2
}

// ─── Root computation from a leaf + sibling path ──────────────────────────

/// Fold a leaf hash up to the root. `rev_siblings` is the sibling list in
/// DEEPEST-first order; `level` is the bit index of the deepest sibling (=
/// depth-1). At each step the key bit at `level` decides child order.
fn combine(
  key: ByteArray,
  node: ByteArray,
  rev_siblings: List<ByteArray>,
  level: Int,
) -> ByteArray {
  when rev_siblings is {
    [] -> node
    [sib, ..rest] -> {
      let parent =
        if key_bit(key, level) == 0 {
          h_node(node, sib)
        } else {
          h_node(sib, node)
        }
      combine(key, parent, rest, level - 1)
    }
  }
}

/// Root implied by a leaf at `key` with `status` and the top→bottom `siblings`.
/// `siblings` length is the tree depth.
pub fn compute_root(
  key: ByteArray,
  status: LeafStatus,
  siblings: List<ByteArray>,
) -> ByteArray {
  let depth = list.length(siblings)
  combine(key, leaf_hash(key, status), list.reverse(siblings), depth - 1)
}

/// The accumulator agrees that `key` currently has `status`, against `root`.
pub fn verify(
  root: ByteArray,
  key: ByteArray,
  status: LeafStatus,
  siblings: List<ByteArray>,
) -> Bool {
  compute_root(key, status, siblings) == root
}

// ─── Transition predicate (the accumulator half of register_ok) ──────────

/// REGISTER: `key` is currently NOT live (i.e. Absent) and the tree moves
/// to Live. Rejects a `key` that is already Live — this is the exact check that
/// makes a second (forged) anchor for a live name impossible (CID-1).
pub fn register_transition_ok(
  old_root: ByteArray,
  new_root: ByteArray,
  key: ByteArray,
  old_status: LeafStatus,
  siblings: List<ByteArray>,
) -> Bool {
  and {
    old_status != Live,
    verify(old_root, key, old_status, siblings),
    new_root == compute_root(key, Live, siblings),
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS — a dense reference tree at small depth exercises the SAME code the
// depth-256 production instantiation runs. Keys are chosen so their top `depth`
// bits equal a leaf index in [0, 2^depth); the tree is built densely so the
// sibling paths are REAL (not hand-picked), giving adversarial proofs teeth.
// ════════════════════════════════════════════════════════════════════════════

const test_depth: Int = 8

/// A 32-byte key whose leading 8 bits equal `idx` (idx in [0,256)).
fn test_key(idx: Int) -> ByteArray {
  bytearray.concat(
    bytearray.push(#"", idx),
    #"000000000000000000000000000000000000000000000000000000000000",
  )
}

fn pow2(n: Int) -> Int {
  if n <= 0 {
    1
  } else {
    2 * pow2(n - 1)
  }
}

fn status_at(occupied: List<(Int, LeafStatus)>, idx: Int) -> LeafStatus {
  when list.find(occupied, fn(p) { p.1st == idx }) is {
    Some((_, st)) -> st
    None -> Absent
  }
}

/// Hash of the subtree rooted at node `base` on `level` (leaves span
/// [base·2^level, (base+1)·2^level)). Dense, O(2^level) — fine at test depth.
fn subtree(occupied: List<(Int, LeafStatus)>, level: Int, base: Int) -> ByteArray {
  if level == 0 {
    leaf_hash(test_key(base), status_at(occupied, base))
  } else {
    let l = subtree(occupied, level - 1, base * 2)
    let r = subtree(occupied, level - 1, base * 2 + 1)
    h_node(l, r)
  }
}

fn tree_root(occupied: List<(Int, LeafStatus)>) -> ByteArray {
  subtree(occupied, test_depth, 0)
}

/// Top→bottom sibling path for leaf `idx` in the dense tree.
fn sibling_path(occupied: List<(Int, LeafStatus)>, idx: Int) -> List<ByteArray> {
  build_siblings(occupied, idx, test_depth, [])
}

fn build_siblings(
  occupied: List<(Int, LeafStatus)>,
  idx: Int,
  lvl: Int,
  acc: List<ByteArray>,
) -> List<ByteArray> {
  if lvl == 0 {
    acc
  } else {
    // node index of the key's node at the child level (lvl-1)
    let child_idx = idx / pow2(lvl - 1)
    let sib_idx =
      if child_idx % 2 == 0 {
        child_idx + 1
      } else {
        child_idx - 1
      }
    let sib = subtree(occupied, lvl - 1, sib_idx)
    // append so the final list is top→bottom (lvl D first … lvl 1 last)
    build_siblings(occupied, idx, lvl - 1, list.concat(acc, [sib]))
  }
}

// ─── Sanity: empty-tree root is the default ladder, proofs round-trip ─────

test smt_empty_tree_absent_verifies() {
  let occ = []
  let root = tree_root(occ)
  let key = test_key(42)
  verify(root, key, Absent, sibling_path(occ, 42))
}

test smt_live_membership_verifies() {
  let occ = [(42, Live)]
  let root = tree_root(occ)
  verify(root, test_key(42), Live, sibling_path(occ, 42))
}

// A live leaf must NOT verify as Absent (root binds the status).
test smt_live_not_absent() fail {
  let occ = [(42, Live)]
  let root = tree_root(occ)
  verify(root, test_key(42), Absent, sibling_path(occ, 42))
}

test smt_nonmember_absent_amid_others() {
  let occ = [(10, Live), (200, Live), (255, Live)]
  let root = tree_root(occ)
  // 42 is absent even though the tree is non-empty.
  verify(root, test_key(42), Absent, sibling_path(occ, 42))
}

// ─── register_transition_ok ───────────────────────────────────────────────

test smt_register_fresh_ok() {
  let occ = [(10, Live)]
  let old_root = tree_root(occ)
  let occ2 = [(10, Live), (42, Live)]
  let new_root = tree_root(occ2)
  register_transition_ok(
    old_root,
    new_root,
    test_key(42),
    Absent,
    sibling_path(occ, 42),
  )
}

// The forgery move: register a name that is ALREADY live. Rejected because
// old_status==Live is refused AND no Absent proof matches the real root.
test smt_register_duplicate_live_rejected() fail {
  let occ = [(42, Live)]
  let old_root = tree_root(occ)
  // attacker wants the leaf live for THEM; claims the resulting root
  let new_root = tree_root([(42, Live)])
  register_transition_ok(
    old_root,
    new_root,
    test_key(42),
    Live,
    sibling_path(occ, 42),
  )
}

// Attacker lies that the live name is Absent (to sneak past the old_status gate).
// The forged Absent proof does not reproduce old_root → rejected.
test smt_register_forged_absent_proof_rejected() fail {
  let occ = [(42, Live)]
  let old_root = tree_root(occ)
  let new_root = tree_root([(42, Live)])
  register_transition_ok(
    old_root,
    new_root,
    test_key(42),
    Absent,
    // sibling path is real, but claiming Absent won't match old_root
    sibling_path(occ, 42),
  )
}

// Attacker supplies a bogus new_root that isn't the honest insertion result.
test smt_register_wrong_new_root_rejected() fail {
  let occ = [(10, Live)]
  let old_root = tree_root(occ)
  let bogus_new_root = tree_root([(10, Live), (99, Live)])
  register_transition_ok(
    old_root,
    bogus_new_root,
    test_key(42),
    Absent,
    sibling_path(occ, 42),
  )
}

// Sibling path from a DIFFERENT key cannot be reused to prove this key.
test smt_wrong_sibling_path_rejected() fail {
  let occ = [(10, Live), (42, Live)]
  let root = tree_root(occ)
  // prove 42 absent using 200's path → mismatch
  verify(root, test_key(42), Absent, sibling_path(occ, 200))
}

// ─── GHIM genesis root (issue #40) ─────────────────────────────────────────
// `deploy/bootstrap_uniqueness.sh` phải nhét ĐÚNG giá trị này vào inline datum
// của cả K shard-thread. Off-chain tính lại bằng blake2b_256 thuần, không chạy
// Aiken — nếu ladder mặc định ở đây đổi mà hằng bên script không đổi thì tx
// bootstrap sẽ fail on-chain một cách khó hiểu. Test này bắt lệch ngay tại CI.
test empty_root_256_pinned() {
  empty_root(256) == #"933f40aae7a4ce7f2705c889bd9417d6360695ec0852fb3e1326b1c03dc6da13"
}
