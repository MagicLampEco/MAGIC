// src/greenback.ts — beacon GreenBack + shard GB phía két InstantGen (Gen v2.0, gói d1).
//
// P8: gương của `onchain/lib/magiclamp/protocol/greenback.ak` (`vault_shard_id`,
// `shard_nft_name`, `greenback_open`, `shard_draw`) và của
// `GenBeacons/onchain/lib/genbeacons/shard.ak ▸ lazy_reset` (bộ dựng phải tự tính datum
// shard ra, validator shard so NGUYÊN bản ghi). Đổi một bên ⟹ đổi bên kia cùng commit.
//
// Vế nào validator `fail` thì ở đây NÉM có mã — dựng tiếp chỉ ra một giao dịch chết ở
// pha script với một câu không trỏ về đâu.

import { blake2b } from "@noble/hashes/blake2b";
import {
  GB_SHARD_COUNT, GB_SHARD_NFT_PREFIX, GREENBACK_BEACON_MAX_AGE_EPOCHS,
} from "./constants.js";
import type { GbShard, GreenBackBeacon, OwnerCredentialData } from "./types.js";

/** Hash 28 byte bên trong `Credential` (khoá hay script như nhau). */
function credentialInner(owner: OwnerCredentialData): string {
  if ("VerificationKey" in owner) return owner.VerificationKey[0];
  if ("Script" in owner) return owner.Script[0];
  throw new Error(`GEN-INST-013: owner không phải Credential (VerificationKey | Script).`);
}

/**
 * Ánh xạ két → shard GB: byte ĐẦU của `blake2b_256(hash trong owner)`, mod 16.
 * Gương `greenback.ak ▸ vault_shard_id` (bản gốc: `ScheduleGen/.../math.ak ▸ compute_shard_id`).
 */
export function vaultShardId(owner: OwnerCredentialData): bigint {
  const inner = credentialInner(owner);
  if (!/^[0-9a-f]{56}$/.test(inner)) {
    throw new Error(`GEN-INST-013: hash trong owner phải là 28 byte hex thường, nhận "${inner}".`);
  }
  const h = blake2b(Buffer.from(inner, "hex"), { dkLen: 32 });
  return BigInt(h[0]!) % GB_SHARD_COUNT;
}

/** "GBS" ‖ một byte `id`, hex. Gương `greenback.ak ▸ shard_nft_name`. */
export function shardNftName(id: bigint): string {
  if (id < 0n || id >= GB_SHARD_COUNT) {
    throw new RangeError(`shard_id ${id} ngoài [0, ${GB_SHARD_COUNT})`);
  }
  return GB_SHARD_NFT_PREFIX + id.toString(16).padStart(2, "0");
}

/**
 * Beacon GreenBack ĐANG MỞ ở epoch `e` — gương vế datum của `greenback_open`:
 * `depeg == False`, `epoch ≤ e`, `e − epoch ≤ GREENBACK_BEACON_MAX_AGE_EPOCHS`.
 * (Vế NFT + địa chỉ script là việc của bộ dựng giao dịch, trên UTxO.)
 */
export function assertGreenbackOpen(g: GreenBackBeacon, e: bigint): void {
  if (g.depeg) {
    throw new Error(`GEN-INST-012: beacon GreenBack báo depeg — cửa sinh đóng.`);
  }
  if (g.epoch > e) {
    throw new Error(`GEN-INST-012: beacon GreenBack mang epoch ${g.epoch} > epoch hiện tại ${e}.`);
  }
  if (e - g.epoch > GREENBACK_BEACON_MAX_AGE_EPOCHS) {
    throw new Error(
      `GEN-INST-012: beacon GreenBack cũ (epoch ${g.epoch}, hiện tại ${e}, tuổi tối đa ` +
      `${GREENBACK_BEACON_MAX_AGE_EPOCHS}). Chờ bên ghi beacon cập nhật.`,
    );
  }
}

/**
 * Trạng thái HIỆU LỰC của shard trước lượt rút. Gương `genbeacons/shard.ak ▸ lazy_reset`:
 * `beacon.seq > shard.seq` ⟹ đặt lại về `min(⌊gb_nanogic / 16⌋, cap)`; bằng ⟹ giữ;
 * nhỏ hơn ⟹ trạng thái không tới được, NÉM (validator shard `fail`).
 */
export function lazyResetShard(shard: GbShard, beacon: GreenBackBeacon, capNanogic: bigint): GbShard {
  if (beacon.seq > shard.seq) {
    const perShard = beacon.gb_nanogic / GB_SHARD_COUNT;
    const amount = perShard < capNanogic ? perShard : capNanogic;
    return { shard_id: shard.shard_id, seq: beacon.seq, reset_amount: amount, remaining: amount };
  }
  if (beacon.seq !== shard.seq) {
    throw new Error(
      `GEN-INST-013: shard ${shard.shard_id} mang seq ${shard.seq} > seq beacon ${beacon.seq} — ` +
      `trạng thái không tới được, validator shard sẽ từ chối.`,
    );
  }
  return { ...shard };
}

/**
 * Datum shard ra của một lượt rút `amount` (gương vế ghi của `gb_shard.spend`:
 * `s_out == { ..eff, remaining: eff.remaining − amount }`, `remaining_out ≥ 0`) cùng
 * `GB_available` mà két so (`greenback.ak ▸ shard_draw`).
 */
export function drawShard(
  shardIn: GbShard, beacon: GreenBackBeacon, capNanogic: bigint, amount: bigint,
): { effective: GbShard; shardOut: GbShard; gbAvailable: bigint } {
  if (amount < 0n) throw new RangeError(`lượng rút âm: ${amount}`);
  const effective = lazyResetShard(shardIn, beacon, capNanogic);
  const remainingOut = effective.remaining - amount;
  if (remainingOut < 0n) {
    throw new Error(
      `GEN-INST-013: shard ${shardIn.shard_id} chỉ còn ${effective.remaining} nanogic GB, ` +
      `lượt này rút ${amount}.`,
    );
  }
  return {
    effective,
    shardOut: { ...effective, remaining: remainingOut },
    gbAvailable: effective.remaining,
  };
}
