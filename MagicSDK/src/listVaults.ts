// MagicSDK/src/listVaults.ts — discover all vaults owned by a given PKH.
//
// Cardano native: nhiều UTxO có thể nằm cùng 1 script address. Vault validator
// (`expect list.count(inputs at vault_addr) == 1`) chỉ chặn double-spend trong
// 1 tx — KHÔNG giới hạn "1 vault per owner". User có thể có N vault cùng loại
// (Instant hoặc Schedule), mỗi vault 1 khoản LAMP khác nhau (ngắn / trung /
// dài hạn). Mỗi vault có
// tuổi loyalty độc lập → tiêu LAMP của vault ngắn hạn KHÔNG ảnh hưởng tới LF
// của vault dài hạn. Đây là feature có sẵn — không cần thay đổi onchain.

import { Data, type LucidEvolution, type UTxO } from "@lucid-evolution/lucid";
import { applyVaultValidator } from "./validatorScripts.js";
import { ownerRefOf, sameOwner, type OwnerRef } from "@magiclamp/protocol-utils";
import { resolveOwnerInput } from "./ownerInput.js";
import { InstantVaultDatumSchema, VaultDatumSchema, type VaultDatum } from "./schemas.js";
import type { ProtocolParams, ValidatorBundle, VaultType } from "./types.js";

export interface VaultRecord {
  /** Unique tx-level identifier: `<txHash>#<outputIndex>`. */
  vaultId:        string;
  /** The raw UTxO (for downstream tx builders). */
  utxo:           UTxO;
  /** Decoded datum. */
  datum:          VaultDatum;
  /** Network-derived vault address (same for all vaults of this type). */
  vaultAddress:   string;
  /** LAMP balance in oildrop (lamp_balance from datum). */
  lampBalanceOildrop: bigint;
  /** Oldest holding's acquired_epoch — lower bound on this vault's age. */
  oldestEpoch:    bigint;
  /** Profile of this vault. */
  profile:        VaultDatum["profile"];
}

export interface ListVaultsParams {
  lucid:      LucidEvolution;
  vaultType:  VaultType;
  protocol:   ProtocolParams;
  validators: ValidatorBundle;
  /** Chủ cần lọc — so CẢ tag lẫn hash (`sameOwner`). Truyền `owner` HOẶC bí danh `ownerPkh`. */
  owner?:     OwnerRef;
  /** Bí danh nhánh khoá: `ownerPkh: h` ≡ `owner: { type: "key", hash: h }`. */
  ownerPkh?:  string;
}

/**
 * Query all vaults at the per-network vault address whose `datum.owner` matches
 * `ownerPkh`. Returns one entry per UTxO — a user can have multiple vaults of
 * the same type (different time horizons / profiles), each independent.
 *
 * UX hint: sort by `oldestEpoch` ascending = oldest vault first = highest LF.
 * Caller can label them off-chain ("long-term" / "mid-term" / "short-term")
 * however they want.
 */
export async function listVaultsForOwner(params: ListVaultsParams): Promise<VaultRecord[]> {
  const { lucid, vaultType, protocol, validators } = params;
  const owner = resolveOwnerInput(params, "listVaultsForOwner");

  const { vaultAddress } = applyVaultValidator(vaultType, validators, protocol);

  const allUtxos = await lucid.utxosAt(vaultAddress);

  // Mỗi địa chỉ vault phục vụ ĐÚNG MỘT loại két, nên hình dạng datum suy ra từ
  // `vaultType` chứ không phải thử hai lần: Instant 18 trường, Schedule 17
  // (`schemas.ts` đầu tệp).
  const datumSchema = vaultType === "Instant" ? InstantVaultDatumSchema : VaultDatumSchema;

  const records: VaultRecord[] = [];
  // 🔴 Một UTxO mang datum ở ĐỊA CHỈ KÉT mà không giải mã nổi là tín hiệu lược
  // đồ của kho đã trôi khỏi chuỗi, KHÔNG phải rác. `continue` im lặng biến nó
  // thành "bạn chưa có két" — hai trạng thái rất khác nhau ra cùng một màn hình,
  // đúng thứ tệp anh em `VaultReadAPI/src/vaultView.ts` đã xử bằng `throw`.
  const khongGiaiMaDuoc: string[] = [];
  for (const u of allUtxos) {
    if (!u.datum) continue;   // skip UTxOs without inline datum (not our vault)
    let datum: VaultDatum;
    try {
      datum = Data.from(u.datum, datumSchema) as VaultDatum;
    } catch (e) {
      khongGiaiMaDuoc.push(
        `${u.txHash}#${u.outputIndex}: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    // Chủ là `Credential`; so CẢ tag lẫn hash. Két chủ-script cùng 28 byte với một pkh là
    // chủ KHÁC (on-chain so cả tag), nên không lọt sang bộ lọc nhánh khoá và ngược lại.
    if (!sameOwner(ownerRefOf(datum.owner), owner)) continue;

    const holdings = datum.loyalty_holdings as { amount: bigint; acquired_epoch: bigint; is_locked: boolean }[];
    const oldestEpoch = holdings.length === 0
      ? datum.last_updated_epoch
      : holdings.map(h => h.acquired_epoch).reduce((min, e) => e < min ? e : min);

    records.push({
      vaultId:        `${u.txHash}#${u.outputIndex}`,
      utxo:           u,
      datum,
      vaultAddress,
      lampBalanceOildrop: datum.lamp_balance,
      oldestEpoch,
      profile:        datum.profile,
    });
  }

  // Ném khi KHÔNG trả về được gì mà có thứ không giải mã nổi: đó là ca người
  // dùng đọc thành "chưa có két". Còn khi đã trả về được ít nhất một két thì chỉ
  // cảnh báo — ném ở đó sẽ giết một lượt đọc vẫn dùng được, mà tín hiệu lệch
  // thì vẫn phải hiện ra chứ không được nuốt.
  if (khongGiaiMaDuoc.length > 0) {
    const chiTiet =
      `${khongGiaiMaDuoc.length} UTxO ở địa chỉ két ${vaultAddress} không giải mã được bằng ` +
      `lược đồ của loại "${vaultType}" (${vaultType === "Instant" ? "18" : "17"} trường):\n  ` +
      khongGiaiMaDuoc.join("\n  ");
    if (records.length === 0) {
      throw new Error(
        `${chiTiet}\n` +
        `Đây là LƯỢC ĐỒ LỆCH, không phải "chủ này chưa có két". Đối chiếu hiện vật ` +
        `với nguồn bằng \`scripts/check_datum_shape.ts\`.`,
      );
    }
    console.warn(`⚠ ${chiTiet}`);
  }

  return records;
}
