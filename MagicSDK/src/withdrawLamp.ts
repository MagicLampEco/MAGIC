// MagicSDK/src/withdrawLamp.ts — withdraw LAMP từ vault về ví user.
//
// LF-PRESERVING SELECTION: rút từ holding MỚI NHẤT (newest first).
// Lý do: LF (Loyalty Factor §6.3) là weighted-average tuổi holding × amount;
// giữ holding CŨ → LF cao → MAGIC sinh ra nhiều. Rút newest-first
// = sacrifice 0 tuổi loyalty (vs rút oldest-first sẽ phá max LF user đã tích).
// Đây là pattern ngược của Instant subtractFromHoldings (oldest-first) — vì
// withdraw là discretionary, user nên được optimize cho retention.
//
// ⚠ ONCHAIN STATUS: validator chưa support redeemer này (Tuân v1.0 work).
// SDK code complete + tx builder pattern set — chỉ chờ validator merge.
// Submit tx này TRƯỚC khi onchain v1.0 deploy sẽ bị validator reject.

import {
  Constr, Data, toUnit,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  slotToUnixTime,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator,
} from "@lucid-evolution/lucid";
import {
  getTipSlot, posixMsToEpoch, msPerEpoch,
  cmpBigIntDesc, lampAssetName,
  type Network,
} from "@magiclamp/protocol-utils";

import { VaultDatumSchema, type VaultDatum } from "./schemas.js";
import type { VaultType } from "./types.js";
import { resolveConstrIndex, type PlutusJson } from "./redeemerIndex.js";

/** Aiken redeemer variant title. Matches `pub type VaultRedeemer { WithdrawLamp ... }`. */
const WITHDRAW_LAMP_TAG = "WithdrawLamp";

/** Validator title in plutus.json — same across all 4 vault modules. */
const VAULT_VALIDATOR_TITLE = "vault.vault.spend";

export interface WithdrawLampParams {
  lucid:           LucidEvolution;
  /** The vault UTxO to withdraw from. Use `listVaultsForOwner` to discover. */
  vaultUtxo:       UTxO;
  /** Amount to withdraw, in oildrop (1 LAMP = 10^6 oildrop). MUST be ≤ L_avail. */
  amountOildrop:       bigint;
  /** Applied vault validator (same one used at createVault). */
  vaultScript:     Validator;
  /** Vault type — for logging / error messages only. Constructor index for
   *  the WithdrawLamp redeemer is resolved at runtime from `vaultPlutusJson`
   *  (so SDK can't desync with onchain enum order). */
  vaultType:       VaultType;
  /** Full plutus.json of the vault module — SDK reads redeemer enum to
   *  resolve the WithdrawLamp constructor index at runtime. */
  vaultPlutusJson: PlutusJson;
  /** Network. */
  network:         Network;
  /** LAMP minting policy + asset name. */
  lampPolicyId:    string;
  lampAssetName?:  string;        // default = lampAssetName(network)
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


/**
 * Build an unsigned tx that withdraws `amountOildrop` LAMP from `vaultUtxo`
 * back to `destinationAddress` (defaults to caller's wallet).
 *
 * Validation (mirrors what the validator must enforce):
 *   - Owner signs (`extra_signatories` contains `datum.owner`)
 *   - `amountOildrop > 0`
 *   - `amountOildrop ≤ L_avail = lamp_balance - lamp_locked`
 *   - Output vault datum:
 *       - lamp_balance -= amountOildrop
 *       - loyalty_holdings: NEWEST-FIRST removal (LF-preserving)
 *       - lamp_locked, magic_batches, vacuum_orders, gen_schedules: UNCHANGED
 *       - profile, profile_changed_epoch, pending_profile: UNCHANGED
 *       - delegation_cert, activity_state, streak_state: UNCHANGED
 *       - personal_delegate, attribution: UNCHANGED
 *       - last_updated_epoch: UNCHANGED (validator ép giữ nguyên)
 *   - Output: `amountOildrop` LAMP sent to `destinationAddress`
 *   - Vault output preserved at vault address with same lovelace AND the
 *     vault-identity NFT (INV-VAULT-IDENTITY) — value chép nguyên từ input
 */
export async function withdrawLamp(params: WithdrawLampParams): Promise<WithdrawLampResult> {
  const {
    lucid, vaultUtxo, amountOildrop, vaultScript, network,
    lampPolicyId, vaultPlutusJson,
  } = params;
  const assetName = params.lampAssetName ?? lampAssetName(network);

  if (amountOildrop <= 0n) {
    throw new Error(`WITHDRAW-001: amountOildrop must be > 0 (got ${amountOildrop})`);
  }

  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);

  const lAvail = vaultDatum.lamp_balance - vaultDatum.lamp_locked;
  if (amountOildrop > lAvail) {
    throw new Error(
      `WITHDRAW-002: amount ${amountOildrop} > L_avail ${lAvail} ` +
      `(balance=${vaultDatum.lamp_balance}, locked=${vaultDatum.lamp_locked})`,
    );
  }

  // ── Current PROTOCOL epoch (POSIX-derived, matches validator) ────
  // Cast lucid → any: getTipSlot accepts `{provider: unknown}`; LucidEvolution
  // has `provider` at runtime but its type def doesn't expose it. Same cast
  // used across all MAGIC SDK builders (instant.ts, schedule.ts).
  const tipPosixMs = params.tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(lucid as never, network)));
  const currentEpoch = posixMsToEpoch(tipPosixMs, network);

  // ── Newest-first holding removal (LF-preserving) ────────────────
  const newHoldings = removeNewestFirst(
    vaultDatum.loyalty_holdings as { amount: bigint; acquired_epoch: bigint; is_locked: boolean }[],
    amountOildrop,
  );

  // ── Build updated VaultDatum (A02: field-by-field) ──────────────
  const newVaultDatum: VaultDatum = {
    ...vaultDatum,
    lamp_balance:       vaultDatum.lamp_balance - amountOildrop,
    loyalty_holdings:   newHoldings,
    // last_updated_epoch GIỮ NGUYÊN — validator ép
    //   output_datum.last_updated_epoch == input_datum.last_updated_epoch
    // (InstantGen/onchain/validators/vault.ak, validate_withdraw_lamp). Đẩy nó
    // lên current epoch sẽ reset cửa sổ bắt-kịp và làm mất MAGIC đã tích. Rút
    // LAMP là việc trực giao với sinh MAGIC.
    // Everything else unchanged per A02.
  };

  // ── Addresses + units ───────────────────────────────────────────
  const vaultAddress = credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(vaultScript)),
  );
  const destination = params.destinationAddress ?? (await lucid.wallet().address());
  const lampUnit = toUnit(lampPolicyId, assetName);

  // ── Build redeemer — resolve constr index from plutus.json at runtime ──
  // No hardcoded indices: SDK reads the Aiken enum from plutus.json, finds
  // the "WithdrawLamp" variant by title, uses its .index. If onchain enum
  // reorders, the new plutus.json reflects it; SDK auto-updates.
  const redeemer = encodeWithdrawLampRedeemer(vaultPlutusJson, amountOildrop);

  // ── Vault output assets: chép NGUYÊN value đầu vào, chỉ hạ LAMP ──
  // Phải chép nguyên chứ không dựng lại từ {lovelace, lamp}: vault còn mang NFT
  // danh tính (INV-VAULT-IDENTITY), và validate_vault_value đòi đúng 1 NFT của
  // policy vault còn nguyên trên output ở MỌI đường spend. Dựng lại tay là bỏ
  // rơi nó ⇒ tx bị từ chối, và không có gì bắt được lúc biên dịch.
  const remainingLamp = vaultDatum.lamp_balance - amountOildrop;
  const vaultOutputAssets: Record<string, bigint> = { ...vaultUtxo.assets };
  if (remainingLamp > 0n) vaultOutputAssets[lampUnit] = remainingLamp;
  else delete vaultOutputAssets[lampUnit];
  // remainingLamp == 0 thì vault vẫn tồn tại (min-ADA + NFT danh tính), giữ 0 LAMP.

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
    .pay.ToAddress(destination, { [lampUnit]: amountOildrop })
    .addSignerKey(vaultDatum.owner)
    .validFrom(lowerTime)
    .validTo(upperTime)
    .complete();

  const summary = [
    `═══ WithdrawLamp ═══`,
    `Vault:           ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`,
    `Owner:           ${vaultDatum.owner}`,
    `Amount:          ${amountOildrop / 1_000_000n} LAMP (${amountOildrop} oildrop)`,
    `LAMP before:     ${vaultDatum.lamp_balance / 1_000_000n}`,
    `LAMP after:      ${remainingLamp / 1_000_000n}`,
    `Locked unchanged: ${vaultDatum.lamp_locked / 1_000_000n}`,
    `Destination:     ${destination}`,
    `Selection:       newest-first (preserves loyalty of older holdings)`,
    `Current epoch:   ${currentEpoch}`,
  ].join("\n");

  return {
    tx,
    amountWithdrawn: amountOildrop,
    lampRemaining:   remainingLamp,
    newVaultDatum,
    summary,
  };
}

// ── helpers ───────────────────────────────────────────────────────

/**
 * Remove `amount` oildrop from holdings, picking NEWEST first (LF-preserving).
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
    throw new Error(`WITHDRAW-003: insufficient unlocked LAMP (short ${remaining} oildrop)`);
  }
  return result;
}

/**
 * Encode the `WithdrawLamp { amount }` redeemer.
 *
 * Constructor index resolved at runtime from `plutusJson` (no hardcoded table —
 * see `redeemerIndex.ts:resolveConstrIndex`). Throws if `WithdrawLamp` variant
 * is missing from the plutus.json (e.g. you forgot to rebuild after the Aiken
 * change landed).
 */
function encodeWithdrawLampRedeemer(plutusJson: PlutusJson, amount: bigint): string {
  const idx = resolveConstrIndex(plutusJson, VAULT_VALIDATOR_TITLE, WITHDRAW_LAMP_TAG);
  return Data.to(new Constr(idx, [amount]));
}

export { WITHDRAW_LAMP_TAG, VAULT_VALIDATOR_TITLE };
