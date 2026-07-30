// src/instant.ts — InstantGen transaction builder (§6.3)
//
// PHA 2 model:
//   • LAMP NEVER MOVES (I-ACT-7). There is no Treasury output; `lamp_balance`,
//     `lamp_locked` and `loyalty_holdings` are byte-identical across the tx.
//     Holding LAMP only opens eligibility.
//   • The grant is keyed to MAGIC ALREADY CONSUMED:
//       grant = min( reward(consumed), cap_surplus(br), 0.5 × pp_schedule )
//     `consumed` = activity_state.consumed_credit, zeroed by this tx.
//   • The new batch is a 1-epoch cliff (§4.2) and dead batches are collected.
//
// Uses Lucid Evolution (https://github.com/Anastasia-Labs/lucid-evolution).

import {
  Lucid, Blockfrost, Data, toUnit,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  type LucidEvolution, type UTxO, type Tx, type Validator,
} from "@lucid-evolution/lucid";
import {
  TESTNET_CONFIG, MAX_BATCHES_PER_VAULT, MAGIC_DECAY_WINDOW,
  MIN_INSTANT_HOLDING, MAX_BACKING_STALE, PM_Q,
} from "./constants.js";
import {
  computeInstantGrant, getUmForInstant, isExpired,
  nanogicToMagicStr, qToStr,
} from "./math.js";
import { getTipSlot, posixMsToEpoch, msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import { slotToUnixTime } from "@lucid-evolution/lucid";
import {
  VaultDatumSchema, UMDatumSchema, BackingBeaconDatumSchema, VaultRedeemerSchema,
  type VaultDatum, type MagicBatch,
} from "./types.js";
import { blake2b } from "@noble/hashes/blake2b";

// ── Types ─────────────────────────────────────────────────────

export interface InstantGenParams {
  /** Lucid instance connected to Preview testnet */
  lucid: LucidEvolution;
  /** The vault UTxO to spend */
  vaultUtxo: UTxO;
  /** UM datum UTxO (used as reference input) */
  umDatumUtxo: UTxO;
  /**
   * BackingBeacon UTxO (reference input, §6.3).  [CẦN XÁC NHẬN — chờ CARP]
   * REQUIRED: without it the validator cannot evaluate cap_surplus and the tx
   * is rejected. That is deliberate — the Gen door is shut rather than opened
   * on an invented `br`.
   */
  backingBeaconUtxo: UTxO;
  /** User's wallet address (must match vault.owner) */
  userAddress: string;
  /** Compiled vault validator with all 6 params already applied per-network
   *  (lamp_policy_id, um_nft_policy, um_script_hash, backing_nft_policy,
   *  backing_script_hash, ms_per_epoch). Required to spend the vault UTxO. */
  vaultScript: Validator;
  /** LAMP policy id (hex) — must match `lamp_policy_id` param applied to validator. */
  lampPolicyId: string;
  /** LAMP asset name (hex). Defaults to TESTNET_CONFIG.lampAssetName. */
  lampAssetName?: string;
  /** Network — picks ms_per_epoch for POSIX-based epoch math (must match validator). */
  network?: Network;
  /** Optional tip POSIX ms. If omitted, derived from `getTipSlot(lucid, network)`. */
  tipPosixMs?: bigint;
  /** TEST ONLY: mutate output datum (negative tests). */
  tamperOutputDatum?: (d: any) => any;
  /** TEST ONLY: skip required-signer for owner-sig negative test. */
  skipOwnerSig?: boolean;
  /** TEST ONLY: send LAMP out of the vault to prove I-ACT-7 rejects it. */
  tamperLampOutOil?: bigint;
}

export interface InstantGenResult {
  /** The built but not yet signed/submitted transaction */
  tx: Tx;
  /** Granted MAGIC in nanogic (= redeemer `claimed_amount`) */
  grantNanogic: bigint;
  /** consumed_credit consumed by this tx (zeroed afterwards) */
  consumedCreditSpent: bigint;
  /** The three ceilings, for diagnostics */
  ceilings: { reward: bigint; capSurplus: bigint; capPp: bigint };
  /** UM value used (after stale check) */
  umUsedQ: bigint;
  /** Current epoch at time of building */
  currentEpoch: bigint;
  /** Whether UM fallback was applied due to staleness */
  umFallbackApplied: boolean;
  /** LAMP balance after tx — ALWAYS equal to the balance before (I-ACT-7). */
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
 *  1. eligibility — LAMP sits in the vault, unencumbered (C-INST-1 / C-INST-3)
 *  2. read UM datum → C-UM-6 stale check
 *  3. read BackingBeacon → depeg + staleness (fail-closed)
 *  4. grant = min(reward(consumed), cap_surplus, 0.5×pp) (C-INST-5)
 *  5. collect dead batches (§4.2 cliff) and append the new one
 *  6. build tx: vault→vault only, LAMP untouched
 */
export async function buildInstantGenTx(
  params: InstantGenParams,
): Promise<InstantGenResult> {
  const {
    lucid, vaultUtxo, umDatumUtxo, backingBeaconUtxo,
    vaultScript, lampPolicyId,
  } = params;
  const network = params.network ?? TESTNET_CONFIG.network;
  const lampAssetName = params.lampAssetName ?? TESTNET_CONFIG.lampAssetName;

  // ── Decode datums ────────────────────────────────────────────
  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  const umDatum    = Data.from(umDatumUtxo.datum!, UMDatumSchema);
  const backing    = Data.from(backingBeaconUtxo.datum!, BackingBeaconDatumSchema);

  // ── Get current epoch (POSIX-ms-based, matches Aiken validator) ──
  const tipPosixMs = params.tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(lucid, network)));
  const currentEpoch = posixMsToEpoch(tipPosixMs, network);

  // ── C-INST-1: LAMP must SIT in the vault (eligibility only) ──
  if (vaultDatum.lamp_balance < MIN_INSTANT_HOLDING) {
    throw new Error(
      `GEN-INST-001: lamp_balance ${vaultDatum.lamp_balance} < MIN_INSTANT_HOLDING ` +
      `${MIN_INSTANT_HOLDING} oildrop (10 LAMP). Holding LAMP opens the door; it is never spent.`,
    );
  }

  // ── C-INST-3: the eligible LAMP must be unencumbered ────────
  const lAvail = vaultDatum.lamp_balance - vaultDatum.lamp_locked;
  if (lAvail < MIN_INSTANT_HOLDING) {
    throw new Error(
      `GEN-INST-003: L_avail ${lAvail} < MIN_INSTANT_HOLDING ${MIN_INSTANT_HOLDING} oildrop. ` +
      `lamp_locked=${vaultDatum.lamp_locked} — locked LAMP does not buy eligibility.`,
    );
  }

  // ── §4.2 cliff: keep only LIVE batches ───────────────────────
  const liveBatches = vaultDatum.magic_batches.filter(
    (b) => !isExpired(b.created_epoch, b.decay_window, currentEpoch),
  );
  const prunedCount = vaultDatum.magic_batches.length - liveBatches.length;

  // ── C-INST-7: batch budget ───────────────────────────────────
  if (liveBatches.length >= MAX_BATCHES_PER_VAULT) {
    throw new Error(
      `GEN-VAULT-001: |live batches|=${liveBatches.length} ≥ ${MAX_BATCHES_PER_VAULT}. Burn some first.`,
    );
  }

  // ── C-UM-6: stale check ──────────────────────────────────────
  const umUsedQ = getUmForInstant(umDatum, currentEpoch);
  const umFallbackApplied = umUsedQ !== umDatum.smoothed_q;

  // ── §6.3 backing gate — FAIL-CLOSED ─────────────────────────
  if (backing.depeg) {
    throw new Error(
      `GEN-INST-006: BackingBeacon reports depeg → cap_surplus = 0. Gen is shut.`,
    );
  }
  const backingAge = currentEpoch - backing.last_updated_epoch;
  if (backingAge < 0n || backingAge > MAX_BACKING_STALE) {
    throw new Error(
      `GEN-INST-007: BackingBeacon stale (age=${backingAge} > ${MAX_BACKING_STALE}). ` +
      `A stale beacon counts as ABSENT — no default br is ever substituted.`,
    );
  }

  // ── C-INST-5: the §6.3 grant ─────────────────────────────────
  const pmQ = PM_Q[vaultDatum.profile];
  if (!pmQ) throw new Error(`Unknown profile: ${vaultDatum.profile}`);

  const consumed = vaultDatum.activity_state.consumed_credit;
  const grant = computeInstantGrant(
    consumed, umUsedQ, pmQ, backing.br_q, backing.magic_supply, vaultDatum.gen_schedules,
  );
  const ceilings = diagnoseCeilings(vaultDatum, consumed, umUsedQ, pmQ, backing);

  if (grant <= 0n) {
    throw new Error(
      `GEN-INST-005: grant = 0 → nothing to mint. ` +
      `reward=${ceilings.reward} cap_surplus=${ceilings.capSurplus} cap_pp=${ceilings.capPp} ` +
      `(consumed_credit=${consumed}). InstantGen only pays out against MAGIC actually consumed, ` +
      `and never above 0.5 × the committed ScheduleGen flow.`,
    );
  }

  // ── New batch for THIS epoch (§4.2 cliff) ────────────────────
  const newBatchId = computeBatchId(vaultUtxo, vaultDatum.next_batch_index);
  const newBatch: MagicBatch = {
    batch_id:            newBatchId,
    source:              "Instant",
    created_epoch:       currentEpoch,
    initial_amount:      grant,
    current_amount:      grant,
    decay_window:        MAGIC_DECAY_WINDOW,   // 1 — dies next epoch
    profile_at_creation: null,                 // C-DECAY-4: None for Instant
    contract_id:         null,
    halved:              false,                // dead field, always false
  };

  const updatedBatches = [...liveBatches, newBatch];

  // ── Update attribution hash (C-ATT-1, C-ATT-2) ──────────────
  const newAttribution = updateAttribution(vaultDatum.attribution, {
    type: "BatchCreated",
    source: "Instant",
    epoch: currentEpoch,
  });

  // ── Build updated VaultDatum (A02: field-by-field) ────────────
  // I-ACT-7: lamp_balance / lamp_locked / loyalty_holdings are copied verbatim.
  const newVaultDatum: VaultDatum = {
    ...vaultDatum,
    magic_batches:      updatedBatches,
    next_batch_index:   vaultDatum.next_batch_index + 1n,
    last_updated_epoch: currentEpoch,
    // INV-CASHBACK-BOUND: the credit is SPENT, never reusable.
    activity_state:     { ...vaultDatum.activity_state, consumed_credit: 0n },
    attribution:        newAttribution,
  };

  // ── Build transaction ─────────────────────────────────────────
  const vaultScriptAddress = credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(vaultScript)),
  );

  // TEST ONLY: mutate output datum if tamper provided
  if (params.tamperOutputDatum) {
    Object.assign(newVaultDatum, params.tamperOutputDatum(newVaultDatum));
  }

  const redeemer = Data.to(
    { InstantGen: { claimed_amount: grant } },
    VaultRedeemerSchema,
  );

  const lampUnit = toUnit(lampPolicyId, lampAssetName);

  // Validity range: lower bound = current tip POSIX ms; upper = end of POSIX-epoch.
  const lowerTime = Number(tipPosixMs);
  const upperTime = Number((currentEpoch + 1n) * msPerEpoch(network) - 1n);

  // I-ACT-7: the vault output carries EXACTLY the LAMP it came in with.
  const lampOut = vaultDatum.lamp_balance - (params.tamperLampOutOil ?? 0n);

  let txBuilder = lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .attach.SpendingValidator(vaultScript)
    .readFrom([umDatumUtxo, backingBeaconUtxo])   // reference inputs (not spent)
    .pay.ToAddressWithData(
      vaultScriptAddress,
      { kind: "inline", value: Data.to(newVaultDatum, VaultDatumSchema) },
      {
        lovelace:  vaultUtxo.assets.lovelace,   // ADA stays on vault
        [lampUnit]: lampOut,                     // LAMP stays on vault (I-ACT-7)
      },
    )
    .validFrom(lowerTime)
    .validTo(upperTime);

  if (!params.skipOwnerSig) txBuilder = txBuilder.addSignerKey(vaultDatum.owner);
  const tx = await txBuilder.complete();

  const summary = buildSummary({
    grant,
    consumed,
    ceilings,
    umUsedQ,
    umFallbackApplied,
    currentEpoch,
    prunedCount,
    newBatchCount: updatedBatches.length,
    lampBalance: vaultDatum.lamp_balance,
  });

  return {
    tx,
    grantNanogic: grant,
    consumedCreditSpent: consumed,
    ceilings,
    umUsedQ,
    currentEpoch,
    umFallbackApplied,
    newLampBalance: vaultDatum.lamp_balance,   // unchanged by construction
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

// ── Diagnostics: the three ceilings separately ───────────────

import { computeRewardFromConsumed, computeCapSurplus, computeCapPp } from "./math.js";
import type { BackingBeaconDatum } from "./types.js";

export function diagnoseCeilings(
  vaultDatum: VaultDatum,
  consumed  : bigint,
  umQ       : bigint,
  pmQ       : bigint,
  backing   : BackingBeaconDatum,
): { reward: bigint; capSurplus: bigint; capPp: bigint } {
  return {
    reward:     computeRewardFromConsumed(consumed, umQ, pmQ),
    capSurplus: computeCapSurplus(backing.br_q, backing.magic_supply),
    capPp:      computeCapPp(vaultDatum.gen_schedules),
  };
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

// ── Utility: update attribution hash chain ────────────────────
//
// new_root = blake2b256(old_root ∥ encode(event)) — §7.2

function updateAttribution(
  attr  : VaultDatum["attribution"],
  event : { type: string; source: string; epoch: bigint },
): VaultDatum["attribution"] {
  const oldRoot  = Buffer.from(attr.attribution_root, "hex");
  const eventEnc = Buffer.from(JSON.stringify({ ...event, epoch: event.epoch.toString() }));
  const preimage = Buffer.concat([oldRoot, eventEnc]);
  const newRoot  = Buffer.from(blake2b(preimage, { dkLen: 32 })).toString("hex");

  return {
    attribution_root: newRoot,
    last_event_epoch: event.epoch,
    total_events:     attr.total_events + 1n,
  };
}

// ── Human-readable summary ────────────────────────────────────

function buildSummary(params: {
  grant            : bigint;
  consumed         : bigint;
  ceilings         : { reward: bigint; capSurplus: bigint; capPp: bigint };
  umUsedQ          : bigint;
  umFallbackApplied: boolean;
  currentEpoch     : bigint;
  prunedCount      : number;
  newBatchCount    : number;
  lampBalance      : bigint;
}): string {
  const binding =
    params.grant === params.ceilings.reward ? "reward(consumed)"
    : params.grant === params.ceilings.capSurplus ? "cap_surplus(br)"
    : "0.5 × pp_schedule";

  const lines = [
    `═══ InstantGen Summary ═══`,
    `Epoch:            ${params.currentEpoch}`,
    `LAMP in vault:    ${params.lampBalance / 1_000_000n} tLAMP — UNCHANGED (I-ACT-7)`,
    `MAGIC consumed:   ${nanogicToMagicStr(params.consumed)} MAGIC (credit spent by this tx)`,
    `UM used:          ${qToStr(params.umUsedQ)}× ${params.umFallbackApplied ? "⚠ FALLBACK (stale UM — keeper not updated)" : "✓"}`,
    ``,
    `Ceilings (min wins):`,
    `  reward(consumed): ${nanogicToMagicStr(params.ceilings.reward)}`,
    `  cap_surplus(br):  ${nanogicToMagicStr(params.ceilings.capSurplus)}`,
    `  0.5 × pp_sched:   ${nanogicToMagicStr(params.ceilings.capPp)}`,
    `  → GRANTED:        ${nanogicToMagicStr(params.grant)} MAGIC (bound by ${binding})`,
    ``,
    `Batch lifetime:   1 epoch (§4.2 use-or-lose — spend it this epoch or lose it)`,
    `  Dead batches collected: ${params.prunedCount}`,
    `  Live batches after tx:  ${params.newBatchCount} (incl. new)`,
    ``,
    params.umFallbackApplied
      ? `⚠  UM was stale (staleness > 1 epoch). Used UM_FALLBACK=0.5×. Submit after the keeper updates UM for a better rate.`
      : `✓  UM fresh. Full UM=${qToStr(params.umUsedQ)}× applied.`,
  ];
  return lines.join("\n");
}
