//// Gốc lưới cửa sổ theo mạng + test vector — LAMP/Specs/Window/CONTRACT.md v1.0 §2–§3.
////
//// CHỈ DÙNG CHO TEST. Bản chép có nhãn (chép 2026-10-02 từ spec v1.0 §2/§3, khuôn theo
//// LAMP `Allocation/onchain/lib/magiclamp/allocation/window_origin_fixtures.ak` nhánh
//// `feat/window-origin-epoch`): nguồn chân lý off-chain của kho MAGIC là
//// `ProtocolUtils/src` ▸ `WINDOW_ORIGIN_MS_BY_NETWORK`; on-chain thì `window_origin_ms` là
//// THAM SỐ validator (apply-param cuối), không gõ cứng ở đâu khác.
////
//// Vì sao test cần gốc khác 0: với gốc 0 bản có trừ gốc và bản QUÊN trừ gốc cho cùng một
//// kết quả (spec §3) — hai gốc dưới đây không chia hết cho `ms_per_window` nên phân biệt
//// được. Lưu ý: gốc Preprod CHIA HẾT cho 86_400_000 (độ dài epoch Preview mà nhiều ca kiểm
//// validator dùng), nên ở độ dài đó chỉ gốc Mainnet phân biệt được.

use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/transaction.{Transaction}
use magiclamp/consume/util

pub const ms_per_window: Int = 432_000_000

pub const mainnet_origin_ms: Int = 1_506_203_091_000

pub const preprod_origin_ms: Int = 1_654_041_600_000

/// Mainnet: `window(t) = 658`, `window(t − 1) = 657` (spec §3).
pub const mainnet_t_658: Int = 1_790_459_091_000

/// Preprod: `window(t) = 316`, `window(t − 1) = 315` (spec §3).
pub const preprod_t_316: Int = 1_790_553_600_000

/// Bản tham chiếu CỐ Ý SAI: lưới Unix cũ, quên trừ gốc. Chỉ để chứng minh vector phân biệt được.
pub fn window_without_origin(t: Int) -> Int {
  t / ms_per_window
}

fn shift_bound(b: IntervalBound, d: Int) -> IntervalBound {
  when b.bound_type is {
    Finite(x) -> IntervalBound { ..b, bound_type: Finite(x + d) }
    _ -> b
  }
}

/// Dời mọi biên HỮU HẠN của validity range đi `d` ms; biên vô hạn giữ nguyên.
pub fn shift_tx(tx: Transaction, d: Int) -> Transaction {
  Transaction {
    ..tx,
    validity_range: Interval {
      lower_bound: shift_bound(tx.validity_range.lower_bound, d),
      upper_bound: shift_bound(tx.validity_range.upper_bound, d),
    },
  }
}

pub fn tx_between(lo: Int, hi: Int) -> Transaction {
  Transaction { ..transaction.placeholder, validity_range: interval.between(lo, hi) }
}

// ── Vector §3 trên bản tham chiếu sai: phải LỆCH vector ──────────────────────

test vector_mainnet_window_without_origin_differs() {
  window_without_origin(mainnet_t_658) != 658
}

test vector_preprod_window_without_origin_differs() {
  window_without_origin(preprod_t_316) != 316
}

// ── util.get_epoch trên vector §3 ──
// `get_epoch` của project này đòi CẢ HAI biên hữu hạn, ≤ 1 epoch và CÙNG epoch. Ca "t" dùng cửa sổ
// [t, t + 1000]; ca "t − 1" dùng [t − 1000, t − 1] để cả hai biên nằm trong epoch 657/315.

test get_epoch_mainnet_at_boundary() {
  util.get_epoch(tx_between(mainnet_t_658, mainnet_t_658 + 1_000), ms_per_window, mainnet_origin_ms) == 658
}

test get_epoch_mainnet_one_ms_before() {
  util.get_epoch(tx_between(mainnet_t_658 - 1_000, mainnet_t_658 - 1), ms_per_window, mainnet_origin_ms) == 657
}

test get_epoch_preprod_at_boundary() {
  util.get_epoch(tx_between(preprod_t_316, preprod_t_316 + 1_000), ms_per_window, preprod_origin_ms) == 316
}

test get_epoch_preprod_one_ms_before() {
  util.get_epoch(tx_between(preprod_t_316 - 1_000, preprod_t_316 - 1), ms_per_window, preprod_origin_ms) == 315
}

/// Ca âm: gọi với gốc 0 (quên gốc) thì KHÔNG ra vector ⇒ bài này phải đỏ.
test get_epoch_mainnet_forgotten_origin() fail {
  expect util.get_epoch(tx_between(mainnet_t_658, mainnet_t_658 + 1_000), ms_per_window, 0) == 658
  True
}

test get_epoch_preprod_forgotten_origin() fail {
  expect util.get_epoch(tx_between(preprod_t_316, preprod_t_316 + 1_000), ms_per_window, 0) == 316
  True
}
