// VaultReadAPI/src/prepaidView.ts — LÕI THUẦN cho két PrepaidGen: (UTxO thô, script hash, epoch) → số MAGIC.
//
// Hàm thuần, không mạng, không khoá, không I/O — cùng khuôn với `vaultView.ts`.
//
// ── BA THỨ TỆP NÀY CỐ Ý KHÔNG TỰ LÀM ────────────────────────────────────────────
// 1. Giải mã datum: `decodeVaultDatum` của `@magiclamp/prepaidgen-sdk`
//    (`PrepaidGen/offchain/src/tx/codec.ts`), lược đồ `PrepaidVaultDatumSchema`. Không khai
//    lại lược đồ ở đây.
// 2. Cổng NFT danh-tính / trùng NFT / datum inline / chủ khớp: `vaultView.ts` ▸
//    `readGatedVaults` — đúng bản cổng mà két Instant/Schedule đi qua.
// 3. Tổng MAGIC tiêu được: `liveMagic` của PrepaidGen (`PrepaidGen/offchain/src/prepaid.ts`).
//
// ── LUẬT "CÒN SỐNG" CỦA KÉT PREPAID KHÁC `isBatchExpired` ───────────────────────
// On-chain két Prepaid chỉ cho đốt batch có `created_epoch == current_epoch`
// (`PrepaidGen/onchain/validators/prepaid.ak` ▸ `apply_burns`, chốt C-PP-5), và `liveMagic`
// là gương của luật đó. `isBatchExpired` của MagicSDK (`current − created ≥ decay_window`)
// trùng luật này khi `at_epoch ≥ created_epoch`, nhưng LỆCH khi bên gọi ép một `at_epoch`
// nhỏ hơn `created_epoch`: SDK nói "sống", két Prepaid không cho đốt. Nên ở đây cờ `live`
// của từng batch theo luật Prepaid, và tổng của các cờ đó bị ĐỐI CHIẾU với `liveMagic` —
// lệch ⟹ NÉM, không chọn bên (luật bên PrepaidGen đổi mà tệp này chưa theo).

import {
  BATCH_SOURCE_PREPAID, PREPAID_DECAY_WINDOW, decodeVaultDatum, liveMagic,
  type PrepaidVaultDatum,
} from "@magiclamp/prepaidgen-sdk";
import { ownerRefOf, type OwnerRef } from "@magiclamp/protocol-utils";

import type { ChainUtxo } from "./chain.js";
import { VaultDatumUndecodableError } from "./errors.js";
import { readGatedVaults, type IgnoredUtxo } from "./vaultView.js";

/** Một lô MAGIC của két Prepaid. Cùng tên trường với `BatchView` của két Gen. */
export interface PrepaidBatchView {
  batchId: string;
  /** Luôn `"Prepaid"` — `source` trên chuỗi là số `3` (`BATCH_SOURCE_PREPAID`), hiện bằng
   *  tên để cùng không gian giá trị với `"Instant"`/`"Schedule"` của két Gen. */
  source: "Prepaid";
  createdEpoch: bigint;
  /** Epoch ĐẦU TIÊN mà batch đã chết: `created_epoch + decay_window` (= +1). */
  expiresAtEpoch: bigint;
  decayWindow: bigint;
  /** `null`: `MagicBatch` của PrepaidGen KHÔNG có trường `initial_amount` (7 trường, không
   *  phải 9). Đệm bằng `current_amount` là bịa một số đã sinh không ai ghi. */
  initialAmountNanogic: null;
  currentAmountNanogic: bigint;
  live: boolean;
  /** `contract_id` = `fund_id` của dòng hạn mức sinh ra lô này. */
  contractId: string;
}

/** Một dòng hạn mức (`PrepaidCredit`) — thứ chủ két cần để biết còn rút được bao nhiêu. */
export interface PrepaidCreditView {
  fundId: string;
  /** CARP còn rút được từ dòng này, carpdrop. */
  remainingCarpdrop: bigint;
  issuedEpoch: bigint;
  lastDrawEpoch: bigint;
  /** nanogic đã đốt từ dòng này mà quỹ CHƯA ghi nhận (về 0 ở `SettleLine`). */
  consumedUnsettledNanogic: bigint;
}

export interface PrepaidVaultView {
  utxoRef: string;
  vaultKind: "Prepaid";
  /** Hình dạng datum đã đọc được — ở đây là "giải được bằng lược đồ Prepaid". */
  datumKind: "Prepaid";
  vaultAddress: string;
  vaultIdUnit: string;
  owner: OwnerRef;
  ownerPkh: string | null;
  availableNanogic: bigint;
  accruedNanogic: bigint;
  expiredNanogic: bigint;
  lastUpdatedEpoch: bigint;
  batches: PrepaidBatchView[];
  prepaidCredits: PrepaidCreditView[];
}

export interface ReadPrepaidVaultsResult {
  vaults: PrepaidVaultView[];
  ignored: IgnoredUtxo[];
}

/**
 * Cùng hợp đồng tham số với `readVaultsFromUtxos` trừ `vaultKind` (luôn `Prepaid`).
 * `vaultScriptHash` là script hash két Prepaid — cũng là policy NFT danh-tính
 * (`PrepaidGen/offchain/src/tx/codec.ts` ▸ `readVaultUtxo` đòi đúng một token dưới đó).
 */
export function readPrepaidVaultsFromUtxos(
  utxos: ChainUtxo[],
  vaultScriptHash: string,
  vaultAddress: string,
  owner: OwnerRef | string,
  atEpoch: bigint,
): ReadPrepaidVaultsResult {
  return readGatedVaults(
    utxos, vaultScriptHash, owner,
    decodePrepaidDatum,
    d => d.owner,
    (d, utxoRef, vaultIdUnit) => toPrepaidVaultView(d, utxoRef, vaultAddress, vaultIdUnit, atEpoch),
  );
}

/** NÉM `VaultDatumUndecodableError` (502) khi datum không đúng lược đồ Prepaid — ví dụ một
 *  datum két Instant đỗ ở địa chỉ khai là Prepaid. Không trả `null`, không đệm. */
function decodePrepaidDatum(hex: string, utxoRef: string): PrepaidVaultDatum {
  try {
    return decodeVaultDatum(hex);
  } catch (e) {
    throw new VaultDatumUndecodableError(utxoRef, `lược đồ Prepaid: ${(e as Error).message}`);
  }
}

function toPrepaidVaultView(
  d: PrepaidVaultDatum,
  utxoRef: string,
  vaultAddress: string,
  vaultIdUnit: string,
  atEpoch: bigint,
): PrepaidVaultView {
  const batches: PrepaidBatchView[] = d.magic_batches.map(b => {
    // Hai hằng mà validator ép lúc Draw. Khác ⟹ datum không phải két Prepaid của giao thức
    // này (hoặc luật đã đổi mà tệp này chưa theo) — NÉM, đừng hiện như thật.
    if (b.source !== BATCH_SOURCE_PREPAID) {
      throw new VaultDatumUndecodableError(utxoRef, `magic_batches[].source = ${b.source}, chờ ${BATCH_SOURCE_PREPAID}`);
    }
    if (b.decay_window !== PREPAID_DECAY_WINDOW) {
      throw new VaultDatumUndecodableError(
        utxoRef, `magic_batches[].decay_window = ${b.decay_window}, chờ ${PREPAID_DECAY_WINDOW}`,
      );
    }
    return {
      batchId: b.batch_id,
      source: "Prepaid",
      createdEpoch: b.created_epoch,
      decayWindow: b.decay_window,
      expiresAtEpoch: b.created_epoch + b.decay_window,
      initialAmountNanogic: null,
      currentAmountNanogic: b.current_amount,
      // Luật C-PP-5 (xem đầu tệp), không phải `isBatchExpired`.
      live: b.created_epoch === atEpoch,
      contractId: b.contract_id,
    };
  });

  const availableNanogic = batches.filter(b => b.live).reduce((t, b) => t + b.currentAmountNanogic, 0n);
  const fromModule = liveMagic(d, atEpoch);
  if (availableNanogic !== fromModule) {
    // Không phải lỗi dữ liệu chuỗi: hai bản của một luật đã lệch nhau. Ném Error thường ⟹
    // 500 kèm mã tham chiếu; cái gì cũng tốt hơn chọn một trong hai con số.
    throw new Error(
      `[prepaidView] cờ live lệch liveMagic của PrepaidGen ở ${utxoRef}: ${availableNanogic} ≠ ${fromModule}`,
    );
  }
  const accruedNanogic = batches.reduce((t, b) => t + b.currentAmountNanogic, 0n);
  const owner = ownerRefOf(d.owner);

  return {
    utxoRef,
    vaultKind: "Prepaid",
    datumKind: "Prepaid",
    vaultAddress,
    vaultIdUnit,
    owner,
    ownerPkh: owner.type === "key" ? owner.hash : null,
    availableNanogic,
    accruedNanogic,
    expiredNanogic: accruedNanogic - availableNanogic,
    lastUpdatedEpoch: d.last_updated_epoch,
    batches,
    prepaidCredits: d.prepaid_credits.map(c => ({
      fundId: c.fund_id,
      remainingCarpdrop: c.remaining,
      issuedEpoch: c.issued_epoch,
      lastDrawEpoch: c.last_draw_epoch,
      consumedUnsettledNanogic: c.consumed_unsettled,
    })),
  };
}
