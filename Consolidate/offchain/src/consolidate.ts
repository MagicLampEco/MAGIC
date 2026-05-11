// src/consolidate.ts — ConsolidateHoldings (§6.9)
// Normative: C-CONSOLIDATE-1..6, T23 (determinism, convergence, conservation)
// Algorithm: sort-partition-merge (P8: deterministic across all implementations)
//
// T23 proof:
//   Determinism: partition → sort → adjacent merge → deterministic (P8 fix for same-epoch ties)
//   Convergence: each pass reduces ≥1 entry → terminates in ≤⌊n/2⌋ passes
//   Conservation: merge sums amounts; partition preserves locked/unlocked separation

export interface LoyaltyHolding {
  amount         : bigint;
  acquired_epoch : bigint;
  is_locked      : boolean;
}

// ══════════════════════════════════════════════════════════════
// §6.9 ConsolidateHoldings — sort-partition-merge
// ══════════════════════════════════════════════════════════════

/**
 * Main entry point.
 * MUST produce bit-identical output across all implementations (P8, T23).
 *
 * TV-CONSOLIDATE-01: [5L,6L,7L] → [{5,2,L},{7,1,L}]
 * TV-CONSOLIDATE-02: [5L,6U,6L,7U] → [{5,2,L},{6,2,U}]
 * TV-CONSOLIDATE-03: After consolidate + fire → C-VAULT-9 maintained
 */
export function consolidateHoldings(holdings: LoyaltyHolding[]): LoyaltyHolding[] {
  // Step 1: Partition by is_locked (C-CONSOLIDATE-1: only merge same is_locked)
  // P8: partition before sort → no non-deterministic tie-breaking between locked/unlocked
  const locked   = holdings.filter(h =>  h.is_locked);
  const unlocked = holdings.filter(h => !h.is_locked);

  // Step 2: Merge each group independently
  const mergedLocked   = mergeGroup(locked);
  const mergedUnlocked = mergeGroup(unlocked);

  // Step 3: Combine and sort by (acquired_epoch, is_locked) for canonical output
  return [...mergedLocked, ...mergedUnlocked]
    .sort((a, b) => {
      const epDiff = Number(a.acquired_epoch - b.acquired_epoch);
      if (epDiff !== 0) return epDiff;
      return a.is_locked === b.is_locked ? 0 : a.is_locked ? -1 : 1;
    });
}

/**
 * MergeGroup: sort by epoch, then repeatedly merge adjacent pairs with |epoch_diff| ≤ 1.
 * C-CONSOLIDATE-2: merged.acquired_epoch = min(A, B)  [conservative LF]
 * C-CONSOLIDATE-3: merged.amount = A + B
 * Convergence (T23): each pass reduces ≥1 entry; terminates in ≤⌊n/2⌋ passes.
 */
function mergeGroup(group: LoyaltyHolding[]): LoyaltyHolding[] {
  // Sort ascending by acquired_epoch (canonical order)
  let sorted = [...group].sort((a, b) => Number(a.acquired_epoch - b.acquired_epoch));

  let changed = true;
  while (changed) {
    changed = false;
    const next: LoyaltyHolding[] = [];
    let i = 0;
    while (i < sorted.length) {
      const cur  = sorted[i]!;
      const nxt  = sorted[i + 1];
      if (nxt && nxt.acquired_epoch - cur.acquired_epoch <= 1n) {
        // Merge: min epoch (conservative LF), sum amounts
        next.push({
          amount:         cur.amount + nxt.amount,
          acquired_epoch: cur.acquired_epoch,     // C-CONSOLIDATE-2: min = conservative LF
          is_locked:      cur.is_locked,           // guaranteed same by partition
        });
        i += 2;
        changed = true;
      } else {
        next.push(cur);
        i++;
      }
    }
    sorted = next;
  }
  return sorted;
}

// ══════════════════════════════════════════════════════════════
// Validation helpers (C-CONSOLIDATE-4..6)
// ══════════════════════════════════════════════════════════════

/** C-CONSOLIDATE-4: |output| < |input| */
export function validateReduced(input: LoyaltyHolding[], output: LoyaltyHolding[]): boolean {
  return output.length < input.length;
}

/** C-CONSOLIDATE-5: Σ(output.amount) == Σ(input.amount) */
export function validateTotalConserved(input: LoyaltyHolding[], output: LoyaltyHolding[]): boolean {
  const sumIn  = input.reduce((s, h) => s + h.amount, 0n);
  const sumOut = output.reduce((s, h) => s + h.amount, 0n);
  return sumIn === sumOut;
}

/** C-CONSOLIDATE-6: Σ(locked output) == Σ(locked input) [C-VAULT-9 safety] */
export function validateLockedConserved(input: LoyaltyHolding[], output: LoyaltyHolding[]): boolean {
  const lockedIn  = input.filter(h =>  h.is_locked).reduce((s, h) => s + h.amount, 0n);
  const lockedOut = output.filter(h => h.is_locked).reduce((s, h) => s + h.amount, 0n);
  return lockedIn === lockedOut;
}

/** Run all C-CONSOLIDATE-* checks. Throws on violation. */
export function validateConsolidate(
  input  : LoyaltyHolding[],
  output : LoyaltyHolding[],
): void {
  if (!validateReduced(input, output))
    throw new Error(`C-CONSOLIDATE-4: |output|=${output.length} ≥ |input|=${input.length}`);
  if (!validateTotalConserved(input, output))
    throw new Error(`C-CONSOLIDATE-5: Σ amount not conserved`);
  if (!validateLockedConserved(input, output))
    throw new Error(`C-CONSOLIDATE-6: Σ locked amount not conserved — C-VAULT-9 violation`);
}

// ══════════════════════════════════════════════════════════════
// Utility: check if consolidation is needed/possible
// ══════════════════════════════════════════════════════════════

/** Returns true if at least one mergeable pair exists */
export function canConsolidate(holdings: LoyaltyHolding[]): boolean {
  const locked   = holdings.filter(h =>  h.is_locked)
    .sort((a, b) => Number(a.acquired_epoch - b.acquired_epoch));
  const unlocked = holdings.filter(h => !h.is_locked)
    .sort((a, b) => Number(a.acquired_epoch - b.acquired_epoch));

  const hasMerge = (group: LoyaltyHolding[]) =>
    group.some((h, i) => i + 1 < group.length && group[i+1]!.acquired_epoch - h.acquired_epoch <= 1n);

  return hasMerge(locked) || hasMerge(unlocked);
}
