//// GenMAGIC — math on-chain (v0.2)
//// Neo: Specs/GenMAGIC-Math-Vi.md
//// P8: PHẢI bit-identical với GenMAGIC/offchain/src/math.ts. Sửa một bên = sửa cả hai.

// ── Hằng ─────────────────────────────────────────────────────────────────
pub const q: Int = 1_000_000_000

pub const oil_per_lamp: Int = 1_000_000

pub const slots_per_epoch: Int = 432_000

pub const d_cap: Int = 1001

pub const tran_tuoi: Int = 24

pub const tran_tang: Int = 1_250_000_000

// Trọng số tư-cách (anh Aladin chốt 17/7). Σ = 1.5Q ⟹ tư_cách ∈ [Q, 2.5Q].
pub const w_tuoi: Int = 300_000_000

pub const w_tieu: Int = 900_000_000

pub const w_thap: Int = 200_000_000

pub const w_cam: Int = 100_000_000

pub const tu_cach_san: Int = 1_000_000_000

pub const tu_cach_tran: Int = 2_500_000_000

// ── Tiện ích ─────────────────────────────────────────────────────────────
pub fn kep(x: Int, lo: Int, hi: Int) -> Int {
  if x < lo {
    lo
  } else if x > hi {
    hi
  } else {
    x
  }
}

fn an_toan_mau(x: Int) -> Int {
  if x > 0 {
    x
  } else {
    1
  }
}

// ── §3. c_dùng — KHÔNG BAO GIỜ tin c trong datum ─────────────────────────
/// TỰ ĐO LAMP từ value rồi lấy min. Chống UTxO giả 2 ADA datum bịa c=10^12 (PoC PASS trên v0.1).
/// Trả về 0 nếu ngoài biên [1, d_cap] ⟹ vault bị LOẠI.
pub fn c_dung(c_datum: Int, lamp_oildrop_do: Int) -> Int {
  let c_tu_lamp = lamp_oildrop_do / oil_per_lamp
  let c =
    if c_datum < c_tu_lamp {
      c_datum
    } else {
      c_tu_lamp
    }
  if c < 1 || c > d_cap {
    0
  } else {
    c
  }
}

// ── §4. Bốn tỷ-lệ ∈ [0, Q] ───────────────────────────────────────────────
/// max(0, ·) LOAD-BEARING: v0.1 chỉ kẹp TRÊN ⟹ vest_start_slot = 10^18 → tuổi ÂM
/// → tư-cách ÂM → W ÂM → nhịp nổ. PoC PASS, giá 1 LAMP.
pub fn tuoi_epoch(slot_now: Int, vest_start_slot: Int) -> Int {
  let troi = slot_now - vest_start_slot
  if troi <= 0 {
    0
  } else {
    kep(troi / slots_per_epoch, 0, tran_tuoi)
  }
}

pub fn r_tuoi(slot_now: Int, vest_start_slot: Int) -> Int {
  tuoi_epoch(slot_now, vest_start_slot) * q / tran_tuoi
}

/// Đo TỶ LỆ không đo LƯỢNG ⟹ cá voi không lợi thế.
pub fn r_tieu(da_tieu: Int, da_sinh: Int) -> Int {
  kep(da_tieu * q / an_toan_mau(da_sinh), 0, q)
}

/// Chuẩn hoá theo đã_SINH (KHÔNG theo đã_tiêu) — LOAD-BEARING.
/// v0.1 chia đã_tiêu ⟹ tiêu 1 nanogic lúc thấp điểm ăn TRỌN 1.5×.
pub fn r_thap_diem(tieu_thap_diem: Int, da_sinh: Int) -> Int {
  kep(tieu_thap_diem * q / an_toan_mau(da_sinh), 0, q)
}

pub fn r_cam_ket(magic_cam_ket: Int, da_sinh: Int) -> Int {
  kep(magic_cam_ket * q / an_toan_mau(da_sinh), 0, q)
}

// ── §4. Gộp — TỔNG-CÓ-TRỌNG-SỐ (bỏ tích: tích làm G4 GÃY) ────────────────
/// ĐÚNG MỘT tham số (G2). Ép sàn+trần tường minh.
pub fn tu_cach(
  slot_now: Int,
  vest_start_slot: Int,
  da_tieu: Int,
  da_sinh: Int,
  tieu_thap_diem: Int,
  magic_cam_ket: Int,
) -> Int {
  let t = r_tuoi(slot_now, vest_start_slot)
  let c = r_tieu(da_tieu, da_sinh)
  let p = r_thap_diem(tieu_thap_diem, da_sinh)
  let k = r_cam_ket(magic_cam_ket, da_sinh)
  let tong = ( w_tuoi * t + w_tieu * c + w_thap * p + w_cam * k ) / q
  kep(q + tong, tu_cach_san, tu_cach_tran)
}

// ── §5. Trọng số + nhịp + M_v ────────────────────────────────────────────
/// Nhân tư_cách TRƯỚC khi floor theo c ⟹ đẩy lùi cổng floor-về-0.
pub fn trong_so_vault(c: Int, tc: Int) -> Int {
  let w = c * tc / q
  if w > 0 {
    w
  } else {
    0
  }
}

/// nhip_tran (trần tuyệt đối) BẮT BUỘC — van tran_tang chặn TỐC ĐỘ, không chặn MỨC.
pub fn nhip_gen(
  ngan_sach: Int,
  w_truoc: Int,
  nhip_truoc: Int,
  nhip_tran: Int,
) -> Int {
  let theo_ngan_sach = ngan_sach * q / an_toan_mau(w_truoc)
  let theo_van = nhip_truoc * tran_tang / q
  let r =
    if theo_ngan_sach < theo_van {
      theo_ngan_sach
    } else {
      theo_van
    }
  let r2 =
    if r > nhip_tran {
      nhip_tran
    } else {
      r
    }
  if r2 > 0 {
    r2
  } else {
    0
  }
}

/// max(1, ·) ÉP G1 — G1 là tiên đề, phải ÉP chứ không phải "kiểm".
pub fn magic_vault(w_v: Int, nhip: Int) -> Int {
  if w_v <= 0 {
    0
  } else {
    let m = w_v * nhip / q
    if m > 1 {
      m
    } else {
      1
    }
  }
}

// ── Test bit-identical với TypeScript (P8) ───────────────────────────────
test t_c_dung_vault_gia_2ada() {
  // UTxO 2 ADA, datum bịa c=10^12, KHÔNG LAMP ⟹ LOẠI
  c_dung(1_000_000_000_000, 0) == 0
}

test t_c_dung_khai_man() {
  // datum khai 1000 nhưng chỉ có 5 LAMP thật ⟹ dùng 5
  c_dung(1000, 5 * oil_per_lamp) == 5
}

test t_c_dung_vuot_cap() {
  c_dung(5000, 5000 * oil_per_lamp) == 0
}

test t_c_dung_that() {
  c_dung(1000, 1000 * oil_per_lamp) == 1000
}

test t_tuoi_kip_no_khong_am() {
  // vest_start_slot = 10^18 ⟹ tuổi KHÔNG âm (v0.1: ≈ −2.3×10^12)
  tuoi_epoch(500_000_000, 1_000_000_000_000_000_000) == 0
}

test t_tuoi_kep_tran() {
  tuoi_epoch(500_000_000, 500_000_000 - 10_000 * slots_per_epoch) == tran_tuoi
}

test t_tu_cach_san_khi_kip_no() {
  tu_cach(500_000_000, 1_000_000_000_000_000_000, 0, 0, 0, 0) == q
}

test t_inv_g4_trong_so() {
  // w_tieu > w_tuoi + w_thap + w_cam  (0.90 > 0.60)
  w_tieu > w_tuoi + w_thap + w_cam
}

test t_inv_g4_hanh_vi() {
  // người tiêu-thật (mọi thứ khác 0) THẮNG người ôm tối đa mọi thứ khác
  let tieu_that = tu_cach(500_000_000, 500_000_000, 1000, 1000, 0, 0)
  let om_giu =
    tu_cach(
      500_000_000,
      500_000_000 - tran_tuoi * slots_per_epoch,
      0,
      1000,
      1000,
      1000,
    )
  tieu_that == 1_900_000_000 && om_giu == 1_600_000_000 && tieu_that > om_giu
}

test t_inv_g1_moi_c() {
  // ∀ c, tư_cách ⟹ M_v ≥ 1 kể cả nhịp cực nhỏ
  magic_vault(trong_so_vault(1, q), 1) >= 1 && magic_vault(
    trong_so_vault(d_cap, tu_cach_tran),
    1,
  ) >= 1
}

test t_inv_tong_thu_nguyen() {
  // Σ w_v × nhịp / Q = B
  let w = 1_000_000
  let b = 1_000_000_000_000_000
  let nhip = nhip_gen(b, w, 1_000_000_000_000_000_000, 1_000_000_000_000_000_000)
  w * nhip / q == b
}

test t_thap_diem_co_thang() {
  // v0.1 chia đã_tiêu ⟹ 1 nanogic ăn trọn Q. v0.2 chia đã_sinh ⟹ 1/1000
  r_thap_diem(1, 1000) == q / 1000 && r_thap_diem(1000, 1000) == q
}

test t_van_chan_toc_do() {
  nhip_gen(1_000_000_000_000_000_000, 1, 1000, 1_000_000_000_000_000_000) == 1250
}

test t_nhip_tran_chan_muc() {
  nhip_gen(1_000_000_000_000_000_000, 0, 1_000_000_000_000_000_000, 5000) == 5000
}
