// MagicSDK/src/vaultDatum.ts — build the initial VaultDatum at vault creation
//
// All 4 vault types share the same datum shape. Initial state is mostly
// zero/empty: no batches, no orders, no schedules, no activity, no streak.
// The only "interesting" fields are owner, lamp_balance, profile, and
// last_updated_epoch.

import type { Profile } from "./types.js";

export interface InitialVaultDatumInputs {
  ownerPkh:           string;
  lampBalanceOil:     bigint;
  profile:            Profile;
  currentEpoch:       bigint;
  personalDelegate?:  string | null;
}

/**
 * Build the canonical initial VaultDatum for a freshly-created vault.
 *
 * Design choices:
 *   - `loyalty_holdings` starts with a single unlocked holding of size
 *     `lamp_balance` acquired at the current epoch. As LF age (§6.3)
 *     measures from `acquired_epoch`, this gives the user a clean
 *     LF=1.0 baseline. SnapshotGen will mutate this list naturally.
 *
 *   - `last_updated_epoch = current` means the user can immediately call
 *     `TriggerSnapshot` only at the NEXT epoch boundary (C-SS-1 requires
 *     `current_epoch > last_updated_epoch`). If the caller wants to make
 *     the vault fire-immediately for tests, post-process this value or
 *     wait one epoch.
 *
 *   - `attribution_root = 32 zero bytes` is the genesis state for the
 *     attribution Merkle chain (§A11). Validator hashes events into this
 *     incrementally on TriggerSnapshot.
 *
 *   - `lamp_locked = 0` always at creation. Locks only happen via Vacuum
 *     Commit or Schedule Commit.
 */
export function buildInitialVaultDatum(inputs: InitialVaultDatumInputs): {
  owner:                 string;
  lamp_balance:          bigint;
  lamp_locked:           bigint;
  loyalty_holdings:      Array<{ amount: bigint; acquired_epoch: bigint; is_locked: boolean }>;
  magic_batches:         never[];
  next_batch_index:      bigint;
  vacuum_orders:         never[];
  gen_schedules:         never[];
  profile:               Profile;
  profile_changed_epoch: bigint;
  pending_profile:       null;
  last_updated_epoch:    bigint;
  delegation_cert: {
    current: never[];
    pending: null;
    current_effective_epoch: bigint;
    last_changed_epoch:      bigint;
  };
  activity_state: {
    recent_burn_epochs: never[];
    total_burns_count:  bigint;
  };
  streak_state: {
    current_streak:    bigint;
    last_active_epoch: bigint;
  };
  personal_delegate: string | null;
  attribution: {
    attribution_root: string;
    last_event_epoch: bigint;
    total_events:     bigint;
  };
} {
  const { ownerPkh, lampBalanceOil, profile, currentEpoch } = inputs;

  if (lampBalanceOil <= 0n) {
    throw new Error(`lampDeposit must be > 0 oil (got ${lampBalanceOil})`);
  }
  if (!/^[0-9a-fA-F]{56}$/.test(ownerPkh)) {
    throw new Error(`ownerPkh must be 28-byte hex (got "${ownerPkh}")`);
  }
  if (inputs.personalDelegate && !/^[0-9a-fA-F]{56}$/.test(inputs.personalDelegate)) {
    throw new Error(`personalDelegate must be 28-byte hex if set`);
  }

  return {
    owner:        ownerPkh,
    lamp_balance: lampBalanceOil,
    lamp_locked:  0n,
    loyalty_holdings: [{
      amount:         lampBalanceOil,
      acquired_epoch: currentEpoch,
      is_locked:      false,
    }],
    magic_batches:    [],
    next_batch_index: 0n,
    vacuum_orders:    [],
    gen_schedules:    [],
    profile,
    profile_changed_epoch: 0n,
    pending_profile:    null,
    last_updated_epoch: currentEpoch,
    delegation_cert: {
      current: [],
      pending: null,
      current_effective_epoch: 0n,
      last_changed_epoch:      0n,
    },
    activity_state: {
      recent_burn_epochs: [],
      total_burns_count:  0n,
    },
    streak_state: {
      current_streak:    0n,
      last_active_epoch: 0n,
    },
    personal_delegate: inputs.personalDelegate ?? null,
    attribution: {
      attribution_root: "00".repeat(32),   // 32 zero bytes hex
      last_event_epoch: 0n,
      total_events:     0n,
    },
  };
}
