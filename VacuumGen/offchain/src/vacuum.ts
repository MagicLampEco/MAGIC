// src/vacuum.ts — VacuumGen: Commit + Fire transaction builders
// Two-phase protocol: Commit (user) → Fire (permissionless, 2 epochs later)

import {
  Lucid, Blockfrost, Data, toUnit,
  type LucidEvolution, type UTxO, type Tx,
} from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";
import {
  TESTNET_CONFIG, MIN_VACUUM_AMOUNT, MAX_VACUUM_ORDERS,
  VACUUM_DELAY, VACUUM_DECAY_WINDOW, MAX_BATCHES_PER_VAULT,
} from "./constants.js";
import {
  computeVacuumMagic, getUmForVacuum, computeSmQ,
  selectLampForLock, removeLockedAmount,
  isVacuumExpired, slotToEpoch, lampToOil, lAvail,
  nanogicToMagicStr, qToStr,
} from "./math.js";
import { getTipSlot } from "@magiclamp/protocol-utils";
import {
  VaultDatumSchema, UMDatumSchema, VaultRedeemerSchema,
  type VaultDatum, type UMDatum, type MagicBatch,
  type VacuumOrder, type LoyaltyHolding,
} from "./types.js";

// ── Types ─────────────────────────────────────────────────────

export interface CommitParams {
  lucid        : LucidEvolution;
  vaultUtxo    : UTxO;
  lambdaOil    : bigint;   // oil to lock (1 LAMP = 10^6 oil, min 10^6)
  userAddress  : string;
}

export interface CommitResult {
  tx           : Tx;
  orderId      : string;
  fireEpoch    : bigint;
  commitEpoch  : bigint;
  lambdaOil    : bigint;
  summary      : string;
}

export interface FireParams {
  lucid        : LucidEvolution;
  vaultUtxo    : UTxO;
  orderId      : string;
  umDatumUtxo  : UTxO;
  // No userAddress — fire is permissionless (C-VAC-FIRE-PERMISSION)
}

export interface FireResult {
  tx             : Tx;
  mGenerated     : bigint;
  batchCreated   : boolean;   // false = vault full (C-VAC-FIRE-FULL-VAULT)
  umUsedQ        : bigint;
  smUsedQ        : bigint;
  prunedCount    : number;
  summary        : string;
}

// ── Lucid setup ───────────────────────────────────────────────
export async function createLucid(blockfrostApiKey: string): Promise<LucidEvolution> {
  return Lucid(new Blockfrost(TESTNET_CONFIG.blockfrostUrl, blockfrostApiKey), TESTNET_CONFIG.network);
}

// ══════════════════════════════════════════════════════════════
// Phase 1: buildVacuumCommitTx
// ══════════════════════════════════════════════════════════════
export async function buildVacuumCommitTx(params: CommitParams): Promise<CommitResult> {
  const { lucid, vaultUtxo, lambdaOil } = params;
  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);

  const tipSlot     = await getTipSlot(lucid);
  const commitEpoch = slotToEpoch(BigInt(tipSlot));
  const fireEpoch   = commitEpoch + VACUUM_DELAY;  // C-VAC-4: = commit + 2

  // ── C-VAC-3: λ ≥ 1 LAMP ──────────────────────────────────
  if (lambdaOil < MIN_VACUUM_AMOUNT)
    throw new Error(`GEN-VAC-002: λ=${lambdaOil} < MIN=${MIN_VACUUM_AMOUNT} (1 LAMP)`);

  // ── C-VAC-2: λ ≤ L_avail ─────────────────────────────────
  const avail = lAvail(vaultDatum.lamp_balance, vaultDatum.lamp_locked);
  if (lambdaOil > avail)
    throw new Error(`GEN-VAC-001: λ=${lambdaOil} > L_avail=${avail}`);

  // ── C-VAC-5: |orders| < 10 ───────────────────────────────
  if (vaultDatum.vacuum_orders.length >= MAX_VACUUM_ORDERS)
    throw new Error(`GEN-VAC-003: ${vaultDatum.vacuum_orders.length} orders ≥ MAX=${MAX_VACUUM_ORDERS}`);

  // Build order ID
  const orderId = computeOrderId(vaultUtxo, commitEpoch, lambdaOil);

  const newOrder: VacuumOrder = {
    order_id:     orderId,
    commit_epoch: commitEpoch,
    fire_epoch:   fireEpoch,
    lamp_amount:  lambdaOil,
  };

  // Lock youngest holdings (T5, §6.8)
  const newHoldings = selectLampForLock(vaultDatum.loyalty_holdings, lambdaOil);

  // Build updated datum (A02)
  const newVaultDatum: VaultDatum = {
    ...vaultDatum,
    lamp_locked:      vaultDatum.lamp_locked + lambdaOil,
    loyalty_holdings: newHoldings,
    vacuum_orders:    [...vaultDatum.vacuum_orders, newOrder],
    last_updated_epoch: commitEpoch,
  };

  const vaultAddr = lucid.utils.validatorToAddress({ type: "PlutusV3", script: TESTNET_CONFIG.vaultScriptHash });
  const redeemer  = Data.to({ VacuumCommit: { lambda: lambdaOil } }, VaultRedeemerSchema);
  const epochStart = Number(commitEpoch * 432_000n);

  const tx = await lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .pay.ToAddressWithData(
      vaultAddr,
      { kind: "inline", value: Data.to(newVaultDatum, VaultDatumSchema) },
      vaultUtxo.assets,   // LAMP stays on vault (no transfer yet)
    )
    .addSignerKey(vaultDatum.owner)     // C-VAC-1: user signs
    .validFrom(epochStart)
    .validTo(epochStart + 432_000 - 1)
    .complete();

  const summary = [
    `═══ VacuumGen Commit ═══`,
    `Commit epoch:  ${commitEpoch}`,
    `Fire epoch:    ${fireEpoch} (~${Number(VACUUM_DELAY * 5n)} days from now)`,
    `λ locked:      ${lambdaOil / 1_000_000n} tLAMP (${lambdaOil} oil)`,
    `Order ID:      ${orderId.slice(0, 16)}...`,
    ``,
    `✓  LAMP locked. Fire tx can be triggered by ANYONE at epoch ${fireEpoch}.`,
    `⚠  Cannot cancel (C-VAC-12). LAMP will transfer to Treasury at fire.`,
  ].join("\n");

  return { tx, orderId, fireEpoch, commitEpoch, lambdaOil, summary };
}

// ══════════════════════════════════════════════════════════════
// Phase 2: buildVacuumFireTx — PERMISSIONLESS
// ══════════════════════════════════════════════════════════════
export async function buildVacuumFireTx(params: FireParams): Promise<FireResult> {
  const { lucid, vaultUtxo, orderId, umDatumUtxo } = params;

  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  const umDatum    = Data.from(umDatumUtxo.datum!, UMDatumSchema);

  const tipSlot     = await getTipSlot(lucid);
  const currentEpoch = slotToEpoch(BigInt(tipSlot));

  // Find the order
  const order = vaultDatum.vacuum_orders.find(o => o.order_id === orderId);
  if (!order) throw new Error(`Order ${orderId} not found in vault`);

  // ── C-VAC-6: EXACT epoch match ────────────────────────────
  if (currentEpoch !== order.fire_epoch)
    throw new Error(`GEN-VAC-004: current_epoch ${currentEpoch} ≠ fire_epoch ${order.fire_epoch}. Wait until epoch ${order.fire_epoch}.`);

  // ── C-UM-7: Always smoothed, no stale check ───────────────
  const umQ = getUmForVacuum(umDatum);

  // ── SM from streak ────────────────────────────────────────
  const smQ = computeSmQ(vaultDatum.streak_state);

  // ── C-VAC-PRUNE: Force prune BEFORE batch count check ─────
  const prunedBatches = vaultDatum.magic_batches.filter(
    b => !isVacuumExpired(b.created_epoch, currentEpoch),
  );
  const prunedCount = vaultDatum.magic_batches.length - prunedBatches.length;

  // ── C-VAC-FIRE-FULL-VAULT: vault full after prune? ────────
  let updatedBatches: MagicBatch[];
  let mGenerated = 0n;
  let batchCreated = false;

  if (prunedBatches.length < MAX_BATCHES_PER_VAULT) {
    mGenerated = computeVacuumMagic(order.lamp_amount, umQ, smQ);
    const newBatch: MagicBatch = {
      batch_id:            computeBatchId(vaultUtxo, vaultDatum.next_batch_index),
      source:              "Vacuum",
      created_epoch:       currentEpoch,
      initial_amount:      mGenerated,
      current_amount:      mGenerated,
      decay_window:        VACUUM_DECAY_WINDOW,   // 1 (cliff)
      profile_at_creation: null,
      contract_id:         null,
      halved:              false,
    };
    updatedBatches = [...prunedBatches, newBatch];
    batchCreated = true;
  } else {
    // C-VAC-FIRE-FULL-VAULT: M=0; LAMP still transfers (INV-43)
    updatedBatches = prunedBatches;
  }

  // Remove order + remove locked amount from holdings
  const remainingOrders = vaultDatum.vacuum_orders.filter(o => o.order_id !== orderId);
  const newHoldings     = removeLockedAmount(vaultDatum.loyalty_holdings, order.lamp_amount);
  const newLampBalance  = vaultDatum.lamp_balance - order.lamp_amount;
  const newLampLocked   = vaultDatum.lamp_locked  - order.lamp_amount;

  // Updated datum
  const newVaultDatum: VaultDatum = {
    ...vaultDatum,
    lamp_balance:       newLampBalance,
    lamp_locked:        newLampLocked,
    loyalty_holdings:   newHoldings,
    magic_batches:      updatedBatches,
    next_batch_index:   batchCreated ? vaultDatum.next_batch_index + 1n : vaultDatum.next_batch_index,
    vacuum_orders:      remainingOrders,
    last_updated_epoch: currentEpoch,
  };

  const vaultAddr  = lucid.utils.validatorToAddress({ type: "PlutusV3", script: TESTNET_CONFIG.vaultScriptHash });
  const lampUnit   = toUnit(TESTNET_CONFIG.lampPolicyId, TESTNET_CONFIG.lampAssetName);
  const redeemer   = Data.to({ VacuumFire: { order_id: orderId } }, VaultRedeemerSchema);
  const epochStart = Number(currentEpoch * 432_000n);

  const tx = await lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .readFrom([umDatumUtxo])        // C-UM-7: reference input (not spent)
    .pay.ToAddressWithData(
      vaultAddr,
      { kind: "inline", value: Data.to(newVaultDatum, VaultDatumSchema) },
      { lovelace: vaultUtxo.assets.lovelace, [lampUnit]: newLampBalance },
    )
    .pay.ToAddress(
      TESTNET_CONFIG.treasuryAddress,
      { [lampUnit]: order.lamp_amount },  // C-VAC-7/INV-43: ALWAYS transfer
    )
    // C-VAC-FIRE-PERMISSION: NO .addSignerKey() — permissionless!
    .validFrom(epochStart)
    .validTo(epochStart + 432_000 - 1)
    .complete();

  const summary = [
    `═══ VacuumGen Fire ═══`,
    `Epoch:          ${currentEpoch}`,
    `λ transferred:  ${order.lamp_amount / 1_000_000n} tLAMP → Treasury`,
    `UM used:        ${qToStr(umQ)}× (C-UM-7: always smoothed)`,
    `SM used:        ${qToStr(smQ)}× (streak=${vaultDatum.streak_state.current_streak})`,
    `MAGIC minted:   ${batchCreated ? nanogicToMagicStr(mGenerated) : "0 (vault full — C-VAC-FIRE-FULL-VAULT)"} MAGIC`,
    `Batches pruned: ${prunedCount}`,
    ``,
    batchCreated
      ? `✓  Batch created. Expires end of epoch ${currentEpoch} (cliff, §4.4).`
      : `⚠  Vault full after prune. LAMP transferred, no batch. Burn batches first.`,
    ``,
    `Note: This tx required NO owner signature (C-VAC-FIRE-PERMISSION).`,
  ].join("\n");

  return { tx, mGenerated, batchCreated, umUsedQ: umQ, smUsedQ: smQ, prunedCount, summary };
}

// ── Submit helper ────────────────────────────────────────────
export async function signAndSubmit(lucid: LucidEvolution, tx: Tx): Promise<string> {
  const signed = await tx.sign.withWallet().complete();
  return signed.submit();
}

// ── Utilities ────────────────────────────────────────────────
function computeBatchId(vaultUtxo: UTxO, idx: bigint): string {
  const pre = Buffer.concat([
    Buffer.from(vaultUtxo.txHash, "hex"),
    toU64(BigInt(vaultUtxo.outputIndex)),
    toU64(idx),
  ]);
  return Buffer.from(blake2b(pre, { dkLen: 32 })).toString("hex");
}

function computeOrderId(vaultUtxo: UTxO, epoch: bigint, lambda: bigint): string {
  const pre = Buffer.concat([
    Buffer.from(vaultUtxo.txHash, "hex"),
    toU64(BigInt(vaultUtxo.outputIndex)),
    toU64(epoch),
    toU64(lambda),
  ]);
  return Buffer.from(blake2b(pre, { dkLen: 32 })).toString("hex");
}

function toU64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}

// getTipSlot moved to @magiclamp/protocol-utils — network-aware fallback (P8).
