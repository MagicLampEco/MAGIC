//// Hằng biên dịch của module GenBeacons.

use aiken/primitive/bytearray

/// Số shard của bộ đếm `GB_available` (SPEC §11 `SHARD_COUNT`, `INV-SURPLUS-RATION`).
pub const shard_count: Int = 16

/// Tên NFT one-shot của beacon ρ ("RHO"). Policy = hash chính script `rate_param`.
pub const rate_nft_name: ByteArray = #"52484f"

/// Tên NFT one-shot của beacon GreenBack ("GBB"). Policy = hash chính script
/// `greenback_beacon`. Shard đọc beacon theo CẶP (policy apply-param, tên này).
pub const greenback_nft_name: ByteArray = #"474242"

/// Tiền tố tên NFT shard ("GBS"); byte cuối là `shard_id`.
pub const shard_nft_prefix: ByteArray = #"474253"

/// Tên NFT của shard `id` (0 ≤ id < 16): "GBS" ‖ một byte `id`.
pub fn shard_nft_name(id: Int) -> ByteArray {
  bytearray.concat(shard_nft_prefix, bytearray.push(#"", id))
}
