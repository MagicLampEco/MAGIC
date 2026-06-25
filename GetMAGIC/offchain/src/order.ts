// src/order.ts — OTC Order transaction builders for GetMAGIC
// Builds Cardano transactions for creating, settling, and expiring OTC orders.

import {
  type LucidEvolution,
  type UTxO,
  type TxSignBuilder,
  Data,
  toHex,
  fromText,
  validatorToAddress,
} from "@lucid-evolution/lucid";

import {
  OrderDatumSchema,
  OrderRedeemerSchema,
  AllocationDatumSchema,
  MAGIC_ALLOCATION_HASH,
  ORDER_EXPIRY_MS,
  type OrderDatum,
  type OrderRedeemer,
  type AllocationDatum,
} from "./types.js";

// 0.4.34 removed `lucid.utils.*`; network must be read from the instance config.
function requireNetwork(lucid: LucidEvolution) {
  const network = lucid.config().network;
  if (network === undefined) {
    throw new Error("LucidEvolution instance has no network configured");
  }
  return network;
}

// ── CreateOrder ───────────────────────────────────────────────

export interface CreateOrderParams {
  lucid:           LucidEvolution;
  orgPkh:          string;          // hex 28 bytes
  userPkh:         string;          // hex 28 bytes
  userStakeKey?:   string;          // hex credential hash (optional)
  magicPerEpoch:   bigint;          // nanogic
  totalEpochs:     bigint;
  fiatAmountVnd:   bigint;
  oracleVkey:      string;          // hex 32 bytes
  orderId:         string;          // hex-encoded 16-char ASCII order ID
  /**
   * Applied OTC order validator (PlutusV3 CBOR), parameterized with the deployed
   * magic_allocation script hash (alloc_hash). Produced at deploy time by
   * scripts/deploy/08_deploy_getmagic.ts. REQUIRED — see the Phase-1 guard below.
   */
  orderScript?:    { type: "PlutusV3"; script: string };
}

/**
 * Build a transaction that places an OrderDatum UTxO on-chain.
 * Called by VeData after matching user with Org.
 *
 * The UTxO holds a minimal ADA lovelace deposit at the OTC Order script address.
 * The order expires after ORDER_EXPIRY_MS (4 hours).
 *
 * ⚠️ Phase-1 known-limit (KL-3, see GetMAGIC/TECH.md): the OTC order script is
 * parameterized by the deployed alloc_hash and MUST be applied at deploy time.
 * This builder therefore REQUIRES `params.orderScript`; without it the call
 * throws rather than silently placing the order at the wrong address.
 */
export async function buildCreateOrderTx(
  params: CreateOrderParams,
): Promise<TxSignBuilder> {
  const {
    lucid, orgPkh, userPkh, userStakeKey,
    magicPerEpoch, totalEpochs, fiatAmountVnd,
    oracleVkey, orderId, orderScript,
  } = params;

  // ── Phase-1 isolation guard (PR #20 review item 2) ──────────────────────────
  // The previous implementation derived the order address from MAGIC_ALLOCATION_HASH
  // — that is the ALLOCATION script address, NOT the OTC order address. Placing an
  // order deposit there would lock it at the wrong script (the allocation validator
  // has no Expire/Cancel path for an OrderDatum). The correct order address comes
  // from the order validator applied with the real alloc_hash at deploy time. Refuse
  // to build until that applied script is supplied.
  if (orderScript === undefined) {
    throw new Error(
      "GETMAGIC-ORDER-PHASE2: buildCreateOrderTx requires params.orderScript — the " +
      "OTC order validator applied with the deployed alloc_hash (see " +
      "scripts/deploy/08_deploy_getmagic.ts). It is NOT yet wired in Phase 1. The " +
      "MAGIC_ALLOCATION_HASH placeholder is the allocation script, not the order " +
      "script; building against it would lock the deposit at the wrong address.",
    );
  }

  const createdPosixMs = BigInt(Date.now());
  const expiryPosixMs  = createdPosixMs + BigInt(ORDER_EXPIRY_MS);

  const userStakeCred = userStakeKey
    ? { VerificationKey: { hash: userStakeKey } }
    : null;

  const datum: OrderDatum = {
    order_id:         orderId,
    org_pkh:          orgPkh,
    user_pkh:         userPkh,
    user_stake_cred:  userStakeCred,
    magic_per_epoch:  magicPerEpoch,
    total_epochs:     totalEpochs,
    fiat_amount_vnd:  fiatAmountVnd,
    created_posix_ms: createdPosixMs,
    expiry_posix_ms:  expiryPosixMs,
    oracle_vkey:      oracleVkey,
  };

  const datumCbor = Data.to<OrderDatum>(datum, OrderDatumSchema as unknown as OrderDatum);

  // Derive OTC Order script address from the applied order validator (parameterized
  // with the deployed alloc_hash). Guarded above: orderScript is guaranteed defined.
  const scriptAddress = validatorToAddress(requireNetwork(lucid), orderScript);

  const tx = await lucid
    .newTx()
    .pay.ToAddressWithData(
      scriptAddress,
      { kind: "inline", value: datumCbor },
      { lovelace: 2_000_000n }, // min ADA deposit
    )
    .complete();

  return tx;
}

// ── SettleOrder ───────────────────────────────────────────────

export interface SettleOrderParams {
  lucid:               LucidEvolution;
  orderUtxo:           UTxO;
  oracleNonce:         string;    // hex 32 bytes
  oracleTimestamp:     bigint;    // Unix ms
  oracleSignature:     string;    // hex 64 bytes
  epochVouchers:       string[];  // hex 64-byte sigs, one per epoch
  allocId:             string;    // hex 32 bytes
  orgVaultNftPolicy:   string;    // hex policy ID
  currentEpoch:        bigint;
}

/**
 * Build a transaction that settles an OTC order.
 * Consumes the OrderDatum UTxO and produces an AllocationDatum UTxO
 * at the magic_allocation script address.
 */
export async function buildSettleOrderTx(
  params: SettleOrderParams,
): Promise<TxSignBuilder> {
  const {
    lucid, orderUtxo, oracleNonce, oracleTimestamp,
    oracleSignature, epochVouchers, allocId,
    orgVaultNftPolicy, currentEpoch,
  } = params;

  // Decode existing OrderDatum
  const orderDatum = Data.from<OrderDatum>(
    orderUtxo.datum ?? (() => { throw new Error("OrderDatum UTxO has no inline datum"); })(),
    OrderDatumSchema as unknown as OrderDatum,
  );

  const expiryEpoch = currentEpoch + orderDatum.total_epochs;

  const allocDatum: AllocationDatum = {
    alloc_id:             allocId,
    order_id:             orderDatum.order_id,
    org_pkh:              orderDatum.org_pkh,
    org_vault_nft_policy: orgVaultNftPolicy,
    beneficiary_pkh:      orderDatum.user_pkh,
    beneficiary_stake:    orderDatum.user_stake_cred,
    magic_per_epoch:      orderDatum.magic_per_epoch,
    total_epochs:         orderDatum.total_epochs,
    claimed_epochs:       [],
    start_epoch:          currentEpoch,
    expiry_epoch:         expiryEpoch,
    vouchers:             epochVouchers,
    oracle_vkey:          orderDatum.oracle_vkey,
  };

  const allocDatumCbor = Data.to<AllocationDatum>(allocDatum, AllocationDatumSchema as unknown as AllocationDatum);

  const redeemer = Data.to<OrderRedeemer>(
    {
      Settle: {
        oracle_nonce:     oracleNonce,
        oracle_timestamp: oracleTimestamp,
        oracle_signature: oracleSignature,
        epoch_vouchers:   epochVouchers,
      },
    },
    OrderRedeemerSchema as unknown as OrderRedeemer,
  );

  const allocAddress = validatorToAddress(requireNetwork(lucid), {
    type:   "PlutusV3",
    script: MAGIC_ALLOCATION_HASH,
  });

  const nowMs  = BigInt(Date.now());
  const validTo = nowMs + BigInt(3_600_000); // +1h validity window

  const tx = await lucid
    .newTx()
    .collectFrom([orderUtxo], redeemer)
    .pay.ToAddressWithData(
      allocAddress,
      { kind: "inline", value: allocDatumCbor },
      { lovelace: 2_000_000n },
    )
    .validFrom(Number(nowMs))
    .validTo(Number(validTo))
    .complete();

  return tx;
}

// ── ExpireOrder ───────────────────────────────────────────────

export interface ExpireOrderParams {
  lucid:      LucidEvolution;
  orderUtxo:  UTxO;
}

/**
 * Build a transaction that expires an OTC order after the 4-hour timeout.
 * Sweeps the ADA deposit back to the caller.
 */
export async function buildExpireOrderTx(
  params: ExpireOrderParams,
): Promise<TxSignBuilder> {
  const { lucid, orderUtxo } = params;

  const orderDatum = Data.from<OrderDatum>(
    orderUtxo.datum ?? (() => { throw new Error("OrderDatum UTxO has no inline datum"); })(),
    OrderDatumSchema as unknown as OrderDatum,
  );

  const redeemer = Data.to<OrderRedeemer>("Expire", OrderRedeemerSchema as unknown as OrderRedeemer);

  const expiryMs = orderDatum.expiry_posix_ms;

  const tx = await lucid
    .newTx()
    .collectFrom([orderUtxo], redeemer)
    .validFrom(Number(expiryMs))
    .complete();

  return tx;
}
