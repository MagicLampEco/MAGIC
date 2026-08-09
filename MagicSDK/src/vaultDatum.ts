// MagicSDK/src/vaultDatum.ts — build the initial VaultDatum at vault creation
//
// All 4 vault types share the same datum shape. Initial state is mostly
// zero/empty: no batches, no orders, no schedules, no activity, no streak.
// The only "interesting" fields are owner, lamp_balance, profile, and
// last_updated_epoch.

import type { Profile } from "./types.js";

export interface InitialVaultDatumInputs {
  ownerPkh:           string;
  lampBalanceOildrop:     bigint;
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
 *     LF=1.0 baseline. Deposits/withdrawals mutate this list naturally.
 *
 *   - `last_updated_epoch = 0` — KHÔNG phải epoch hiện tại. `validate_mint_vault_id`
 *     (validators/vault.ak) ép `vd.last_updated_epoch == 0` tại lúc mint NFT
 *     danh-tính. Đặt epoch thật vào đây làm tx tạo vault fail. Trường này là
 *     TRẠNG THÁI TÍCH LUỸ ("lần cuối vault đổi trạng thái"), giá trị sạch của
 *     nó là 0; mọi handler đều chỉ so `current_epoch > last_updated_epoch` nên
 *     0 là an toàn (vault dùng được ngay từ epoch kế tiếp).
 *
 *   - `attribution_root = #""` (RỖNG, 0 byte) — không phải 32 byte 0.
 *     `validate_mint_vault_id` ép `attribution == VaultAttribution {
 *     attribution_root: #"", last_event_epoch: 0, total_events: 0 }`.
 *
 *   - `personal_delegate = None` bắt buộc tại lúc sinh. Muốn đặt uỷ quyền cá
 *     nhân thì dùng redeemer `SetDelegate` SAU khi vault đã tồn tại.
 *
 *   - `lamp_locked = 0` always at creation. Locks only happen via Schedule
 *     Commit (ScheduleFire chỉ mở khoá, LAMP vẫn ở trong vault — I-ACT-7).
 *
 * MỌI hằng số trong hàm này là một điều kiện on-chain, không phải sở thích:
 * đối chiếu trực tiếp với `validate_mint_vault_id` trước khi sửa bất kỳ dòng nào.
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
  const { ownerPkh, lampBalanceOildrop, profile, currentEpoch } = inputs;

  if (lampBalanceOildrop <= 0n) {
    throw new Error(`lampDeposit must be > 0 oildrop (got ${lampBalanceOildrop})`);
  }
  if (!/^[0-9a-fA-F]{56}$/.test(ownerPkh)) {
    throw new Error(`ownerPkh must be 28-byte hex (got "${ownerPkh}")`);
  }
  if (inputs.personalDelegate != null) {
    if (!/^[0-9a-fA-F]{56}$/.test(inputs.personalDelegate)) {
      throw new Error(`personalDelegate must be 28-byte hex if set`);
    }
    // Genesis phải SẠCH: validate_mint_vault_id ép `personal_delegate == None`.
    throw new Error(
      `personalDelegate không đặt được lúc tạo vault: validate_mint_vault_id ` +
      `ép personal_delegate == None ở datum khởi sinh. Tạo vault trước, rồi ` +
      `dùng redeemer SetDelegate.`,
    );
  }

  return {
    owner:        ownerPkh,
    lamp_balance: lampBalanceOildrop,
    lamp_locked:  0n,
    loyalty_holdings: [{
      amount:         lampBalanceOildrop,
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
    // PIN on-chain: `expect vd.last_updated_epoch == 0`
    last_updated_epoch: 0n,
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
    personal_delegate: null,   // PIN on-chain: `expect vd.personal_delegate == None`
    attribution: {
      // PIN on-chain: `attribution_root: #""` — chuỗi byte RỖNG, không phải 32 byte 0.
      attribution_root: "",
      last_event_epoch: 0n,
      total_events:     0n,
    },
  };
}
