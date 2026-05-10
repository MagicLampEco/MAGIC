// src/keeper.ts — UM Keeper: update UM datum mỗi epoch
// §14.1 Compute & Smoothing, §14.3 Permissionless update
// Keeper có incentive update vì users nhận better Instant rate khi UM fresh (C-UM-6).

import {
  Lucid, Blockfrost, Data,
  type LucidEvolution, type UTxO, type Tx,
} from "@lucid-evolution/lucid";

// ── Constants ─────────────────────────────────────────────────
const Q              = 1_000_000_000n;
const UM_MIN_Q       = 500_000_000n;
const UM_MAX_Q       = 2_000_000_000n;
const UM_WINDOW      = 6;
const SLOTS_PER_EPOCH = 432_000n;

// ── Types ─────────────────────────────────────────────────────
export interface UMDatum {
  smoothed_q         : bigint;
  last_updated_epoch : bigint;
  history            : bigint[];
}

export interface EpochStats {
  epoch      : bigint;
  totalBurns : bigint;   // nanogic burned this epoch
  totalMints : bigint;   // nanogic minted this epoch
}

export interface UMUpdateResult {
  tx           : Tx;
  oldSmoothed  : bigint;
  newSmoothed  : bigint;
  newRaw       : bigint;
  epoch        : bigint;
  summary      : string;
}

// ══════════════════════════════════════════════════════════════
// §14.1 UM Math (BigInt — C-OVERFLOW)
// ══════════════════════════════════════════════════════════════

/** C-UM-1: um_raw = ⌊epoch_burns × Q / max(epoch_mints, 1)⌋ */
export function computeUMRaw(epochBurns: bigint, epochMints: bigint): bigint {
  const denominator = epochMints > 0n ? epochMints : 1n;
  return epochBurns * Q / denominator;
}

/** Clamp to [UM_MIN_Q, UM_MAX_Q] */
export function clampUM(x: bigint): bigint {
  if (x < UM_MIN_Q) return UM_MIN_Q;
  if (x > UM_MAX_Q) return UM_MAX_Q;
  return x;
}

/** C-UM-2: append new_raw to history, keep last ≤ 6 entries */
export function appendHistory(history: bigint[], newRaw: bigint): bigint[] {
  const appended = [...history, clampUM(newRaw)];
  return appended.slice(-UM_WINDOW);   // keep last 6
}

/** C-UM-1: SMA over history */
export function computeSMA(history: bigint[]): bigint {
  if (history.length === 0) return Q;
  const total = history.reduce((s, x) => s + x, 0n);
  return total / BigInt(history.length);
}

/** Full UM update: given epoch stats, compute new smoothed UM */
export function computeNewUM(
  datum       : UMDatum,
  epochBurns  : bigint,
  epochMints  : bigint,
): { newSmoothed: bigint; newHistory: bigint[]; newRaw: bigint } {
  const newRaw      = computeUMRaw(epochBurns, epochMints);
  const newHistory  = appendHistory(datum.history, newRaw);
  const newSmoothed = clampUM(computeSMA(newHistory));
  return { newSmoothed, newHistory, newRaw };
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

const UMDatumSchema = Data.Object({
  smoothed_q:          Data.Integer(),
  last_updated_epoch:  Data.Integer(),
  history:             Data.Array(Data.Integer()),
});

const UMRedeemerSchema = Data.Enum([
  Data.Object({ UMUpdate: Data.Object({ new_raw: Data.Integer() }) }),
]);

export async function buildUMUpdateTx(
  lucid          : LucidEvolution,
  umUtxo         : UTxO,
  epochStats     : EpochStats,
  umScriptHash   : string,
): Promise<UMUpdateResult> {
  const datum    = Data.from(umUtxo.datum!, UMDatumSchema);
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

  const umAddr   = lucid.utils.validatorToAddress({ type: "PlutusV3", script: umScriptHash });
  const redeemer = Data.to({ UMUpdate: { new_raw: newRaw } }, UMRedeemerSchema);
  const epochStart = Number(currentEpoch * SLOTS_PER_EPOCH);

  const tx = await lucid
    .newTx()
    .collectFrom([umUtxo], redeemer)
    .pay.ToAddressWithData(
      umAddr,
      { kind: "inline", value: Data.to(newDatum, UMDatumSchema) },
      umUtxo.assets,
    )
    // Permissionless — no .addSignerKey()
    .validFrom(epochStart)
    .validTo(epochStart + Number(SLOTS_PER_EPOCH) - 1)
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
  umScriptHash   : string;
  shardAddresses : string[];   // for epoch stats query
  intervalMs     : number;     // polling interval (e.g. 60_000 = 1 min)
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
  const { lucid, umUtxoUnit, umScriptHash, shardAddresses, intervalMs } = config;
  let running = true;

  async function tick() {
    if (!running) return;
    try {
      const umUtxo = await lucid.utxoByUnit(umUtxoUnit);
      if (!umUtxo.datum) return;

      const datum       = Data.from(umUtxo.datum, UMDatumSchema);
      const tip         = await (lucid.provider as any).getBlock("latest");
      const currentSlot = BigInt(tip.slot ?? 0);
      const currentEpoch = currentSlot / SLOTS_PER_EPOCH;

      // Check if update needed
      if (currentEpoch <= datum.last_updated_epoch) return;

      console.log(`[UM Keeper] New epoch ${currentEpoch} detected. Updating UM...`);

      const stats  = await getEpochStats(lucid, currentEpoch, shardAddresses);
      const result = await buildUMUpdateTx(lucid, umUtxo, stats, umScriptHash);
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
