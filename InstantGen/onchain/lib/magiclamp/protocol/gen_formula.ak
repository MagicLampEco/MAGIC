// lib/gen_formula.ak — công thức sinh chung Gen v2.0 `F(L, usage_ratio, GB)`
// (SPEC §6.1.1–§6.1.3, INV-MAGIC-CITIZEN).
//
// Hàm THUẦN, chưa nối vào validator nào (gói (a)). Validator sẽ gọi ở gói sau.
//
// Quy tắc làm tròn (SPEC §6.1.1 "Tuần tự sàn"): mỗi VẾ là một chuỗi bước `⌊× / Q⌋`
// riêng, không nhân gộp rồi chia. Hai chỗ SPEC tự viết một phép chia duy nhất và mã
// giữ đúng như thế: `usage_ratio_q = ⌊Σc × Q / Σg⌋` và
// `scale_limit = ⌊Σg × Q / (horizon × scale_coverage_q)⌋`.
// Aiken `/` trên Int là chia SÀN; mọi đầu vào đã bị ép ≥ 0 nên sàn = cắt.
//
// Dấu: mọi đầu vào âm ⟹ `fail` (hình dạng lạ thì ném, KHÔNG kẹp về 0 — kẹp trong hàm
// toán che mất chỗ GHI đang thủng). Bản TS ném Error ở đúng các chỗ đó.
//
// P8: `offchain/src/genFormula.ts` gương từng hàm, trùng BIT. Vector `TV-GEN-*` chép
// literal giống hệt ở `tests/vectors.ts`.

use aiken/collection/list
use magiclamp/protocol/constants.{
  gb_shard_cap_nanogic, gb_vault_share_q, instant_scale_horizon, lent_pp_cap, q,
  rho_max_q, scale_coverage_q, usage_factor_floor_q, usage_window_len,
}
use magiclamp/protocol/math.{min2}

/// Một ô của cửa sổ `usage_window` (SPEC §6.1.2): nanogic sinh và nanogic đốt
/// (BurnBatch) của vault trong MỘT epoch.
///
/// Kiểu này CHƯA vào datum ở gói (a). Khi vào datum (gói sau), thứ tự trường
/// `generated, consumed` là hợp đồng nhị phân (constr 0, hai trường).
pub type EpochUsage {
  generated: Int,
  consumed: Int,
}

fn usage_non_negative(u: EpochUsage) -> Bool {
  u.generated >= 0 && u.consumed >= 0
}

/// Cửa sổ hợp lệ: đúng `usage_window_len` (7) ô, mọi ô không âm.
/// Ô 0 = epoch ĐANG MỞ; ô 1..6 = 6 epoch ĐÃ ĐÓNG, ô 1 là epoch vừa qua.
pub fn window_well_formed(window: List<EpochUsage>) -> Bool {
  list.length(window) == usage_window_len && list.all(window, usage_non_negative)
}

/// `(Σ generated, Σ consumed)` trên ô 1..6 — 6 epoch ĐÃ QUA, KHÔNG gồm epoch hiện tại
/// (SPEC §6.1.2). Cửa sổ sai hình dạng ⟹ fail.
pub fn closed_window_totals(window: List<EpochUsage>) -> (Int, Int) {
  expect window_well_formed(window)
  expect [_open, ..closed] = window
  list.foldl(
    closed,
    (0, 0),
    fn(u, acc) {
      let (g, c) = acc
      (g + u.generated, c + u.consumed)
    },
  )
}

// ── Lõi theo tổng (dùng chung, để `amount_by_lamp` chỉ duyệt cửa sổ MỘT lần) ──

fn ratio_from_totals(total_generated: Int, total_consumed: Int) -> Int {
  if total_generated == 0 {
    0
  } else {
    min2(q, total_consumed * q / total_generated)
  }
}

fn factor_from_totals(total_generated: Int, total_consumed: Int) -> Int {
  if total_generated == 0 {
    usage_factor_coldstart_q()
  } else {
    usage_factor_floor_q + ( q - usage_factor_floor_q ) * ratio_from_totals(
      total_generated,
      total_consumed,
    ) / q
  }
}

fn scale_from_totals(total_generated: Int, horizon: Int, base: Int) -> Int {
  if horizon <= 0 {
    // SPEC không định nghĩa horizon ≤ 0 (InstantGen = 6, ScheduleGen = min(N, 6) với
    // N ≥ schedule_min_length). Mẫu số = 0 ⟹ fail-closed: không phần nào trên sàn.
    0
  } else if total_generated == 0 {
    // Khởi động lạnh (CC-GEN-COLD-START): không ràng buộc.
    base
  } else {
    total_generated * q / ( horizon * scale_coverage_q )
  }
}

// ── API ─────────────────────────────────────────────────────────────────────

/// SPEC §6.1.1:
///   lamp_base_amount = ⌊L_owned × ρ / Q⌋ + min(⌊L_lent × ρ / Q⌋, LENT_PP_CAP)
/// Làm tròn: sàn RIÊNG từng vế rồi mới cộng (không `⌊(L_owned + L_lent)·ρ/Q⌋`).
/// Đơn vị: oildrop × Q-format ⟹ nanogic/epoch. Đầu vào âm ⟹ fail.
/// `rho_q = 0` (epoch trước epoch hiệu lực đầu tiên của beacon ρ) ⟹ 0.
pub fn lamp_base_amount(l_owned: Int, l_lent: Int, rho_q: Int) -> Int {
  expect l_owned >= 0 && l_lent >= 0 && rho_q >= 0
  l_owned * rho_q / q + min2(l_lent * rho_q / q, lent_pp_cap)
}

/// Điểm giữa dải `[sàn, Q]` (CC-GEN-COLD-START): `sàn + ⌊(Q − sàn) / 2⌋`.
/// Viết theo sàn, không gõ hằng riêng — đổi sàn thì mức trung tính đi theo.
pub fn usage_factor_coldstart_q() -> Int {
  usage_factor_floor_q + ( q - usage_factor_floor_q ) / 2
}

/// SPEC §6.1.2: `0` nếu Σg = 0, ngược lại `min(Q, ⌊Σc × Q / Σg⌋)` — MỘT phép chia.
/// Σ lấy trên ô 1..6. Kẹp `≤ Q` là phòng thủ (SPEC "Kẹp ≤ Q").
pub fn usage_ratio_q(window: List<EpochUsage>) -> Int {
  let (g, c) = closed_window_totals(window)
  ratio_from_totals(g, c)
}

/// SPEC §6.1.1: coldstart nếu Σg = 0, ngược lại
/// `sàn + ⌊(Q − sàn) × usage_ratio_q / Q⌋` — sàn trên TỶ LỆ ĐÃ SÀN (hai bước).
pub fn usage_factor_q(window: List<EpochUsage>) -> Int {
  let (g, c) = closed_window_totals(window)
  factor_from_totals(g, c)
}

/// SPEC §6.1.1: `base` nếu Σg = 0 (không ràng buộc), ngược lại
/// `⌊Σg × Q / (horizon × scale_coverage_q)⌋` — MỘT phép chia.
/// `horizon ≤ 0` ⟹ 0 (fail-closed, SPEC không định nghĩa). `base` âm ⟹ fail.
pub fn scale_limit(window: List<EpochUsage>, horizon: Int, base: Int) -> Int {
  expect base >= 0
  let (g, _c) = closed_window_totals(window)
  scale_from_totals(g, horizon, base)
}

/// SPEC §6.1.1:
///   amount_by_lamp = ⌊base × sàn / Q⌋ + ⌊min(base, scale_limit) × (uf − sàn) / Q⌋
/// Làm tròn: sàn RIÊNG hai vế, và `uf` đã sàn ở bước của nó (không gộp
/// `⌊base × uf / Q⌋`). Cửa sổ duyệt MỘT lần.
/// `horizon ≤ 0` ⟹ 0 (fail-closed); đầu vào sai hình dạng ⟹ fail TRƯỚC nhánh đó.
/// Cận vật lý: kết quả ≤ base (vì uf ≤ Q), nên Σ ≤ Σ L × ρ (INV-ORACLE-INDEP).
pub fn amount_by_lamp(
  l_owned: Int,
  l_lent: Int,
  window: List<EpochUsage>,
  rho_q: Int,
  horizon: Int,
) -> Int {
  let base = lamp_base_amount(l_owned, l_lent, rho_q)
  let (g, c) = closed_window_totals(window)
  if horizon <= 0 {
    0
  } else {
    let factor = factor_from_totals(g, c)
    let limit = scale_from_totals(g, horizon, base)
    base * usage_factor_floor_q / q + min2(base, limit) * (
      factor - usage_factor_floor_q
    ) / q
  }
}

/// SPEC §6.1.1: `amount = min(amount_by_lamp, GB_available)` — `GB` là TRẦN, không
/// nhân (CC-GEN-GB-ROLE). `GB_available = 0` ⟹ 0 (luật "không có giao dịch cấp 0"
/// nằm ở validator). Đầu vào âm ⟹ fail (beacon mang số tự nhiên).
pub fn generation_amount(amount_by_lamp: Int, gb_available: Int) -> Int {
  expect amount_by_lamp >= 0 && gb_available >= 0
  min2(amount_by_lamp, gb_available)
}

/// SPEC §6.1.3: trần rút của MỘT vault trong MỘT epoch trên shard GB:
/// `⌊reset_amount × gb_vault_share_q / Q⌋`. Âm ⟹ fail.
pub fn gb_vault_share(reset_amount: Int) -> Int {
  expect reset_amount >= 0
  reset_amount * gb_vault_share_q / q
}

/// Dịch cửa sổ từ epoch `from_epoch` (epoch của ô 0) sang `to_epoch`:
/// k = to − from; thêm `min(k, 7)` ô 0 vào ĐẦU rồi cắt còn 7 (SPEC §6.1.2 "điền 0 cho
/// epoch không có giao dịch"). k = 0 ⟹ giữ nguyên. k < 0 (thời gian lùi) ⟹ fail.
pub fn shift_window(
  window: List<EpochUsage>,
  from_epoch: Int,
  to_epoch: Int,
) -> List<EpochUsage> {
  expect window_well_formed(window)
  let k = to_epoch - from_epoch
  expect k >= 0
  if k == 0 {
    window
  } else {
    list.take(
      list.concat(
        list.repeat(EpochUsage { generated: 0, consumed: 0 }, min2(k, usage_window_len)),
        window,
      ),
      usage_window_len,
    )
  }
}

/// Cộng vào ô 0 (epoch đang mở). Âm ⟹ fail.
/// Ghi chú: bắn bù ScheduleGen ghi vào ô của epoch danh nghĩa `e'` (SPEC §6.1.2) —
/// hàm đó thuộc lượt ScheduleGen, không có ở đây.
pub fn window_add(
  window: List<EpochUsage>,
  generated: Int,
  consumed: Int,
) -> List<EpochUsage> {
  expect window_well_formed(window)
  expect generated >= 0 && consumed >= 0
  expect [open, ..closed] = window
  [
    EpochUsage {
      generated: open.generated + generated,
      consumed: open.consumed + consumed,
    },
    ..closed
  ]
}

// ════════════════════════════════════════════════════════════════════════════
// Bài `fail`: thân trả True với MỌI giá trị trả về (`x * 0 == 0`, `length >= 0`),
// vì Aiken tính cả thân trả False là "fail" — so `== 0` thì trả số khác 0 cũng xanh.
// Vector chuẩn TV-GEN-* — CÙNG SỐ, literal giống hệt `tests/vectors.ts` (P8).
// Chung: Q = 10⁹, sàn = 5×10⁸, coldstart = 7.5×10⁸, ρ = 4×10⁹ (suất tạm), LENT_PP_CAP = 10⁹.
// L1000 = 1000 LAMP = 1_000_000_000 oildrop ⟹ base = 4_000_000_000.
// Cửa sổ viết [ô0, ô1, …, ô6] dưới dạng cặp (generated, consumed).
// ════════════════════════════════════════════════════════════════════════════

fn win(cells: List<(Int, Int)>) -> List<EpochUsage> {
  list.map(
    cells,
    fn(p) {
      let (g, c) = p
      EpochUsage { generated: g, consumed: c }
    },
  )
}

const w_cold: List<(Int, Int)> =
  [(0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)]

const w_cold_open: List<(Int, Int)> =
  [(5_000_000_000, 5_000_000_000), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)]

const w_zero_use: List<(Int, Int)> =
  [(0, 0), (6_000_000_000, 0), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)]

const w_full: List<(Int, Int)> =
  [(0, 0), (6_000_000_000, 6_000_000_000), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)]

const w_partial: List<(Int, Int)> =
  [
    (0, 0), (5_000_000_000, 3_000_000_000), (3_000_000_000, 0), (0, 0), (0, 0),
    (0, 0), (0, 0),
  ]

const w_over: List<(Int, Int)> =
  [(0, 0), (2_000_000_000, 3_000_000_000), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)]

const w_round: List<(Int, Int)> =
  [(0, 0), (3, 1), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)]

const w_last_cell: List<(Int, Int)> =
  [(0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (4_000_000_000, 1_000_000_000)]

const w_full_big: List<(Int, Int)> =
  [(0, 0), (30_000_000_000, 30_000_000_000), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)]

const w_scale_round: List<(Int, Int)> =
  [(0, 0), (7, 0), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)]

const w_seq: List<(Int, Int)> =
  [(1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7)]

// ── TV-GEN-BASE-* : lamp_base_amount ────────────────────────────────────────

test tv_gen_base_owned() {
  lamp_base_amount(1_000_000_000, 0, 4_000_000_000) == 4_000_000_000
}

// LENT-BELOW ↔ LENT-CAP chỉ khác l_lent: dưới trần ⟹ cộng đủ; trên trần ⟹ kẹp 10⁹.
test tv_gen_base_lent_below() {
  lamp_base_amount(1_000_000_000, 100_000_000, 4_000_000_000) == 4_400_000_000
}

test tv_gen_base_lent_knee() {
  lamp_base_amount(1_000_000_000, 250_000_000, 4_000_000_000) == 5_000_000_000
}

test tv_gen_base_lent_cap() {
  lamp_base_amount(1_000_000_000, 1_001_000_000, 4_000_000_000) == 5_000_000_000
}

// Sàn RIÊNG từng vế: ⌊1.5⌋ + ⌊1.5⌋ = 2; bản gộp ⌊3⌋ = 3.
test tv_gen_base_floor_per_term() {
  lamp_base_amount(1, 1, 1_500_000_000) == 2
}

test tv_gen_base_rho_zero() {
  lamp_base_amount(1_000_000_000, 1_001_000_000, 0) == 0
}

test tv_gen_base_negative_owned_rejected() fail {
  lamp_base_amount(-1, 0, 4_000_000_000) * 0 == 0
}

test tv_gen_base_negative_lent_rejected() fail {
  lamp_base_amount(0, -1, 4_000_000_000) * 0 == 0
}

test tv_gen_base_negative_rho_rejected() fail {
  lamp_base_amount(1, 0, -1) * 0 == 0
}

// ── TV-GEN-USAGE-* : usage_ratio_q, usage_factor_q ──────────────────────────

test tv_gen_coldstart_is_midpoint() {
  usage_factor_coldstart_q() == 750_000_000
}

test tv_gen_usage_cold() {
  and {
    usage_ratio_q(win(w_cold)) == 0,
    usage_factor_q(win(w_cold)) == 750_000_000,
  }
}

// Ô 0 (epoch đang mở) KHÔNG vào cửa sổ ⟹ vẫn khởi động lạnh.
test tv_gen_usage_cold_open_ignored() {
  and {
    usage_ratio_q(win(w_cold_open)) == 0,
    usage_factor_q(win(w_cold_open)) == 750_000_000,
  }
}

// ZERO-USE ↔ COLD: chỉ khác Σg ⟹ sàn, không phải trung tính.
test tv_gen_usage_zero_use() {
  and {
    usage_ratio_q(win(w_zero_use)) == 0,
    usage_factor_q(win(w_zero_use)) == 500_000_000,
  }
}

// FULL ↔ ZERO-USE: chỉ khác Σc.
test tv_gen_usage_full() {
  and {
    usage_ratio_q(win(w_full)) == 1_000_000_000,
    usage_factor_q(win(w_full)) == 1_000_000_000,
  }
}

test tv_gen_usage_partial() {
  and {
    usage_ratio_q(win(w_partial)) == 375_000_000,
    usage_factor_q(win(w_partial)) == 687_500_000,
  }
}

// Σc > Σg (phòng thủ): kẹp Q.
test tv_gen_usage_over_clamped() {
  and {
    usage_ratio_q(win(w_over)) == 1_000_000_000,
    usage_factor_q(win(w_over)) == 1_000_000_000,
  }
}

test tv_gen_usage_round() {
  and {
    usage_ratio_q(win(w_round)) == 333_333_333,
    usage_factor_q(win(w_round)) == 666_666_666,
  }
}

// Ô 6 (epoch xa nhất còn trong cửa sổ) CÓ được đếm.
test tv_gen_usage_last_cell() {
  and {
    usage_ratio_q(win(w_last_cell)) == 250_000_000,
    usage_factor_q(win(w_last_cell)) == 625_000_000,
  }
}

test tv_gen_window_short_rejected() fail {
  usage_ratio_q(win([(0, 0), (1, 1), (0, 0), (0, 0), (0, 0), (0, 0)])) * 0 == 0
}

test tv_gen_window_long_rejected() fail {
  usage_ratio_q(
    win([(0, 0), (1, 1), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)]),
  ) * 0 == 0
}

test tv_gen_window_negative_rejected() fail {
  usage_ratio_q(win([(0, 0), (1, -1), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)])) * 0 == 0
}

test tv_gen_window_negative_open_rejected() fail {
  usage_ratio_q(win([(-1, 0), (1, 1), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0)])) * 0 == 0
}

// ── TV-GEN-SCALE-* : scale_limit ────────────────────────────────────────────

test tv_gen_scale_cold_unbound() {
  scale_limit(win(w_cold), 6, 4_000_000_000) == 4_000_000_000
}

test tv_gen_scale_cold_open_unbound() {
  scale_limit(win(w_cold_open), 6, 4_000_000_000) == 4_000_000_000
}

test tv_gen_scale_ig() {
  scale_limit(win(w_full), 6, 4_000_000_000) == 1_000_000_000
}

test tv_gen_scale_h3() {
  scale_limit(win(w_full), 3, 4_000_000_000) == 2_000_000_000
}

test tv_gen_scale_h0() {
  scale_limit(win(w_full), 0, 4_000_000_000) == 0
}

test tv_gen_scale_round() {
  scale_limit(win(w_scale_round), 6, 100) == 1
}

test tv_gen_scale_negative_base_rejected() fail {
  scale_limit(win(w_full), 6, -1) * 0 == 0
}

// ── TV-GEN-AMOUNT-* : amount_by_lamp (ρ = 4×10⁹, horizon 6 trừ khi ghi) ───────

// Khởi động lạnh: 0.75 × base, scale_limit không ràng buộc.
test tv_gen_amount_cold() {
  amount_by_lamp(1_000_000_000, 0, win(w_cold), 4_000_000_000, 6) == 3_000_000_000
}

// Có lịch sử mà tiêu 0: 0.5 × base.
test tv_gen_amount_zero_use() {
  amount_by_lamp(1_000_000_000, 0, win(w_zero_use), 4_000_000_000, 6) == 2_000_000_000
}

// scale_limit (10⁹) < base (4×10⁹) ⟹ ràng buộc.
test tv_gen_amount_scale_binds() {
  amount_by_lamp(1_000_000_000, 0, win(w_full), 4_000_000_000, 6) == 2_500_000_000
}

// Hàng xóm chỉ khác l_owned: base 8×10⁸ < scale_limit ⟹ không ràng buộc, = base.
test tv_gen_amount_scale_free_small_l() {
  amount_by_lamp(200_000_000, 0, win(w_full), 4_000_000_000, 6) == 800_000_000
}

// Hàng xóm chỉ khác cửa sổ: lịch sử lớn ⟹ scale_limit 5×10⁹ ≥ base ⟹ = base.
test tv_gen_amount_scale_free_big_history() {
  amount_by_lamp(1_000_000_000, 0, win(w_full_big), 4_000_000_000, 6) == 4_000_000_000
}

test tv_gen_amount_lent_below() {
  amount_by_lamp(1_000_000_000, 100_000_000, win(w_cold), 4_000_000_000, 6) == 3_300_000_000
}

// LENT_PP_CAP ràng buộc (chỉ khác l_lent với ca trên).
test tv_gen_amount_lent_cap() {
  amount_by_lamp(1_000_000_000, 1_001_000_000, win(w_cold), 4_000_000_000, 6) == 3_750_000_000
}

// horizon = 0 ⟹ 0 (fail-closed). Chỉ khác horizon với SCALE-BINDS.
test tv_gen_amount_horizon_zero() {
  amount_by_lamp(1_000_000_000, 0, win(w_full), 4_000_000_000, 0) == 0
}

// Sàn tuần tự: ⌊3×5e8/Q⌋ + ⌊3×2.5e8/Q⌋ = 1 + 0 = 1; bản gộp ⌊3×7.5e8/Q⌋ = 2.
test tv_gen_amount_round_seq() {
  amount_by_lamp(3, 0, win(w_cold), 1_000_000_000, 6) == 1
}

// Tràn số: 36×10¹⁵ oildrop (trần cung LAMP) × rho_max_q — tích trung gian 1.44×10²⁶.
test tv_gen_amount_overflow() {
  and {
    rho_max_q == 4_000_000_000,
    lamp_base_amount(36_000_000_000_000_000, 0, 4_000_000_000) == 144_000_000_000_000_000,
    amount_by_lamp(36_000_000_000_000_000, 0, win(w_cold), 4_000_000_000, 6) == 108_000_000_000_000_000,
  }
}

test tv_gen_amount_bad_window_rejected_even_h0() fail {
  amount_by_lamp(1, 0, win([(0, 0)]), 4_000_000_000, 0) * 0 == 0
}

test tv_gen_ig_horizon_is_six() {
  instant_scale_horizon == 6
}

// ── TV-GEN-GB-* : generation_amount ─────────────────────────────────────────

test tv_gen_gb_binds() {
  generation_amount(3_000_000_000, 1_000_000_000) == 1_000_000_000
}

test tv_gen_gb_free() {
  generation_amount(3_000_000_000, 5_000_000_000) == 3_000_000_000
}

test tv_gen_gb_equal() {
  generation_amount(3_000_000_000, 3_000_000_000) == 3_000_000_000
}

test tv_gen_gb_zero() {
  generation_amount(3_000_000_000, 0) == 0
}

test tv_gen_gb_negative_rejected() fail {
  generation_amount(3_000_000_000, -1) * 0 == 0
}

test tv_gen_gb_negative_amount_rejected() fail {
  generation_amount(-1, 5) * 0 == 0
}

// ── TV-GEN-VAULT-SHARE-* : gb_vault_share ───────────────────────────────────

test tv_gen_vault_share_cap() {
  gb_vault_share(1_800_000_000_000_000) == 90_000_000_000_000
}

test tv_gen_vault_share_round() {
  and {
    gb_vault_share(19) == 0,
    gb_vault_share(20) == 1,
    gb_vault_share(0) == 0,
  }
}

test tv_gen_vault_share_negative_rejected() fail {
  gb_vault_share(-1) * 0 == 0
}

test gen_shard_cap_matches_derivation() {
  // ⌊ SHARD_CAP × generation_rate_q(tạm) / Q ⌋, SPEC §6.1.3.
  gb_shard_cap_nanogic == 450_000_000_000_000 * 4_000_000_000 / q
}

// ── TV-GEN-SHIFT-* : shift_window (từ epoch 100) ────────────────────────────

test tv_gen_shift_k0() {
  shift_window(win(w_seq), 100, 100) == win(w_seq)
}

test tv_gen_shift_k1() {
  shift_window(win(w_seq), 100, 101) == win(
    [(0, 0), (1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6)],
  )
}

test tv_gen_shift_k6() {
  shift_window(win(w_seq), 100, 106) == win(
    [(0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (0, 0), (1, 1)],
  )
}

test tv_gen_shift_k7() {
  shift_window(win(w_seq), 100, 107) == win(w_cold)
}

test tv_gen_shift_k100() {
  shift_window(win(w_seq), 100, 200) == win(w_cold)
}

test tv_gen_shift_backwards_rejected() fail {
  list.length(shift_window(win(w_seq), 100, 99)) >= 0
}

test tv_gen_shift_bad_window_rejected() fail {
  list.length(shift_window(win([(0, 0)]), 100, 100)) >= 0
}

// ── TV-GEN-ADD-* : window_add ───────────────────────────────────────────────

test tv_gen_add_open_cell() {
  window_add(win(w_seq), 10, 3) == win(
    [(11, 4), (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7)],
  )
}

test tv_gen_add_negative_rejected() fail {
  list.length(window_add(win(w_seq), 10, -1)) >= 0
}
