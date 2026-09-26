// MagicSDK/src/vaultDatum.ts — build the initial VaultDatum at vault creation
//
// Trạng thái khởi sinh gần như toàn bộ là rỗng/0: không batch, không order,
// không lịch, không hoạt động, không chuỗi ngày. Trường "có nội dung" chỉ có
// owner, lamp_balance, profile, last_updated_epoch.
//
// ── HAI HÌNH DẠNG, CHỌN BẰNG `vaultType` ──────────────────────────────────────
// Bản trước khai *"All 4 vault types share the same datum shape"*. Nay SAI: két
// InstantGen có thêm trường 17 `instant_unlock_ms` (xem `schemas.ts` đầu tệp).
// `vaultType: "Instant"` ⟹ đối tượng trả về có thêm `instant_unlock_ms: 0n`
// (genesis GHIM `== 0`, `InstantGen/onchain/validators/vault.ak` ▸
// `validate_mint_vault_id`). Bỏ trống `vaultType` ⟹ hình dạng 17 trường, y hệt
// hành vi cũ — thêm một tham số TUỲ CHỌN chứ không đổi chữ ký đã hứa.
//
// Dựng datum 17 trường cho một két Instant rồi mã hoá bằng lược đồ 18 trường thì
// Lucid NÉM ngay lúc `Data.to` — hỏng trước khi có giao dịch nào, không phải một
// két hỏng trên chuỗi.

import { ownerCredentialOf, type OwnerCredential, type OwnerRef } from "@magiclamp/protocol-utils";
import type { Profile, VaultType } from "./types.js";
import { resolveOwnerInput } from "./ownerInput.js";

export interface InitialVaultDatumInputs {
  /** Chủ vault — `Credential` dạng JSON. Nhánh `script` hợp lệ: genesis ép
   *  `owner_authorized(tx, vd.owner)`, nên giao dịch tạo phải mang mục rút `Script(h)`. */
  owner?:             OwnerRef;
  /** Bí danh nhánh khoá của `owner` (= `{ type: "key", hash: ownerPkh }`). */
  ownerPkh?:          string;
  lampBalanceOildrop:     bigint;
  profile:            Profile;
  currentEpoch:       bigint;
  personalDelegate?:  string | null;
  /** Loại két. `"Instant"` ⟹ thêm `instant_unlock_ms: 0n` ở cuối. Bỏ trống ⟹
   *  hình dạng 17 trường (Schedule/Prepaid). */
  vaultType?:         VaultType;
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
 *   - `personal_delegate = None` bắt buộc tại lúc sinh, và 🪦 nay KHÔNG CÒN
 *     đường nào đặt nó về khác `None`: nhánh uỷ nhiệm bị bỏ khỏi mô hình ngày
 *     2026-09-16 (Nợ #14). Redeemer `SetDelegate` vẫn tồn tại — chỉ số
 *     constructor là hợp đồng nhị phân — nhưng chỉ XOÁ được.
 *
 *   - `lamp_locked = 0` always at creation. Locks only happen via Schedule
 *     Commit (ScheduleFire chỉ mở khoá, LAMP vẫn ở trong vault — I-ACT-7).
 *
 * MỌI hằng số trong hàm này là một điều kiện on-chain, không phải sở thích:
 * đối chiếu trực tiếp với `validate_mint_vault_id` trước khi sửa bất kỳ dòng nào.
 */
export function buildInitialVaultDatum(inputs: InitialVaultDatumInputs): {
  owner:                 OwnerCredential;
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
    consumed_credit:    bigint;
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
  /** CHỈ có mặt khi `vaultType === "Instant"`. Vắng mặt = hình dạng 17 trường. */
  instant_unlock_ms?:    bigint;
} {
  const { lampBalanceOildrop, profile, currentEpoch } = inputs;

  if (lampBalanceOildrop <= 0n) {
    throw new Error(`lampDeposit must be > 0 oildrop (got ${lampBalanceOildrop})`);
  }
  // Ném `OWNER_HASH_INVALID` ("ownerPkh must be 28-byte hex") / `OWNER_AUTH_MISMATCH` /
  // `OWNER_CREDENTIAL_SHAPE` — quy tắc ở `ownerInput.ts`.
  const owner = resolveOwnerInput(inputs, "buildInitialVaultDatum");
  if (inputs.personalDelegate != null) {
    if (!/^[0-9a-fA-F]{56}$/.test(inputs.personalDelegate)) {
      throw new Error(`personalDelegate must be 28-byte hex if set`);
    }
    // Genesis phải SẠCH: validate_mint_vault_id ép `personal_delegate == None`.
    throw new Error(
      `personalDelegate không đặt được: nhánh uỷ nhiệm đã bị bỏ khỏi mô hình ` +
      `ngày 2026-09-16 (Nợ #14). Cổng đúc vẫn ép personal_delegate == None ở ` +
      `datum khởi sinh, và redeemer SetDelegate nay CHỈ XOÁ được — không còn ` +
      `đường nào đặt trường này về khác None.`,
    );
  }

  return {
    // Chủ là `Credential`: `{VerificationKey:[h]}` hoặc `{Script:[h]}`.
    owner:        ownerCredentialOf(owner),
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
      consumed_credit:    0n,
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
    // Trường 17, CHỈ két Instant. PIN on-chain: `expect vd.instant_unlock_ms == 0`
    // (`InstantGen/onchain/validators/vault.ak` ▸ `validate_mint_vault_id`).
    // `...(cond ? {x} : {})` chứ không `x: undefined`: một khoá mang `undefined`
    // vẫn là một khoá, và `Data.to` đếm khoá — nó sẽ dựng ra 18 trường cho một két
    // Schedule rồi hỏng ở một chỗ không nhắc gì tới loại két.
    ...(inputs.vaultType === "Instant" ? { instant_unlock_ms: 0n } : {}),
  };
}
