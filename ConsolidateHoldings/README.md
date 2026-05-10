# ConsolidateHoldings
## GenMAGIC v3.3 · §6.9 · C-CONSOLIDATE-1..6 · T23

---

## Khi nào cần?

- `MAX_LOYALTY_HOLDINGS = 64` — nếu vault có nhiều holdings → ExUnit exhaustion (A5)
- Mỗi lần nhận LAMP từ Treasury (reward) → thêm 1 holding mới (age=0)
- Sau nhiều giao dịch → holdings phân mảnh → cần merge

**Wallet nên gợi ý consolidate khi `|holdings| ≥ 50`.**

---

## Algorithm — Sort-Partition-Merge (P8 compliant)

```
1. Partition: locked → group L, unlocked → group U
2. Sort each group by acquired_epoch ascending
3. Scan pairs (i, i+1): if |epoch[i+1] - epoch[i]| ≤ 1 AND same is_locked → merge
4. Repeat until stable
5. Return sorted(L∪U)
```

**Tại sao partition trước (P8 fix)?**
Input `[5L,6U,6L,7U]`: sort-by-epoch-only → tie tại epoch=6 → non-deterministic.
Sort-by-partition → locked=[5L,6L], unlocked=[6U,7U] → ALWAYS deterministic.

---

## Usage

```typescript
import { consolidateHoldings, canConsolidate, validateConsolidate } from "@magiclamp/consolidate";

// Check if needed
if (canConsolidate(vault.loyalty_holdings)) {
  const newHoldings = consolidateHoldings(vault.loyalty_holdings);
  validateConsolidate(vault.loyalty_holdings, newHoldings);  // throws if invalid
  // Build tx with newHoldings in output datum
}
```

---

## Tests

```bash
cd offchain && npm install && npm test
# TV-CONSOLIDATE-01/02/03 must all pass
```

---

## C-CONSOLIDATE constraints (normative)

| Constraint | Rule |
|---|---|
| C-CONSOLIDATE-1 | Only merge holdings với cùng `is_locked` |
| C-CONSOLIDATE-2 | `merged.acquired_epoch = min(A, B)` [conservative LF] |
| C-CONSOLIDATE-3 | `merged.amount = A + B` |
| C-CONSOLIDATE-4 | `|output| < |input|` (phải giảm entries) |
| C-CONSOLIDATE-5 | `Σ(output.amount) = Σ(input.amount)` |
| C-CONSOLIDATE-6 | `Σ(locked output) = Σ(locked input)` [C-VAULT-9 safety] |
