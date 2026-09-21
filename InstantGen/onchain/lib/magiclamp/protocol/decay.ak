// lib/decay.ak — MAGIC batch lifetime (§4.2 per-epoch use-or-lose CLIFF)
//
// The multi-epoch decay / halving machinery is GONE. A batch has exactly one
// live epoch — its own `created_epoch`:
//
//   k = current_epoch − created_epoch
//   k = 0            → LIVE   (full current_amount, burnable)
//   k ≥ decay_window → DEAD   (value 0, NOT burnable, garbage-collectable)
//
// with `decay_window = 1` for every source (constants.magic_decay_window).
// The generic `k ≥ decay_window` form is kept so the helpers stay usable if a
// future source ever gets a different window; today every batch is a 1-epoch
// cliff, and there is no halving step at any k.

use aiken/collection/list
use magiclamp/protocol/types.{Instant, MagicBatch}

// ── Liveness ─────────────────────────────────────────────────

/// Is this batch DEAD at current_epoch? (k ≥ decay_window)
/// A dead batch contributes 0 and may not be burned.
pub fn is_expired(batch: MagicBatch, current_epoch: Int) -> Bool {
  current_epoch - batch.created_epoch >= batch.decay_window
}

/// Is this batch LIVE at current_epoch? (exactly its own created_epoch)
pub fn is_live(batch: MagicBatch, current_epoch: Int) -> Bool {
  !is_expired(batch, current_epoch)
}

// ── Garbage collection (§7.4 PruneExpired) ───────────────────

/// Drop every DEAD batch. Removes bytes only — a dead batch already counts as
/// zero, so pruning never changes any live value.
pub fn prune_expired(
  batches       : List<MagicBatch>,
  current_epoch : Int,
) -> List<MagicBatch> {
  list.filter(batches, fn(b) { !is_expired(b, current_epoch) })
}

/// Number of DEAD batches in the list (used to reject a no-op prune).
pub fn count_expired(batches: List<MagicBatch>, current_epoch: Int) -> Int {
  list.count(batches, fn(b) { is_expired(b, current_epoch) })
}

// ── Balance ──────────────────────────────────────────────────

/// Live balance of a batch at current_epoch. 0 once the cliff has passed.
pub fn batch_balance(batch: MagicBatch, current_epoch: Int) -> Int {
  let k = current_epoch - batch.created_epoch
  if k < 0 {
    fail @"negative batch age (C-DECAY-2)"
  } else if k >= batch.decay_window {
    0
  } else {
    batch.current_amount
  }
}

/// Total live MAGIC across a batch list (S-side accounting, off-chain mirror).
pub fn live_total(batches: List<MagicBatch>, current_epoch: Int) -> Int {
  list.foldl(batches, 0, fn(b, acc) { acc + batch_balance(b, current_epoch) })
}

// ── Bộ đếm lượng đã SINH trong epoch hiện tại (`CC-GEN-LOCK-FIELD`) ──────────
//
// Đây là phanh ĐỘC LẬP-ORACLE của `InstantGen`: tổng lượng sinh trong một epoch
// phải nằm dưới trần theo LAMP, chứ không phải mỗi lượt sinh nằm dưới trần. Không
// có nó thì `InstantGen → BurnBatch → InstantGen` lặp được trong cùng một epoch,
// mỗi vòng lấy trọn trần, và trần duy nhất phía trên là phần thặng dư GreenBack.
//
// 🔴 Con số này KHÔNG có ô nhớ trong datum, CỐ Ý. Một trường datum là một ô ghi
// được, và mọi ô ghi được đòi một cổng đông-cứng ở MỌI nhánh — kể cả nhánh không
// cần chữ ký (`PruneExpired`). Quên một nhánh là một đường giặt khoá mà không bài
// kiểm nào đỏ.
//
// Nhưng đừng đọc thành *"không có chỗ nào để quên"* — bản trước của dòng này viết
// thế và nó sai. Phép suy vẫn đọc `magic_batches`, một trường datum ghi được, qua
// ba trường con (`source`, `created_epoch`, `initial_amount`) CỘNG tư cách thành
// viên của danh sách. Mức đúng: ô ấy đã có sẵn cổng đông-cứng vì lý do khác (mỗi
// nhánh so trọn danh sách đầu ra), nên phép suy không thêm nghĩa vụ MỚI. Cái đã
// bị quên chính là tư cách thành viên — xem điều kiện 2.
//
// Bốn điều kiện giữ phép suy này đứng, cả bốn nằm trong chính tệp này hoặc ngay
// cạnh nó — đổi một trong bốn là làm hỏng phanh, nên chúng được kê ra để lần sau
// ai sửa `is_expired` hay `prune_expired` đọc được hệ quả:
//
//   1. `is_expired` dùng `decay_window = 1` ⟹ batch sinh trong epoch này không bao
//      giờ bị dọn TRONG epoch này, nên nó còn đó để đếm.
//   2. KHÔNG nhánh nào xoá một batch CÒN SỐNG khỏi danh sách. Hai đường xoá
//      duy nhất là `prune_expired` (lọc DUY NHẤT theo `is_expired`) và
//      `apply_burns` — mà `apply_burns` giữ batch đốt sạch ở lại với
//      `current_amount: 0`, nên nó còn đó mang nguyên `initial_amount`.
//
//      🔴 Điều kiện này từng được viết là *"`prune_expired` lọc duy nhất theo
//      `is_expired` ⟹ đốt sạch không làm batch biến mất"*. Câu đó đúng VỀ
//      `prune_expired` và sai VỀ HỆ: `apply_burns` là đường xoá thứ hai, và
//      bản trước của nó trả `None` khi số dư về 0. Ba nhà soát độc lập cùng
//      chỉ ra chỗ này; một nhà dựng PoC chạy thật cho thấy 107/107 bài xanh
//      CÙNG LÚC với một chuỗi lách được cổng. Bài học giữ lại: điều kiện phải
//      nói về TẬP CÁC ĐƯỜNG XOÁ, không nói về một hàm có tên nghe như thế.
//   3. `PruneExpired` (nhánh không cần chữ ký) dùng đúng vị từ ấy ⟹ người lạ không
//      hạ được bộ đếm của nạn nhân.
//   4. Sang epoch sau batch cũ thành `is_expired` và bị dọn ⟹ bộ đếm tự về 0,
//      không nhánh nào phải nhớ xoá nó.
//
// Đọc `initial_amount` chứ không `current_amount`: câu hỏi là *"đã sinh ra bao
// nhiêu trong epoch này"*, không phải *"còn lại bao nhiêu"*. Tiêu rồi vẫn tính là
// đã sinh — đó đúng là thứ làm vòng lặp đốt-rồi-sinh-lại vô hiệu.
pub fn instant_gen_in_epoch(
  batches       : List<MagicBatch>,
  current_epoch : Int,
) -> Int {
  list.foldl(
    batches,
    0,
    fn(b, acc) {
      if b.source == Instant && b.created_epoch == current_epoch {
        acc + b.initial_amount
      } else {
        acc
      }
    },
  )
}

// ── `halved` is a dead field under the cliff model ────────────
//
// `MagicBatch.halved` is kept only so the Plutus Data shape stays compatible.
// No code path may ever set it: a batch is created with halved=False and never
// mutated. Validators call this on every batch they emit.
pub fn halved_must_be_false(batch: MagicBatch) -> Bool {
  !batch.halved
}
