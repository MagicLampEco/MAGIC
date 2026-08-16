// lib/getmagic/utils.ak — GetMAGIC utility functions
// Shared helpers for oracle message construction and epoch voucher logic.
//
// ── FRAMING RULE (read this before touching any builder below) ────────────
// Every byte string that is HASHED into an identifier or SIGNED by the oracle
// is built with the SAME shape:
//
//   LP(s)  = u32be(len(s)) ++ s                       (length-prefixed field)
//   msg    = <domain-tag> ++ 0x00 ++ LP(f1) ++ LP(f2) ++ … ++ u64be(i1) ++ …
//
// Why (nợ #26): plain concatenation of variable-length fields is NOT injective.
// `order_id ++ user_pkh` for (#"41", #"4243") and (#"4142", #"43") is the same
// byte string, so one hash / one oracle signature covers BOTH field splittings.
// With LP, decoding is a total function (read 4 bytes → read that many bytes →
// repeat), so encoding is injective. Fixed-width ints (u64be) are already
// self-delimiting and go LAST, un-prefixed.
//
// Rules for anyone extending these:
//   1. Any NEW variable-length field MUST be wrapped in `length_prefixed`.
//      A raw `bytearray.concat` of an unframed field re-opens nợ #26.
//   2. New fixed-width fields go AFTER all LP fields, or get LP'd too.
//   3. A new message kind gets a NEW domain tag; never reuse one.
//      Tags are ASCII (no 0x00 byte), so `tag ++ 0x00` is unambiguous and the
//      images of the three builders below are pairwise disjoint.

use aiken/collection/list
use aiken/crypto
use aiken/primitive/bytearray

// ── Domain tags ───────────────────────────────────────────────
// ASCII, no 0x00 byte inside — see rule 3 above.

/// "MAGIC_ALLOC_ID:v1" (17 bytes)
pub const domain_alloc_id: ByteArray = #"4d414749435f414c4c4f435f49443a7631"

/// "MAGIC_ORACLE_SETTLE:v1" (22 bytes)
pub const domain_oracle_settle: ByteArray =
  #"4d414749435f4f5241434c455f534554544c453a7631"

/// "MAGIC_VOUCHER:v1" (16 bytes)
pub const domain_voucher: ByteArray = #"4d414749435f564f55434845523a7631"

/// Length of an alloc_id — blake2b_256 output. Enforced, not assumed.
pub const alloc_id_length: Int = 32

// ── Encoding ─────────────────────────────────────────────────

/// Encode Int to big-endian 8-byte ByteArray for oracle message building.
/// Uses stdlib bytearray.from_int_big_endian (matches off-chain DataView.setBigUint64 BE).
pub fn encode_int_8bytes(n: Int) -> ByteArray {
  bytearray.from_int_big_endian(n, 8)
}

/// LP(s) = u32be(len(s)) ++ s — makes a variable-length field self-delimiting.
/// Fails (fail-closed) if len(s) does not fit in 4 bytes; unreachable on Cardano
/// where a whole tx is capped well under 2^32 bytes.
pub fn length_prefixed(s: ByteArray) -> ByteArray {
  bytearray.concat(bytearray.from_int_big_endian(bytearray.length(s), 4), s)
}

/// `tag ++ 0x00` — domain separator prefix.
fn domain_prefix(tag: ByteArray) -> ByteArray {
  bytearray.concat(tag, #"00")
}

// ── Identifier derivation ─────────────────────────────────────

/// Derive the canonical allocation identifier.
///
///   alloc_id = blake2b_256(
///     "MAGIC_ALLOC_ID:v1" ++ 0x00 ++ LP(order_id) ++ LP(user_pkh)
///   )
///
/// P8: mirrored bit-for-bit by `deriveAllocId` in offchain/src/oracle.ts.
///
/// alloc_id is a LOOKUP KEY (accounting, double-claim tracking, vouchers). Two
/// different (order_id, user_pkh) pairs colliding here corrupts all three, and
/// it fails SILENTLY — no signature check trips. Hence the framing.
pub fn build_alloc_id(order_id: ByteArray, user_pkh: ByteArray) -> ByteArray {
  crypto.blake2b_256(
    domain_prefix(domain_alloc_id)
      |> bytearray.concat(length_prefixed(order_id))
      |> bytearray.concat(length_prefixed(user_pkh)),
  )
}

// ── Oracle message builders ───────────────────────────────────

/// Build oracle settlement message:
///
///   msg = "MAGIC_ORACLE_SETTLE:v1" ++ 0x00
///      ++ LP(order_id) ++ LP(user_pkh) ++ LP(nonce)
///      ++ u64be(timestamp_ms)
///
/// G-OTC-1: Oracle sig covers exactly this payload.
/// P8: mirrored bit-for-bit by `buildOracleSettleMsg` in offchain/src/oracle.ts.
pub fn build_oracle_settle_msg(
  order_id: ByteArray,
  user_pkh: ByteArray,
  nonce: ByteArray,
  timestamp_ms: Int,
) -> ByteArray {
  domain_prefix(domain_oracle_settle)
    |> bytearray.concat(length_prefixed(order_id))
    |> bytearray.concat(length_prefixed(user_pkh))
    |> bytearray.concat(length_prefixed(nonce))
    |> bytearray.concat(encode_int_8bytes(timestamp_ms))
}

/// Build epoch voucher message:
///
///   msg = "MAGIC_VOUCHER:v1" ++ 0x00
///      ++ LP(alloc_id)
///      ++ u64be(epoch) ++ u64be(nanogic) ++ u64be(expiry_posix)
///
/// G-ALLOC-1: Each voucher is an Ed25519 sig over this per-epoch payload.
/// P8: mirrored bit-for-bit by `buildVoucherMsg` in offchain/src/oracle.ts.
///
/// The `expect` turns "alloc_id is always 32 bytes" from a convention held by
/// off-chain code into an invariant enforced by the validator: `alloc_id` is
/// declared as a free `ByteArray` in types.ak, and nothing else pins its width.
pub fn build_voucher_msg(
  alloc_id: ByteArray,
  epoch: Int,
  nanogic: Int,
  expiry_posix: Int,
) -> ByteArray {
  expect bytearray.length(alloc_id) == alloc_id_length
  domain_prefix(domain_voucher)
    |> bytearray.concat(length_prefixed(alloc_id))
    |> bytearray.concat(encode_int_8bytes(epoch))
    |> bytearray.concat(encode_int_8bytes(nanogic))
    |> bytearray.concat(encode_int_8bytes(expiry_posix))
}

// ── Epoch helpers ─────────────────────────────────────────────

/// Returns True if the given epoch is already in the claimed list.
pub fn epoch_already_claimed(claimed: List<Int>, epoch: Int) -> Bool {
  list.has(claimed, epoch)
}

/// Return the voucher at index (epoch - start_epoch), 0-based.
/// Returns None if the index is out of range.
pub fn get_voucher_for_epoch(
  vouchers: List<ByteArray>,
  epoch: Int,
  start_epoch: Int,
) -> Option<ByteArray> {
  let idx = epoch - start_epoch
  list.at(vouchers, idx)
}
