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

// ── Catch-up limit [Routine] ─────────────────────────────────────────
pub const max_fires_per_tx_catchup : Int = 8

// ── System limits [Routine] ──────────────────────────────────────────
pub const max_gen_schedules     : Int = 20
pub const max_batches_per_vault : Int = 32
// Hạ 64 → 40 ngày 2026-09-14. 64 nằm TRÊN trần vật lý: một vault chạm trần cũ
// thì KHÔNG tiêu được, và fire là nhánh duy nhất hạ được `lamp_locked`.
//
// KHÔNG chép số đo xuống đây. Bản trước của khối này chép, rồi bản vá #48 đo lại
// và ĐẢO hai kết luận — chỗ chép thì không ai báo cho, nên nó nằm đây nói ngược
// với chính tệp nó trỏ tới, suốt từ lúc vá. Đó là bản sao chết im lặng, đúng lớp
// mà `BOUNDARIES.md` cảnh báo, và lần này nó chết ở nơi người ta tra để chọn trần.
//
// Một nguồn duy nhất cho số đo, cách đo, thang đo, và mốc kích hoạt phần còn nợ:
// `validators/vault.ak` ▸ khối "Trần ExUnit của hai nhánh mang LAMP", ngay trên
// `t_fire_datum_n`. Đo lại là một lệnh `aiken check`.
pub const max_loyalty_holdings  : Int = 40

// ── Shard [Constitutional] ────────────────────────────────────────────
pub const shard_count : Int = 16
// shard_cap = 4.5 × 10^14 oildrop = 450,000,000 LAMP per shard
// = TOTAL_LAMP × SCHEDULE_PARTICIPATION_CAP_BPS / (10000 × shard_count)
// = 36×10^15 × 2000 / 160000 = 4.5×10^14
pub const shard_cap : Int = 450_000_000_000_000
