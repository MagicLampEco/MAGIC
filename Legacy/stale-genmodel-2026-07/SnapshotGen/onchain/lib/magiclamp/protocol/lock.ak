// lib/lock.ak — LAMP holdings helpers (SnapshotGen)
// SnapshotGen does not lock LAMP; only needs:
//   - remove_newest_first: §1 WithdrawLamp selection rule
//   - sum_holdings:        W-7 invariant Σholdings == lamp_balance

use aiken/collection/list
use aiken/primitive/int
use magiclamp/protocol/types.{LoyaltyHolding}

// ══════════════════════════════════════════════════════════════
// remove_newest_first — WithdrawLamp selection (SPEC_V1 §1)
// ══════════════════════════════════════════════════════════════
//
// Pick from NEWEST unlocked holdings first → preserve loyalty
// (older = higher LF for future Snapshot generation).
// Locked holdings are never touched.
//
// Algorithm mirrors MagicSDK/src/withdrawLamp.ts:206 (P8 invariant —
// bit-identical between Aiken and TypeScript).
//
// Output order: locked ++ remaining_unlocked
pub fn remove_newest_first(
  holdings : List<LoyaltyHolding>,
  amount   : Int,                   // oildrop to remove
) -> List<LoyaltyHolding> {
  let locked   = list.filter(holdings, fn(h) {  h.is_locked })
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })
  // Sort unlocked DESC by acquired_epoch (newest first)
  let sorted = list.sort(unlocked, fn(a, b) { int.compare(b.acquired_epoch, a.acquired_epoch) })
  let remaining_unlocked = consume_newest(sorted, amount)
  list.concat(locked, remaining_unlocked)
}

// Iterate sorted (newest-first) list; full or partial consume; preserve
// iteration order for items not yet reached when remaining == 0.
fn consume_newest(
  holdings  : List<LoyaltyHolding>,
  remaining : Int,
) -> List<LoyaltyHolding> {
  when holdings is {
    [] -> {
      expect remaining == 0   // W-3 mirror — caller guarantees amount ≤ L_avail
      []
    }
    [h, ..rest] ->
      if remaining <= 0 { holdings }
      else if remaining >= h.amount {
        // Full consume — drop this holding entirely
        consume_newest(rest, remaining - h.amount)
      } else {
        // Partial consume — keep the older portion of this holding
        [LoyaltyHolding { ..h, amount: h.amount - remaining }, ..rest]
      }
  }
}

// ══════════════════════════════════════════════════════════════
// sum_holdings — INV-3 / C-VAULT-10 (W-7 invariant)
// ══════════════════════════════════════════════════════════════
pub fn sum_holdings(holdings: List<LoyaltyHolding>) -> Int {
  list.foldl(holdings, 0, fn(h, acc) { acc + h.amount })
}
