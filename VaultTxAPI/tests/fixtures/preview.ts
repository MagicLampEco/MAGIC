// VaultTxAPI/tests/fixtures/preview.ts — hằng THẬT của Preview + bộ dựng datum.
//
// Địa chỉ, script hash, NFT danh-tính và unit LAMP dưới đây là BẢN CHÉP CÓ NHÃN, chép từ
// `VaultReadAPI/tests/fixtures/preview-e5fd34b1.ts` (ghi từ chuỗi Preview 2026-09-11, tx
// e5fd34b1b58e291437d419b8a7dbd8f0d508a911e722d91dae76a38cf22ebd76). Chép sang đây thay
// vì nhập từ gói kia là CÓ CHỦ ĐÍCH: hai gói đứng cạnh nhau, không gói nào phụ thuộc gói
// nào — VaultReadAPI cố ý ĐỌC-THÔI và nối một đường dựng tx vào nó là phá đúng thuộc tính
// khiến nó an toàn.
//
// Vì sao dùng số THẬT: một địa chỉ bech32 bịa sẽ không qua `CML.Address.from_bech32`, nên
// phép kiểm sẽ phải bỏ luôn bước giải mã địa chỉ — đúng bước cần kiểm nhất.
//
// DATUM thì KHÔNG chép: mọi datum ở đây đi qua `Data.to(..., VaultDatumSchema)` của
// MagicSDK, nên lược đồ đổi hình là mẫu đổi theo và phép kiểm nói cho biết. Một chuỗi CBOR
// gõ tay sẽ đóng băng ở hình dạng cũ và vẫn xanh sau khi datum thật đã trôi.

import { Data } from "@lucid-evolution/lucid";
import {
  InstantVaultDatumSchema, VaultDatumSchema, buildInitialVaultDatum,
} from "@magiclamp/sdk";

export const VAULT_ADDRESS = "addr_test1wpm2t24x02y7lkqw3f8yyarz5j844x8a3jzsx9wcrv5900cv2wj6x";
export const VAULT_SCRIPT_HASH = "76a5aaa67a89efd80e8a4e427462a48f5a98fd8c850315d81b2857bf";
export const VAULT_ID_UNIT =
  VAULT_SCRIPT_HASH + "f45cfae55ac7f579420d5758cceb15a35f178486d003c31aaa9391a466f181a6";

/** Địa chỉ shard Preview — chỉ dùng làm khoá tra trong bảng UTxO ghi sẵn. */
export const SHARD_ADDRESS = "addr_test1wpm2t24x02y7lkqw3f8yyarz5j844x8a3jzsx9wcrv5900cv2wj6x";

/**
 * Policy id TỔNG HỢP, cố ý không phải một giá trị có thật trên mạng nào.
 *
 * 🪦 Bản trước dùng `28e916b0…`. Đó là một policy id CÓ THẬT trên Preview/Preprod, và
 * nó nằm trong danh sách chặn của `MagicSDK/src/lampPolicy.ts` ▸
 * `NON_LAMP_LOOKALIKE_POLICIES`: chính sách chữ-ký-đơn suy từ khoá một ví triển khai,
 * đã đúc cả "LAMP", "tLAMP", "CARP" và "MAGIC". Một fixture cầm đúng giá trị bị chặn là
 * một fixture dạy sai — nó là chỗ người ta chép đi khi cần "một policy id để thử".
 *
 * Giá trị dưới đây không mang thông tin nào ngoài hình dạng (56 hex), và đó là toàn bộ
 * thứ các bài kiểm của gói này cần: không bài nào tra tài sản theo policy THẬT.
 */
export const LAMP_POLICY_ID = "f1".repeat(28);
/** "tLAMP" — apply-param #2 theo mạng. Mainnet phải là "LAMP" (`4c414d50`). */
export const LAMP_ASSET_NAME_HEX = "744c414d50";
export const LAMP_UNIT = LAMP_POLICY_ID + LAMP_ASSET_NAME_HEX;

export const OWNER_PKH = "2e5e1418afd402e48232b143876104cac6188a44b867ffb7538318f4";
export const OTHER_OWNER_PKH = "11".repeat(28);

/** Địa chỉ enterprise của OWNER_PKH trên Preview — nơi nhận tiền thừa. */
export const OWNER_ENTERPRISE_ADDRESS_PREFIX = "addr_test1v";

export const INPUT_TX_HASH = "e5fd34b1b58e291437d419b8a7dbd8f0d508a911e722d91dae76a38cf22ebd76";

export interface BatchSpec {
  id: string;
  createdEpoch: bigint;
  amountNanogic: bigint;
  decayWindow?: bigint;
}

export interface DatumSpec {
  ownerPkh?: string;
  /** Chủ `Credential` đầy đủ; có thì thắng `ownerPkh`. */
  owner?: { type: "key" | "script"; hash: string };
  lampBalanceOildrop?: bigint;
  lampLockedOildrop?: bigint;
  batches?: BatchSpec[];
  consumedCreditNanogic?: bigint;
  lastUpdatedEpoch?: bigint;
  genScheduleCount?: number;
  /**
   * Đặt giá trị ⟹ dựng datum hình dạng **Instant** (18 trường) với
   * `instant_unlock_ms` bằng đúng giá trị đó. Bỏ trống ⟹ hình dạng **Schedule**
   * (17 trường), nơi trường này KHÔNG TỒN TẠI.
   *
   * Hai hình dạng phải dựng bằng HAI lược đồ khác nhau chứ không phải một lược đồ
   * cộng một trường tuỳ chọn: giải mã Plutus Data của Aiken nghiêm ngặt về SỐ
   * TRƯỜNG theo cả hai chiều, nên một mẫu 18 trường đọc bằng lược đồ 17 sẽ hỏng
   * đúng như trên chuỗi. Đó chính là thuộc tính cần mẫu này giữ.
   */
  instantUnlockMs?: bigint;
}

function batch(spec: BatchSpec): Record<string, unknown> {
  return {
    batch_id: spec.id,
    source: "Schedule",
    created_epoch: spec.createdEpoch,
    initial_amount: spec.amountNanogic,
    current_amount: spec.amountNanogic,
    decay_window: spec.decayWindow ?? 1n,
    profile_at_creation: null,
    contract_id: null,
    halved: false,
  };
}

function genSchedule(i: number): Record<string, unknown> {
  return {
    schedule_id: `${(0xa0 + i).toString(16)}`.repeat(32).slice(0, 64),
    commit_epoch: 20_700n,
    start_fire_epoch: 20_702n,
    end_fire_epoch: 20_711n,
    schedule_length: 10n,
    lamp_per_epoch: 7_000_000n,
    rate_locked_q: 8_000_000_000n,
    baseline_at_commit_q: 8_000_000_000n,
    multiplier_at_commit_q: 1_000_000_000n,
    fired_count: 0n,
    auto_burn_target: null,
  };
}

/** Datum đầy đủ, dựng bằng LƯỢC ĐỒ THẬT rồi ghi đè các trường phép kiểm quan tâm. */
export function datumHex(spec: DatumSpec = {}): string {
  const base = buildInitialVaultDatum({
    ...(spec.owner !== undefined ? { owner: spec.owner } : { ownerPkh: spec.ownerPkh ?? OWNER_PKH }),
    lampBalanceOildrop: spec.lampBalanceOildrop ?? 1_001_000_000n,
    profile: "Flame",
    currentEpoch: 20_700n,
  }) as unknown as Record<string, unknown>;

  const full = {
    ...base,
    lamp_locked: spec.lampLockedOildrop ?? 2_000_000n,
    magic_batches: (spec.batches ?? []).map(batch),
    gen_schedules: Array.from({ length: spec.genScheduleCount ?? 0 }, (_, i) => genSchedule(i)),
    last_updated_epoch: spec.lastUpdatedEpoch ?? 20_700n,
    activity_state: {
      ...(base.activity_state as Record<string, unknown>),
      consumed_credit: spec.consumedCreditNanogic ?? 0n,
    },
  };

  if (spec.instantUnlockMs === undefined) {
    return Data.to(full as never, VaultDatumSchema);
  }
  return Data.to(
    { ...full, instant_unlock_ms: spec.instantUnlockMs } as never,
    InstantVaultDatumSchema,
  );
}
