//// Gốc lưới cửa sổ theo mạng + test vector — LAMP `Specs/Window/CONTRACT.md` v1.0 §2–§3.
////
//// CHỈ DÙNG CHO TEST. Bản chép có nhãn (chép 2026-10-02 từ CONTRACT v1.0 §2/§3, khuôn theo
//// LAMP `Allocation/onchain/lib/magiclamp/allocation/window_origin_fixtures.ak` @ nhánh
//// `feat/window-origin-epoch`): nguồn chân lý off-chain của kho MAGIC là `ProtocolUtils/src` ▸
//// `WINDOW_ORIGIN_MS_BY_NETWORK`; on-chain thì `window_origin_ms` là THAM SỐ validator
//// (WIN-ORIGIN-3), không gõ cứng ở đâu khác.
////
//// Vì sao test cần gốc khác 0: với gốc 0 bản có trừ gốc và bản QUÊN trừ gốc cho cùng một kết
//// quả (CONTRACT §3). Gốc Mainnet/Preprod lớn hơn nhiều `ms_per_window` nên quên trừ gốc là
//// lệch hàng nghìn epoch — phân biệt được.

use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/transaction.{Transaction}

pub const ms_per_window: Int = 432_000_000

pub const mainnet_origin_ms: Int = 1_506_203_091_000

pub const preprod_origin_ms: Int = 1_654_041_600_000

/// Mainnet: `window(t) = 658`, `window(t − 1) = 657` (CONTRACT §3).
pub const mainnet_t_658: Int = 1_790_459_091_000

/// Preprod: `window(t) = 316`, `window(t − 1) = 315` (CONTRACT §3).
pub const preprod_t_316: Int = 1_790_553_600_000

/// Phép tham chiếu ĐÚNG theo CONTRACT §1 (chia sàn).
pub fn window_of(t: Int, ms_per_epoch: Int, origin_ms: Int) -> Int {
  ( t - origin_ms ) / ms_per_epoch
}

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

// ── Vector §3 trên phép tham chiếu ─────────────────────────────────────────

test vector_mainnet_658() {
  window_of(mainnet_t_658, ms_per_window, mainnet_origin_ms) == 658
}

test vector_mainnet_657() {
  window_of(mainnet_t_658 - 1, ms_per_window, mainnet_origin_ms) == 657
}

test vector_preprod_316() {
  window_of(preprod_t_316, ms_per_window, preprod_origin_ms) == 316
}

test vector_preprod_315() {
  window_of(preprod_t_316 - 1, ms_per_window, preprod_origin_ms) == 315
}

// Bản quên trừ gốc phải LỆCH vector — nếu không thì vector không phân biệt được gì.
test vector_mainnet_window_without_origin_differs() {
  window_without_origin(mainnet_t_658) != 658
}

test vector_preprod_window_without_origin_differs() {
  window_without_origin(preprod_t_316) != 316
}

// Hằng gốc khớp công thức suy ra ở CONTRACT §2 (Shelley start − epoch × 432_000_000).
test origin_constants_match_contract_derivation() {
  and {
    mainnet_origin_ms == 1_596_059_091_000 - 208 * ms_per_window,
    preprod_origin_ms == 1_655_769_600_000 - 4 * ms_per_window,
  }
}

test shift_tx_moves_finite_bounds() {
  let tx = shift_tx(tx_between(10, 20), 5)
  tx.validity_range == interval.between(15, 25)
}
