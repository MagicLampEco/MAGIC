// MagicSDK/src/updateProfile.ts — đổi profile vault (Ember/Flame/Lantern)
//
// Profile thay đổi LAZY: tx này chỉ set `pending_profile`, validator áp dụng
// thực sự vào lần tx kế tiếp chạm tới vault (T4, C-PC-V6). Lý do: existing
// `magic_batches` giữ nguyên `profile_at_creation` — batches sinh dưới profile
// Flame sẽ vẫn decay theo N=6 dù user đổi sang Ember.
//
// Cooldown: 2 epoch giữa các lần đổi (C-PC-V2). Tránh user flip-flop.
//
// ONCHAIN STATUS:
//   - InstantGen vault: `UpdateProfile` ĐÃ HIỆN THỰC ĐẦY ĐỦ (`validate_update_profile`
//     trong `InstantGen/onchain/validators/vault.ak`) — ép cooldown, ép lazy apply
//     (không cho set thẳng `profile`), chặn đổi sang chính profile đang dùng, và
//     kiểm toàn vẹn datum. Có test: `up_positive`, `up_cooldown_not_met`,
//     `up_bypass_lazy`, `up_same_profile`.
//   - ScheduleGen: không support UpdateProfile (validator không dùng profile
//     cho compute) — đúng thiết kế, không phải thiếu sót.
//
// (Bình luận cũ ghi handler là STUB "chờ Tuân implement" — đã quá hạn.)

import {
  Constr, Data,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  slotToUnixTime,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator,
} from "@lucid-evolution/lucid";
import {
  getTipSlot, posixMsToEpoch, msPerEpoch,
  type Network,
} from "@magiclamp/protocol-utils";

import { VaultDatumSchema, type VaultDatum } from "./schemas.js";
import type { Profile, VaultType } from "./types.js";
import { resolveConstrIndex, type PlutusJson } from "./redeemerIndex.js";

const PROFILE_COOLDOWN = 2n; // epochs (C-PC-V2)
const UPDATE_PROFILE_TAG = "UpdateProfile";
const VAULT_VALIDATOR_TITLE = "vault.vault.spend";

export interface UpdateProfileParams {
  lucid:        LucidEvolution;
  vaultUtxo:    UTxO;
  newProfile:   Profile;
  vaultScript:  Validator;
  /** Vault type — for error/logging only; only "Instant" supports UpdateProfile
   *  ("Schedule" doesn't use profile in M computation). */
  vaultType:    VaultType;
  /** Full plutus.json of the vault module — SDK resolves UpdateProfile
   *  constructor index at runtime (no hardcoded table). */
  vaultPlutusJson: PlutusJson;
  network:      Network;
  tipPosixMs?:  bigint;
}

export interface UpdateProfileResult {
  tx:               TxSignBuilder;
  oldProfile:       Profile;
  newProfile:       Profile;
  effectiveEpoch:   bigint;
  newVaultDatum:    VaultDatum;
  summary:          string;
}

/**
 * Build an unsigned tx that schedules a profile change. Validator (when fully
 * implemented) MUST enforce:
 *   - Owner signs
 *   - `current_epoch - profile_changed_epoch >= PROFILE_COOLDOWN (2)` (C-PC-V2)
 *   - `new_profile != current.profile` (C-PC-V3)
 *   - Output datum:
 *       - profile == input.profile (unchanged — lazy apply)
 *       - pending_profile == Some({ new_profile, effective_epoch: current+1 })
 *       - profile_changed_epoch == current_epoch
 *       - last_updated_epoch == current_epoch
 *       - magic_batches == input (C-PC-V4: existing batches keep their P)
 *       - lamp_balance, lamp_locked, loyalty_holdings: unchanged
 *       - All other fields: unchanged
 */
export async function updateProfile(params: UpdateProfileParams): Promise<UpdateProfileResult> {
  const { lucid, vaultUtxo, newProfile, vaultScript, vaultType, network, vaultPlutusJson } = params;

  if (vaultType === "Schedule") {
    throw new Error(
      `UPDATE-001: vaultType="${vaultType}" doesn't use profile (PM_Q only applies to Instant). ` +
      `No UpdateProfile redeemer on this vault.`,
    );
  }

  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);

  // C-PC-V3
  if (newProfile === vaultDatum.profile) {
    throw new Error(
      `UPDATE-002: new_profile == current profile (${newProfile}). No change.`,
    );
  }

  // Current PROTOCOL epoch (see withdrawLamp.ts comment about `lucid as never` cast)
  const tipPosixMs = params.tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(lucid as never, network)));
  const currentEpoch = posixMsToEpoch(tipPosixMs, network);

  // C-PC-V2 cooldown
  const elapsed = currentEpoch - vaultDatum.profile_changed_epoch;
  if (elapsed < PROFILE_COOLDOWN) {
    const wait = PROFILE_COOLDOWN - elapsed;
    throw new Error(
      `C-PC-V2: cooldown not met. Wait ${wait} more epoch(s). ` +
      `Last change: ep${vaultDatum.profile_changed_epoch}, current: ep${currentEpoch}.`,
    );
  }

  const effectiveEpoch = currentEpoch + 1n;

  // Build new datum (A02 — lazy: profile unchanged, pending set)
  const newVaultDatum: VaultDatum = {
    ...vaultDatum,
    pending_profile:       { new_profile: newProfile, effective_epoch: effectiveEpoch },
    profile_changed_epoch: currentEpoch,
    last_updated_epoch:    currentEpoch,
    // profile, magic_batches, lamp_*, etc.: unchanged (C-PC-V4)
  };

  const vaultAddress = credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(vaultScript)),
  );
  const redeemer = encodeUpdateProfileRedeemer(vaultPlutusJson, newProfile);

  const lowerTime = Number(tipPosixMs);
  const upperTime = Number((currentEpoch + 1n) * msPerEpoch(network) - 1n);

  const tx = await lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .attach.SpendingValidator(vaultScript)
    .pay.ToAddressWithData(
      vaultAddress,
      { kind: "inline", value: Data.to(newVaultDatum as never, VaultDatumSchema) },
      vaultUtxo.assets,   // assets unchanged
    )
    .addSignerKey(vaultDatum.owner)
    .validFrom(lowerTime)
    .validTo(upperTime)
    .complete();

  const summary = [
    `═══ UpdateProfile (lazy) ═══`,
    `Vault:           ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`,
    `Vault type:      ${vaultType}`,
    `Old profile:     ${vaultDatum.profile}`,
    `New profile:     ${newProfile}  (pending — applies at epoch ${effectiveEpoch})`,
    `Current epoch:   ${currentEpoch}`,
    `Cooldown until:  ep${currentEpoch + PROFILE_COOLDOWN}`,
    ``,
    `⚠ Existing magic_batches keep profile_at_creation (T4) — decay rule unchanged for them.`,
    `⚠ Lazy: this tx ONLY sets pending. Profile actually flips at next vault touch (epoch ${effectiveEpoch}+).`,
  ].join("\n");

  return {
    tx,
    oldProfile:     vaultDatum.profile as Profile,
    newProfile,
    effectiveEpoch,
    newVaultDatum,
    summary,
  };
}

// ── helpers ───────────────────────────────────────────────────────

/**
 * Encode the `UpdateProfile { new_profile }` redeemer.
 *
 * Constructor index resolved at runtime from `plutusJson` (no hardcoded table).
 * Throws if `UpdateProfile` variant missing (e.g. used on a Schedule vault
 * where the enum doesn't include it).
 *
 * ActivityProfile inner constructor: Ember=0, Flame=1, Lantern=2 (Aiken order
 * is invariant since it's defined as `type ActivityProfile { Ember Flame Lantern }`
 * — kept hardcoded as the enum is closed and pre-dates v1.0).
 */
function encodeUpdateProfileRedeemer(plutusJson: PlutusJson, newProfile: Profile): string {
  const profileConstr = new Constr(PROFILE_CONSTR_INDEX[newProfile], []);
  const idx = resolveConstrIndex(plutusJson, VAULT_VALIDATOR_TITLE, UPDATE_PROFILE_TAG);
  return Data.to(new Constr(idx, [profileConstr]));
}

/** ActivityProfile enum order — fixed since v0 (not subject to v1.0 churn). */
const PROFILE_CONSTR_INDEX: Record<Profile, number> = {
  Ember:   0,
  Flame:   1,
  Lantern: 2,
};

export { PROFILE_COOLDOWN, UPDATE_PROFILE_TAG, PROFILE_CONSTR_INDEX };
