// src/keeper.ts — UM Keeper: update UM datum mỗi epoch
// §14.1 Compute & Smoothing, §14.3 Permissionless update
// Keeper có incentive update vì users nhận better Instant rate khi UM fresh (C-UM-6).

import {
  Lucid, Blockfrost, Data,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  slotToUnixTime,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator,
} from "@lucid-evolution/lucid";
import { posixMsToEpoch, msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import {
  computeUMRaw, clampUM, appendHistory, computeSMA, computeNewUM,
  type UMDatum,
} from "./math.js";

export {
  computeUMRaw, clampUM, appendHistory, computeSMA, computeNewUM, type UMDatum,
};

// ── Local constants used for tx serialization only ────────────
const Q = 1_000_000_000n;

export interface EpochStats {
  epoch      : bigint;
  totalBurns : bigint;   // nanogic burned this epoch
  totalMints : bigint;   // nanogic minted this epoch
}

export interface UMUpdateResult {
  tx           : TxSignBuilder;
  oldSmoothed  : bigint;
  newSmoothed  : bigint;
  newRaw       : bigint;
  epoch        : bigint;
  summary      : string;
}

// ══════════════════════════════════════════════════════════════
// Epoch stats — query from Blockfrost or on-chain indexer
// ══════════════════════════════════════════════════════════════

/**
 * Get total burns and mints for the previous epoch.
 * In production: query from a MagicSupplyShard UTxO or Blockfrost tx history.
 * For testnet: simplified stub that keeper replaces with real data.
 */
export async function getEpochStats(
  lucid   : LucidEvolution,
  epoch   : bigint,
  shardAddresses: string[],
): Promise<EpochStats> {
  // In production, read from MagicSupplyShardDatums which track per-epoch stats.
  // For testnet v1: keeper provides these values from off-chain indexer.
  // Stub returns neutral (1:1 ratio → raw=Q=1.0)
  console.log(`⚠  getEpochStats stub for epoch ${epoch}. Replace with real indexer query.`);
  return {
    epoch,
    totalBurns: 1_000_000_000_000n,   // 1000 MAGIC burned
    totalMints: 1_000_000_000_000n,   // 1000 MAGIC minted → ratio = 1.0 → raw = Q
  };
}

// ══════════════════════════════════════════════════════════════
// Transaction builder
// ══════════════════════════════════════════════════════════════

// Lược đồ Plutus Data. Thứ tự trường LÀ hợp đồng nhị phân — đổi chỗ là vỡ decode
// mọi UM UTxO đã tạo. Neo: UMKeeper/onchain/validators/um_datum.ak.
//
// Cặp `type X = Data.Static<...>` + `const X = schema as unknown as X` là khuôn bắt
// buộc của lucid-evolution: `Data.to`/`Data.from` nhận KIỂU TĨNH ở tham số thứ hai,
// không nhận chính đối tượng lược đồ. Thiếu cặp này thì tệp không biên dịch được —
// và trước đây không ai biết, vì gói này chưa từng có `tsconfig.json` để chạy
// `tsc --noEmit`, còn vitest thì chỉ chạm `math.ts`.
const UMDatumSchema = Data.Object({
  smoothed_q:          Data.Integer(),
  last_updated_epoch:  Data.Integer(),
  history:             Data.Array(Data.Integer()),
});
type UMDatumPlutus = Data.Static<typeof UMDatumSchema>;
const UMDatumPlutus = UMDatumSchema as unknown as UMDatumPlutus;

const UMRedeemerSchema = Data.Enum([
  Data.Object({ UMUpdate: Data.Object({ new_raw: Data.Integer() }) }),
]);
type UMRedeemerPlutus = Data.Static<typeof UMRedeemerSchema>;
const UMRedeemerPlutus = UMRedeemerSchema as unknown as UMRedeemerPlutus;

export async function buildUMUpdateTx(
  lucid          : LucidEvolution,
  umUtxo         : UTxO,
  epochStats     : EpochStats,
  umScript       : Validator,         // applied script (ms_per_epoch baked in)
  network        : Network = "Preview",
  tipPosixMs?    : bigint,
): Promise<UMUpdateResult> {
  const datum    = Data.from(umUtxo.datum!, UMDatumPlutus);
  const currentEpoch = epochStats.epoch;

  // C-UM-4: Must be a new epoch
  if (currentEpoch <= datum.last_updated_epoch) {
    throw new Error(`C-UM-4: current_epoch ${currentEpoch} ≤ last_updated ${datum.last_updated_epoch}`);
  }

  // Compute new UM
  const { newSmoothed, newHistory, newRaw } = computeNewUM(
    datum, epochStats.totalBurns, epochStats.totalMints,
  );

  const newDatum: UMDatum = {
    smoothed_q:         newSmoothed,
    last_updated_epoch: currentEpoch,
    history:            newHistory,
  };

  // UM address derived from applied script (hash differs per-network).
  const umAddr   = credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(umScript)),
  );
  const redeemer = Data.to({ UMUpdate: { new_raw: newRaw } }, UMRedeemerPlutus);
  // POSIX-ms validity range. Validator computes epoch = posix_ms / ms_per_epoch.
  const tipMs    = tipPosixMs ?? BigInt(Date.now());
  const lowerTime = Number(tipMs);
  const upperTime = Number((currentEpoch + 1n) * msPerEpoch(network) - 1n);

  const tx = await lucid
    .newTx()
    .collectFrom([umUtxo], redeemer)
    .attach.SpendingValidator(umScript)
    .pay.ToAddressWithData(
      umAddr,
      { kind: "inline", value: Data.to(newDatum, UMDatumPlutus) },
      umUtxo.assets,
    )
    // Permissionless — no .addSignerKey()
    .validFrom(lowerTime)
    .validTo(upperTime)
    .complete();

  const arrow = newSmoothed > datum.smoothed_q ? "▲" : newSmoothed < datum.smoothed_q ? "▼" : "─";
  const summary = [
    `═══ UM Update ═══`,
    `Epoch:         ${currentEpoch}`,
    `Burns / Mints: ${epochStats.totalBurns} / ${epochStats.totalMints} nanogic`,
    `New raw UM:    ${newRaw} (${(Number(newRaw) / 1e9).toFixed(4)}×)`,
    `Old smoothed:  ${datum.smoothed_q} (${(Number(datum.smoothed_q) / 1e9).toFixed(4)}×)`,
    `New smoothed:  ${newSmoothed} (${(Number(newSmoothed) / 1e9).toFixed(4)}×) ${arrow}`,
    `History:       [${newHistory.map(x => (Number(x)/1e9).toFixed(2)).join(", ")}]`,
    ``,
    `Effect on Instant rate at UM=${(Number(newSmoothed)/1e9).toFixed(2)}×:`,
    `  Flame 1000 LAMP → ${(Number(newSmoothed) * 3 * 1.05 / 1e9).toFixed(4)} MAGIC`,
    ``,
    `Note: Permissionless tx — no owner signature required (§14.3).`,
  ].join("\n");

  return { tx, oldSmoothed: datum.smoothed_q, newSmoothed, newRaw, epoch: currentEpoch, summary };
}

// ══════════════════════════════════════════════════════════════
// Keeper monitoring loop
// ══════════════════════════════════════════════════════════════

export interface KeeperConfig {
  lucid          : LucidEvolution;
  umUtxoUnit     : string;     // NFT unit to identify UM UTxO
  umScript       : Validator;  // applied script (ms_per_epoch baked in)
  shardAddresses : string[];   // for epoch stats query
  intervalMs     : number;     // polling interval (e.g. 60_000 = 1 min)
  network?       : Network;    // for POSIX-based epoch math
  onUpdate?      : (result: UMUpdateResult) => void;
  onError?       : (err: Error) => void;
}

/**
 * Start the UM keeper loop.
 * Checks every `intervalMs` ms if a new epoch has started.
 * If yes: queries stats, builds and submits UM update tx.
 * Returns a stop function.
 */
export function startUMKeeper(config: KeeperConfig): () => void {
  const { lucid, umUtxoUnit, umScript, shardAddresses, intervalMs } = config;
  let running = true;

  async function tick() {
    if (!running) return;
    try {
      const umUtxo = await lucid.utxoByUnit(umUtxoUnit);
      if (!umUtxo.datum) return;

      const datum       = Data.from(umUtxo.datum, UMDatumPlutus);
      const tip         = await (lucid.config().provider as any).getBlock("latest");
      const network     = config.network ?? "Preview";
      const tipPosixMs  = BigInt(slotToUnixTime(network, tip.slot ?? 0));
      const currentEpoch = posixMsToEpoch(tipPosixMs, network);

      // Check if update needed
      if (currentEpoch <= datum.last_updated_epoch) return;

      console.log(`[UM Keeper] New epoch ${currentEpoch} detected. Updating UM...`);

      const stats  = await getEpochStats(lucid, currentEpoch, shardAddresses);
      const result = await buildUMUpdateTx(lucid, umUtxo, stats, umScript, network);
      const signed = await result.tx.sign.withWallet().complete();
      const txHash = await signed.submit();

      console.log(`[UM Keeper] Updated UM at epoch ${currentEpoch}. TX: ${txHash}`);
      console.log(result.summary);
      config.onUpdate?.(result);

    } catch (err) {
      console.error(`[UM Keeper] Error:`, err);
      config.onError?.(err as Error);
    }
  }

  const interval = setInterval(tick, intervalMs);
  tick();  // run immediately

  return () => { running = false; clearInterval(interval); };
}

export async function createLucid(apiKey: string, network = "Preview"): Promise<LucidEvolution> {
  return Lucid(
    new Blockfrost(`https://cardano-${network.toLowerCase()}.blockfrost.io/api/v0`, apiKey),
    network as any,
  );
}
