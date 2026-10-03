// MagicSDK/src/genV2Refs.ts — đọc hai reference input của lượt làm mới checkpoint két
// InstantGen Gen v2.0: beacon ρ (`RateParam`, NFT "RHO") và két Wakeme ghim két này.
//
// Dùng ở những nhánh chủ ký mà SDK tự dựng datum ra (`BurnBatch` qua `burnBatch.ts`,
// `UpdateProfile` qua `updateProfile.ts`). Công thức checkpoint KHÔNG ở đây — nó là
// `@magiclamp/instantgen-sdk` ▸ `expectedCheckpoint` (gương `checkpoint.ak`). Tệp này chỉ
// soát UTxO do người gọi đưa vào rồi giải mã, NÉM ở mọi hình dạng lạ — không đệm giá trị.
//
// Luật khi nào cần gì (gương `checkpoint.ak` ▸ `expected_checkpoint`, mode `FollowVault`):
//   `cap_epoch == e`  ⟹ không làm mới, KHÔNG đọc ref nào.
//   `cap_epoch <  e`  ⟹ làm mới: BẮT BUỘC beacon ρ; `wakeme_link != ""` ⟹ BẮT BUỘC két Wakeme
//                       đang ghim két; link "" mà có két Wakeme ⟹ chỉ hợp lệ khi két đó ghim két này
//                       (`L_lent > 0`, luật 6 siết 2026-10-03), không thì NÉM GEN-INST-011.

import { Data, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import {
  RATE_NFT_NAME, RateParam, readWakemeVault,
  type InstantVaultParams, type WakemeRead,
} from "@magiclamp/instantgen-sdk";

/** Phần apply-param két Instant mà hai phép đọc cần. Truyền trọn `InstantVaultParams` cũng được. */
export type InstantRefParams = Pick<
  InstantVaultParams,
  | "lampPolicyId" | "lampAssetName" | "rateNftPolicy" | "rateScriptHash" | "wakemeVaultHash"
  // vế (d) ngoại lệ genesis của `wakeme_read` (2026-10-02)
  | "msPerEpoch" | "windowOriginMs"
>;

function at(u: UTxO): string {
  return `${u.txHash}#${u.outputIndex}`;
}

/**
 * Beacon ρ: UTxO tại `Script(rateScriptHash)`, mang ĐÚNG 1 NFT (rateNftPolicy, "RHO"),
 * datum inline `RateParam`. Sai ⟹ NÉM `SDK-GENV2-RATE`.
 */
export function readRateBeacon(u: UTxO, p: Pick<InstantRefParams, "rateNftPolicy" | "rateScriptHash">): RateParam {
  const pc = getAddressDetails(u.address).paymentCredential;
  if (pc?.type !== "Script" || pc.hash !== p.rateScriptHash) {
    throw new Error(`SDK-GENV2-RATE: beacon ρ ${at(u)} không nằm tại script rate_param ${p.rateScriptHash}.`);
  }
  const unit = p.rateNftPolicy + RATE_NFT_NAME;
  if (u.assets[unit] !== 1n) {
    throw new Error(`SDK-GENV2-RATE: beacon ρ ${at(u)} không mang đúng 1 NFT ${unit}.`);
  }
  if (typeof u.datum !== "string" || u.datum.length === 0) {
    throw new Error(`SDK-GENV2-RATE: beacon ρ ${at(u)} không có datum inline.`);
  }
  try {
    return Data.from(u.datum, RateParam);
  } catch (e) {
    throw new Error(`SDK-GENV2-RATE: datum beacon ρ ${at(u)} sai hình dạng RateParam — ${(e as Error).message}`);
  }
}

/** (hash script két, tên NFT vault-id DUY NHẤT dưới policy = hash đó). Sai ⟹ NÉM. */
export function vaultIdentityOf(vaultUtxo: UTxO): { scriptHash: string; name: string } {
  const pc = getAddressDetails(vaultUtxo.address).paymentCredential;
  if (pc?.type !== "Script") {
    throw new Error(`SDK-GENV2-VAULT: két ${at(vaultUtxo)} không nằm ở địa chỉ script.`);
  }
  const ids = Object.entries(vaultUtxo.assets).filter(([u]) => u !== "lovelace" && u.slice(0, 56) === pc.hash);
  if (ids.length !== 1 || ids[0]![1] !== 1n) {
    throw new Error(
      `SDK-GENV2-VAULT: két ${at(vaultUtxo)} phải mang ĐÚNG MỘT NFT vault-id dưới ${pc.hash} (số lượng 1), ` +
      `thấy ${ids.length}.`,
    );
  }
  return { scriptHash: pc.hash, name: ids[0]![0].slice(56) };
}

/** Đọc két Wakeme ghim `vaultUtxo` ở kỳ `e` — ủy cho `readWakemeVault` của InstantGen. */
export function readWakemeForVault(
  wakemeUtxo: UTxO, vaultUtxo: UTxO, p: InstantRefParams, e: bigint,
): WakemeRead {
  const id = vaultIdentityOf(vaultUtxo);
  return readWakemeVault(wakemeUtxo, {
    wakemeVaultHash: p.wakemeVaultHash,
    ownScriptHash:   id.scriptHash,
    ownVaultName:    id.name,
    currentPeriod:   e,
    msPerEpoch:      p.msPerEpoch,
    windowOriginMs:  p.windowOriginMs,
    lampPolicyId:    p.lampPolicyId,
    lampAssetName:   p.lampAssetName,
  });
}

/** Đầu vào đã giải mã cho `expectedCheckpoint`. `null` = người gọi KHÔNG đưa UTxO đó. */
export interface CheckpointRefsRead {
  rate:   RateParam | null;
  wakeme: WakemeRead | null;
}

/**
 * Giải mã hai ref input nếu có. Có UTxO mà thiếu `params` ⟹ NÉM: không có apply-param
 * thì không soát được UTxO có đúng là beacon/két mà validator sẽ nhận hay không.
 */
export function readCheckpointRefs(args: {
  vaultUtxo: UTxO;
  e: bigint;
  params?: InstantRefParams;
  rateBeaconUtxo?: UTxO;
  wakemeVaultUtxo?: UTxO;
}): CheckpointRefsRead {
  const need = args.rateBeaconUtxo !== undefined || args.wakemeVaultUtxo !== undefined;
  if (need && args.params === undefined) {
    throw new Error(
      `SDK-GENV2-PARAMS: đã truyền beacon ρ / két Wakeme nhưng thiếu \`instantVaultParams\` — ` +
      `SDK cần apply-param của két (rateNftPolicy, rateScriptHash, wakemeVaultHash, LAMP) để soát chúng.`,
    );
  }
  return {
    rate:   args.rateBeaconUtxo === undefined ? null : readRateBeacon(args.rateBeaconUtxo, args.params!),
    wakeme: args.wakemeVaultUtxo === undefined ? null
      : readWakemeForVault(args.wakemeVaultUtxo, args.vaultUtxo, args.params!, args.e),
  };
}
