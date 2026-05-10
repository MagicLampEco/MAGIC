// src/instant.ts — InstantGen transaction builder
// Builds and submits the InstantGen transaction to Cardano testnet.
// Uses Lucid Evolution (https://github.com/Anastasia-Labs/lucid-evolution).

import {
  Lucid, Blockfrost, Data, fromText, toUnit,
  type LucidEvolution, type UTxO, type Tx,
} from "@lucid-evolution/lucid";
import {
  TESTNET_CONFIG, MAX_BATCHES_PER_VAULT, INSTANT_DECAY_WINDOW,
  MIN_INSTANT_PURCHASE, MAX_INSTANT_PURCHASE, PM_Q,
} from "./constants.js";
import {
  computeInstantMagic, getUmForInstant, shouldHalve, applyHalving,
  isExpired, lampToOil, slotToEpoch, nanogicToMagicStr, qToStr,
} from "./math.js";
import {
  VaultDatumSchema, UMDatumSchema, VaultRedeemerSchema,
  type VaultDatum, type UMDatum, type MagicBatch, type LoyaltyHolding,
} from "./types.js";
import { blake2b } from "@noble/hashes/blake2b";

// ── Types ─────────────────────────────────────────────────────

export interface InstantGenParams {
  /** Lucid instance connected to Preview testnet */
  lucid: LucidEvolution;
  /** The vault UTxO to spend */
  vaultUtxo: UTxO;
  /** LAMP to pay in oil (1 LAMP = 10^6 oil). Min: 10^7, Max: 10^13 */
  lampPaidOil: bigint;
  /** UM datum UTxO (used as reference input) */
  umDatumUtxo: UTxO;
  /** User's wallet address (must match vault.owner) */
  userAddress: string;
}

export interface InstantGenResult {
  /** The built but not yet signed/submitted transaction */
  tx: Tx;
  /** Expected MAGIC amount in nanogic */
  expectedMagicNanogic: bigint;
  /** UM value used (after stale check) */
  umUsedQ: bigint;
  /** Current epoch at time of building */
  currentEpoch: bigint;
  /** Whether UM fallback was applied due to staleness */
  umFallbackApplied: boolean;
  /** Estimated LAMP balance after tx */
  newLampBalance: bigint;
  /** Human-readable summary */
  summary: string;
}

// ── Lucid setup ───────────────────────────────────────────────

/** Create a Lucid instance connected to Preview testnet. */
export async function createLucid(blockfrostApiKey: string): Promise<LucidEvolution> {
  return Lucid(
    new Blockfrost(TESTNET_CONFIG.blockfrostUrl, blockfrostApiKey),
    TESTNET_CONFIG.network,
  );
}

// ── Main builder ─────────────────────────────────────────────

/**
 * Build an InstantGen transaction.
 *
 * Flow:
 *  1. Validate params (C-INST-1,2,3)
 *  2. Read UM datum → apply C-UM-6 stale check
 *  3. Compute expected M (C-INST-5)
 *  4. Apply lazy halving to existing Instant batches (C-DECAY-7)
 *  5. Prune expired batches (C-PRUNE-1) — AFTER halving (C-PRUNE-2)
 *  6. Create new Instant batch (C-INST-6)
 *  7. Build tx: vault update + Treasury LAMP transfer
 *  8. Return unsigned tx for signing
 */
export async function buildInstantGenTx(
  params: InstantGenParams,
): Promise<InstantGenResult> {
  const { lucid, vaultUtxo, lampPaidOil, umDatumUtxo, userAddress } = params;

  // ── Decode vault datum ───────────────────────────────────────
  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);

  // ── Decode UM datum ──────────────────────────────────────────
  const umDatum = Data.from(umDatumUtxo.datum!, UMDatumSchema);

  // ── Get current slot / epoch ─────────────────────────────────
  const { slot: currentSlot } = await lucid.provider.getProtocolParameters();
  // Use tip slot — adjust as needed based on your Blockfrost version
  const tipSlot = await getTipSlot(lucid);
  const currentEpoch = slotToEpoch(BigInt(tipSlot));

  // ── C-INST-1: MIN purchase ───────────────────────────────────
  if (lampPaidOil < MIN_INSTANT_PURCHASE) {
    throw new Error(
      `GEN-INST-001: lamp_paid ${lampPaidOil} < MIN ${MIN_INSTANT_PURCHASE} oil (10 LAMP)`,
    );
  }

  // ── C-INST-2: MAX purchase ───────────────────────────────────
  if (lampPaidOil > MAX_INSTANT_PURCHASE) {
    throw new Error(
      `GEN-INST-002: lamp_paid ${lampPaidOil} > MAX ${MAX_INSTANT_PURCHASE} oil`,
    );
  }

  // ── C-INST-3: lamp_paid ≤ L_avail ───────────────────────────
  const lAvail = vaultDatum.lamp_balance - vaultDatum.lamp_locked;
  if (lampPaidOil > lAvail) {
    throw new Error(
      `GEN-INST-003: lamp_paid ${lampPaidOil} > L_avail ${lAvail} oil. ` +
      `lamp_locked=${vaultDatum.lamp_locked}`,
    );
  }

  // ── C-INST-7: batch count ────────────────────────────────────
  const activeBatches = vaultDatum.magic_batches.filter(
    (b) => !isExpired(b.created_epoch, b.decay_window, currentEpoch),
  );
  if (activeBatches.length >= MAX_BATCHES_PER_VAULT) {
    throw new Error(
      `GEN-VAULT-001: |batches|=${activeBatches.length} ≥ ${MAX_BATCHES_PER_VAULT}. Burn some first.`,
    );
  }

  // ── C-UM-6: Stale check ──────────────────────────────────────
  const umUsedQ = getUmForInstant(umDatum, currentEpoch);
  const umFallbackApplied = umUsedQ !== umDatum.smoothed_q;

  // ── C-INST-5: Compute expected M ─────────────────────────────
  const pmQ = PM_Q[vaultDatum.profile];
  if (!pmQ) throw new Error(`Unknown profile: ${vaultDatum.profile}`);
  const expectedMagic = computeInstantMagic(lampPaidOil, umUsedQ, pmQ);

  // ── C-PRUNE-2: Halve BEFORE prune ────────────────────────────
  const halvingApplied: string[] = [];
  const halvedBatches: MagicBatch[] = vaultDatum.magic_batches.map((b) => {
    if (shouldHalve(b.source, b.created_epoch, currentEpoch, b.halved)) {
      halvingApplied.push(b.batch_id.slice(0, 8) + "...");
      return { ...b, current_amount: applyHalving(b.current_amount), halved: true };
    }
    return b;
  });

  // ── C-PRUNE-1: Prune expired ─────────────────────────────────
  const prunedBatches = halvedBatches.filter(
    (b) => !isExpired(b.created_epoch, b.decay_window, currentEpoch),
  );

  // ── Create new Instant batch (C-INST-6) ──────────────────────
  const newBatchId = computeBatchId(vaultUtxo, vaultDatum.next_batch_index);
  const newBatch: MagicBatch = {
    batch_id:            newBatchId,
    source:              "Instant",
    created_epoch:       currentEpoch,
    initial_amount:      expectedMagic,
    current_amount:      expectedMagic,
    decay_window:        INSTANT_DECAY_WINDOW,
    profile_at_creation: null,   // C-DECAY-4: None for Instant
    contract_id:         null,
    halved:              false,   // C-INST-6 + T22
  };

  const updatedBatches = [...prunedBatches, newBatch];

  // ── Remove lamp_paid from loyalty holdings ───────────────────
  const updatedHoldings = removeFromHoldings(vaultDatum.loyalty_holdings, lampPaidOil);
  const newLampBalance = vaultDatum.lamp_balance - lampPaidOil;

  // ── Update attribution hash (C-ATT-1, C-ATT-2) ──────────────
  const newAttribution = updateAttribution(vaultDatum.attribution, {
    type: "BatchCreated",
    source: "Instant",
    epoch: currentEpoch,
  });

  // ── Build updated VaultDatum (A02: field-by-field) ────────────
  const newVaultDatum: VaultDatum = {
    ...vaultDatum,
    lamp_balance:      newLampBalance,
    loyalty_holdings:  updatedHoldings,
    magic_batches:     updatedBatches,
    next_batch_index:  vaultDatum.next_batch_index + 1n,
    last_updated_epoch: currentEpoch,
    attribution:       newAttribution,
  };

  // ── Build transaction ─────────────────────────────────────────
  const vaultScriptAddress = lucid.utils.validatorToAddress({
    type:   "PlutusV3",
    script: TESTNET_CONFIG.vaultScriptHash,
  });

  const redeemer = Data.to(
    { InstantGen: { lamp_paid: lampPaidOil } },
    VaultRedeemerSchema,
  );

  const lampUnit = toUnit(TESTNET_CONFIG.lampPolicyId, TESTNET_CONFIG.lampAssetName);

  // Validity range: constrain tx to current epoch only (one epoch slot range)
  const epochStartSlot = Number(currentEpoch * 432_000n);
  const epochEndSlot   = epochStartSlot + 432_000 - 1;

  const tx = await lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .readFrom([umDatumUtxo])        // UM datum as reference input (not spent)
    .pay.ToAddressWithData(
      vaultScriptAddress,
      { kind: "inline", value: Data.to(newVaultDatum, VaultDatumSchema) },
      {
        lovelace:  vaultUtxo.assets.lovelace,   // ADA stays on vault
        [lampUnit]: vaultDatum.lamp_balance - lampPaidOil, // remaining LAMP on vault
      },
    )
    .pay.ToAddress(
      TESTNET_CONFIG.treasuryAddress,
      { [lampUnit]: lampPaidOil },              // C-INST-4: LAMP → Treasury
    )
    .addSignerKey(vaultDatum.owner)             // User must sign (C-PC-V1)
    .validFrom(epochStartSlot)
    .validTo(epochEndSlot)
    .complete();

  const summary = buildSummary({
    lampPaidOil,
    expectedMagic,
    umUsedQ,
    umFallbackApplied,
    currentEpoch,
    halvingApplied,
    prunedCount: vaultDatum.magic_batches.length - prunedBatches.length,
    newBatchCount: updatedBatches.length,
    newLampBalance,
  });

  return {
    tx,
    expectedMagicNanogic: expectedMagic,
    umUsedQ,
    currentEpoch,
    umFallbackApplied,
    newLampBalance,
    summary,
  };
}

// ── Submit helper ────────────────────────────────────────────

/** Sign (with user's wallet) and submit the tx. Returns tx hash. */
export async function signAndSubmit(
  lucid : LucidEvolution,
  tx    : Tx,
): Promise<string> {
  const signedTx = await tx.sign.withWallet().complete();
  return signedTx.submit();
}

// ── Utility: compute batch_id ─────────────────────────────────
//
// batch_id = blake2b256(vault_utxo_ref ∥ encode(next_batch_index))
// MUST match onchain/validators/vault.ak: compute_batch_id
// (P8: bit-identical across implementations)

function computeBatchId(vaultUtxo: UTxO, nextBatchIndex: bigint): string {
  const txHash = Buffer.from(vaultUtxo.txHash, "hex");
  const outputIndex = Buffer.alloc(8);
  outputIndex.writeBigUInt64BE(BigInt(vaultUtxo.outputIndex));
  const indexBytes = Buffer.alloc(8);
  indexBytes.writeBigUInt64BE(nextBatchIndex);

  const preimage = Buffer.concat([txHash, outputIndex, indexBytes]);
  const hash = blake2b(preimage, { dkLen: 32 });
  return Buffer.from(hash).toString("hex");
}

// ── Utility: remove LAMP from holdings ───────────────────────
//
// For InstantGen: remove lamp_paid from UNLOCKED holdings, oldest-first.
// This is deterministic (P8) and preserves newer (higher LF) holdings.
// Must match onchain/lib/lamp.ak: remove_from_holdings

function removeFromHoldings(
  holdings : LoyaltyHolding[],
  amount   : bigint,
): LoyaltyHolding[] {
  const locked   = holdings.filter((h) =>  h.is_locked);
  const unlocked = holdings.filter((h) => !h.is_locked);

  // Sort oldest-first for removal
  const sorted = [...unlocked].sort((a, b) =>
    Number(a.acquired_epoch - b.acquired_epoch),
  );

  let remaining = amount;
  const resultUnlocked: LoyaltyHolding[] = [];

  for (const h of sorted) {
    if (remaining <= 0n) {
      resultUnlocked.push(h);
    } else if (remaining >= h.amount) {
      remaining -= h.amount; // fully consumed
    } else {
      resultUnlocked.push({ ...h, amount: h.amount - remaining });
      remaining = 0n;
    }
  }

  if (remaining > 0n) {
    throw new Error(`GEN-INST-003: holdings insufficient (remaining=${remaining})`);
  }

  return [...locked, ...resultUnlocked];
}

// ── Utility: update attribution hash chain ────────────────────
//
// new_root = blake2b256(old_root ∥ encode(event)) — §7.2

function updateAttribution(
  attr  : VaultDatum["attribution"],
  event : { type: string; source: string; epoch: bigint },
): VaultDatum["attribution"] {
  const oldRoot  = Buffer.from(attr.attribution_root, "hex");
  const eventEnc = Buffer.from(JSON.stringify(event));
  const preimage = Buffer.concat([oldRoot, eventEnc]);
  const newRoot  = Buffer.from(blake2b(preimage, { dkLen: 32 })).toString("hex");

  return {
    attribution_root: newRoot,
    last_event_epoch: event.epoch,
    total_events:     attr.total_events + 1n,
  };
}

// ── Utility: get current tip slot from Blockfrost ────────────

async function getTipSlot(lucid: LucidEvolution): Promise<number> {
  // Blockfrost-compatible: get current tip
  try {
    const tip = await (lucid.provider as any).getBlock("latest");
    return tip.slot ?? 0;
  } catch {
    // Fallback: use current time-based estimate for Preview testnet
    // Preview testnet started at UNIX 1666656000 (approx Oct 2022)
    const nowSec = Math.floor(Date.now() / 1000);
    const previewStart = 1666656000;
    return Math.max(0, nowSec - previewStart);
  }
}

// ── Human-readable summary ────────────────────────────────────

function buildSummary(params: {
  lampPaidOil      : bigint;
  expectedMagic    : bigint;
  umUsedQ          : bigint;
  umFallbackApplied: boolean;
  currentEpoch     : bigint;
  halvingApplied   : string[];
  prunedCount      : number;
  newBatchCount    : number;
  newLampBalance   : bigint;
}): string {
  const lines = [
    `═══ InstantGen Summary ═══`,
    `Epoch:         ${params.currentEpoch}`,
    `LAMP paid:     ${params.lampPaidOil / 1_000_000n} tLAMP (${params.lampPaidOil} oil)`,
    `UM used:       ${qToStr(params.umUsedQ)}× ${params.umFallbackApplied ? "⚠ FALLBACK (stale UM — keeper not updated)" : "✓"}`,
    `MAGIC minted:  ${nanogicToMagicStr(params.expectedMagic)} MAGIC (${params.expectedMagic} nanogic)`,
    `Batch lifetime: 2 epochs (k=0: full, k=1: halved, k≥2: expired)`,
    ``,
    `Changes:`,
    `  Batches halved:  ${params.halvingApplied.length > 0 ? params.halvingApplied.join(", ") : "none"}`,
    `  Batches pruned:  ${params.prunedCount}`,
    `  Active batches:  ${params.newBatchCount} (incl. new)`,
    `  New LAMP balance: ${params.newLampBalance / 1_000_000n} tLAMP`,
    ``,
    params.umFallbackApplied
      ? `⚠  UM was stale (staleness > 1 epoch). Used UM_FALLBACK=0.5×. Submit after keeper updates UM for better rate.`
      : `✓  UM fresh. Full UM=${qToStr(params.umUsedQ)}× applied.`,
  ];
  return lines.join("\n");
}
