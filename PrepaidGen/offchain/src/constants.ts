// src/constants.ts — PrepaidGen constants
// Sinh đôi của onchain/lib/magiclamp/protocol/constants.ak (P8).
// MỌI số lượng là bigint (C-OVERFLOW) — cấm Number cho carpdrop/nanogic.

export const Q = 1_000_000_000n;

// CARP dùng 9 chữ số thập phân, BẰNG MAGIC — chủ nhân chốt 2026-09-05, khớp
// `nanothread = CARP × 10⁹` ở `BOUNDARIES.md`. Bản trước ghi 10⁶ kèm nhãn
// [CẦN XÁC NHẬN] và nhãn đó nay đã được trả lời.
export const CARPDROP_PER_CARP = 1_000_000_000n; // CARP decimals = 9
export const NANOGIC_PER_MAGIC = 1_000_000_000n; // MAGIC decimals = 9 (§11)

/**
 * par_scale = NANOGIC_PER_MAGIC / CARPDROP_PER_CARP.
 * 1 CARP khoá → đúng 1 MAGIC (C-PP-1).
 *
 * Hai thang bằng nhau ⟹ PAR_SCALE = 1, tức quy đổi là PHÉP ĐỒNG NHẤT. Hệ quả
 * đổi NGỮ NGHĨA chứ không chỉ đổi số: chiều MAGIC→CARP (`parCarpFromMagic`)
 * trước đây SÀN và cố ý lệch về phía an toàn cho quỹ; nay nó chính xác tuyệt
 * đối, không còn phần dư nào để mất. Ngày nào một trong hai token đổi decimals
 * thì hằng này đổi theo, và cái sàn kia sống lại.  [Constitutional]
 */
export const PAR_SCALE = 1n;

// ── Hình dạng batch (§4.1, §4.2) ─────────────────────────────
export const BATCH_SOURCE_PREPAID = 3n; // §4.1: 1=Instant 2=Schedule 3=Prepaid
export const PREPAID_DECAY_WINDOW = 1n; // cliff  [Constitutional]
export const PREPAID_PROFILE = 0n; // PrepaidGen không dùng tư-cách

// ── Sàn số lượng ──────────────────────────────────────────────
export const MIN_LOCK_CARPDROP = 1_000_000_000n; // 1 CARP
export const MIN_DRAW_CARPDROP = 1_000_000n; // 0.001 CARP = giá 1 op CID (§7.2)

// ── Trần hệ thống (§11) ───────────────────────────────────────
export const MAX_BATCHES_PER_VAULT = 32;
export const MAX_PREPAID_CREDITS = 20;

// ── Quỹ Paid (Carpet-CARP-DacTa-Vi.md §5.1 F2) ────────────────
export const BPS_DENOM = 10_000n;
export const MIN_BUFFER_BPS = 1_500n; // buffer-Paid ≥ 15%  [Constitutional]

// ── Constructor index (§11) ───────────────────────────────────
// ConsumeMAGIC ghim `burn_batch_constr` cho từng vault. PrepaidGen = 2, đồng
// nhất với InstantGen/ScheduleGen.  [CẦN XÁC NHẬN — §11 chưa có dòng PrepaidGen]
export const BURN_BATCH_CONSTR = 2;

// ── Cấu hình mạng: CARP ───────────────────────────────────────
// CHỦ QUYỀN CỦA NHÀ CarpetMint. Kho này KHÔNG được tự đặt, tự suy, tự điền.
//
// Trạng thái đo ngày 2026-09-11 (số do nhà CarpetMint phát, thư trả lời cùng
// ngày):
//   Preprod — CÓ CARP, policy + asset name bên dưới.
//   Preview — KHÔNG CÓ CARP. Instance duy nhất sống ở Preview là LACE, khác
//             vai (BASE) và khác token. Điền policy LACE vào đây là dựng một
//             quỹ Paid không bao giờ nhìn thấy đồng CARP nào.
//   Mainnet — CHƯA DEPLOY.
// Đo lại bằng: hỏi nhà CarpetMint (họ giữ nguồn), rồi đối chiếu on-chain
//   `curl "$BLOCKFROST_URL/assets/<policy><asset_name>"` trên đúng mạng đó.
//
// Bản trước của khối này viết "tCARP đã đúc thật trên cả hai testnet" và điền
// ba giá trị KHÔNG khớp nguồn nào: hai policy lạ, cộng asset name `43415250`
// = hex ASCII của chuỗi "CARP". `carp_asset_name` KHÔNG phải ticker mã hoá —
// nó là một băm 28 byte. Nhầm đó qua được mọi phép kiểm cũ vì phép kiểm cũ
// ghim đúng con số sai.

/** Ba mạng PrepaidGen biết tới. Trùng khoá với `MS_PER_EPOCH` bên dưới. */
export type CarpNetwork = "Mainnet" | "Preview" | "Preprod";

/**
 * `null` = CHƯA CÓ CARP trên mạng đó. Không có giá trị nào thay thế được, và
 * chuỗi rỗng KHÔNG phải giá trị thay thế — xem `carpAssetClass()`.
 */
export const CARP_POLICY_ID: Record<CarpNetwork, string | null> = {
  Mainnet: null, // chưa deploy (2026-09-11)
  Preview: null, // KHÔNG CÓ CARP trên Preview (2026-09-11)
  Preprod: "4967df00c7e038fc7ce2abdc1e6d4c946342ffa905e059ab861dffc2",
};

/** Băm 28 byte do nhà CarpetMint phát. KHÔNG phải hex của "CARP"/"tCARP". */
export const CARP_ASSET_NAME: Record<CarpNetwork, string | null> = {
  Mainnet: null,
  Preview: null,
  Preprod: "30cb6a6b6a1c9746bf9eb081d914d96ede4c4c13e661404678a933a6",
};

/** 28 byte = 56 ký tự hex — độ dài của cả policy id lẫn asset name CARP. */
const HEX28 = /^[0-9a-f]{56}$/;

/**
 * Cửa DUY NHẤT để lấy cặp (policy, asset name) của CARP. FAIL-CLOSED: mạng
 * chưa có CARP thì NÉM, không trả chuỗi rỗng, không trả giá trị mặc định.
 *
 * Vì sao là hàm chứ không phải hằng: một `?? ""` ở nơi gọi biến "chưa có CARP"
 * thành "có CARP tên rỗng", và `assets.quantity_of(value, "", "")` trên chuỗi
 * trả về 0 một cách im lặng — đúng hình dạng cái vỏ im lặng. Ném ở đây làm
 * đường Preview DỪNG với một câu người đọc hành động được.
 */
export function carpAssetClass(
  network: CarpNetwork,
): { policyId: string; assetName: string } {
  const policyId = CARP_POLICY_ID[network];
  const assetName = CARP_ASSET_NAME[network];
  if (policyId === null || assetName === null) {
    throw new Error(
      `PrepaidGen: mạng ${network} CHƯA CÓ CARP (đo 2026-09-11, nguồn: nhà ` +
        `CarpetMint). PrepaidGen khoá CARP thật nên không có đường chạy nào ` +
        `trên mạng này — nghiệm thu PrepaidGen phải chạy trên Preprod. ` +
        `TUYỆT ĐỐI không điền policy của LACE (instance khác, vai BASE) vào ` +
        `chỗ của CARP để "cho nó chạy".`,
    );
  }
  if (!HEX28.test(policyId)) {
    throw new Error(
      `PrepaidGen: carp_policy_id của ${network} phải là 56 ký tự hex ` +
        `thường (28 byte), đang là ${policyId.length} ký tự: "${policyId}".`,
    );
  }
  if (!HEX28.test(assetName)) {
    throw new Error(
      `PrepaidGen: carp_asset_name của ${network} phải là 56 ký tự hex ` +
        `thường (28 byte, một BĂM do nhà CarpetMint phát), đang là ` +
        `${assetName.length} ký tự: "${assetName}". Nếu giá trị này là hex ` +
        `của chuỗi "CARP"/"tCARP" thì nó là ticker mã hoá, không phải asset ` +
        `name — đó đúng là lỗi đã vá ngày 2026-09-11.`,
    );
  }
  return { policyId, assetName };
}

// Nhịp epoch của GIAO THỨC — phải trùng `MS_PER_EPOCH_BY_NETWORK` ở
// `ProtocolUtils/src/index.ts` (đó là nguồn; bảng này là bản chép có nhãn vì
// PrepaidGen chưa nạp ProtocolUtils). Preprod nén 5× so với mạng thật (5 ngày),
// giao thức chạy 1 ngày để một vòng hết hạn gói trọn trong một ngày kiểm thử.
// Đổi số ở đây là đổi apply-param ⟹ đổi script hash. Chép ngày 2026-09-05.
export const MS_PER_EPOCH = {
  Mainnet: 432_000_000n,   // 5 ngày — trùng nhịp mainnet
  Preview: 86_400_000n,    // 1 ngày — trùng nhịp mạng Preview
  Preprod: 86_400_000n,    // 1 ngày — ĐỒNG HỒ NÉN 5×, mạng thật là 5 ngày
} as const;
