// lib/lock.ak — LAMP lock/unlock helpers (§6.8, §A.9)
// T5: youngest-first lock maximizes LF(free holdings)
// C-SCH-8 / C-VAC-commit: select_lamp_for_lock youngest-first
// Fire: remove_locked_amount oldest-locked-first

use aiken/collection/list
use magiclamp/vacuumgen/lib/types.{LoyaltyHolding}

// ══════════════════════════════════════════════════════════════
// §6.8 select_lamp_for_lock — youngest-first
// ══════════════════════════════════════════════════════════════
//
// Lock youngest holdings first → free = oldest → LF(free) maximized (T5, C.6)
// TV-LOCK-01: [{1000,50},{2000,80},{1500,60}], lock=2500
//   Sorted youngest: [2000@80, 1500@60, 1000@50]
//   Lock 2000@80 (rem=500); Lock 500@60 (split); Free 1000@60; Free 1000@50 ✓
//
// Algorithm: sort all holdings by acquired_epoch DESC, lock from youngest.

pub fn select_lamp_for_lock(
  holdings : List<LoyaltyHolding>,
  amount   : Int,               // oil to lock
) -> List<LoyaltyHolding> {
  // Sort youngest-first (desc acquired_epoch)
  let sorted = list.sort(holdings, fn(a, b) { a.acquired_epoch >= b.acquired_epoch })
  lock_from_youngest(sorted, amount, [])
}

fn lock_from_youngest(
  holdings   : List<LoyaltyHolding>,
  remaining  : Int,
  acc        : List<LoyaltyHolding>,
) -> List<LoyaltyHolding> {
  when holdings is {
    [] -> {
      expect remaining == 0   // C-VAC-2 ensures λ ≤ L_avail
      acc
    }
    [h, ..rest] -> {
      if remaining <= 0 {
        // Done locking — append rest unchanged
        list.concat(acc, [h, ..rest])
      } else if remaining >= h.amount {
        // Fully lock this holding
        let locked = LoyaltyHolding { ..h, is_locked: True }
        lock_from_youngest(rest, remaining - h.amount, list.concat(acc, [locked]))
      } else {
        // Partially lock: split into locked + free portions
        let locked_part = LoyaltyHolding { amount: remaining, acquired_epoch: h.acquired_epoch, is_locked: True }
        let free_part   = LoyaltyHolding { amount: h.amount - remaining, acquired_epoch: h.acquired_epoch, is_locked: False }
        list.concat(acc, [locked_part, free_part, ..rest])
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════
// remove_locked_amount — oldest-locked-first (§A.9)
// ══════════════════════════════════════════════════════════════
//
// Called at fire time: remove λ oil from locked holdings.
// Removes oldest locked holdings first (FIFO for locks).

pub fn remove_locked_amount(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  let locked   = list.filter(holdings, fn(h) {  h.is_locked })
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })
  // Sort locked oldest-first (asc acquired_epoch)
  let sorted_locked = list.sort(locked, fn(a, b) { a.acquired_epoch <= b.acquired_epoch })
  let remaining_locked = remove_oldest_first(sorted_locked, amount)
  list.concat(unlocked, remaining_locked)
}

fn remove_oldest_first(
  holdings  : List<LoyaltyHolding>,
  remaining : Int,
) -> List<LoyaltyHolding> {
  when holdings is {
    [] -> {
      expect remaining == 0
      []
    }
    [h, ..rest] -> {
      if remaining <= 0 { holdings }
      else if remaining >= h.amount {
        remove_oldest_first(rest, remaining - h.amount)
      } else {
        [LoyaltyHolding { ..h, amount: h.amount - remaining }, ..rest]
      }
    }
  }
}

// ── INV-3 / C-VAULT-10 ───────────────────────────────────────
pub fn sum_holdings(holdings: List<LoyaltyHolding>) -> Int {
  list.foldl(holdings, 0, fn(acc, h) { acc + h.amount })
}

pub fn sum_locked(holdings: List<LoyaltyHolding>) -> Int {
  list.foldl(holdings, 0, fn(acc, h) { if h.is_locked { acc + h.amount } else { acc } })
}

// ── L_avail ──────────────────────────────────────────────────
pub fn l_avail(lamp_balance: Int, lamp_locked: Int) -> Int {
  lamp_balance - lamp_locked
}
