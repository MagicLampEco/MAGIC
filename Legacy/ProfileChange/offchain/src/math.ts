// src/math.ts — ProfileChange pure logic (no Lucid dependency)

export type ActivityProfile = "Ember" | "Flame" | "Lantern";

export const PROFILE_COOLDOWN = 2n;  // epochs [Significant]

export const PROFILE_INFO: Record<ActivityProfile, { N: number; decay: string; ELV: string }> = {
  Ember:   { N: 3, decay: "×0.70/ep", ELV: "2.19" },
  Flame:   { N: 6, decay: "×0.80/ep", ELV: "3.69" },
  Lantern: { N: 9, decay: "×0.90/ep", ELV: "6.12" },
};

/** §12.2: Apply pending profile if effective_epoch ≤ current_epoch */
export function applyPendingProfile(
  profile  : ActivityProfile,
  pending  : { new_profile: ActivityProfile; effective_epoch: bigint } | null,
  current  : bigint,
): { profile: ActivityProfile; pending: null | typeof pending } {
  if (!pending) return { profile, pending: null };
  if (pending.effective_epoch <= current) return { profile: pending.new_profile, pending: null };
  return { profile, pending };
}

/** C-PC-V2: cooldown check */
export function canChangeProfile(
  profileChangedEpoch : bigint,
  currentEpoch        : bigint,
): { allowed: boolean; waitEpochs: bigint } {
  const elapsed = currentEpoch - profileChangedEpoch;
  const allowed = elapsed >= PROFILE_COOLDOWN;
  return { allowed, waitEpochs: allowed ? 0n : PROFILE_COOLDOWN - elapsed };
}
