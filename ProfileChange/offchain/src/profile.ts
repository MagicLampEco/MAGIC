// src/profile.ts — ProfileChange flow (§12)
// Normative: C-PC-V1..6, T4, §3.5

import {
  Data, type LucidEvolution, type UTxO, type Tx,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  slotToUnixTime,
  type Validator,
} from "@lucid-evolution/lucid";
import { getTipSlot, posixMsToEpoch, msPerEpoch, type Network } from "@magiclamp/protocol-utils";

const PROFILE_COOLDOWN  = 2n;   // epochs [Significant]

export type ActivityProfile = "Ember" | "Flame" | "Lantern";

// Profile parameters (§3.1) — for display
export const PROFILE_INFO: Record<ActivityProfile, { N: number; decay: string; ELV: string }> = {
  Ember:   { N: 3, decay: "×0.70/ep", ELV: "2.19" },
  Flame:   { N: 6, decay: "×0.80/ep", ELV: "3.69" },
  Lantern: { N: 9, decay: "×0.90/ep", ELV: "6.12" },
};

export interface ProfileChangeResult {
  tx              : Tx;
  oldProfile      : ActivityProfile;
  newProfile      : ActivityProfile;
  effectiveEpoch  : bigint;
  summary         : string;
}

// ══════════════════════════════════════════════════════════════
// buildProfileChangeTx — §12.1
// ══════════════════════════════════════════════════════════════

export async function buildProfileChangeTx(
  lucid         : LucidEvolution,
  vaultUtxo     : UTxO,
  newProfile    : ActivityProfile,
  vaultSchema   : any,
  vaultScript   : Validator,
  network       : Network = "Preview",
  tipPosixMs?   : bigint,
): Promise<ProfileChangeResult> {
  const datum = Data.from(vaultUtxo.datum!, vaultSchema);
  const tipMs = tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(lucid, network)));
  const currentEpoch = posixMsToEpoch(tipMs, network);

  // C-PC-V2: cooldown ≥ 2 epochs
  const lastChange = datum.profile_changed_epoch;
  if (currentEpoch - lastChange < PROFILE_COOLDOWN) {
    const wait = PROFILE_COOLDOWN - (currentEpoch - lastChange);
    throw new Error(
      `C-PC-V2: Cooldown not met. Wait ${wait} more epoch(s). ` +
      `Last change: ep${lastChange}, current: ep${currentEpoch}`,
    );
  }

  // C-PC-V3: must actually change
  if (newProfile === datum.profile) {
    throw new Error(`C-PC-V3: new_profile = current_profile (${newProfile}). No change.`);
  }

  const effectiveEpoch = currentEpoch + 1n;

  // Build new datum (C-PC-V4: magic_batches unchanged)
  const newDatum = {
    ...datum,
    pending_profile:       { new_profile: newProfile, effective_epoch: effectiveEpoch },
    profile_changed_epoch: currentEpoch,
    last_updated_epoch:    currentEpoch,
    // profile still = old profile (applied lazily next tx)
    // magic_batches unchanged (T4, C-PC-V4)
  };

  const vaultAddr  = credentialToAddress(network, scriptHashToCredential(validatorToScriptHash(vaultScript)));
  const redeemer   = Data.to({ UpdateProfile: { new_profile: newProfile } });
  // POSIX-ms validity range. Validator computes epoch = posix_ms / ms_per_epoch.
  const lowerTime = Number(tipMs);
  const upperTime = Number((currentEpoch + 1n) * msPerEpoch(network) - 1n);

  const tx = await lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .attach.SpendingValidator(vaultScript)
    .pay.ToAddressWithData(vaultAddr, { kind: "inline", value: Data.to(newDatum, vaultSchema) }, vaultUtxo.assets)
    .addSignerKey(datum.owner)   // C-PC-V1
    .validFrom(lowerTime)
    .validTo(upperTime)
    .complete();

  const oldInfo = PROFILE_INFO[datum.profile as ActivityProfile];
  const newInfo = PROFILE_INFO[newProfile];

  const summary = [
    `═══ Profile Change ═══`,
    `Current epoch:    ${currentEpoch}`,
    ``,
    `Old profile:      ${datum.profile}  (N=${oldInfo.N} epoch, ${oldInfo.decay}, ELV=${oldInfo.ELV}×)`,
    `New profile:      ${newProfile}  (N=${newInfo.N} epoch, ${newInfo.decay}, ELV=${newInfo.ELV}×)`,
    `Effective:        epoch ${effectiveEpoch} (next tx that touches vault)`,
    ``,
    `⚠  Existing Snapshot batches KEEP their original profile (T4, C-PC-V6).`,
    `   A Flame batch born at ep95 stays Flame N=6 even after you switch to Ember.`,
    `⚠  Cooldown: cannot change again until ep${currentEpoch + PROFILE_COOLDOWN}.`,
    ``,
    `✓  Pending set. Profile applies lazily on next vault interaction.`,
  ].join("\n");

  return { tx, oldProfile: datum.profile, newProfile, effectiveEpoch, summary };
}

// ══════════════════════════════════════════════════════════════
// Profile change logic (off-chain — used in epoch boundary processing)
// ══════════════════════════════════════════════════════════════

/** §12.2: Apply pending profile if effective_epoch ≤ current_epoch */
export function applyPendingProfile(
  profile               : ActivityProfile,
  pending               : { new_profile: ActivityProfile; effective_epoch: bigint } | null,
  currentEpoch          : bigint,
): { profile: ActivityProfile; pending: null | typeof pending } {
  if (!pending) return { profile, pending: null };
  if (pending.effective_epoch <= currentEpoch) {
    return { profile: pending.new_profile, pending: null };   // apply + clear
  }
  return { profile, pending };   // not yet effective
}

/** C-PC-V2: Check if cooldown allows profile change */
export function canChangeProfile(
  profileChangedEpoch : bigint,
  currentEpoch        : bigint,
): { allowed: boolean; waitEpochs: bigint } {
  const elapsed = currentEpoch - profileChangedEpoch;
  const allowed = elapsed >= PROFILE_COOLDOWN;
  return { allowed, waitEpochs: allowed ? 0n : PROFILE_COOLDOWN - elapsed };
}
