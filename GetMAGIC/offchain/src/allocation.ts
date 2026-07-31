// src/allocation.ts — Allocation claim transactions and queries for GetMAGIC
// Phase 1: claims mark epoch in claimed_epochs. No BurnBatch integration yet.

import {
  type LucidEvolution,
  type UTxO,
  type TxSignBuilder,
  Data,
  Constr,
  validatorToAddress,
} from "@lucid-evolution/lucid";

import {
  AllocationDatumSchema,
  AllocationRedeemerSchema,
  MAGIC_ALLOCATION_HASH,
  type AllocationDatum,
  type AllocationRedeemer,
} from "./types.js";

// 0.4.34 removed `lucid.utils.*`; network must be read from the instance config.
function requireNetwork(lucid: LucidEvolution) {
  const network = lucid.config().network;
  if (network === undefined) {
    throw new Error("LucidEvolution instance has no network configured");
  }
  return network;
}

// ── ClaimEpoch ────────────────────────────────────────────────

export interface ClaimEpochParams {
  lucid:           LucidEvolution;
  allocationUtxo:  UTxO;
  epoch:           bigint;
  umRef?:          UTxO;  // optional UMKeeper reference (Phase 2)
}

/**
 * Build a transaction that claims MAGIC rights for one epoch.
 *
 * Phase 1: adds `epoch` to claimed_epochs in the continuing AllocationDatum.
 * The validator verifies the oracle voucher and beneficiary signature.
 *
 * The caller must attach their signing key via lucid.selectWallet* before calling.
 */
export async function buildClaimEpochTx(
  params: ClaimEpochParams,
): Promise<TxSignBuilder> {
  const { lucid, allocationUtxo, epoch, umRef } = params;

  const datum = Data.from<AllocationDatum>(
    allocationUtxo.datum ?? (() => { throw new Error("AllocationDatum UTxO has no inline datum"); })(),
    AllocationDatumSchema as unknown as AllocationDatum,
  );

  // Build updated datum with epoch added to claimed_epochs (sorted ascending).
  const newClaimedEpochs = [...datum.claimed_epochs, epoch].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );

  const updatedDatum: AllocationDatum = {
    ...datum,
    claimed_epochs: newClaimedEpochs,
  };

  const updatedDatumCbor = Data.to<AllocationDatum>(updatedDatum, AllocationDatumSchema as unknown as AllocationDatum);

  // um_ref field in Aiken is `Data` (opaque OutputReference placeholder for Phase 2).
  // Phase 1: pass a unit/void-equivalent Plutus Data (Constr 0 []).
  const umRefData = new Constr(0, []);

  const redeemer = Data.to<AllocationRedeemer>(
    {
      ClaimEpoch: {
        epoch,
        um_ref: umRefData,
      },
    },
    AllocationRedeemerSchema as unknown as AllocationRedeemer,
  );

  const allocAddress = validatorToAddress(requireNetwork(lucid), {
    type:   "PlutusV3",
    script: MAGIC_ALLOCATION_HASH,
  });

  const txBuilder = lucid
    .newTx()
    .collectFrom([allocationUtxo], redeemer)
    .pay.ToAddressWithData(
      allocAddress,
      { kind: "inline", value: updatedDatumCbor },
      allocationUtxo.assets,
    )
    .addSigner(datum.beneficiary_pkh);

  // Add UMKeeper as read-only reference input if provided (Phase 2 prep)
  if (umRef !== undefined) {
    txBuilder.readFrom([umRef]);
  }

  const tx = await txBuilder.complete();
  return tx;
}

// ── Query allocations ─────────────────────────────────────────

/**
 * Query all AllocationDatum UTxOs for a given beneficiary payment key hash.
 * Scans all UTxOs at the magic_allocation script address.
 */
export async function getAllocationsForUser(
  lucid:   LucidEvolution,
  userPkh: string,
): Promise<AllocationDatum[]> {
  const allocAddress = validatorToAddress(requireNetwork(lucid), {
    type:   "PlutusV3",
    script: MAGIC_ALLOCATION_HASH,
  });

  const utxos = await lucid.utxosAt(allocAddress);

  const results: AllocationDatum[] = [];
  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    try {
      const datum = Data.from<AllocationDatum>(utxo.datum, AllocationDatumSchema as unknown as AllocationDatum);
      if (datum.beneficiary_pkh === userPkh) {
        results.push(datum);
      }
    } catch {
      // Skip UTxOs with unreadable datums
    }
  }
  return results;
}

// ── Claimable epoch computation ───────────────────────────────

/**
 * Return the list of epochs that can still be claimed.
 *
 * An epoch is claimable when:
 *   - it is in [start_epoch, expiry_epoch)
 *   - it has not yet been claimed
 *   - it is ≤ currentEpoch (can only claim past/current epochs, not future ones)
 */
export function getClaimableEpochs(
  alloc:        AllocationDatum,
  currentEpoch: bigint,
): bigint[] {
  const { start_epoch, expiry_epoch, claimed_epochs } = alloc;
  const claimedSet = new Set(claimed_epochs.map(String));

  const result: bigint[] = [];
  for (let e = start_epoch; e < expiry_epoch && e <= currentEpoch; e++) {
    if (!claimedSet.has(String(e))) {
      result.push(e);
    }
  }
  return result;
}
