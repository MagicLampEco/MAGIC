// src/schedule.ts — ScheduleGen: Commit + Fire transaction builders
// Forward contract: rate locked at commit; permissionless fire with catch-up.

import {
  Lucid, Blockfrost, Data, toUnit,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  type LucidEvolution, type UTxO, type Tx, type Validator,
} from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";
import {
  TESTNET_CONFIG, SCHEDULE_DELAY, SCHEDULE_DECAY_WINDOW,
  MAX_FIRES_PER_TX_CATCHUP, MAX_GEN_SCHEDULES, MAX_BATCHES_PER_VAULT,
  SCHEDULE_MIN_LENGTH, SCHEDULE_MAX_LENGTH, MIN_LAMP_PER_FIRE, SHARD_CAP,
  SNAPSHOT_BASE_RATE_Q,
} from "./constants.js";
import {
  computeSQ, computeRateLockedQ, computeMi, checkSchRate,
  computeShardId, nextFireEpoch, countEligibleFires,
  selectLampForLock, unlockLockedAmount, isExpired, lAvail,
  lampToOil, nanogicToMagicStr, qToStr,
} from "./math.js";
import { getTipSlot, posixMsToEpoch, msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import { slotToUnixTime } from "@lucid-evolution/lucid";
import {
  VaultDatumSchema, VaultRedeemerSchema, ShardRedeemerSchema,
  type VaultDatum, type GenSchedule, type MagicBatch, type LoyaltyHolding,
} from "./types.js";

// ── Shard datum schema ────────────────────────────────────────
import { Data as D } from "@lucid-evolution/lucid";
const ShardDatumSchema = D.Object({
  shard_id:                    D.Integer(),
  shard_locked_lamp:            D.Integer(),
  shard_active_count:           D.Integer(),
  shard_cumulative_committed:   D.Integer(),
  shard_cumulative_fired:       D.Integer(),
  last_updated_epoch:           D.Integer(),
  shard_cap:                    D.Integer(),
});
type ShardDatum = D.Static<typeof ShardDatumSchema>;

// ── Types ─────────────────────────────────────────────────────

export interface CommitParams {
  lucid           : LucidEvolution;
  vaultUtxo       : UTxO;
  shardUtxos      : UTxO[];    // all 16 shard UTxOs (builder finds the right one)
  scheduleLength  : bigint;    // L ∈ [10,200]
  lampPerEpoch    : bigint;    // λ in oil
  userAddress     : string;
  /** Compiled vault validator (3 params: lamp_policy_id, shard_policy_id, ms_per_epoch).
   *  `treasury_addr` was REMOVED in PHA 2 — no handler moves LAMP any more (I-ACT-7). */
  vaultScript     : Validator;
  /** Compiled shard validator (0 params). */
  shardScript     : Validator;
  lampPolicyId    : string;
  lampAssetName?  : string;
  network?        : Network;
  tipPosixMs?     : bigint;
  tamperOutputDatum?: (d: any) => any;
  skipOwnerSig?   : boolean;
}

export interface CommitResult {
  tx              : Tx;
  scheduleId      : string;
  rateLockedQ     : bigint;
  mPerFire        : bigint;
  totalMagic      : bigint;
  totalLampLocked : bigint;
  firstFireEpoch  : bigint;
  lastFireEpoch   : bigint;
  summary         : string;
}

export interface FireParams {
  lucid           : LucidEvolution;
  vaultUtxo       : UTxO;
  shardUtxos      : UTxO[];
  scheduleId      : string;
  // No userAddress — permissionless (C-SCH-FIRE-PERMISSION)
  vaultScript     : Validator;
  shardScript     : Validator;
  lampPolicyId    : string;
  lampAssetName?  : string;
  network?        : Network;
  tipPosixMs?     : bigint;
  tamperOutputDatum?: (d: any) => any;
  /** TEST ONLY: move LAMP out of the vault to prove I-ACT-7 rejects it. */
  tamperLampOutOil?: bigint;
}

export interface FireResult {
  tx             : Tx;
  firesInTx      : number;
  mPerFire       : bigint;
  totalMagicFired: bigint;
  /** LAMP RELEASED from the locked pool — it stays in the vault (I-ACT-7). */
  lampReleased   : bigint;
  scheduleComplete: boolean;
  summary        : string;
}

// ── Lucid setup ───────────────────────────────────────────────
export async function createLucid(apiKey: string): Promise<LucidEvolution> {
  return Lucid(new Blockfrost(TESTNET_CONFIG.blockfrostUrl, apiKey), TESTNET_CONFIG.network);
}

// ══════════════════════════════════════════════════════════════
// Phase 1: buildScheduleCommitTx
// ══════════════════════════════════════════════════════════════
export async function buildScheduleCommitTx(params: CommitParams): Promise<CommitResult> {
  const { lucid, vaultUtxo, shardUtxos, scheduleLength: L, lampPerEpoch: lambda } = params;
  const network = params.network ?? TESTNET_CONFIG.network;

  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  const tipPosixMs = params.tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(lucid, network)));
  const commitEpoch = posixMsToEpoch(tipPosixMs, network);

  // ── Validations ──────────────────────────────────────────
  if (L < SCHEDULE_MIN_LENGTH || L > SCHEDULE_MAX_LENGTH)
    throw new Error(`GEN-SCH-001: L=${L} ∉ [10,200]`);
  if (lambda < MIN_LAMP_PER_FIRE)
    throw new Error(`GEN-SCH-002: λ=${lambda} < MIN=1 LAMP`);

  const totalLock = L * lambda;
  const avail = lAvail(vaultDatum.lamp_balance, vaultDatum.lamp_locked);
  if (totalLock > avail)
    throw new Error(`GEN-SCH-003: L×λ=${totalLock} > L_avail=${avail}`);

  if (vaultDatum.gen_schedules.length >= MAX_GEN_SCHEDULES)
    throw new Error(`GEN-SCH-005: ${vaultDatum.gen_schedules.length} schedules ≥ MAX=20`);

  // ── Compute rate_locked_q (T8: immutable from here) ──────
  const sQ          = computeSQ(L);
  const rateLockedQ = computeRateLockedQ(SNAPSHOT_BASE_RATE_Q, L);
  const mPerFire    = computeMi(lambda, rateLockedQ);

  // C-SCH-RATE / T19: M_i ≥ 1
  if (!checkSchRate(lambda, rateLockedQ))
    throw new Error(`GEN-SCH-004: C-SCH-RATE fail — M_i would be 0. Increase λ or R_snap.`);

  // ── Shard check (C-SCH-CAP) ───────────────────────────────
  const shardId  = computeShardId(vaultDatum.owner);
  const shardUtxo = shardUtxos.find(u => {
    const d = Data.from(u.datum!, ShardDatumSchema);
    return Number(d.shard_id) === shardId;
  });
  if (!shardUtxo) throw new Error(`Shard UTxO not found for shard_id=${shardId}`);
  const shardDatum = Data.from(shardUtxo.datum!, ShardDatumSchema);

  if (shardDatum.shard_locked_lamp + totalLock > SHARD_CAP)
    throw new Error(`GEN-SCH-006: Shard cap exceeded. shard_locked=${shardDatum.shard_locked_lamp}, adding=${totalLock}, cap=${SHARD_CAP}`);

  // ── Build schedule ─────────────────────────────────────────
  const scheduleId     = computeScheduleId(vaultUtxo, vaultDatum.gen_schedules.length);
  const startFireEpoch = commitEpoch + SCHEDULE_DELAY;
  const endFireEpoch   = commitEpoch + L + 1n;

  const newSchedule: GenSchedule = {
    schedule_id:              scheduleId,
    commit_epoch:             commitEpoch,
    start_fire_epoch:         startFireEpoch,
    end_fire_epoch:           endFireEpoch,
    schedule_length:          L,
    lamp_per_epoch:           lambda,
    rate_locked_q:            rateLockedQ,        // T8: immutable
    baseline_at_commit_q:     SNAPSHOT_BASE_RATE_Q,
    multiplier_at_commit_q:   sQ,
    fired_count:              0n,
    auto_burn_target:         null,
  };

  // Lock youngest holdings (C-SCH-8, T5)
  const newHoldings = selectLampForLock(vaultDatum.loyalty_holdings, totalLock);

  // Updated vault datum (A02: field-by-field)
  let newVaultDatum: VaultDatum = {
    ...vaultDatum,
    lamp_locked:       vaultDatum.lamp_locked + totalLock,
    loyalty_holdings:  newHoldings,
    gen_schedules:     [...vaultDatum.gen_schedules, newSchedule],
    last_updated_epoch: commitEpoch,
  };
  if (params.tamperOutputDatum) newVaultDatum = params.tamperOutputDatum(newVaultDatum);

  // Updated shard datum (C-SCH-AGG)
  const newShardDatum: ShardDatum = {
    ...shardDatum,
    shard_locked_lamp:          shardDatum.shard_locked_lamp + totalLock,
    shard_active_count:         shardDatum.shard_active_count + 1n,
    shard_cumulative_committed: shardDatum.shard_cumulative_committed + totalLock,
    last_updated_epoch:         commitEpoch,
  };

  // Build tx
  const { vaultScript, shardScript } = params;
  const vaultAddr = credentialToAddress(network, scriptHashToCredential(validatorToScriptHash(vaultScript)));
  const shardAddr = credentialToAddress(network, scriptHashToCredential(validatorToScriptHash(shardScript)));
  const redeemer  = Data.to({ ScheduleCommit: { schedule_length: L, lamp_per_epoch: lambda } }, VaultRedeemerSchema);
  const shardRed  = Data.to({ ShardUpdateCommit: { delta_locked: totalLock, delta_committed: totalLock } }, ShardRedeemerSchema);
  const lowerTime = Number(tipPosixMs);
  const upperTime = Number((commitEpoch + 1n) * msPerEpoch(network) - 1n);

  let txBuilder = lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .collectFrom([shardUtxo], shardRed)
    .attach.SpendingValidator(vaultScript)
    .attach.SpendingValidator(shardScript)
    .pay.ToAddressWithData(vaultAddr, { kind: "inline", value: Data.to(newVaultDatum, VaultDatumSchema) }, vaultUtxo.assets)
    .pay.ToAddressWithData(shardAddr, { kind: "inline", value: Data.to(newShardDatum, ShardDatumSchema) }, shardUtxo.assets)
    .validFrom(lowerTime)
    .validTo(upperTime);
  if (!params.skipOwnerSig) txBuilder = txBuilder.addSignerKey(vaultDatum.owner);
  const tx = await txBuilder.complete();

  const summary = [
    `═══ ScheduleGen Commit ═══`,
    `Commit epoch:    ${commitEpoch}`,
    `Schedule length: ${L} orders (~${Number(L) * 5} days)`,
    `λ per fire:      ${lambda / 1_000_000n} tLAMP (${lambda} oil)`,
    `Total locked:    ${totalLock / 1_000_000n} tLAMP`,
    `rate_locked_q:   ${rateLockedQ} (immutable forever — T8)`,
    `M_i per fire:    ${nanogicToMagicStr(mPerFire)} MAGIC`,
    `Total MAGIC:     ${nanogicToMagicStr(mPerFire * L)} MAGIC (guaranteed)`,
    `First fire:      epoch ${startFireEpoch} (~${Number(SCHEDULE_DELAY * 5n)} days)`,
    `Last fire:       epoch ${endFireEpoch}`,
    `S_Q(${L}):       ${qToStr(sQ)}×`,
    `Schedule ID:     ${scheduleId.slice(0, 16)}...`,
    `Shard:           ${shardId} of 16`,
    ``,
    `✓  Rate locked at current R_snap. DAO changes won't affect this contract.`,
    `⚠  Cannot cancel (T10). Fire is permissionless from epoch ${startFireEpoch}.`,
  ].join("\n");

  return {
    tx, scheduleId, rateLockedQ, mPerFire, totalMagic: mPerFire * L,
    totalLampLocked: totalLock, firstFireEpoch: startFireEpoch,
    lastFireEpoch: endFireEpoch, summary,
  };
}

// ══════════════════════════════════════════════════════════════
// Phase 2: buildScheduleFireTx — PERMISSIONLESS (C-SCH-FIRE-PERMISSION)
// ══════════════════════════════════════════════════════════════
export async function buildScheduleFireTx(params: FireParams): Promise<FireResult> {
  const { lucid, vaultUtxo, shardUtxos, scheduleId } = params;
  const network = params.network ?? TESTNET_CONFIG.network;

  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  const tipPosixMs = params.tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(lucid, network)));
  const currentEpoch = posixMsToEpoch(tipPosixMs, network);

  const sched = vaultDatum.gen_schedules.find(s => s.schedule_id === scheduleId);
  if (!sched) throw new Error(`Schedule ${scheduleId} not found`);

  // C-FIRE-1 ≥: count eligible fires (catch-up)
  const firesInTx = countEligibleFires(
    sched.start_fire_epoch, sched.fired_count,
    sched.schedule_length, currentEpoch,
    vaultDatum.magic_batches.length,
  );
  if (firesInTx === 0)
    throw new Error(`No eligible fires: next fire at epoch ${nextFireEpoch(sched.start_fire_epoch, sched.fired_count)}, current=${currentEpoch}`);

  // M_i — reads STORED rate_locked_q (T8: immutable)
  const mI = computeMi(sched.lamp_per_epoch, sched.rate_locked_q);
  // PHA 2 / I-ACT-7: LAMP is RELEASED from the locked pool, not transferred.
  const lampReleased = sched.lamp_per_epoch * BigInt(firesInTx);

  // Create batches (one per fire). Every batch — including catch-up ones — is
  // stamped with the CURRENT epoch and lives exactly this epoch (§4.2 cliff),
  // so a catch-up can never resurrect MAGIC missed in earlier epochs.
  const newBatches: MagicBatch[] = Array.from({ length: firesInTx }, (_, i) => ({
    batch_id:            computeBatchId(vaultUtxo, vaultDatum.next_batch_index + BigInt(i)),
    source:              "Schedule" as const,
    created_epoch:       currentEpoch,
    initial_amount:      mI,
    current_amount:      mI,
    decay_window:        SCHEDULE_DECAY_WINDOW,   // 1 (cliff)
    profile_at_creation: null,
    contract_id:         scheduleId,
    halved:              false,
  }));

  // §4.2: collect DEAD batches on the way out.
  const liveBatches = vaultDatum.magic_batches.filter(
    b => !isExpired(b.created_epoch, b.decay_window, currentEpoch),
  );
  const updatedBatches = [...liveBatches, ...newBatches];
  if (updatedBatches.length > MAX_BATCHES_PER_VAULT)
    throw new Error(`GEN-VAULT-001: would exceed 32 batches`);

  // Update or remove schedule (C-FIRE-5)
  const newFiredCount  = sched.fired_count + BigInt(firesInTx);
  const schedComplete  = newFiredCount === sched.schedule_length;
  const updatedSchedules = schedComplete
    ? vaultDatum.gen_schedules.filter(s => s.schedule_id !== scheduleId)
    : vaultDatum.gen_schedules.map(s =>
        s.schedule_id === scheduleId ? { ...s, fired_count: newFiredCount } : s
      );

  // C-FIRE-6 (PHA 2): RELEASE the lock. Holdings keep their amount and epoch,
  // only `is_locked` flips → Σholdings, lamp_balance and the LAMP inside the
  // UTxO are all invariant (I-ACT-7).
  const newHoldings    = unlockLockedAmount(vaultDatum.loyalty_holdings, lampReleased);
  const newLampBalance = vaultDatum.lamp_balance;                    // UNCHANGED
  const newLampLocked  = vaultDatum.lamp_locked - lampReleased;

  // Updated vault datum (A02)
  let newVaultDatum: VaultDatum = {
    ...vaultDatum,
    lamp_balance:       newLampBalance,
    lamp_locked:        newLampLocked,
    loyalty_holdings:   newHoldings,
    magic_batches:      updatedBatches,
    next_batch_index:   vaultDatum.next_batch_index + BigInt(firesInTx),
    gen_schedules:      updatedSchedules,
    last_updated_epoch: currentEpoch,
  };
  if (params.tamperOutputDatum) newVaultDatum = params.tamperOutputDatum(newVaultDatum);

  // C-SCH-FIRE-SHARD: find and update the correct shard (A19)
  const shardId = computeShardId(vaultDatum.owner);
  const shardUtxo = shardUtxos.find(u => {
    const d = Data.from(u.datum!, ShardDatumSchema);
    return Number(d.shard_id) === shardId;
  });
  if (!shardUtxo) throw new Error(`GEN-SCH-008: Shard ${shardId} not found`);
  const shardDatum = Data.from(shardUtxo.datum!, ShardDatumSchema);

  const newShardDatum: ShardDatum = {
    ...shardDatum,
    shard_locked_lamp:      shardDatum.shard_locked_lamp - lampReleased,
    shard_cumulative_fired: shardDatum.shard_cumulative_fired + lampReleased,
    shard_active_count:     schedComplete ? shardDatum.shard_active_count - 1n : shardDatum.shard_active_count,
    last_updated_epoch:     currentEpoch,
  };

  // Build tx
  const { vaultScript, shardScript, lampPolicyId } = params;
  const lampAssetName = params.lampAssetName ?? TESTNET_CONFIG.lampAssetName;
  const vaultAddr  = credentialToAddress(network, scriptHashToCredential(validatorToScriptHash(vaultScript)));
  const shardAddr  = credentialToAddress(network, scriptHashToCredential(validatorToScriptHash(shardScript)));
  const lampUnit   = toUnit(lampPolicyId, lampAssetName);
  const redeemer   = Data.to({ ScheduleFire: { schedule_id: scheduleId } }, VaultRedeemerSchema);
  const shardRed   = Data.to({ ShardUpdateFire: { fires_in_tx: BigInt(firesInTx), lambda: sched.lamp_per_epoch } }, ShardRedeemerSchema);
  const lowerTime  = Number(tipPosixMs);
  const upperTime  = Number((currentEpoch + 1n) * msPerEpoch(network) - 1n);

  const tx = await lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .collectFrom([shardUtxo], shardRed)
    .attach.SpendingValidator(vaultScript)
    .attach.SpendingValidator(shardScript)
    // I-ACT-7: the vault output carries EXACTLY the LAMP it came in with.
    .pay.ToAddressWithData(vaultAddr, { kind: "inline", value: Data.to(newVaultDatum, VaultDatumSchema) },
      { lovelace: vaultUtxo.assets.lovelace,
        [lampUnit]: newLampBalance - (params.tamperLampOutOil ?? 0n) })
    .pay.ToAddressWithData(shardAddr, { kind: "inline", value: Data.to(newShardDatum, ShardDatumSchema) }, shardUtxo.assets)
    // NO Treasury output — a fire moves no LAMP anywhere.
    // C-SCH-FIRE-PERMISSION: NO .addSignerKey() — permissionless
    .validFrom(lowerTime)
    .validTo(upperTime)
    .complete();

  const summary = [
    `═══ ScheduleGen Fire ═══`,
    `Epoch:          ${currentEpoch}`,
    `Fires in tx:    ${firesInTx} (of ${Number(sched.schedule_length - sched.fired_count)} remaining)`,
    `M_i per fire:   ${nanogicToMagicStr(mI)} MAGIC (rate_locked at commit — T8)`,
    `Total MAGIC:    ${nanogicToMagicStr(mI * BigInt(firesInTx))} MAGIC`,
    `LAMP released:  ${lampReleased / 1_000_000n} tLAMP unlocked — stays in the vault (I-ACT-7)`,
    `Progress:       ${Number(newFiredCount)}/${Number(sched.schedule_length)} orders`,
    `Schedule:       ${schedComplete ? "✅ COMPLETE — removed" : `⏳ ${Number(sched.schedule_length - newFiredCount)} orders remaining`}`,
    `Shard:          ${shardId} (C-SCH-FIRE-SHARD ✓)`,
    ``,
    firesInTx > 1 ? `ℹ  Catch-up: ${firesInTx} missed epochs processed in 1 tx (C-FIRE-1 ≥).` : "",
    `Note: This tx required NO owner signature (C-SCH-FIRE-PERMISSION).`,
  ].filter(Boolean).join("\n");

  return { tx, firesInTx, mPerFire: mI, totalMagicFired: mI * BigInt(firesInTx), lampReleased, scheduleComplete: schedComplete, summary };
}

// ── Submit ────────────────────────────────────────────────────
export async function signAndSubmit(lucid: LucidEvolution, tx: Tx): Promise<string> {
  return (await tx.sign.withWallet().complete()).submit();
}

// ── Utilities ────────────────────────────────────────────────
function computeScheduleId(vaultUtxo: UTxO, schedIndex: number): string {
  return h(vaultUtxo, BigInt(schedIndex));
}
function computeBatchId(vaultUtxo: UTxO, idx: bigint): string {
  return h(vaultUtxo, idx);
}
function h(utxo: UTxO, idx: bigint): string {
  const pre = Buffer.concat([Buffer.from(utxo.txHash, "hex"), u64(BigInt(utxo.outputIndex)), u64(idx)]);
  return Buffer.from(blake2b(pre, { dkLen: 32 })).toString("hex");
}
function u64(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; }

// getTipSlot moved to @magiclamp/protocol-utils — network-aware fallback (P8).
