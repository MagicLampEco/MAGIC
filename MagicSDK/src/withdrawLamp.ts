// MagicSDK/src/withdrawLamp.ts — withdraw LAMP từ vault về ví user.
//
// LF-PRESERVING SELECTION: rút từ holding MỚI NHẤT (newest first).
// Lý do: LF (Loyalty Factor §6.3) là weighted-average tuổi holding × amount;
// giữ holding CŨ → LF cao → MAGIC sinh ra (Snapshot) nhiều. Rút newest-first
// = sacrifice 0 tuổi loyalty (vs rút oldest-first sẽ phá max LF user đã tích).
// Đây là pattern ngược của Instant subtractFromHoldings (oldest-first) — vì
// withdraw là discretionary, user nên được optimize cho retention.
//
// ⚠ ONCHAIN STATUS: validator chưa support redeemer này (Tuân v1.0 work).
// SDK code complete + tx builder pattern set — chỉ chờ validator merge.
// Submit tx này TRƯỚC khi onchain v1.0 deploy sẽ bị validator reject.

import {
  Data, toUnit,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  slotToUnixTime,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator,
} from "@lucid-evolution/lucid";
import {
  getTipSlot, posixMsToEpoch, msPerEpoch,
  cmpBigIntDesc,
  type Network,
} from "@magiclamp/protocol-utils";

import { VaultDatumSchema, type VaultDatum } from "./schemas.js";
import type { VaultType } from "./types.js";

/**
 * Redeemer enum index for `WithdrawLamp` per vault type. Must match Aiken
 * enum constructor order in each module's `types.ak`. Tuân finalizes these
 * during v1.0 onchain implementation — update here if order differs.
 */
const WITHDRAW_LAMP_TAG = "WithdrawLamp";

export interface WithdrawLampParams {
  lucid:           LucidEvolution;
  /** The vault UTxO to withdraw from. Use `listVaultsForOwner` to discover. */
  vaultUtxo:       UTxO;
  /** Amount to withdraw, in oil (1 LAMP = 10^6 oil). MUST be ≤ L_avail. */
  amountOil:       bigint;
  /** Applied vault validator (same one used at createVault). */
  vaultScript:     Validator;
  /** Vault type — picks the right validator redeemer enum. */
  vaultType:       VaultType;
  /** Network. */
  network:         Network;
  /** LAMP minting policy + asset name. */
  lampPolicyId:    string;
  lampAssetName?:  string;        // default "4c414d50" = "LAMP"
  /** Where the withdrawn LAMP goes. Default = wallet's own address. */
  destinationAddress?: string;
  /** Override tip POSIX ms for deterministic testing. */
  tipPosixMs?:     bigint;
}

export interface WithdrawLampResult {
  tx:              TxSignBuilder;
  amountWithdrawn: bigint;
  lampRemaining:   bigint;
  newVaultDatum:   VaultDatum;
  summary:         string;
}

const DEFAULT_LAMP_ASSET_NAME = "4c414d50";

/**
 * Build an unsigned tx that withdraws `amountOil` LAMP from `vaultUtxo`
 * back to `destinationAddress` (defaults to caller's wallet).
 *
 * Validation (mirrors what the validator must enforce):
 *   - Owner signs (`extra_signatories` contains `datum.owner`)
 *   - `amountOil > 0`
 *   - `amountOil ≤ L_avail = lamp_balance - lamp_locked`
 *   - Output vault datum:
 *       - lamp_balance -= amountOil
 *       - loyalty_holdings: NEWEST-FIRST removal (LF-preserving)
 *       - lamp_locked, magic_batches, vacuum_orders, gen_schedules: UNCHANGED
 *       - profile, profile_changed_epoch, pending_profile: UNCHANGED
 *       - delegation_cert, activity_state, streak_state: UNCHANGED
 *       - personal_delegate, attribution: UNCHANGED
 *       - last_updated_epoch: advanced to current epoch
 *   - Output: `amountOil` LAMP sent to `destinationAddress`
 *   - Vault output preserved at vault address with same lovelace
 */
export async function withdrawLamp(params: WithdrawLampParams): Promise<WithdrawLampResult> {
  const {
    lucid, vaultUtxo, amountOil, vaultScript, network,
    lampPolicyId,
  } = params;
  const lampAssetName = params.lampAssetName ?? DEFAULT_LAMP_ASSET_NAME;

  if (amountOil <= 0n) {
    throw new Error(`WITHDRAW-001: amountOil must be > 0 (got ${amountOil})`);
  }

  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);

  const lAvail = vaultDatum.lamp_balance - vaultDatum.lamp_locked;
  if (amountOil > lAvail) {
    throw new Error(
      `WITHDRAW-002: amount ${amountOil} > L_avail ${lAvail} ` +
      `(balance=${vaultDatum.lamp_balance}, locked=${vaultDatum.lamp_locked})`,
    );
  }

  // ── Current PROTOCOL epoch (POSIX-derived, matches validator) ────
  // Cast lucid → any: getTipSlot accepts `{provider: unknown}`; LucidEvolution
  // has `provider` at runtime but its type def doesn't expose it. Same cast
  // used across all MAGIC SDK builders (snapshot.ts, instant.ts, ...).
  const tipPosixMs = params.tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(lucid as never, network)));
  const currentEpoch = posixMsToEpoch(tipPosixMs, network);

  // ── Newest-first holding removal (LF-preserving) ────────────────
  const newHoldings = removeNewestFirst(
    vaultDatum.loyalty_holdings as { amount: bigint; acquired_epoch: bigint; is_locked: boolean }[],
    amountOil,
  );

  // ── Build updated VaultDatum (A02: field-by-field) ──────────────
  const newVaultDatum: VaultDatum = {
    ...vaultDatum,
    lamp_balance:       vaultDatum.lamp_balance - amountOil,
    loyalty_holdings:   newHoldings,
    last_updated_epoch: currentEpoch,
    // Everything else unchanged per A02.
  };

  // ── Addresses + units ───────────────────────────────────────────
  const vaultAddress = credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(vaultScript)),
  );
  const destination = params.destinationAddress ?? (await lucid.wallet().address());
  const lampUnit = toUnit(lampPolicyId, lampAssetName);

  // ── Build redeemer (Constr depends on vault type's enum index) ──
  // Tuân finalizes the Aiken enum order in v1.0 — keep as labeled object
  // here, Lucid Evolution maps via Data.to with the schema (TODO: add
  // schema). For now, encode via Constr index pattern matching existing
  // vault redeemer codes.
  const redeemer = encodeWithdrawLampRedeemer(params.vaultType, amountOil);

  // ── Vault output assets: same lovelace, reduced LAMP ────────────
  const remainingLamp = vaultDatum.lamp_balance - amountOil;
  const vaultOutputAssets: Record<string, bigint> = { lovelace: vaultUtxo.assets.lovelace };
  if (remainingLamp > 0n) vaultOutputAssets[lampUnit] = remainingLamp;
  // If remainingLamp == 0, the vault still exists (with min-ADA) but holds 0 LAMP.

  // ── Validity range (POSIX ms, matches validator's epoch math) ────
  const lowerTime = Number(tipPosixMs);
  const upperTime = Number((currentEpoch + 1n) * msPerEpoch(network) - 1n);

  const tx = await lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .attach.SpendingValidator(vaultScript)
    .pay.ToAddressWithData(
      vaultAddress,
      { kind: "inline", value: Data.to(newVaultDatum as never, VaultDatumSchema) },
      vaultOutputAssets,
    )
    .pay.ToAddress(destination, { [lampUnit]: amountOil })
    .addSignerKey(vaultDatum.owner)
    .validFrom(lowerTime)
    .validTo(upperTime)
    .complete();

  const summary = [
    `═══ WithdrawLamp ═══`,
    `Vault:           ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`,
    `Owner:           ${vaultDatum.owner}`,
    `Amount:          ${amountOil / 1_000_000n} LAMP (${amountOil} oil)`,
    `LAMP before:     ${vaultDatum.lamp_balance / 1_000_000n}`,
    `LAMP after:      ${remainingLamp / 1_000_000n}`,
    `Locked unchanged: ${vaultDatum.lamp_locked / 1_000_000n}`,
    `Destination:     ${destination}`,
    `Selection:       newest-first (preserves loyalty of older holdings)`,
    `Current epoch:   ${currentEpoch}`,
  ].join("\n");

  return {
    tx,
    amountWithdrawn: amountOil,
    lampRemaining:   remainingLamp,
    newVaultDatum,
    summary,
  };
}

// ── helpers ───────────────────────────────────────────────────────

/**
 * Remove `amount` oil from holdings, picking NEWEST first (LF-preserving).
 * Locked holdings (is_locked=true) are NEVER touched — withdraw only from
 * unlocked balance.
 *
 * Mirrors what the Aiken validator must compute when verifying output
 * `loyalty_holdings`. P8 invariant requires bit-identical behavior.
 */
export function removeNewestFirst(
  holdings: { amount: bigint; acquired_epoch: bigint; is_locked: boolean }[],
  amount:   bigint,
): { amount: bigint; acquired_epoch: bigint; is_locked: boolean }[] {
  // Split locked (keep as-is) vs unlocked (eligible for withdrawal)
  const locked   = holdings.filter(h =>  h.is_locked);
  const unlocked = holdings.filter(h => !h.is_locked)
    .sort((a, b) => cmpBigIntDesc(a.acquired_epoch, b.acquired_epoch)); // newest first

  let remaining = amount;
  const result = [...locked];

  for (const h of unlocked) {
    if (remaining === 0n) { result.push(h); continue; }
    if (h.amount <= remaining) {
      // Fully consumed
      remaining -= h.amount;
    } else {
      // Partial consume — keep the older portion
      result.push({ ...h, amount: h.amount - remaining });
      remaining = 0n;
    }
  }

  if (remaining > 0n) {
    throw new Error(`WITHDRAW-003: insufficient unlocked LAMP (short ${remaining} oil)`);
  }
  return result;
}

/**
 * Encode the `WithdrawLamp { amount }` redeemer.
 *
 * Indices = NEXT slot after existing variants per actual Aiken enum on main:
 *
 *   SnapshotGen/onchain/lib/magiclamp/protocol/types.ak:
 *     0 TriggerSnapshot · 1 BurnBatch · 2 UpdateProfile (stub)
 *     → WithdrawLamp = 3
 *
 *   InstantGen/onchain/lib/magiclamp/protocol/types.ak:
 *     0 InstantGen · 1 ApplyHalving · 2 BurnBatch · 3 UpdateProfile (stub)
 *     → WithdrawLamp = 4
 *
 *   VacuumGen/onchain/lib/magiclamp/protocol/types.ak (6 variants — shares Instant/Halving/Burn/Update):
 *     0 VacuumCommit · 1 VacuumFire · 2 InstantGen · 3 ApplyHalving · 4 BurnBatch · 5 UpdateProfile
 *     → WithdrawLamp = 6
 *
 *   ScheduleGen/onchain/lib/magiclamp/protocol/types.ak:
 *     0 ScheduleCommit · 1 ScheduleFire · 2 BurnBatch
 *     → WithdrawLamp = 3
 *
 * If onchain enum order changes during v1.0 implementation, update the table below.
 */
function encodeWithdrawLampRedeemer(vaultType: VaultType, amount: bigint): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Constr } = require("@lucid-evolution/lucid") as typeof import("@lucid-evolution/lucid");
  const idx = WITHDRAW_LAMP_CONSTR_INDEX[vaultType];
  return Data.to(new Constr(idx, [amount]));
}

const WITHDRAW_LAMP_CONSTR_INDEX: Record<VaultType, number> = {
  Snapshot: 3,
  Instant:  4,
  Vacuum:   6,   // Vacuum enum has 6 variants — shares Inst/Halving/Burn/Update
  Schedule: 3,
};

// Re-export for tests + future spec evolution.
export { WITHDRAW_LAMP_TAG, WITHDRAW_LAMP_CONSTR_INDEX };
