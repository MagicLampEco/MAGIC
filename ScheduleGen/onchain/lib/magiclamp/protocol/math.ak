// lib/math.ak — ScheduleGen core math (§11.2–§11.4)
// Normative: T8 (rate immutable), T11 (S continuous), T12 (S diminishing), T-DET, T19

use aiken/collection/list
use aiken/crypto
use aiken/primitive/bytearray
use magiclamp/protocol/constants.{
  q, shard_count, snapshot_base_rate_q,
  s_seg1_intercept_q, s_seg1_slope_q,
  s_seg2_knee, s_seg2_intercept_q, s_seg2_slope_q,
  s_seg3_knee, s_seg3_intercept_q, s_seg3_slope_q,
}
use magiclamp/protocol/types.{GenSchedule}

// ══════════════════════════════════════════════════════════════
// §11.3 S(L) — Schedule bonus multiplier (piecewise)
// ══════════════════════════════════════════════════════════════
//
// S(L) = { 1.5 + 0.010L        L ∈ [10,50]
//         { 2.0 + 0.005(L-50)  L ∈ (50,150]
//         { 2.5 + 0.0025(L-150) L ∈ (150,200]
//
// T11: Continuous at L=50 and L=150
//   seg1(50)=2.0; seg2(50)=2.0 ✓
//   seg2(150)=2.5; seg3(150)=2.5 ✓
// T12: dS/dL strictly decreasing: 0.010 > 0.005 > 0.0025 ✓
// L5: Self-computable by addition and multiplication only
//
// TV-SCH-01 values:
//   L=10  → 1_600_000_000  (1.60)
//   L=50  → 2_000_000_000  (2.00)  ← continuity check
//   L=100 → 2_250_000_000  (2.25)
//   L=150 → 2_500_000_000  (2.50)  ← continuity check
//   L=200 → 2_625_000_000  (2.625)

pub fn compute_s_q(l: Int) -> Int {
  if l <= s_seg2_knee {
    // Segment 1: L ∈ [10,50]
    s_seg1_intercept_q + s_seg1_slope_q * l
  } else if l <= s_seg3_knee {
    // Segment 2: L ∈ (50,150]
    s_seg2_intercept_q + s_seg2_slope_q * ( l - s_seg2_knee )
  } else {
    // Segment 3: L ∈ (150,200]
    s_seg3_intercept_q + s_seg3_slope_q * ( l - s_seg3_knee )
  }
}

// ══════════════════════════════════════════════════════════════
// §11.2 rate_locked_q — immutable rate locked at commit (T8)
// ══════════════════════════════════════════════════════════════
//
// rate_locked_q = ⌊ R_snap_c × S_Q(L) / Q ⌋
//
// T8: Once stored in GenSchedule, NEVER changes.
//   DAO may update R_snap globally → affects future commits only.
//   Existing schedule reads stored rate_locked_q.
//
// TV-SCH-02: L=100, R_snap=5B
//   S_Q(100)  = 2_250_000_000
//   rate_locked_q = ⌊5B × 2.25B / Q⌋ = 11_250_000_000 ✓

pub fn compute_rate_locked_q(r_snap_q: Int, l: Int) -> Int {
  let s_q = compute_s_q(l)
  r_snap_q * s_q / q
}

// ══════════════════════════════════════════════════════════════
// §11.4 M_i — MAGIC per fire order (T-DET, T19)
// ══════════════════════════════════════════════════════════════
//
// M_i = ⌊ λ × rate_locked_q / Q ⌋
//
// T-DET: All M_i in the same contract are identical.
//   rate_locked_q is immutable → same λ → same M_i every fire.
// T19: C-SCH-RATE: λ × rate_locked_q ≥ Q → M_i ≥ 1 every fire.
//
// TV-SCH-02: λ=4000 LAMP=4×10⁹ oildrop, rate_locked_q=11_250_000_000
//   M_i = ⌊4×10⁹ × 11_250_000_000 / Q⌋ = 45_000_000_000 = 45 MAGIC ✓

pub fn compute_m_i(lambda_oildrop: Int, rate_locked_q: Int) -> Int {
  lambda_oildrop * rate_locked_q / q
}

// ── MỐC ĐƠN VỊ — ba bài dưới đây ghim thứ không hằng số nào tự khai ──────
//
// `rate_locked_q / q` đọc ra "8,0" ở L=10. Con số đó là **nanogic trên mỗi
// oildrop**, KHÔNG phải MAGIC trên mỗi LAMP. Hai thang lệch nhau đúng 10³, vì
// λ ở thang 10⁶ còn M_i ở thang 10⁹ mà mã chỉ chia `q` MỘT lần — `r` âm thầm
// gánh luôn cầu-nối-đơn-vị 10³ chồng lên thang Q của nó. Ai đọc "8,0" thành
// "8 MAGIC mỗi LAMP" sai 1000 lần, và toàn bộ phần kinh tế dựng trên số đó.
// Không dòng mã nào nói ra hệ số 10³ này; ba bài dưới đây nói.

/// 1 LAMP khoá, bắn một lần ở L=10, cho ĐÚNG 0,008 MAGIC — không phải 8.
/// ĐỌC HẰNG SỐNG, không gõ cứng: bài này phải đỏ ngay khi ai đổi
/// `snapshot_base_rate_q`, để mốc kinh tế được sửa CÓ Ý THỨC chứ không trôi theo.
test unit_anchor_one_lamp_at_min_length() {
  let lambda_one_lamp = 1_000_000            // 1 LAMP, tính bằng oildrop
  let r = compute_rate_locked_q(snapshot_base_rate_q, 10)
  and {
    r == 8_000_000_000,                      // = 8,0 nanogic/oildrop
    compute_m_i(lambda_one_lamp, r) == 8_000_000,   // = 0,008 MAGIC
  }
}

/// Vector chuẩn TV-SCH-02, neo ở chú thích §11.4 ngay trên. Giữ hai đầu mút
/// cùng một bài để bất cứ ai đổi `snapshot_base_rate_q` phải đi qua cả hai.
test unit_anchor_tv_sch_02() {
  let r = compute_rate_locked_q(5_000_000_000, 100)
  and {
    r == 11_250_000_000,
    compute_m_i(4_000_000_000, r) == 45_000_000_000,   // 4000 LAMP → 45 MAGIC
  }
}

/// Tầng sàn thứ nhất trong `compute_rate_locked_q` VÔ HIỆU — nhưng chỉ vì giá
/// trị hằng hiện hành thoả một điều kiện KHÔNG dòng nào ép.
///
/// Điều kiện đúng là **`400 | snapshot_base_rate_q`**, không phải `5×10⁹ | R`.
/// `S_Q(L)` luôn là bội của 2,5×10⁶ trên cả ba đoạn (1,5e9 · 1e7 · 2e9 · 5e6 ·
/// 2,5e9 · 2,5e6 đều chia hết cho 2,5e6), nên `R·S_Q ≡ 0 mod 10⁹` ⟺ `R` chia
/// hết cho `10⁹ / 2,5×10⁶ = 400`.
///
/// Con số 400 này là KẾT QUẢ ĐO, không phải suy luận: bản đầu của chú thích
/// viết `5×10⁹ | R`, rồi phép đột biến `R := 8,5×10⁹` (chia hết 400, không chia
/// hết 5×10⁹) để bài này XANH — chứng tỏ `5×10⁹` là điều kiện đủ mà thừa xa.
/// Đột biến `R := 5.000.000.100` (chia hết 4, không chia hết 400) mới làm nó
/// ĐỎ. Ghi cận đúng ở đây vì cận thừa sẽ bị ai đó đọc thành "phải giữ bội 5 tỷ"
/// và loại oan những giá trị hoàn toàn hợp lệ.
///
/// Vì sao cần canh: đổi hằng sang một số bất kỳ vẫn biên dịch xanh và âm thầm
/// bật lại một tầng cắt cụt mà không tài liệu nào nói tới.
test rate_floor_is_exact_across_full_l_range() {
  let l_probes = [10, 35, 50, 51, 100, 149, 150, 151, 200]
  list.all(
    l_probes,
    fn(l) { snapshot_base_rate_q * compute_s_q(l) % q == 0 },
  )
}

/// GHIM CHO BẢN CHÉP Ở KHO KHÁC — đừng xoá vì tưởng nó trùng bài trên.
///
/// `ConsumeMAGIC/onchain/lib/magiclamp/consume/pricing.ak` ▸
/// `max_base_price_below_network_lock_threshold` chép ba hằng của tệp này để dựng lại
/// suất ở độ dài lịch tối đa. Hai kho là hai gói Aiken rời (`magiclamp/protocol` và
/// `magiclamp/consume`, hai `aiken.toml` không phụ thuộc nhau) nên bản chép KHÔNG
/// import được — mức 3 "chép có nhãn" là mức cao nhất còn khả thi.
///
/// Bài này là nửa còn lại của cái nhãn đó: nó làm bản chép **chết ỒN ÀO**. Đổi
/// `snapshot_base_rate_q` hay hệ số đoạn 3 của `S_Q` ⟹ bài này đỏ ngay tại kho nguồn,
/// kèm câu chỉ thẳng sang tệp phải sửa theo. Không có bài này thì bản chép bên kia vẫn
/// xanh với một con số đã chết — đúng kiểu hỏng mà người đọc TIN.
///
/// `L = 200` là trần độ dài lịch, và là ca chặt nhất của bất biến chống-khoá bên đó
/// (`ρ/L` giảm theo `L` vì `S_Q` tăng dưới-tuyến-tính).
test rate_at_max_length_mirrored_in_consumemagic() {
  and {
    compute_s_q(200) == 2_625_000_000,
    compute_rate_locked_q(snapshot_base_rate_q, 200) == 13_125_000_000,
  }
}

// ── C-SCH-RATE check (T19) ───────────────────────────────────
// Must hold at commit time. If false → REJECT commit.
pub fn check_sch_rate(lambda_oildrop: Int, rate_locked_q: Int) -> Bool {
  lambda_oildrop * rate_locked_q >= q
}

// ══════════════════════════════════════════════════════════════
// §5.5 shard_id computation (C-SCH-FIRE-SHARD, A19)
// ══════════════════════════════════════════════════════════════
//
// shard_id(owner) = first_byte(blake2b256(owner)) % 16
// MUST be computed from vault.owner (NOT stored in GenSchedule)
// C-SCH-FIRE-SHARD: validator verifies fire tx updates correct shard

pub fn compute_shard_id(owner_pkh: ByteArray) -> Int {
  let hash = crypto.blake2b_256(owner_pkh)
  // byte đầu mod shard_count. Dùng hằng, không ghi thẳng 16: `shard_nft.ak` đã dùng
  // `shard_count`, nên một chỗ ghi số sẽ tách khỏi chỗ kia trong im lặng khi đổi.
  bytearray.at(hash, 0) % shard_count
}

// ══════════════════════════════════════════════════════════════
// Shard NFT asset name (MAINNET-BLOCK fix: one-shot, distinct names)
// ══════════════════════════════════════════════════════════════
//
// Each of the 16 shards carries a DISTINCT NFT asset name so its identity is
// bound by the asset name (issued exactly once by the one-shot policy), NOT by
// the self-declared `shard_id` field in the datum. This closes the forgery
// where a re-mintable native-sig policy could create a second token under the
// shared "SHARD" name and let a duplicate shard_id reset cap headroom.
//
//   shard_asset_name(id) = "SHARD" ∥ byte(id)     id ∈ [0,15]
//
// = #"5348415244" ∥ single byte 0x00..0x0f (6 bytes total).
pub fn shard_asset_name(shard_id: Int) -> ByteArray {
  expect shard_id >= 0 && shard_id < 16
  bytearray.concat(#"5348415244", bytearray.from_int_big_endian(shard_id, 1))
}

// ══════════════════════════════════════════════════════════════
// Fire epoch for order i (0-indexed)
// ══════════════════════════════════════════════════════════════
//
// e_i = start_fire_epoch + fired_count
// start_fire_epoch = commit_epoch + delay (= c + 2)
// fired_count is the COUNT BEFORE this fire (0-indexed)

pub fn next_fire_epoch(schedule: GenSchedule) -> Int {
  schedule.start_fire_epoch + schedule.fired_count
}

// ── Schedule ID ──────────────────────────────────────────────
// schedule_id = blake2b256(vault_utxo_ref ∥ encode(next_schedule_index))
pub fn compute_schedule_id(
  tx_hash      : ByteArray,
  output_index : Int,
  sched_index  : Int,
) -> ByteArray {
  let ref_bytes = bytearray.concat(tx_hash, bytearray.from_int_big_endian(output_index, 8))
  let idx_bytes = bytearray.from_int_big_endian(sched_index, 8)
  crypto.blake2b_256(bytearray.concat(ref_bytes, idx_bytes))
}

// ── Batch ID ─────────────────────────────────────────────────
pub fn compute_batch_id(
  tx_hash      : ByteArray,
  output_index : Int,
  batch_index  : Int,
) -> ByteArray {
  let ref_bytes = bytearray.concat(tx_hash, bytearray.from_int_big_endian(output_index, 8))
  let idx_bytes = bytearray.from_int_big_endian(batch_index, 8)
  crypto.blake2b_256(bytearray.concat(ref_bytes, idx_bytes))
}
