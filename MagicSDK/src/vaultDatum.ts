// MagicSDK/src/vaultDatum.ts — build the initial VaultDatum at vault creation (Gen v2.0)
//
// Trạng thái khởi sinh gần như toàn bộ là rỗng/0. Trường "có nội dung" chỉ có owner,
// lamp_balance, loyalty_holdings, profile, và (két Instant) hạt giống `consumed_credit`.
//
// ── HAI HÌNH DẠNG, CHỌN BẰNG `vaultType` ──────────────────────────────────────
//   "Instant"  → 20 trường (`InstantGen/.../types.ak ▸ VaultDatum`).
//   "Schedule" → 19 trường (`ScheduleGen/.../types.ak ▸ VaultDatum`). Bỏ trống ⟹ Schedule.
// Lược đồ: `schemas.ts`. Dựng nhầm hình dạng rồi mã hoá bằng lược đồ kia thì Lucid NÉM
// ngay lúc `Data.to` — hỏng trước khi có giao dịch nào.
//
// MỌI hằng số trong tệp này là một điều kiện on-chain, không phải sở thích: đối chiếu
// với `validate_mint_vault_id` của đúng module trước khi sửa dòng nào. Vector CBOR ghim
// hai hình dạng genesis ở `tests/genesisDatumV2.test.ts`.

import { ownerCredentialOf, type OwnerRef } from "@magiclamp/protocol-utils";
import { WAKEME_SEED_CREDIT, USAGE_WINDOW_LEN } from "@magiclamp/instantgen-sdk";
import type { Profile, VaultType } from "./types.js";
import type { InstantVaultDatum, VaultDatum } from "./schemas.js";
import { resolveOwnerInput } from "./ownerInput.js";

export interface InitialVaultDatumInputs {
  /** Chủ vault — `Credential` dạng JSON. Nhánh `script` hợp lệ: genesis ép
   *  `owner_authorized(tx, vd.owner)`, nên giao dịch tạo phải mang mục rút `Script(h)`. */
  owner?:             OwnerRef;
  /** Bí danh nhánh khoá của `owner` (= `{ type: "key", hash: ownerPkh }`). */
  ownerPkh?:          string;
  lampBalanceOildrop: bigint;
  profile:            Profile;
  currentEpoch:       bigint;
  personalDelegate?:  string | null;
  /** Loại két. `"Instant"` ⟹ 20 trường; bỏ trống / `"Schedule"` ⟹ 19 trường. */
  vaultType?:         VaultType;
  /** CHỈ két Instant: `wakeme_link` khai sẵn lúc genesis — `owner_commit` của DID chủ két
   *  (= blake2b_256(UTF8(did)) = tên NFT két Wakeme), 64 hex. Bỏ trống / `""` ⟹ chưa nối.
   *  Genesis IG nhận rỗng HOẶC đúng 32 byte (`validate_mint_vault_id`, 2026-10-02). */
  wakemeLink?:        string;
}

/** Khuôn `owner_commit` / `wakeme_link`: 32 byte, hex thường. */
export const WAKEME_LINK_RE = /^[0-9a-f]{64}$/;

/**
 * Chuẩn hoá `wakemeLink` cho datum genesis: `undefined`/`""` ⟹ `""`; 64 hex (mọi hoa/thường)
 * ⟹ hex thường; còn lại NÉM. Không cắt, không đệm — một link sai độ dài là genesis bị từ chối.
 */
export function normalizeWakemeLink(link: string | undefined, where: string): string {
  if (link === undefined || link === "") return "";
  if (typeof link !== "string" || !/^[0-9a-fA-F]{64}$/.test(link)) {
    throw new Error(
      `${where}: wakemeLink phải rỗng hoặc đúng 32 byte hex (owner_commit của DID); nhận ` +
      `${typeof link === "string" ? `${link.length} ký tự` : typeof link}.`,
    );
  }
  return link.toLowerCase();
}

/** Cửa sổ genesis: ĐÚNG 7 ô `{0, 0}` — cả hai module ép `usage_window == 7 × EpochUsage{0,0}`
 *  (`empty_window()` / `list.repeat(..., 7)`). Độ dài đọc từ gói nền, không gõ tay. */
function emptyWindow(): Array<{ generated: bigint; consumed: bigint }> {
  return Array.from({ length: USAGE_WINDOW_LEN }, () => ({ generated: 0n, consumed: 0n }));
}

/**
 * Datum khởi sinh chuẩn cho một két mới.
 *
 *   - `loyalty_holdings` = một holding mở khoá cỡ `lamp_balance` tại epoch hiện tại
 *     (genesis chỉ ép tổng == lamp_balance, không khoá, ≤ trần).
 *   - `last_updated_epoch = 0`, `profile_changed_epoch = 0`, `pending_profile = None`,
 *     `personal_delegate = None`, `attribution = { #"", 0, 0 }` — ghim ở cả hai module.
 *   - Két Instant: `wakeme_link = #""` hoặc `owner_commit` 32 byte, `cap_epoch = 0`, `cap_nanogic = 0`,
 *     `instant_unlock_ms = 0`, `consumed_credit = wakeme_seed_credit`.
 *   - Két Schedule: `vacuum_orders = []`, `delegation_cert` rỗng, `streak_state` 0,
 *     `consumed_credit = 0`.
 *   - Cả hai: `usage_window` 7 ô 0, `usage_window_epoch = 0` (KHÔNG phải epoch hiện tại —
 *     genesis ghim 0 để giao dịch tạo không cần validity range hữu hạn).
 */
export function buildInitialVaultDatum(inputs: InitialVaultDatumInputs & { vaultType: "Instant" }): InstantVaultDatum;
export function buildInitialVaultDatum(inputs: InitialVaultDatumInputs & { vaultType?: "Schedule" }): VaultDatum;
export function buildInitialVaultDatum(inputs: InitialVaultDatumInputs): VaultDatum | InstantVaultDatum;
export function buildInitialVaultDatum(inputs: InitialVaultDatumInputs): VaultDatum | InstantVaultDatum {
  const { lampBalanceOildrop, profile, currentEpoch } = inputs;

  // Két Instant được mở với 0 LAMP (2026-10-02): người mới chỉ có LAMP mượn ở két Wakeme,
  // và genesis IG chỉ ép `lamp_balance == LAMP thật trong output` (không ép > 0). Két Schedule
  // giữ > 0: genesis SG cũng cho 0 về mặt validator, nhưng không `VaultRedeemer` nào nạp thêm
  // LAMP sau genesis (BOUNDARIES §2 CC-GEN-L-TIMING), và ScheduleGen không đọc két Wakeme ⟹ một
  // két Schedule 0 LAMP không sinh được gì, chỉ khoá min-ADA.
  if (typeof lampBalanceOildrop !== "bigint" || lampBalanceOildrop < 0n
      || (lampBalanceOildrop === 0n && inputs.vaultType !== "Instant")) {
    throw new Error(
      `lampDeposit must be > 0 oildrop for Schedule vaults, >= 0 for Instant (got ${lampBalanceOildrop})`);
  }
  const wakemeLink = normalizeWakemeLink(inputs.wakemeLink, "buildInitialVaultDatum");
  if (wakemeLink !== "" && inputs.vaultType !== "Instant") {
    throw new Error(`buildInitialVaultDatum: wakemeLink chỉ có ở két Instant (két Schedule không có trường này).`);
  }
  // Ném `OWNER_HASH_INVALID` / `OWNER_AUTH_MISMATCH` / `OWNER_CREDENTIAL_SHAPE` — `ownerInput.ts`.
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

  const ownerCred = ownerCredentialOf(owner) as VaultDatum["owner"];
  // 0 LAMP ⟹ KHÔNG holding nào (genesis ép tổng holding == lamp_balance; một holding 0 qua
  // được phép tổng nhưng là một ô chết chiếm trần `max_loyalty_holdings`). Cùng hình dạng bài
  // Aiken `np_mint_genesis_zero_lamp_ok` (`loyalty_holdings: []`).
  const holdings = lampBalanceOildrop === 0n
    ? []
    : [{ amount: lampBalanceOildrop, acquired_epoch: currentEpoch, is_locked: false }];
  const attribution = { attribution_root: "", last_event_epoch: 0n, total_events: 0n };

  if (inputs.vaultType === "Instant") {
    // Thứ tự khoá = thứ tự trường (`Data.Object` mã hoá theo LƯỢC ĐỒ, không theo khoá ở đây,
    // nhưng giữ cùng thứ tự để đọc đối chiếu với `validate_mint_vault_id` được).
    const d: InstantVaultDatum = {
      owner:                 ownerCred,
      lamp_balance:          lampBalanceOildrop,
      lamp_locked:           0n,
      loyalty_holdings:      holdings,
      magic_batches:         [],
      next_batch_index:      0n,
      wakeme_link:           wakemeLink, // PIN: rỗng HOẶC đúng 32 byte
      gen_schedules:         [],
      profile,
      profile_changed_epoch: 0n,
      pending_profile:       null,
      last_updated_epoch:    0n,
      cap_epoch:             0n,        // PIN: `expect vd.cap_epoch == 0`
      activity_state:        { recent_burn_epochs: [], consumed_credit: WAKEME_SEED_CREDIT },
      cap_nanogic:           0n,        // PIN: `expect vd.cap_nanogic == 0`
      personal_delegate:     null,
      attribution,
      instant_unlock_ms:     0n,        // PIN: `expect vd.instant_unlock_ms == 0`
      usage_window:          emptyWindow(),
      usage_window_epoch:    0n,
    };
    return d;
  }

  const d: VaultDatum = {
    owner:                 ownerCred,
    lamp_balance:          lampBalanceOildrop,
    lamp_locked:           0n,
    loyalty_holdings:      holdings,
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [],
    profile,
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    0n,
    delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    // Schedule ghim 0 (Instant ghim hạt giống) — hai cổng đúc ghim HAI giá trị khác nhau.
    activity_state:        { recent_burn_epochs: [], consumed_credit: 0n },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution,
    usage_window:          emptyWindow(),
    usage_window_epoch:    0n,
  };
  return d;
}
