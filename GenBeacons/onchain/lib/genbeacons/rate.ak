//// Đọc beacon ρ — hàm công khai cho két (InstantGen/ScheduleGen) chép sang.

use genbeacons/types.{RateParam}

/// ρ hiệu lực ở epoch `e`. `rho_q` chỉ có hiệu lực từ `effective_epoch`, trước đó là
/// `prev_rho_q`. Lượt CẬP NHẬT đặt `effective_epoch` = epoch SAU epoch đăng
/// (`INV-RATE-GOVERNED`); lượt GENESIS đặt = CHÍNH epoch đăng (trước genesis chưa két nào
/// đọc được ρ) — nên ρ hằng trong mọi epoch theo góc nhìn của két, kể cả epoch có lượt
/// đăng (SPEC §6.1.4 cần điều này cho cận lượng sinh). Luật ghi: `rate_param.ak`.
pub fn rho_at(datum: RateParam, e: Int) -> Int {
  if e >= datum.effective_epoch {
    datum.rho_q
  } else {
    datum.prev_rho_q
  }
}

/// `0 ≤ rho ≤ rho_max_q`.
pub fn rho_in_range(rho: Int, rho_max_q: Int) -> Bool {
  rho >= 0 && rho <= rho_max_q
}

test rho_at_before_effective() {
  rho_at(RateParam { rho_q: 7, prev_rho_q: 3, effective_epoch: 10 }, 9) == 3
}

test rho_at_at_effective() {
  rho_at(RateParam { rho_q: 7, prev_rho_q: 3, effective_epoch: 10 }, 10) == 7
}

test rho_at_after_effective() {
  rho_at(RateParam { rho_q: 7, prev_rho_q: 3, effective_epoch: 10 }, 11) == 7
}
