// lib/constants.ak — GenMAGIC v3.3 Protocol Constants (ScheduleGen)
// Normative §19.6. Tiers marked per spec.

pub const q : Int = 1_000_000_000   // [Immutable]

// KHÔNG có hằng độ dài epoch ở đây, CỐ Ý — nó là THAM SỐ THEO MẠNG (Preview 86_400
// slot, Mainnet/Preprod 432_000). Validator nhận `ms_per_epoch` qua apply-param;
// offchain tra `SLOTS_PER_EPOCH_BY_NETWORK` trong `ProtocolUtils/src/index.ts`.
// (`slots_per_epoch = 432_000` đã xoá 2026-08-09: 0 call site, sai với Preview.)

// ── SnapshotGen base rate (used to compute rate_locked_q at commit) ──
//
// 🔴 NHÃN `[Constitutional]` NAY LÀ NHÃN CỦA MỘT GIAI ĐOẠN, KHÔNG PHẢI CỦA HẰNG NÀY.
// Chủ dự án chốt 2026-09-12: suất sinh `ρ` **không được là hằng biên dịch**
// (`SPEC` ▸ `INV-RATE-GOVERNED`). Giá trị dưới đây là bản đang chạy của
// **giai đoạn 1 — tình thế, để chạy được chuỗi nghiệm thu**, không phải đích.
//
// Vì sao một hằng biên dịch là SAI LOẠI HỘP ở đây, chứ không phải sai con số:
// giá trị đúng của `ρ` phụ thuộc **mức LAMP tham gia** và **cầu dịch vụ thực** —
// hai đại lượng không ai biết lúc deploy. Số đo: ở trần tham gia 20% cung
// (7,2×10⁹ LAMP), suất này phát ~4,2×10⁹ MAGIC mỗi năm; dưới neo của chủ dự án
// (1 MAGIC ≈ giá mint một cây) đó là một lượng dịch vụ thực không nền kinh tế nào
// trong tầm nhìn hấp thụ nổi. Ở mức tham gia nhỏ thì cùng con số này lại quá ít.
// Không tồn tại một hằng nào đúng cho cả hai đầu.
//
// Đích (giai đoạn 2, mở khi `did_commit` sống — `SPEC` §13): nội sinh, zero oracle
//   ρ_{e+1} = clamp( ρ_e · D_e / G_e , ρ_e/2 , ρ_e·2 )
// với `D` = MAGIC đã tiêu cross-DID, `G` = MAGIC đã phát. Nó tự đúng dấu với giá
// LAMP mà KHÔNG đọc giá: giá lên ⟹ nhiều người khoá LAMP ⟹ `G` tăng ⟹ `ρ` giảm.
//
// ĐỪNG đọc `[Constitutional]` thành "đã chốt, đừng đụng". Đọc nó thành: đổi giá trị
// này hôm nay vẫn là đổi script hash, nên nó phải đổi CÙNG lúc chuyển sang tham số
// quản trị, không đổi lẻ.
pub const snapshot_base_rate_q : Int = 5_000_000_000  // [Giai-đoạn-1, sẽ thành tham số quản trị]

// ── S(L) piecewise segments (§11.3, §19.6) [Constitutional] ──────────
pub const s_seg1_intercept_q : Int = 1_500_000_000   // 1.5
pub const s_seg1_slope_q     : Int = 10_000_000       // 0.010 per L
pub const s_seg2_knee        : Int = 50               // L=50 boundary
pub const s_seg2_intercept_q : Int = 2_000_000_000   // 2.0
pub const s_seg2_slope_q     : Int = 5_000_000        // 0.005 per (L-50)
pub const s_seg3_knee        : Int = 150              // L=150 boundary
pub const s_seg3_intercept_q : Int = 2_500_000_000   // 2.5
pub const s_seg3_slope_q     : Int = 2_500_000        // 0.0025 per (L-150)

// ── Schedule length (§19.6) [Significant] ────────────────────────────
pub const schedule_min_length : Int = 10
pub const schedule_max_length : Int = 200

// ── λ minimum (§19.6) [Routine] ──────────────────────────────────────
pub const min_lamp_per_fire : Int = 1_000_000   // 1 LAMP in oildrop

// ── Schedule delay (commit → first fire) [Constitutional] ─────────────
pub const schedule_delay : Int = 2   // epochs

// ── Schedule batch cliff [Constitutional] ────────────────────────────
pub const schedule_decay_window : Int = 1   // cliff at k=1
// GIỮ NGUYÊN 1 — chủ dự án chốt 2026-09-15, và chốt bằng lý do SẢN PHẨM, không phải
// lý do kỹ thuật: *"MAGIC không dùng sẽ mất đi giống như ánh nắng không dùng sẽ mất
// đi, chứ không thể mang sang ngày hôm sau tiêu được."*
//
// Đây là hằng số mà người dùng cuối phải hiểu được, nên nó bị khoá bởi thứ đắt hơn
// một lần biên dịch: một lời hứa đã phát ra. Ai định nâng nó lên vì lý do kỹ thuật
// (cho người dùng đỡ lỡ nhịp, cho bài nghiệm thu dễ chạy) thì đang đổi một câu
// giải thích được lấy một câu phải giải thích — hỏi chủ dự án trước.
//
// Hai hệ quả phải cầm theo khi đọc con số này, cả hai đều phản trực giác:
//
// (1) MỘT epoch là một khoảng THỜI GIAN KHÁC NHAU theo mạng. `ms_per_epoch` của
//     PREVIEW là 86_400_000 (1 ngày); Preprod và mainnet là 432_000_000 (5 ngày).
//     Cùng hằng số này cho ra cửa tiêu ~1 ngày trên Preview và ~5 ngày trên hai mạng
//     kia. Nên một bài nghiệm thu chật vật trên PREVIEW KHÔNG có nghĩa người dùng
//     mainnet cũng chật vật, và ngược lại — đừng suy một bên ra bên kia.
//
//     Chữ "testnet" ở dòng này trước đây gộp Preview với Preprod, và nay gộp thế là
//     SAI: Preprod đổi 1 ngày → 5 ngày ngày 2026-09-20, đúng để lối suy trên không
//     còn cần thiết ở đó. Preprod phải đo ra cùng con số với mainnet, vì nó là nơi
//     người ngoài tập việc. Preview thì cố ý giữ nén, để vòng kiểm thử chạy nhanh.
//
// (2) Cộng với `schedule_delay = 2` ở ngay trên, một vòng đời trọn vẹn của lịch
//     trải qua ít nhất ba epoch: commit, chờ, rồi fire-và-tiêu-trong-cùng-epoch.
//     Vế cuối là vế hẹp: batch sinh ra ở `validate_fire` và chết ở cuối epoch đó
//     (`validators/vault.ak` ▸ `validate_fire`, chỗ đặt `expires_at_epoch`), còn
//     nhánh đốt nằm ở `validators/vault.ak` ▸ `validate_burn_batch`. Fire hôm nay
//     mà tiêu hôm sau là mất trắng — không có nhánh nào cứu, và đó là chủ ý.

// ── Catch-up limit [Routine] ─────────────────────────────────────────
pub const max_fires_per_tx_catchup : Int = 8

// ── System limits [Routine] ──────────────────────────────────────────
pub const max_gen_schedules     : Int = 20
pub const max_batches_per_vault : Int = 32
// Hạ 64 → 40 ngày 2026-09-14. 64 nằm TRÊN trần vật lý: một vault chạm trần cũ
// thì KHÔNG tiêu được, và fire là nhánh duy nhất hạ được `lamp_locked`.
//
// KHÔNG chép số đo xuống đây. Bản trước của khối này chép, rồi bản vá cho Nợ #48 đo lại
// và ĐẢO hai kết luận — chỗ chép thì không ai báo cho, nên nó nằm đây nói ngược
// với chính tệp nó trỏ tới, suốt từ lúc vá. Đó là bản sao chết im lặng, đúng lớp
// mà `BOUNDARIES.md` cảnh báo, và lần này nó chết ở nơi người ta tra để chọn trần.
//
// Một nguồn duy nhất cho số đo, cách đo, thang đo, và mốc kích hoạt phần còn nợ:
// `validators/vault.ak` ▸ khối "Chi phí ExUnit theo TRỤC `loyalty_holdings`", ngay trên
// `t_fire_datum_n`. Đo lại là một lệnh `aiken check`.
pub const max_loyalty_holdings  : Int = 40

// ── Shard [Constitutional] ────────────────────────────────────────────
pub const shard_count : Int = 16
// shard_cap = 4.5 × 10^14 oildrop = 450,000,000 LAMP per shard
// = TOTAL_LAMP × SCHEDULE_PARTICIPATION_CAP_BPS / (10000 × shard_count)
// = 36×10^15 × 2000 / 160000 = 4.5×10^14
pub const shard_cap : Int = 450_000_000_000_000

// ══ BẢN CHÉP CÓ NHÃN từ InstantGen/onchain/lib/magiclamp/protocol/constants.ak @ 1e9a72d9 ══
// Toán Gen v2.0 (`gen_formula.ak`) cần các hằng dưới đây. Sửa một bên phải sửa bên kia
// cùng commit (BOUNDARIES P8); bài so giá trị: ScheduleGen/tests/genFormulaMirror.test.ts.
// Chưa validator ScheduleGen nào đọc các hằng này ⟹ hash vault/shard không đổi.
// `instant_scale_horizon` chép chỉ vì `gen_formula.ak` và bài của nó dẫn tới; horizon của
// ScheduleGen là `min(N, 6)` theo từng hợp đồng (SPEC §6.1.4), không phải một hằng.

// TẠM (`LENT_PP_CAP`, Spec §12 "chốt sau") — trần phần sinh từ LAMP-mượn, nanogic/epoch.
// Dùng ở `gen_formula.lamp_base_amount`.
pub const lent_pp_cap : Int = 1_000_000_000   // nanogic = 1 MAGIC/epoch

// ── Gen v2.0 — công thức sinh chung F(L, usage_ratio, GB) (SPEC §6.1.1–§6.1.3, §11) ──
// Hàm dùng các hằng này: `gen_formula.ak`. Mọi hằng dưới đây là hằng BIÊN DỊCH:
// đổi = đổi bytes ⟹ đổi hash ⟹ đổi địa chỉ vault ⟹ deploy lại (SPEC §6.1.5).
// PHẢI trùng BIT với khối cùng tên trong `offchain/src/constants.ts` (P8).

// TẠM — sàn hệ số tiêu thụ, 0.5Q (`CC-GEN-USAGE-FLOOR`, SPEC §13). Mức khởi động lạnh
// KHÔNG có hằng riêng: nó suy từ sàn (`gen_formula.usage_factor_coldstart_q`).
pub const usage_factor_floor_q : Int = 500_000_000

// TẠM — độ phủ lịch sử của `scale_limit`, = Q (`CC-GEN-SCALE-COVERAGE`, SPEC §13).
pub const scale_coverage_q : Int = 1_000_000_000

// Hình dạng cửa sổ `usage_window`: đúng 7 ô — ô 0 là epoch ĐANG MỞ, ô 1..6 là 6 epoch
// ĐÃ ĐÓNG (SPEC §6.1.2 "6 epoch đã qua" + "một cặp tích luỹ của epoch đang mở").
pub const usage_window_len : Int = 7

// `horizon` của `scale_limit` cho InstantGen (SPEC §6.1.4 bảng: InstantGen = 6).
pub const instant_scale_horizon : Int = 6

// TẠM — phần mỗi vault được rút trên một lần đặt lại shard GB, 0.05Q
// (`CC-GEN-GB-VAULT-SHARE`, SPEC §6.1.3 · §13).
pub const gb_vault_share_q : Int = 50_000_000

// TẠM — trần mỗi shard GB mỗi lần đặt lại, nanogic (`CC-GEN-SURPLUS-SHARD`).
// Dẫn xuất SPEC §6.1.3: ⌊ SHARD_CAP × generation_rate_q / Q ⌋ ở suất tạm 4·10⁹
// = ⌊ 4.5×10¹⁴ × 4×10⁹ / 10⁹ ⌋ = 1.8×10¹⁵. Bài `gen_shard_cap_matches_derivation`
// (gen_formula.ak) tính lại. Bản ở GenBeacons là APPLY-PARAM `gb_shard_cap_nanogic`
// của `gb_shard` (`GenBeacons/onchain/validators/gb_shard.ak`) — hai chỗ giữ cùng giá
// trị, đổi một thì đổi cả hai.
pub const gb_shard_cap_nanogic : Int = 1_800_000_000_000_000

// TẠM — số epoch shard GB ứng trước cho hợp đồng ScheduleGen lúc ký (SPEC §6.4, §11).
// InstantGen không dùng; khai ở đây để bộ hằng Gen v2.0 đủ một chỗ cho lượt ScheduleGen.
pub const buffer_ep : Int = 2

// TẠM — trần cứng của ρ (Q-format) (`INV-RATE-GOVERNED`, `CC-GEN-RATE-VALUE`, SPEC §13).
// Chép có nhãn từ apply-param `rho_max_q` của `GenBeacons/onchain/validators/rate_param.ak`
// (TẠM 4_000_000_000, chép 2026-09-30 @ 04f8a43d). Ở gói (a) chỉ dùng làm cận trên cho
// vector tràn số; nối vào validator là việc của gói sau.
pub const rho_max_q : Int = 4_000_000_000
