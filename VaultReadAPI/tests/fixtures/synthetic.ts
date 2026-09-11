// VaultReadAPI/tests/fixtures/synthetic.ts — dựng vault mẫu BẰNG CHÍNH lược đồ thật.
//
// Không gõ tay chuỗi CBOR: mọi datum ở đây đi qua `Data.to(..., VaultDatumSchema)` của
// MagicSDK, nên khi lược đồ đổi thì mẫu đổi theo và phép kiểm nói cho biết. Một mẫu gõ
// tay sẽ đóng băng ở hình dạng cũ và vẫn xanh sau khi datum thật đã trôi.

import { Data } from "@lucid-evolution/lucid";
import { VaultDatumSchema, buildInitialVaultDatum } from "@magiclamp/sdk";

import type { ChainUtxo } from "../../src/chain.js";

export const SYNTH_SCRIPT_HASH = "aa".repeat(28);
export const SYNTH_ADDRESS = "addr_test1_synthetic_vault";
export const SYNTH_OWNER = "11".repeat(28);
export const SYNTH_OTHER_OWNER = "22".repeat(28);

export interface BatchSpec {
  id: string;
  createdEpoch: bigint;
  amountNanogic: bigint;
  decayWindow?: bigint;
}

/** Một MagicBatch đủ 9 trường, đúng thứ tự khai của `MagicBatchSchema`. */
function batch(spec: BatchSpec): Record<string, unknown> {
  return {
    batch_id: spec.id,
    source: "Schedule",
    created_epoch: spec.createdEpoch,
    initial_amount: spec.amountNanogic,
    current_amount: spec.amountNanogic,
    decay_window: spec.decayWindow ?? 1n,
    profile_at_creation: null,
    contract_id: null,
    halved: false,
  };
}

export function synthDatumHex(ownerPkh: string, batches: BatchSpec[]): string {
  const base = buildInitialVaultDatum({
    ownerPkh,
    lampBalanceOildrop: 1_000_000n,
    profile: "Flame",
    currentEpoch: 0n,
  });
  const withBatches = { ...base, magic_batches: batches.map(batch) };
  return Data.to(withBatches as never, VaultDatumSchema);
}

/** NFT danh-tính: policy == script hash của vault, tên tài sản 32 byte. */
export function synthVaultIdUnit(assetNameSeed: string): string {
  return SYNTH_SCRIPT_HASH + assetNameSeed.repeat(32).slice(0, 64);
}

export function synthUtxo(opts: {
  txHash: string;
  outputIndex?: number;
  datumHex: string | null;
  vaultIdAssetNameSeed?: string | null;
  extraAssets?: Record<string, bigint>;
}): ChainUtxo {
  const assets: Record<string, bigint> = { lovelace: 2_000_000n, ...(opts.extraAssets ?? {}) };
  if (opts.vaultIdAssetNameSeed !== null) {
    assets[synthVaultIdUnit(opts.vaultIdAssetNameSeed ?? "cd")] = 1n;
  }
  return {
    txHash: opts.txHash,
    outputIndex: opts.outputIndex ?? 0,
    assets,
    inlineDatumHex: opts.datumHex,
  };
}

// ── Mẫu GHIM PHÉP CỘNG `available` ────────────────────────────────────────────────
//
// Số chọn sao cho SÁU đại lượng sau đôi một KHÁC NHAU. Không có tính chất đó thì một
// phép kiểm "xanh" chẳng chứng minh gì: nó xanh ở cả hai bên đột biến.
//
//   Σ batch CÒN SỐNG        =  975   ← con số đúng
//   Σ MỌI batch             = 2 986
//   Σ batch ĐÃ CHẾT         = 2 011
//   số batch còn sống       =     3
//   batch còn sống đầu tiên =     5
//   batch còn sống lớn nhất =   900
//   không cộng gì           =     0
export const PIN_EPOCH = 100n;
export const PIN_BATCHES: BatchSpec[] = [
  { id: "b0".repeat(16), createdEpoch: 100n, amountNanogic: 5n },      // sống
  { id: "b1".repeat(16), createdEpoch: 99n, amountNanogic: 11n },      // chết (100−99 ≥ 1)
  { id: "b2".repeat(16), createdEpoch: 100n, amountNanogic: 70n },     // sống
  { id: "b3".repeat(16), createdEpoch: 40n, amountNanogic: 2_000n },   // chết
  { id: "b4".repeat(16), createdEpoch: 100n, amountNanogic: 900n },    // sống
];
export const PIN_AVAILABLE = 975n;
export const PIN_ACCRUED = 2_986n;
export const PIN_EXPIRED = 2_011n;
