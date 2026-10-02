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
//// được. UMKeeper: `get_epoch` là hàm RIÊNG của `validators/um_datum.ak`, nên ca vector
//// của nó nằm trong tệp đó, không ở đây. Lưu ý: gốc Preprod CHIA HẾT cho 86_400_000 (độ dài epoch Preview mà nhiều ca kiểm
//// validator dùng), nên ở độ dài đó chỉ gốc Mainnet phân biệt được.

use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/transaction.{Transaction}

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

