// lib/math.ak — Q-format arithmetic (§6.1, §11)
// Aiken `/` on Int is floor division. Every Q-format formula is applied as a
// chain of SEQUENTIAL ⌊× / Q⌋ steps — never one fused multiply-then-divide —
// so the rounding error stays bounded at ≤ 1 nanogic per step (L4).
//
// P8: offchain/src/math.ts mirrors every function here bit-for-bit.

use magiclamp/protocol/constants.{
  br_safe_q, f_cap_surplus_q, instant_rate_q, instant_reward_rate_q,
  pm_q_ember, q, s_seg1_intercept_q, s_seg1_slope_q, s_seg2_intercept_q,
  s_seg2_knee, s_seg2_slope_q, s_seg3_intercept_q, s_seg3_knee,
  s_seg3_slope_q, schedule_min_length, snapshot_base_rate_q, um_max_q,
}

// ── §6.1 Core Q operations ───────────────────────────────────

/// apply_multiplier: multiply x by a Q-format multiplier
/// Error: ≤ 1 nanogic per call (L4)
pub fn apply_multiplier(x: Int, m_q: Int) -> Int {
  x * m_q / q
}

/// multiply_q: multiply two Q-format values. Result is also Q-format.
pub fn multiply_q(a_q: Int, b_q: Int) -> Int {
  a_q * b_q / q
}

/// Compute batch age k = current_epoch - created_epoch
/// Fails if current_epoch < created_epoch (C-DECAY-2)
pub fn batch_age(created_epoch: Int, current_epoch: Int) -> Int {
  let k = current_epoch - created_epoch
  expect k >= 0
  k
}

/// Clamp value to [lo, hi] inclusive
pub fn clamp(x: Int, lo: Int, hi: Int) -> Int {
  if x < lo {
    lo
  } else if x > hi {
    hi
  } else {
    x
  }
}

pub fn min2(a: Int, b: Int) -> Int {
  if a < b {
    a
  } else {
    b
  }
}

pub fn min3(a: Int, b: Int, c: Int) -> Int {
  min2(min2(a, b), c)
}

// ══════════════════════════════════════════════════════════════
// §6.3 InstantGen — magnitude keyed to MAGIC ALREADY CONSUMED
// ══════════════════════════════════════════════════════════════
//
//   cấp thực = min( reward(consumed), cap_surplus(br), cap_pp(L_avail) )
//
// Holding LAMP OPENS the door (eligibility, C-INST-1/C-INST-3) and now also
// SIZES the third brake — but it still does not move: I-ACT-7 keeps every
// LAMP-bearing field byte-identical across the transaction. The brake reads
// the balance, it does not spend it.

// ── reward(consumed) ─────────────────────────────────────────
//
//   reward = ⌊ ⌊ ⌊ consumed × R_reward / Q ⌋ × UM / Q ⌋ × PM / Q ⌋
//
// 3 sequential floor steps. `result ≤ true value` — ĐÚNG, mọi hạng tử sai số ≥ 0.
//
// 🔴 CẬN SAI SỐ: `< 3,94` nanogic, KHÔNG phải `≤ 3`. Bản trước của dòng này viết
// "≤ 3 nanogic" ở CẢ HAI phía P8 (`math.ts` cùng câu) — sửa 2026-09-12.
//
// Vì sao "3 bước sàn ⟹ ≤ 3 ulp" KHÔNG áp được ở đây: quy tắc đó chỉ đúng khi mọi
// hệ số ĐỨNG SAU một bước sàn đều ≤ 1. Bước 2 nhân `um_q/Q ≤ 2,0` (`constants.ak`
// ▸ `um_max_q`) — nó GIÃN, nên nó khuếch đại sai số của bước 1 lên gấp đôi.
//
//   Δ = α·(um_q/Q)(pm_q/Q) + β·(pm_q/Q) + γ,  mọi hạng tử ≥ 0
//   α = frac(consumed·R/Q) = frac(consumed/5) ≤ 0,8   (R = 2×10⁸)
//   β < 1 ;  γ = frac(s2·23/20) ≤ 19/20 = 0,95        (pm_q ≤ 1,15×10⁹)
//   ⟹ Δ ≤ 0,8×2×1,15 + 1×1,15 + 0,95 = 3,94
//
// Hệ quả kinh tế ~0 (3,94×10⁻⁹ MAGIC). Ghi ra vì không bài kiểm nào đỏ được cho một
// chú thích, nên nó sống sót mọi cổng — và nó là loại câu người sau trích lại làm
// bằng chứng. Cùng lỗi, cùng nguyên nhân, ở `compute_cap_surplus`: hệ số bước 2 tới
// 8,5× nên cận bên đó là `< 6,44` nanogic.
//
// INV-CASHBACK-BOUND (reward ≤ consumed) holds by parameter construction:
//   R_reward × UM_MAX × PM_MAX = 0.20 × 2.00 × 1.15 = 0.46 < 1
// and each floor step only ever lowers the result.
//
// 🔴 `PM_MAX = 1.15` là trần của HỆ SỐ HỒ SƠ HOẠT ĐỘNG (`ActivityProfile`), một
// enum BA mức đóng: `pm_q_ember 1.15` · `pm_q_flame 1.05` · `pm_q_lantern 1.00`
// (`constants.ak:69-71`, ánh xạ ở `vault.ak` ▸ `get_pm_q`). Nó KHÔNG phải hệ số
// tư-cách §6.2 — thứ đó là `eligibility_q ∈ [1.00×, 2.50×]` (`Eligibility/…/math.ak`
// ▸ `eligibility_q`) và nó KHÔNG được nối vào đây.
//
// Vì sao phải viết ra: nối tư-cách vào chỗ này thì bất biến trên thành
// `0.20 × 2.00 × 2.50 = 1.00`, tức HOÀ VỐN — cấp lại đúng bằng số đã tiêu, và
// vòng tiêu-rồi-được-hoàn thôi hội tụ. Hai hệ số cùng mang chữ "multiplier", cùng
// định dạng Q, cùng nhân vào một biểu thức; không dấu hiệu nào trong kiểu phân biệt
// được chúng, và không bài kiểm nào đỏ nếu ai đó hoán chỗ. Chú thích cũ ở dòng
// `pm_q` gọi thẳng nó là "tư-cách, §6.2" — đúng cái nhầm mà bất biến này không chịu nổi.
pub fn compute_reward_from_consumed(
  consumed : Int, // nanogic already burned and not yet rewarded
  um_q     : Int, // Q-format UM (after the C-UM-6 stale check)
  pm_q     : Int, // hệ số hồ sơ hoạt động, enum ba mức ≤ 1.15 — KHÔNG phải tư-cách §6.2
) -> Int {
  let s1 = consumed * instant_reward_rate_q / q // step 1
  let s2 = s1 * um_q / q // step 2
  s2 * pm_q / q // step 3
}

// ── cap_surplus(br) — surplus-backing gate ───────────────────
//
//   xanh (br >  br_safe):  cap = f · S · (br − br_safe) / br_safe
//   đỏ   (br ≤  br_safe):  cap = 0                       (khoá Gen)
//
// Applied as sequential floors:
//   s1 = ⌊ S  × f_q        / Q ⌋          -- f·S
//   s2 = ⌊ s1 × (br−safe)  / Q ⌋          -- f·S·(br−br_safe)
//   s3 = ⌊ s2 × Q / br_safe_q ⌋           -- ÷ br_safe
//
// `br_q` and `magic_supply` come from the BackingBeacon reference input; a
// missing/stale/depegged beacon never reaches this function — the validator
// rejects the tx first (fail-closed, no default br).
//
// ══ CÔNG THỨC NÀY LÀ GÌ, nói bằng một câu (chứng minh 2026-09-12) ══
//
// `cap_surplus = f × ΔS_max`, với `ΔS_max` là KHOẢNG TRỐNG CÒN LẠI TỚI SÀN:
//   `ΔS_max = max{ ΔS : B/(S+ΔS) ≥ br_safe } = S·(br − br_safe)/br_safe`
// Chứng minh: `B/(S+ΔS) ≥ br_safe ⟺ B ≥ br_safe(S+ΔS)` (nhân `S+ΔS > 0`, giữ chiều)
//   `⟺ ΔS ≤ B/br_safe − S ⟺ ΔS ≤ S(br−br_safe)/br_safe` (thay `B = br·S`). Đẳng thức
//   ĐẠT ĐƯỢC ⟹ đây là cận CHẶT, không phải cận lỏng.
// Đối chứng bằng vector có sẵn `TV-IG-CAP-SURPLUS-01` (`InstantGen/tests/vectors.ts`):
//   `S = 1000 MAGIC`, `br = 2,0` → `33_333_333_333` nanogic; và `2000/(1000+333,33…)`
//   `= 1,5 = br_safe` đúng chạm sàn.
//
// Bổ đề đứng được là NHỜ `B` KHÔNG đổi khi gen (`I-ACT-7`: LAMP đứng yên, chỉ đọc
// reference input). Ngày nào gen chạm được `B` thì bổ đề chết và `f` mất hết nghĩa.
//
// ⚠️ `f = 0,10` MỘT MÌNH KHÔNG GIỮ ĐƯỢC SÀN. Beacon là reference input ⟹ đọc mà
// KHÔNG trừ dần. `N` lần gen trong cùng một epoch đều đọc cùng `br₀` và mỗi lần lấy
// `f·H₀` ⟹ tổng `N·f·H₀ > H₀` khi **`N > 1/f = 10`**. Quá 10 lượt là THỦNG SÀN, và
// không cần chiếm oracle nào — chỉ cần 11 vault thật gọi trong cùng epoch.
// Phanh cho việc đó là `INV-SURPLUS-RATION` (16 shard, `SPEC` §6.3), KHÔNG phải hàm
// này. 🔴 Đo 2026-09-12: `grep -rn 'shard\|SHARD' InstantGen --include=*.ak
// --include=*.ts` → **0 kết quả**; 16-shard mới chỉ có trong `DESIGN-PHASE2.md`,
// `FEAT.md`, `EXEC.md`. Nên hôm nay đây là trần MỖI-LƯỢT-GỌI, không phải trần toàn
// mạng — đừng đọc tên `cap_surplus` thành một bảo đảm nó chưa có.
//
// SAI SỐ ba bước sàn: `Δ = α·E/br_safe + β·Q/br_safe + γ < 6,44` nanogic, độc lập
// `S`, và luôn THIẾU-không-thừa (`c ≤ T`, mọi hạng tử ≥ 0). Cùng cơ chế đã làm cận
// của `compute_reward_from_consumed` lớn hơn "3 ulp": bước 2 nhân `E/Q ≤ 8,5` — nó
// GIÃN. Bước 3 NHÂN-trước-CHIA là thứ giữ sai số nhỏ, không phải thứ làm nó lớn:
// viết chia-trước (`⌊s2/br_safe⌋·Q`) thì lượng tử hoá nhảy lên 1 MAGIC và mọi vault
// dưới ~15 MAGIC cung nhận cap = 0.
pub fn compute_cap_surplus(br_q: Int, magic_supply: Int) -> Int {
  if br_q <= br_safe_q {
    0
  } else {
    let excess_q = br_q - br_safe_q
    let s1 = magic_supply * f_cap_surplus_q / q
    let s2 = s1 * excess_q / q
    s2 * q / br_safe_q
  }
}

// ── S_Q mirror — present ONLY to re-derive `instant_rate_q` ──
//
// This is ScheduleGen's `compute_s_q`, copied byte for byte
// (`ScheduleGen/onchain/lib/magiclamp/protocol/math.ak` ▸ `compute_s_q`).
// InstantGen never calls it at validation time — the one value it needs is a
// compile-time constant. It lives here so a TEST can recompute that constant
// from the segment constants instead of trusting a literal, which is the only
// thing that makes the copy self-checking rather than a second source that
// dies quietly.
//
// `l` is a schedule LENGTH IN EPOCHS. Not a LAMP amount. See constants.ak.
pub fn compute_s_q(l: Int) -> Int {
  if l <= s_seg2_knee {
    s_seg1_intercept_q + s_seg1_slope_q * l
  } else if l <= s_seg3_knee {
    s_seg2_intercept_q + s_seg2_slope_q * ( l - s_seg2_knee )
  } else {
    s_seg3_intercept_q + s_seg3_slope_q * ( l - s_seg3_knee )
  }
}

/// Re-derivation of `instant_rate_q` from first constants. A test pins this
/// against the literal; if ScheduleGen ever moves a segment constant and the
/// mirror in constants.ak is updated without the literal, the test goes red.
pub fn instant_rate_q_derived() -> Int {
  snapshot_base_rate_q * compute_s_q(schedule_min_length) / q
}

// ── Third brake — the LAMP the vault actually has available ──
//
//   cap_pp = ⌊ ⌊ L_avail × instant_rate_q / Q ⌋ / 2 ⌋
//
// L_avail is in oildrop (`lamp_balance − lamp_locked`), the result in nanogic.
//
// WHAT CHANGED AND WHY (D2). The previous form summed the vault's live
// ScheduleGen contracts and halved that. Two things were wrong with it:
//
//   1. It read 0 for a vault with no schedule, so `min3` returned 0 and
//      InstantGen could not issue on any network. That was recorded as a
//      fail-closed default, but a permanent 0 is not a default — it is an
//      off switch nobody meant to leave on.
//   2. Worse, the documented replacement (SPEC §6.3, `RATE_REF_Q = 10¹²`)
//      pays 10⁹ nanogic per LAMP per epoch, against the 8×10⁶ per LAMP a
//      shortest-length ScheduleGen commitment pays. Whoever fixed (1) by
//      following the spec would have opened a 125× spread between two doors
//      onto the same LAMP — and nothing in the code would have said so,
//      because the door only exists once InstantGen works at all.
//
// So the rate is `instant_rate_q`, pinned to the least generous rate
// ScheduleGen grants (derivation in constants.ak). The `/2` is kept from the
// old dual ceiling: an InstantGen lock lasts one epoch while a schedule locks
// for at least ten, so the shorter commitment paying strictly less is the
// intended direction, not a rounding artefact.
//
// The floor is applied in two steps rather than one fused
// `l_avail * rate / (q * 2)`: §6.1 requires each Q-format step to floor on its
// own, and the fused form rounds differently at odd multiples.
/// 🔴 HỆ SỐ `/2` — MỘT TRONG HAI CHÂN LÝ DO ĐÃ CHẾT 2026-09-12. ĐỌC TRƯỚC KHI GỠ.
///
/// Bản thiết kế ghi `0.5×` có **hai** vai, không phải một:
///   (1) giữ Instant < Schedule để **kênh tích-backing** sống — Schedule khoá LAMP
///       ⟹ GreenBack mua LAMP ⟹ `B` tăng; Instant không bơm backing, nên nếu Instant
///       được full `pp` thì ai cũng chọn Instant, Schedule chết, `br` yếu.
///   (2) chặn cá voi hút cạn `cap_surplus`.
///
/// **Vai (1) KHÔNG CÒN HIỆU LỰC.** `INV-BACKING-NO-LAMP` (chốt 2026-09-12) cấm LAMP
/// vào `B`, và `SPEC` §6.4 bước (3) đã sửa: LAMP GreenBack mua là **tồn kho**, dùng
/// đỡ giá, không vào mẫu số của `br`. Không còn "kênh tích-backing" nào để giữ sống.
///
/// **Vai (2) VẪN ĐỨNG, và nay nó là chân DUY NHẤT đỡ hệ số này.**
///
/// Viết ra đây vì đây đúng hình dạng hỏng-im-lặng: lý do (1) nằm trong một biên bản
/// thiết kế, hệ số nằm trong mã, và không có gì nối hai chỗ. Ai đọc biên bản đó sau
/// này sẽ thấy một lý do đã chết mà trông như còn sống — rồi gỡ `0.5×` bằng lập luận
/// "kênh tích-backing không còn thì hệ số này vô nghĩa", trong khi vai (2) chưa được
/// thay bằng gì. Gỡ hệ số này đòi **thay vai (2) trước**, không phải bác vai (1).
pub fn compute_cap_pp(l_avail_oildrop: Int) -> Int {
  let per_epoch = l_avail_oildrop * instant_rate_q / q
  per_epoch / 2
}

// ── The whole gate ───────────────────────────────────────────
pub fn compute_instant_grant(
  consumed        : Int,
  um_q            : Int,
  pm_q            : Int,
  br_q            : Int,
  magic_supply    : Int,
  l_avail_oildrop : Int,
) -> Int {
  min3(
    compute_reward_from_consumed(consumed, um_q, pm_q),
    compute_cap_surplus(br_q, magic_supply),
    compute_cap_pp(l_avail_oildrop),
  )
}

// ══════════════════════════════════════════════════════════════
// Tests — D2: the rate InstantGen pays is ScheduleGen's floor
// ══════════════════════════════════════════════════════════════

// The literal in constants.ak must equal the value re-derived from the S_Q
// segment constants. This is what makes the mirrored block self-checking: move
// a segment constant without moving the literal and this goes red.
test ig_instant_rate_q_matches_derivation() {
  instant_rate_q_derived() == instant_rate_q
}

/// Ghim CÂU TRẢ LỜI cho câu hỏi "`cap_surplus` là gì" — không phải ghim một con số.
///
/// Ba vế, cố ý tách rời để khi đỏ thì biết ĐỎ Ở VẾ NÀO:
///   1. `cap` khớp vector chuẩn `TV-IG-CAP-SURPLUS-01`;
///   2. `cap × 10` LẤP ĐÚNG khoảng trống tới sàn — đây là mệnh đề "cap_surplus =
///      f × khoảng-trống", viết thành thứ máy kiểm được thay vì thành văn xuôi;
///   3. `cap × 1001` VƯỢT khoảng trống — tức `N > 1/f = 1000` lượt gen trong cùng
///      một epoch là thủng sàn. Vế này là SỐ ĐO của một lỗ đang mở
///      (`INV-SURPLUS-RATION` chưa có mã), không phải một lời cảnh báo.
///
/// Bài này neo theo `f_cap_surplus_q` chứ không theo số 10 hay 1000: khi `f` hạ
/// 0,10 → 0,001 (2026-09-14) thì hệ số ở vế 2/3 đi theo, và ĐÓ LÀ ĐIỂM — mệnh đề
/// được ghim là "cap = f × khoảng-trống", không phải "cap = một phần mười".
///
/// Vế 3 sẽ vẫn XANH sau khi 16-shard được hiện thực — nó nói về `compute_cap_surplus`
/// đứng một mình, và hàm này đúng là không giữ được sàn một mình. Đừng đọc nó xanh
/// thành "lỗ đã vá".
test cap_surplus_is_f_times_headroom_to_floor() {
  let supply = 1_000_000_000_000
  // 1000 MAGIC
  let br = 2_000_000_000
  // 2,0
  let cap = compute_cap_surplus(br, supply)
  // Khoảng trống tới sàn: S·(br − br_safe)/br_safe = 1000 × 0,5/1,5 MAGIC
  let headroom = supply * ( br - br_safe_q ) / br_safe_q
  // n = 1/f, suy THẲNG từ hằng — không gõ tay, để bài tự đi theo khi `f` đổi.
  let n = q / f_cap_surplus_q
  and {
    cap == 333_333_333,
    headroom == 333_333_333_333,
    n == 1000,
    headroom - cap * n >= 0,
    headroom - cap * n < n,
    cap * ( n + 1 ) > headroom,
  }
}

// S_Q values quoted in ScheduleGen's own comments. If the mirror drifts from
// the original these stop matching the numbers ScheduleGen documents.
test ig_s_q_matches_schedulegen_table() {
  and {
    compute_s_q(10) == 1_600_000_000,
    compute_s_q(50) == 2_000_000_000,
    compute_s_q(100) == 2_250_000_000,
    compute_s_q(150) == 2_500_000_000,
    compute_s_q(200) == 2_625_000_000,
  }
}

// S_Q is increasing in schedule length. The whole argument for pinning
// InstantGen at `S_Q(schedule_min_length)` is that this is the FLOOR of
// ScheduleGen's range — which is only true if the function is monotone.
test ig_s_q_is_monotone_so_min_length_is_the_floor() {
  and {
    compute_s_q(schedule_min_length) <= compute_s_q(11),
    compute_s_q(49) <= compute_s_q(50),
    compute_s_q(50) <= compute_s_q(51),     // knee 1
    compute_s_q(149) <= compute_s_q(150),
    compute_s_q(150) <= compute_s_q(151),   // knee 2
    compute_s_q(199) <= compute_s_q(200),
  }
}

// 1 LAMP = 10⁶ oildrop ⟹ 10⁶ × 8×10⁹ / 10⁹ = 8×10⁶, halved = 4×10⁶ nanogic
// = 0,004 MAGIC per LAMP per epoch.
test ig_cap_pp_one_lamp() {
  compute_cap_pp(1_000_000) == 4_000_000
}

test ig_cap_pp_ten_lamp_is_linear() {
  compute_cap_pp(10_000_000) == 40_000_000
}

// Zero available LAMP pays nothing. Not the same statement as the old
// "no schedule ⟹ nothing": this one is about the vault being empty.
test ig_cap_pp_zero_avail() {
  compute_cap_pp(0) == 0
}

// THE DOOR THAT D2 CLOSED, written as a number so it cannot re-open quietly.
// SPEC §6.3 specifies `RATE_REF_Q = 10¹²` (ρ = 1 MAGIC/LAMP/epoch). For one
// LAMP that is 10⁹ nanogic against the 4×10⁶ this ceiling allows — a factor of
// 250. Anyone raising `instant_rate_q` toward the spec value breaks this test
// first, and has to come here to read why.
test ig_cap_pp_is_far_below_spec_rate_ref() {
  let spec_rate_ref_q = 1_000_000_000_000
  let one_lamp_oildrop = 1_000_000
  let spec_says = one_lamp_oildrop * spec_rate_ref_q / q
  and {
    spec_says == 1_000_000_000,
    compute_cap_pp(one_lamp_oildrop) == 4_000_000,
    spec_says == compute_cap_pp(one_lamp_oildrop) * 250,
  }
}

// The two floors are applied in sequence, not fused. At an odd nanogic the
// fused form `l * rate / (q * 2)` and the sequential form agree here, but the
// test pins the order the code is written in so a later "simplification" that
// changes rounding has to justify itself.
test ig_cap_pp_floors_in_two_steps() {
  let odd = 1_000_001
  let step1 = odd * instant_rate_q / q
  compute_cap_pp(odd) == step1 / 2
}

// The gate takes the minimum of three brakes. With a huge reward and a huge
// surplus allowance, the L_avail brake is what binds.
test ig_grant_binds_on_cap_pp() {
  let grant =
    compute_instant_grant(
      1_000_000_000_000_000,   // consumed — enormous
      2_000_000_000,           // um_q max
      1_150_000_000,           // pm_q max
      9_000_000_000,           // br_q — deep green
      1_000_000_000_000_000,   // magic_supply — large surplus allowance
      1_000_000,               // L_avail = 1 LAMP
    )
  grant == 4_000_000
}

// ── INV-CASHBACK-BOUND: bài kiểm CẮN được, không phải chú thích ──────────────
//
// Bất biến `R_reward × UM_MAX × PM_MAX < 1` cho tới nay chỉ sống trong một dòng
// chú thích. Ba hằng đứng ở ba tệp/chỗ khác nhau, nên nâng một cái không làm gì
// đỏ. Ba bài dưới đây bắt đúng ba đường phá nó.

// Ở TRẦN của cả hai hệ số, hoàn lại phải NGẶT nhỏ hơn số đã tiêu.
test ig_cashback_strictly_below_consumed_at_both_ceilings() {
  let consumed = 1_000_000_000_000
  let reward =
    compute_reward_from_consumed(consumed, um_max_q, pm_q_ember)
  reward < consumed && reward == 460_000_000_000
}

// Ghim đúng ba hằng dựng nên biên 0,46. Nâng bất kỳ cái nào là bài này đỏ ngay
// tại chỗ, thay vì hỏng lặng ở một phép nhân cách đó ba tệp.
test ig_cashback_bound_factors_are_pinned() {
  instant_reward_rate_q == 200_000_000 && um_max_q == 2_000_000_000 && pm_q_ember == 1_150_000_000
}

// Đường phá thật: nối hệ số TƯ-CÁCH (trần 2,50×) vào chỗ `pm_q`. Kết quả là hoàn
// lại ĐÚNG BẰNG số đã tiêu — hoà vốn, vòng tiêu-rồi-được-hoàn thôi hội tụ. Bài này
// khẳng định con số đó để người đọc thấy biên mỏng đến đâu, và để ai định nới
// `pm_q` phải đi qua đây.
test ig_eligibility_ceiling_would_break_the_bound() {
  let consumed = 1_000_000_000_000
  let eligibility_ceiling_q = 2_500_000_000
  compute_reward_from_consumed(consumed, um_max_q, eligibility_ceiling_q) == consumed
}
