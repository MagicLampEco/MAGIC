// lib/lamp.ak — LAMP loyalty holdings management
//
// ── PHA-2: LAMP ĐỨNG YÊN (I-ACT-7) ───────────────────────────
// KHÔNG handler nào của vault chuyển LAMP ra ngoài để đổi lấy MAGIC. Đường
// DUY NHẤT LAMP rời vault là `WithdrawLamp` — chính chủ rút về ví mình.
// Vì thế module này chỉ còn một thuật toán chọn holding: `remove_newest_first`
// (đường withdraw). Hàm `remove_from_holdings` (oldest-first, "InstantGen
// chuyển lamp_paid sang Treasury") ĐÃ XOÁ 2026-08-09: 0 call site trong toàn
// repo, và docstring của nó dạy đúng cái hành vi mà I-ACT-7 cấm.

use aiken/collection/list
use aiken/primitive/int
use magiclamp/protocol/types.{LoyaltyHolding}

// ── Sum of unlocked holdings ─────────────────────────────────
pub fn sum_unlocked(holdings: List<LoyaltyHolding>) -> Int {
  list.foldl(
    holdings,
    0,
    fn(h, acc) { if !h.is_locked { acc + h.amount } else { acc } },
  )
}

// ── INV-3 / C-VAULT-10: Σholdings.amount == lamp_balance ────
pub fn validate_holdings_sum(
  holdings     : List<LoyaltyHolding>,
  lamp_balance : Int,
) -> Bool {
  let total = list.foldl(holdings, 0, fn(h, acc) { acc + h.amount })
  total == lamp_balance
}

// ── C-VAULT-8: lamp_locked ≤ lamp_balance ────────────────────
pub fn validate_lamp_locked(lamp_locked: Int, lamp_balance: Int) -> Bool {
  lamp_locked <= lamp_balance
}

// ── L_avail = lamp_balance − lamp_locked ─────────────────────
pub fn l_avail(lamp_balance: Int, lamp_locked: Int) -> Int {
  lamp_balance - lamp_locked
}

// ══════════════════════════════════════════════════════════════
// remove_newest_first — WithdrawLamp selection (SPEC_V1 §1)
// ══════════════════════════════════════════════════════════════
//
// Withdraw path picks NEWEST unlocked holdings first to preserve
// loyalty of older holdings (LF-favorable for future generations).
// Locked holdings are never touched.
//
// Algorithm mirrors `removeNewestFirst` trong MagicSDK/src/withdrawLamp.ts
// byte-for-byte (P8 invariant — Aiken and TS must produce identical output).
pub fn remove_newest_first(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  let locked   = list.filter(holdings, fn(h) {  h.is_locked })
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })
  let sorted   = list.sort(unlocked, fn(a, b) { int.compare(b.acquired_epoch, a.acquired_epoch) })
  let remaining_unlocked = consume_newest(sorted, amount)
  list.concat(locked, remaining_unlocked)
}

fn consume_newest(
  holdings  : List<LoyaltyHolding>,
  remaining : Int,
) -> List<LoyaltyHolding> {
  when holdings is {
    [] -> {
      expect remaining == 0    // W-3 mirror — caller checks amount ≤ L_avail
      []
    }
    [h, ..rest] ->
      if remaining <= 0 { holdings }
      else if remaining >= h.amount {
        consume_newest(rest, remaining - h.amount)
      } else {
        [LoyaltyHolding { ..h, amount: h.amount - remaining }, ..rest]
      }
  }
}

// ── sum_holdings — W-7 invariant (= validate_holdings_sum body) ─
pub fn sum_holdings(holdings: List<LoyaltyHolding>) -> Int {
  list.foldl(holdings, 0, fn(h, acc) { acc + h.amount })
}
