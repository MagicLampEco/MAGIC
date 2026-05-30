// lib/lamp.ak — LAMP loyalty holdings management
// Spec: §6.8 select_lamp_for_lock, §A.9 remove_locked_amount
// For InstantGen: LAMP is transferred out (not locked), so we remove
// from unlocked holdings oldest-first.

use aiken/collection/list
use aiken/primitive/int
use magiclamp/protocol/types.{LoyaltyHolding}

// ── Remove LAMP from holdings (InstantGen path) ──────────────
//
// InstantGen transfers lamp_paid from vault to Treasury.
// Unlike lock operations (youngest-first), this removes from
// UNLOCKED holdings.
//
// The exact removal algorithm must produce the same result as
// the off-chain SDK (P8: determinism).
//
// Algorithm: Remove oldest unlocked holdings first until lamp_paid satisfied.
// This preserves newer (higher LF) holdings → user-favorable.

pub fn remove_from_holdings(
  holdings   : List<LoyaltyHolding>,
  amount_out : Int,  // oil to remove (= lamp_paid)
) -> List<LoyaltyHolding> {
  // Sort: locked stay, unlocked sorted oldest-first for removal
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })
  let locked   = list.filter(holdings, fn(h) { h.is_locked })

  let sorted_unlocked = list.sort(
    unlocked,
    fn(a, b) { int.compare(a.acquired_epoch, b.acquired_epoch) },
  )

  let remaining_unlocked = remove_oldest_first(sorted_unlocked, amount_out)
  list.concat(locked, remaining_unlocked)
}

/// Remove `amount` oil from a sorted (oldest-first) list of holdings.
/// Holdings are fully consumed before moving to the next one.
fn remove_oldest_first(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  when holdings is {
    [] -> {
      // All holdings consumed; amount should be 0 (C-INST-3 ensures lamp_paid ≤ L_avail)
      expect amount == 0
      []
    }
    [h, ..rest] -> {
      if amount <= 0 {
        holdings   // done — return remaining unchanged
      } else if amount >= h.amount {
        // Fully consume this holding
        remove_oldest_first(rest, amount - h.amount)
      } else {
        // Partially consume this holding
        let partial = LoyaltyHolding {
          amount:         h.amount - amount,
          acquired_epoch: h.acquired_epoch,
          is_locked:      False,
        }
        [partial, ..rest]
      }
    }
  }
}

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
// Algorithm mirrors MagicSDK/src/withdrawLamp.ts:206 byte-for-byte
// (P8 invariant — Aiken and TS must produce identical output).
//
// Distinct from `remove_from_holdings` above (which is OLDEST-first
// for InstantGen path).
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
