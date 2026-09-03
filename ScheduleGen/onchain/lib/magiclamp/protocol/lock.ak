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

// ══════════════════════════════════════════════════════════════
// unlock_locked_amount — RELEASE a lock without moving any LAMP
// ══════════════════════════════════════════════════════════════
//
// I-ACT-7: a ScheduleGen fire generates MAGIC but must NOT displace LAMP. The
// fire therefore RELEASES `amount` oildrop from the locked pool instead of
// removing it: the holdings keep their amount and acquired_epoch, only
// `is_locked` flips to False. Σholdings — and hence lamp_balance and the real
// LAMP in the UTxO — are unchanged.
//
// Selection is oldest-locked-first, mirroring `remove_locked_amount`, so the
// off-chain builder can reproduce it byte-for-byte (P8).
//
// Result order: [unlocked-before] ++ [newly freed] ++ [still locked], then
// coalesced (see `coalesce_holdings` — the count MUST NOT grow per fire).
pub fn unlock_locked_amount(
  holdings : List<LoyaltyHolding>,
  amount   : Int,
) -> List<LoyaltyHolding> {
  let locked   = list.filter(holdings, fn(h) {  h.is_locked })
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })
  let sorted   = list.sort(locked, fn(a, b) { int.compare(a.acquired_epoch, b.acquired_epoch) })
  let (freed, still_locked) = unlock_oldest(sorted, amount, [])
  coalesce_holdings(list.concat(list.concat(unlocked, freed), still_locked))
}

/// Merge holdings sharing (acquired_epoch, is_locked). Lossless: that pair is the
/// only thing that distinguishes two holdings, and `amount` is additive.
///
/// WHY THIS IS NOT OPTIONAL. `unlock_oldest` splits one holding on every partial
/// release, and unlike the old `remove_locked_amount` it never drops an entry —
/// so the list grew by +1 PER FIRE. `max_loyalty_holdings` is 64 and
/// `validate_fire` enforces it, so a long schedule would leave the vault unable
/// to fire OR withdraw at all: LAMP frozen, which is worse than the erosion
/// I-ACT-7 set out to fix. Every split carries the ORIGINAL acquired_epoch, so
/// coalescing collapses them back exactly.
///
/// Ported verbatim from `origin/main:ScheduleGen/.../lock.ak:84-102`, where this
/// bug was found and fixed first (see the comment at `main:vault.ak:1296-1299`).
/// Kept byte-identical on purpose — do not "improve" one side alone (P8).
///
/// O(n²) merge over a list capped at 64. sort-then-scan would be O(n log n) but
/// needs a total order over the pair; revisit only if fire ExUnits actually bite.
pub fn coalesce_holdings(holdings: List<LoyaltyHolding>) -> List<LoyaltyHolding> {
  list.foldl(holdings, [], fn(h, acc) { merge_into(acc, h) })
}

fn same_bucket(a: LoyaltyHolding, b: LoyaltyHolding) -> Bool {
  a.acquired_epoch == b.acquired_epoch && a.is_locked == b.is_locked
}

fn merge_into(
  acc : List<LoyaltyHolding>,
  h   : LoyaltyHolding,
) -> List<LoyaltyHolding> {
  if list.any(acc, fn(x) { same_bucket(x, h) }) {
    // First occurrence keeps its position — order stays deterministic (P8).
    list.map(acc, fn(x) {
      if same_bucket(x, h) { LoyaltyHolding { ..x, amount: x.amount + h.amount } } else { x }
    })
  } else {
    list.concat(acc, [h])
  }
}

fn unlock_oldest(
  holdings  : List<LoyaltyHolding>,
  remaining : Int,
  freed     : List<LoyaltyHolding>,
) -> (List<LoyaltyHolding>, List<LoyaltyHolding>) {
  when holdings is {
    [] -> {
      expect remaining == 0
      (freed, [])
    }
    [h, ..rest] ->
      if remaining <= 0 {
        (freed, [h, ..rest])
      } else if remaining >= h.amount {
        unlock_oldest(
          rest,
          remaining - h.amount,
          list.concat(freed, [LoyaltyHolding { ..h, is_locked: False }]),
        )
      } else {
        (
          list.concat(freed, [
            LoyaltyHolding {
              amount: remaining, acquired_epoch: h.acquired_epoch, is_locked: False,
            },
          ]),
          [
            LoyaltyHolding {
              amount: h.amount - remaining, acquired_epoch: h.acquired_epoch, is_locked: True,
            },
            ..rest
          ],
        )
      }
  }
}

// Oldest-locked-first removal — LEGACY. No handler calls this any more: under
// I-ACT-7 a fire releases the lock (unlock_locked_amount) instead of removing
// LAMP. Kept for reference/tests only.
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

// ══════════════════════════════════════════════════════════════
// remove_newest_first — WithdrawLamp selection (SPEC_V1 §1)
// ══════════════════════════════════════════════════════════════
//
// Pick NEWEST unlocked holdings first → preserve loyalty of older
// holdings (LF-favorable). Locked holdings never touched.
//
// Algorithm mirrors MagicSDK/src/withdrawLamp.ts:206 byte-for-byte
// (P8 invariant). Distinct from `select_lamp_for_lock` (youngest-first
// at lock time) and `remove_locked_amount` (oldest-locked-first at fire).
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
      expect remaining == 0
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
