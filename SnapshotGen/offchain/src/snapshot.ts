// src/snapshot.ts — SnapshotGen transaction builder
// Triggers a SnapshotGen (or catch-up) for a vault at the current epoch boundary.

import {
  Lucid, Blockfrost, Data,
  type LucidEvolution, type UTxO, type Tx,
} from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";
import {
  TESTNET_CONFIG, MAX_BATCHES_PER_VAULT,
  PROFILE_PARAMS,
} from "./constants.js";
import {
  computeLfQ, computeOacQ, computeSnapshotMagic, computeCatchupMagic,
  isExpired, slotToEpoch, nanogicToMagicStr, qToStr, lampToOil,
} from "./math.js";
import { getTipSlot } from "@magiclamp/protocol-utils";
import {
  VaultDatumSchema, VaultRedeemerSchema,
  type VaultDatum, type MagicBatch,
} from "./types.js";

// ── Types ─────────────────────────────────────────────────────

export interface SnapshotGenParams {
  lucid       : LucidEvolution;
  vaultUtxo   : UTxO;
  userAddress : string;
}

export interface SnapshotGenResult {
  tx               : Tx;
  mGenerated       : bigint;   // total nanogic in new batch
  mPerEpoch        : bigint;   // M_snapshot for 1 epoch
  deltaEpochs      : bigint;   // catch-up multiplier
  currentEpoch     : bigint;
  lfQ              : bigint;
  oacQ             : bigint;
  profile          : string;
  batchAdded       : boolean;  // false = vault was full (C-SS-8 skip)
  prunedCount      : number;
  newBatchCount    : number;
  summary          : string;
}

// ── Lucid setup ───────────────────────────────────────────────

export async function createLucid(blockfrostApiKey: string): Promise<LucidEvolution> {
  return Lucid(
    new Blockfrost(TESTNET_CONFIG.blockfrostUrl, blockfrostApiKey),
    TESTNET_CONFIG.network,
  );
}

// ── Main builder ─────────────────────────────────────────────

/**
 * Build a TriggerSnapshot transaction.
 *
 * Flow:
 *  1. Read vault datum → verify new epoch
 *  2. Compute LF (weighted) and OAC (activity window)
 *  3. Compute M_snapshot × Δe (catch-up)
 *  4. Prune expired Snapshot batches (no halving needed — Snapshot only)
 *  5. C-SS-7/8: add batch if room; else SKIP (lost permanently)
 *  6. Build tx with updated VaultDatum (no LAMP movement — T16)
 */
export async function buildSnapshotGenTx(
  params: SnapshotGenParams,
): Promise<SnapshotGenResult> {
  const { lucid, vaultUtxo } = params;

  // Decode vault datum
  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);

  // Get current epoch
  const tipSlot    = await getTipSlot(lucid);
  const currentEpoch = slotToEpoch(BigInt(tipSlot));

  // C-SS-1: must be a new epoch
  if (currentEpoch <= vaultDatum.last_updated_epoch) {
    throw new Error(
      `C-SS-1: current_epoch ${currentEpoch} ≤ last_updated_epoch ${vaultDatum.last_updated_epoch}. ` +
      `Snapshot already triggered this epoch.`
    );
  }

  const deltaEpochs = currentEpoch - vaultDatum.last_updated_epoch;

  // C-SS-5: full lamp_balance (including locked) — L3, T16
  const lampBalance = vaultDatum.lamp_balance;

  // Compute LF and OAC
  const lfQ  = computeLfQ(vaultDatum.loyalty_holdings, currentEpoch);
  const oacQ = computeOacQ(vaultDatum.activity_state, currentEpoch);

  // C-SS-2: M_snapshot per epoch
  const mPerEpoch = computeSnapshotMagic(lampBalance, lfQ, oacQ, vaultDatum.profile);

  // C-SS-6: catch-up
  const mTotal = mPerEpoch * deltaEpochs;

  // Prune expired batches (C-PRUNE-1 — no halving for Snapshot)
  const prunedBatches = vaultDatum.magic_batches.filter(
    (b) => !isExpired(b.created_epoch, b.decay_window, currentEpoch),
  );
  const prunedCount = vaultDatum.magic_batches.length - prunedBatches.length;

  // C-SS-7/8: add batch if room
  const canAdd = prunedBatches.length < MAX_BATCHES_PER_VAULT && mTotal > 0n;
  let updatedBatches: MagicBatch[];
  let batchAdded = false;

  if (canAdd) {
    const { r, N } = PROFILE_PARAMS[vaultDatum.profile]!;
    const newBatch: MagicBatch = {
      batch_id:            computeBatchId(vaultUtxo, vaultDatum.next_batch_index),
      source:              "Snapshot",
      created_epoch:       currentEpoch,
      initial_amount:      mTotal,
      current_amount:      mTotal,
      decay_window:        BigInt(N),             // C-SS-3: N(profile)
      profile_at_creation: vaultDatum.profile,    // C-SS-4, C-DECAY-4: Some(P)
      contract_id:         null,
      halved:              false,                  // C-DECAY-6
    };
    updatedBatches = [...prunedBatches, newBatch];
    batchAdded = true;
  } else {
    // C-SS-8: SKIP — lost permanently
    updatedBatches = prunedBatches;
  }

  // Prune stale activity_state (§15.1 step 7 — AFTER OAC is computed)
  const cutoff = currentEpoch - 12n;
  const prunedActivity = {
    ...vaultDatum.activity_state,
    recent_burn_epochs: vaultDatum.activity_state.recent_burn_epochs.filter(
      ([, ep]) => ep >= cutoff,
    ),
  };

  // Build updated attribution
  const newAttribution = batchAdded ? {
    attribution_root: updateAttributionRoot(vaultDatum.attribution.attribution_root, {
      type: "BatchCreated", source: "Snapshot", epoch: currentEpoch,
    }),
    last_event_epoch: currentEpoch,
    total_events:     vaultDatum.attribution.total_events + 1n,
  } : vaultDatum.attribution;

  // Build updated VaultDatum (A02: field-by-field)
  const newVaultDatum: VaultDatum = {
    ...vaultDatum,
    magic_batches:     updatedBatches,
    next_batch_index:  batchAdded ? vaultDatum.next_batch_index + 1n : vaultDatum.next_batch_index,
    last_updated_epoch: currentEpoch,
    activity_state:    prunedActivity,
    attribution:       newAttribution,
  };

  // Build tx — no Treasury output (T16: no LAMP cost for Snapshot)
  const vaultScriptAddress = lucid.utils.validatorToAddress({
    type:   "PlutusV3",
    script: TESTNET_CONFIG.vaultScriptHash,
  });

  const redeemer = Data.to("TriggerSnapshot", VaultRedeemerSchema);

  const epochStartSlot = Number(currentEpoch * 432_000n);
  const epochEndSlot   = epochStartSlot + 432_000 - 1;

  const tx = await lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .pay.ToAddressWithData(
      vaultScriptAddress,
      { kind: "inline", value: Data.to(newVaultDatum, VaultDatumSchema) },
      vaultUtxo.assets,    // all assets stay on vault — no LAMP movement
    )
    .addSignerKey(vaultDatum.owner)
    .validFrom(epochStartSlot)
    .validTo(epochEndSlot)
    .complete();

  const summary = buildSummary({
    mTotal, mPerEpoch, deltaEpochs, lfQ, oacQ,
    profile: vaultDatum.profile, batchAdded, prunedCount,
    newBatchCount: updatedBatches.length, currentEpoch,
    lampBalance,
  });

  return {
    tx, mGenerated: mTotal, mPerEpoch, deltaEpochs,
    currentEpoch, lfQ, oacQ, profile: vaultDatum.profile,
    batchAdded, prunedCount, newBatchCount: updatedBatches.length,
    summary,
  };
}

// ── Submit helper ────────────────────────────────────────────

export async function signAndSubmit(lucid: LucidEvolution, tx: Tx): Promise<string> {
  const signedTx = await tx.sign.withWallet().complete();
  return signedTx.submit();
}

// ── Utilities ────────────────────────────────────────────────

function computeBatchId(vaultUtxo: UTxO, nextBatchIndex: bigint): string {
  const txHash      = Buffer.from(vaultUtxo.txHash, "hex");
  const outputIndex = Buffer.alloc(8);
  outputIndex.writeBigUInt64BE(BigInt(vaultUtxo.outputIndex));
  const indexBytes  = Buffer.alloc(8);
  indexBytes.writeBigUInt64BE(nextBatchIndex);
  const preimage = Buffer.concat([txHash, outputIndex, indexBytes]);
  return Buffer.from(blake2b(preimage, { dkLen: 32 })).toString("hex");
}

function updateAttributionRoot(
  oldRoot : string,
  event   : { type: string; source: string; epoch: bigint },
): string {
  const old  = Buffer.from(oldRoot, "hex");
  const enc  = Buffer.from(JSON.stringify({ ...event, epoch: event.epoch.toString() }));
  return Buffer.from(blake2b(Buffer.concat([old, enc]), { dkLen: 32 })).toString("hex");
}

// getTipSlot moved to @magiclamp/protocol-utils — network-aware fallback (P8).

function buildSummary(p: {
  mTotal: bigint; mPerEpoch: bigint; deltaEpochs: bigint;
  lfQ: bigint; oacQ: bigint; profile: string; batchAdded: boolean;
  prunedCount: number; newBatchCount: number; currentEpoch: bigint;
  lampBalance: bigint;
}): string {
  const { r, N } = PROFILE_PARAMS[p.profile]!;
  return [
    `═══ SnapshotGen Summary ═══`,
    `Epoch:          ${p.currentEpoch}`,
    `Profile:        ${p.profile}  (r=${r}, N=${N} epoch, decay ×${(10-r)/10})`,
    `LAMP balance:   ${p.lampBalance / 1_000_000n} tLAMP (incl. locked — C-SS-5)`,
    `LF:             ${qToStr(p.lfQ)}×`,
    `OAC:            ${qToStr(p.oacQ)}×`,
    `M₀/epoch:       ${nanogicToMagicStr(p.mPerEpoch)} MAGIC`,
    `Δ epochs:       ${p.deltaEpochs}  (catch-up — C-SS-6)`,
    `MAGIC minted:   ${nanogicToMagicStr(p.mTotal)} MAGIC  (${p.mTotal} nanogic)`,
    ``,
    `Changes:`,
    `  Batches pruned: ${p.prunedCount}`,
    `  Batch added:    ${p.batchAdded ? "YES" : "NO ⚠ (vault full — C-SS-8, generation LOST)"}`,
    `  Active batches: ${p.newBatchCount}`,
    ``,
    p.batchAdded
      ? `✓  Batch created with ${N}-epoch lifetime.`
      : `⚠  Vault full (${MAX_BATCHES_PER_VAULT} batches). Burn first, then re-trigger.`,
    ``,
    `Note: No LAMP moved. SnapshotGen is free (T16 — no UM).`,
  ].join("\n");
}
