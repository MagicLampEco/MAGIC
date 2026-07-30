// Paymaster math — Q-format tỷ giá. Pure BigInt, KHÔNG float. P8 mirror math.ts.
// NORMATIVE: SPEC-Paymaster §4.3, §5.2-5.3.
//
//   lamp_cap = ⌊ magic_consumed × lamp_per_magic_q / Q ⌋    (oildrop)
//   ada_cap  = ⌊ magic_consumed × ada_per_magic_q  / Q ⌋    (lovelace)
//
// magic_consumed = Σ BurnBatch.burns (nanogic). Floor division single-step (1 lần
// nhân rồi 1 lần chia) — đại lượng tuyến tính, KHÔNG cần sequential floor §6.1
// (vốn dành cho M = L×R×UM×PM/Q³). 1 phép × Q-format = 1 floor, bound rounding 0.

/// Scale factor Q (1 MAGIC = 1e9 nanogic), khớp ProtocolUtils.Q + pricing.q.
pub const q: Int = 1_000_000_000

/// Trần LAMP (oildrop) app được sponsor cho magic_consumed (nanogic) tại tỷ giá Q-format.
/// Floor division BigInt. magic_consumed ≥ 0, rate ≥ 0 → kết quả ≥ 0.
pub fn lamp_cap(magic_consumed: Int, lamp_per_magic_q: Int) -> Int {
  magic_consumed * lamp_per_magic_q / q
}

/// Trần ADA (lovelace) app được sponsor cho magic_consumed (nanogic).
pub fn ada_cap(magic_consumed: Int, ada_per_magic_q: Int) -> Int {
  magic_consumed * ada_per_magic_q / q
}

// ── Tests thuần (TV-PM-PRICE-01/02, khớp SPEC §5.3) ──────────────────────────

test tv_pm_price_01_lamp() {
  // magic_consumed=10_000_000, rate=0.5×Q → lamp_sponsored = 5_000_000 oildrop.
  lamp_cap(10_000_000, 500_000_000) == 5_000_000
}

test tv_pm_price_02_ada() {
  // magic_consumed=50_000_000, rate=2.0×Q → ada_sponsored = 100_000_000 lovelace.
  ada_cap(50_000_000, 2_000_000_000) == 100_000_000
}

test lamp_cap_unit_rate() {
  // rate = Q (1.0×) → cap == magic_consumed.
  lamp_cap(7_777_777, q) == 7_777_777
}

test lamp_cap_zero_rate() {
  lamp_cap(10_000_000, 0) == 0
}

test lamp_cap_floor() {
  // 3 × (Q/3 không chia hết) → floor. 3 nanogic × rate 1 → 3*1/Q = 0 (floor).
  lamp_cap(3, 1) == 0
}

test lamp_cap_bigint_overflow_safe() {
  // amount lớn — chứng minh BigInt, không Number overflow (TV-OVERFLOW kiểu).
  lamp_cap(1_000_000_000_000_000, 2_000_000_000) == 2_000_000_000_000_000
}
