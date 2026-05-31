// LampDistribution math helpers (SPEC §3, §4)

/// Ceiling division ⌈a / b⌉ cho b > 0, a ≥ 0.
/// D = ceil(remaining / P) — số drops/tickets.
pub fn ceil_div(a: Int, b: Int) -> Int {
  ( a + b - 1 ) / b
}

/// clamp x vào [lo, hi]
pub fn clamp(x: Int, lo: Int, hi: Int) -> Int {
  if x < lo {
    lo
  } else if x > hi {
    hi
  } else {
    x
  }
}

test ceil_div_exact() {
  ceil_div(200, 100) == 2
}

test ceil_div_round_up() {
  ceil_div(243, 100) == 3
}

test ceil_div_one() {
  ceil_div(1, 100) == 1
}

test ceil_div_zero() {
  ceil_div(0, 100) == 0
}

test clamp_within() {
  clamp(50, 10, 100) == 50
}

test clamp_low() {
  clamp(5, 10, 100) == 10
}

test clamp_high() {
  clamp(500, 10, 100) == 100
}
