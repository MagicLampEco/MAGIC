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
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator, type TxBuilder,
} from "@lucid-evolution/lucid";
import {
  getTipSlot, posixMsToEpoch, msPerEpoch, epochValidityWindow,
  applyOwnerAuth, resolveOwnerAuth, ownerRefOf, ownerRefToString,
  type Network, type OwnerAuth,
} from "@magiclamp/protocol-utils";

import {
  resolveRefScript,
  type AcceptInlineScriptCeiling,
} from "./refScript.js";
import { InstantVaultDatumSchema, decodeVaultDatumOfKind, type InstantVaultDatum } from "./schemas.js";
import { expectedCheckpoint } from "@magiclamp/instantgen-sdk";
import { readCheckpointRefs, type InstantRefParams } from "./genV2Refs.js";
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
  /** Cách chứng minh quyền chủ vault (`@magiclamp/protocol-utils` ▸ `OwnerAuth`).
   *  Bỏ trống: chủ là khoá ⟹ `addSignerKey(pkh)` lấy từ datum; chủ là script ⟹ NÉM
   *  `OWNER_SCRIPT_WITNESS_UNAVAILABLE`. Chủ script (PhoenixKey `did_stake`) dựng bằng
   *  `didStakeOwnerAuthLucid`. Truyền mà khác chủ trong datum ⟹ `OWNER_AUTH_MISMATCH`. */
  ownerAuth?:  OwnerAuth<TxBuilder>;
  /** UTxO CIP-33 mang script tham chiếu của vault — xem `refScript.ts`. Vắng thì
   *  script vẫn được nhét inline như trước. */
  vaultRefScriptUtxo: UTxO | AcceptInlineScriptCeiling;
  // ── Gen v2.0 — nhánh UpdateProfile làm mới checkpoint (`FollowVault`) khi `cap_epoch < e` ──
  /** Beacon ρ (NFT "RHO"). BẮT BUỘC khi két chưa làm mới trong epoch này; thiếu ⟹ NÉM
   *  `GEN-INST-011` trước khi dựng. Cùng epoch ⟹ không đọc, không đưa vào tx. */
  rateBeaconUtxo?:  UTxO;
  /** Két Wakeme ghim két này — chỉ ĐỌC. BẮT BUỘC khi làm mới mà `wakeme_link != ""`. */
  wakemeVaultUtxo?: UTxO;
  /** Apply-param của két Instant để soát hai UTxO trên (`instantVaultParamsFromProtocol`). */
  instantVaultParams?: InstantRefParams;
}

export interface UpdateProfileResult {
  tx:               TxSignBuilder;
  oldProfile:       Profile;
  newProfile:       Profile;
  effectiveEpoch:   bigint;
  newVaultDatum:    InstantVaultDatum;
  /** Lượt này làm mới checkpoint (`cap_epoch < e`) — khi đó tx đọc beacon ρ (+ két Wakeme). */
  checkpointRefreshed: boolean;
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

  // Cổng ngay trên đã loại `"Schedule"`, và `VaultType` là tập ĐÓNG hai phần tử ⟹
  // tới dòng này chỉ còn két Instant, tức hình dạng 20 trường (Gen v2.0). Giải mã thẳng
  // theo loại: datum 19 trường (két Schedule) hay 18 trường (két Instant v1) ⟹ NÉM.
  const vaultDatum = decodeVaultDatumOfKind("Instant", vaultUtxo.datum!);

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

  // Gen v2.0: `validate_update_profile` ▸ `expected_checkpoint(input_datum, …, FollowVault,
  // False, …)` — trên datum VÀO (không áp pending). `cap_epoch == e` ⟹ năm ô ghim nguyên,
  // không đọc ref; `cap_epoch < e` ⟹ làm mới, cần beacon ρ (+ két Wakeme nếu đã ghim).
  const refs = readCheckpointRefs({
    vaultUtxo, e: currentEpoch, params: params.instantVaultParams,
    rateBeaconUtxo: params.rateBeaconUtxo, wakemeVaultUtxo: params.wakemeVaultUtxo,
  });
  const cp = expectedCheckpoint(vaultDatum, currentEpoch, "FollowVault", false, refs.wakeme, refs.rate);
  const checkpointRefreshed = vaultDatum.cap_epoch < currentEpoch;

  // Build new datum (A02 — lazy: profile unchanged, pending set)
  const newVaultDatum: InstantVaultDatum = {
    ...vaultDatum,
    pending_profile:       { new_profile: newProfile, effective_epoch: effectiveEpoch },
    profile_changed_epoch: currentEpoch,
    last_updated_epoch:    currentEpoch,
    // profile, magic_batches, lamp_*, etc.: unchanged (C-PC-V4)
    // `instant_unlock_ms` đi theo phép trải và ĐỨNG YÊN — `validate_update_profile`
    // ép `output_datum.instant_unlock_ms == input_datum.instant_unlock_ms`.
    wakeme_link:           cp.wakeme_link,
    cap_epoch:             cp.cap_epoch,
    cap_nanogic:           cp.cap_nanogic,
    usage_window:          cp.usage_window,
    usage_window_epoch:    cp.usage_window_epoch,
  };
  // Ref input CHỈ khi validator đọc chúng (lượt làm mới).
  const checkpointRefs: UTxO[] = [];
  if (checkpointRefreshed) {
    if (params.rateBeaconUtxo) checkpointRefs.push(params.rateBeaconUtxo);
    if (params.wakemeVaultUtxo) checkpointRefs.push(params.wakemeVaultUtxo);
  }

  const vaultAddress = credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(vaultScript)),
  );
  const redeemer = encodeUpdateProfileRedeemer(vaultPlutusJson, newProfile);

  const { lowerMs: lowerTime, upperMs: upperTime } =
    epochValidityWindow(tipPosixMs, network);

  // `null` = chỗ gọi đã TƯỜNG MINH chọn đường inline, không phải quên truyền.
  const refUtxo = resolveRefScript(
    params.vaultRefScriptUtxo, vaultScript, "vault (UpdateProfile)",
  );
  const txWithScript = refUtxo === null
    ? lucid.newTx().collectFrom([vaultUtxo], redeemer).attach.SpendingValidator(vaultScript)
        .readFrom(checkpointRefs)
    : lucid.newTx().collectFrom([vaultUtxo], redeemer).readFrom([refUtxo, ...checkpointRefs]);

  const txBody = txWithScript
    .pay.ToAddressWithData(
      vaultAddress,
      { kind: "inline", value: Data.to(newVaultDatum as never, InstantVaultDatumSchema) },
      vaultUtxo.assets,   // assets unchanged
    )
    .validFrom(lowerTime)
    .validTo(upperTime);
  // Chủ là `Credential`: khoá ⟹ `addSignerKey(pkh)`; script ⟹ `params.ownerAuth` gắn mục
  // rút `Script(h)`, thiếu thì NÉM `OWNER_SCRIPT_WITNESS_UNAVAILABLE`.
  const tx = await applyOwnerAuth(txBody, resolveOwnerAuth(ownerRefOf(vaultDatum.owner), params.ownerAuth)).complete();

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
    checkpointRefreshed,
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
