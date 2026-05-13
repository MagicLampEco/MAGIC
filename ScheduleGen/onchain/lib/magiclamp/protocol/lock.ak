// lib/lock.ak — LAMP lock/unlock helpers (§6.8, §A.9)
// Identical logic to VacuumGen lock.ak — youngest-first lock (T5).
// For ScheduleGen: lock L×λ at commit; remove fires_in_tx×λ at each fire.

use aiken/collection/list
use aiken/primitive/int
use magiclamp/protocol/types.{LoyaltyHolding}

// Youngest-first lock (T5 — maximizes LF of free holdings)
pub fn select_lamp_for_lock(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  let sorted = list.sort(holdings, fn(a, b) { int.compare(b.acquired_epoch, a.acquired_epoch) })
  lock_youngest(sorted, amount, [])
}

fn lock_youngest(
  holdings  : List<LoyaltyHolding>,
  remaining : Int,
  acc       : List<LoyaltyHolding>,
) -> List<LoyaltyHolding> {
  when holdings is {
    [] -> {
      expect remaining == 0
      acc
    }
    [h, ..rest] ->
      if remaining <= 0 { list.concat(acc, [h, ..rest]) }
      else if remaining >= h.amount {
        lock_youngest(rest, remaining - h.amount,
          list.concat(acc, [LoyaltyHolding { ..h, is_locked: True }]))
      } else {
        list.concat(acc, [
          LoyaltyHolding { amount: remaining, acquired_epoch: h.acquired_epoch, is_locked: True },
          LoyaltyHolding { amount: h.amount - remaining, acquired_epoch: h.acquired_epoch, is_locked: False },
          ..rest
        ])
      }
  }
}

// Oldest-locked-first removal (called per fire)
pub fn remove_locked_amount(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  let locked   = list.filter(holdings, fn(h) {  h.is_locked })
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })
  let sorted   = list.sort(locked, fn(a, b) { int.compare(a.acquired_epoch, b.acquired_epoch) })
  list.concat(unlocked, remove_oldest(sorted, amount))
}

fn remove_oldest(
  holdings  : List<LoyaltyHolding>,
  remaining : Int,
) -> List<LoyaltyHolding> {
  when holdings is {
    [] -> {
      expect remaining == 0
      []
    }
    [h, ..rest] ->
      if remaining <= 0 { holdings }
      else if remaining >= h.amount { remove_oldest(rest, remaining - h.amount) }
      else { [LoyaltyHolding { ..h, amount: h.amount - remaining }, ..rest] }
  }
}

pub fn sum_holdings(h: List<LoyaltyHolding>) -> Int {
  list.foldl(h, 0, fn(x, acc) { acc + x.amount })
}

pub fn l_avail(lamp_balance: Int, lamp_locked: Int) -> Int {
  lamp_balance - lamp_locked
}
