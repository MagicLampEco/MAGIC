// LampDistribution Merkle verify (SPEC §QĐ4)
// BLAKE2b-256, RFC 6962 domain separation, sorted-pair (proof không cần hướng).
// PHẢI khớp byte-perfect với offchain merkle.ts.

use aiken/collection/list
use aiken/crypto
use aiken/primitive/bytearray

/// Hash 1 leaf: blake2b_256( 0x00 ‖ owner ‖ won_cumulative[be8] )
/// won_cumulative đóng gói 8-byte big-endian (≤ 2^63 oil — đủ cho 36×10^15).
pub fn leaf_hash(owner: ByteArray, won_cumulative: Int) -> ByteArray {
  let won_bytes = bytearray.from_int_big_endian(won_cumulative, 8)
  let preimage =
    #"00"
      |> bytearray.concat(owner)
      |> bytearray.concat(won_bytes)
  crypto.blake2b_256(preimage)
}

/// Hash 2 node con: blake2b_256( 0x01 ‖ min(a,b) ‖ max(a,b) )
/// sorted-pair → proof chỉ cần sibling, không cần bit chỉ trái/phải.
pub fn hash_node(a: ByteArray, b: ByteArray) -> ByteArray {
  when bytearray.compare(a, b) is {
    Greater ->
      crypto.blake2b_256(#"01" |> bytearray.concat(b) |> bytearray.concat(a))
    _ ->
      crypto.blake2b_256(#"01" |> bytearray.concat(a) |> bytearray.concat(b))
  }
}

/// Verify Merkle proof: fold leaf qua các sibling → so với root.
pub fn verify_proof(root: ByteArray, leaf: ByteArray, proof: List<ByteArray>) -> Bool {
  let computed =
    list.foldl(proof, leaf, fn(sibling, acc) { hash_node(acc, sibling) })
  computed == root
}

/// Tiện ích: verify trực tiếp từ (owner, won_cumulative).
pub fn verify_claim(
  root           : ByteArray,
  owner          : ByteArray,
  won_cumulative : Int,
  proof          : List<ByteArray>,
) -> Bool {
  verify_proof(root, leaf_hash(owner, won_cumulative), proof)
}

// ── Tests ─────────────────────────────────────────────────────

test leaf_hash_deterministic() {
  leaf_hash(#"abcd", 100) == leaf_hash(#"abcd", 100)
}

test leaf_hash_differs_by_amount() {
  leaf_hash(#"abcd", 100) != leaf_hash(#"abcd", 200)
}

test leaf_hash_differs_by_owner() {
  leaf_hash(#"aa", 100) != leaf_hash(#"bb", 100)
}

test node_sorted_commutative() {
  // hash_node đối xứng (sorted-pair): node(a,b) == node(b,a)
  let a = leaf_hash(#"aa", 100)
  let b = leaf_hash(#"bb", 200)
  hash_node(a, b) == hash_node(b, a)
}

test leaf_node_domain_separated() {
  // leaf prefix 0x00 ≠ node prefix 0x01 → không thể second-preimage
  let a = leaf_hash(#"aa", 100)
  let b = leaf_hash(#"bb", 200)
  hash_node(a, b) != leaf_hash(#"aa", 100)
}

test proof_single_leaf() {
  // cây 1 leaf → root == leaf, proof rỗng
  let leaf = leaf_hash(#"aa", 100)
  verify_proof(leaf, leaf, [])
}

test proof_two_leaves() {
  let l0 = leaf_hash(#"aa", 100)
  let l1 = leaf_hash(#"bb", 200)
  let root = hash_node(l0, l1)
  verify_proof(root, l0, [l1]) && verify_proof(root, l1, [l0])
}

test proof_four_leaves() {
  // cây 4 leaf: ((l0,l1),(l2,l3))
  let l0 = leaf_hash(#"00", 10)
  let l1 = leaf_hash(#"01", 20)
  let l2 = leaf_hash(#"02", 30)
  let l3 = leaf_hash(#"03", 40)
  let n01 = hash_node(l0, l1)
  let n23 = hash_node(l2, l3)
  let root = hash_node(n01, n23)
  // proof cho l0: [l1, n23]
  verify_proof(root, l0, [l1, n23]) && verify_proof(root, l2, [l3, n01])
}

test proof_rejects_wrong_amount() {
  let l0 = leaf_hash(#"aa", 100)
  let l1 = leaf_hash(#"bb", 200)
  let root = hash_node(l0, l1)
  // claim sai amount → leaf khác → reject
  !verify_claim(root, #"aa", 999, [l1])
}

test verify_claim_ok() {
  let l0 = leaf_hash(#"aa", 100)
  let l1 = leaf_hash(#"bb", 200)
  let root = hash_node(l0, l1)
  verify_claim(root, #"aa", 100, [l1])
}

// CROSS-CHECK on-chain ↔ off-chain (byte-perfect).
// Giá trị pin từ offchain merkle.ts: bytesToHex(leafHash("aa", 100n)).
// Nếu test này pass → encoding leaf khớp tuyệt đối giữa Aiken và TypeScript.
test leaf_hash_xcheck_offchain() {
  leaf_hash(#"aa", 100) == #"758af0ead989e9c0e45001a317e85be8645e1a89637499c87d5c86a53ddeaac7"
}
