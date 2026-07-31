// lib/getmagic/utils.ak — GetMAGIC utility functions
// Shared helpers for oracle message construction and epoch voucher logic.

use aiken/collection/list
use aiken/primitive/bytearray

// ── Encoding ─────────────────────────────────────────────────

/// Encode Int to big-endian 8-byte ByteArray for oracle message building.
/// Uses stdlib bytearray.from_int_big_endian (matches off-chain Buffer.writeBigInt64BE).
pub fn encode_int_8bytes(n: Int) -> ByteArray {
  bytearray.from_int_big_endian(n, 8)
}

// ── Oracle message builders ───────────────────────────────────

/// Build oracle settlement message:
///   msg = order_id(16) ++ user_pkh(28) ++ nonce(32) ++ timestamp(8)
///
/// G-OTC-1: Oracle sig covers exactly this payload.
pub fn build_oracle_settle_msg(
  order_id:     ByteArray,
  user_pkh:     ByteArray,
  nonce:        ByteArray,
  timestamp_ms: Int,
) -> ByteArray {
  bytearray.concat(
    bytearray.concat(order_id, user_pkh),
    bytearray.concat(nonce, encode_int_8bytes(timestamp_ms)),
  )
}

/// Build epoch voucher message:
///   msg = alloc_id(32) ++ epoch(8) ++ nanogic(8) ++ expiry_posix(8)
///
/// G-ALLOC-1: Each voucher is an Ed25519 sig over this per-epoch payload.
pub fn build_voucher_msg(
  alloc_id:     ByteArray,
  epoch:        Int,
  nanogic:      Int,
  expiry_posix: Int,
) -> ByteArray {
  bytearray.concat(
    bytearray.concat(alloc_id, encode_int_8bytes(epoch)),
    bytearray.concat(encode_int_8bytes(nanogic), encode_int_8bytes(expiry_posix)),
  )
}

// ── Epoch helpers ─────────────────────────────────────────────

/// Returns True if the given epoch is already in the claimed list.
pub fn epoch_already_claimed(claimed: List<Int>, epoch: Int) -> Bool {
  list.has(claimed, epoch)
}

/// Return the voucher at index (epoch - start_epoch), 0-based.
/// Returns None if the index is out of range.
pub fn get_voucher_for_epoch(
  vouchers:    List<ByteArray>,
  epoch:       Int,
  start_epoch: Int,
) -> Option<ByteArray> {
  let idx = epoch - start_epoch
  list.at(vouchers, idx)
}
