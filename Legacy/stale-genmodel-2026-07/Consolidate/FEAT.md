# FEAT — ConsolidateHoldings (§6.9)
GenMAGIC v3.3 · C-CONSOLIDATE-1..6 · T23

---

## 1. Mục đích

Vault giữ LAMP dưới dạng danh sách `loyalty_holdings` (mỗi entry là `{amount, acquired_epoch, is_locked}`). Mỗi lần nhận LAMP từ Treasury hoặc từ một nguồn reward → thêm 1 entry mới (`age=0`). Sau nhiều giao dịch, danh sách phân mảnh → tiêu tốn ExUnit khi xử lý onchain (A5). Giới hạn cứng `MAX_LOYALTY_HOLDINGS = 64` (`constants.ts:6`, `constants.ak`). Khi số entry tiến gần 64, vault có nguy cơ bị khoá (không thể thêm holding mới).

**ConsolidateHoldings** là cơ chế cho phép chủ vault gộp các entry gần nhau thành ít entry hơn, giảm chiều dài danh sách mà vẫn bảo toàn tổng số dư và cấu trúc khoá/mở khoá.

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| Vault owner | Ký giao dịch consolidate (pubkey hash trong `datum.owner`) |
| Validator `vault_consolidate` | Kiểm tra bất biến onchain |
| Offchain SDK (`consolidate.ts`) | Tính toán danh sách mới, build tx |
| Wallet UI | Gợi ý consolidate khi `|holdings| ≥ 50` (README.md:12) |

---

## 3. Flows

### 3a. Happy path

```
1. Wallet đọc vault UTxO hiện tại.
2. Gọi canConsolidate(holdings) → True.
3. Gọi consolidateHoldings(holdings) → newHoldings.
4. Gọi validateConsolidate(holdings, newHoldings) → không throw.
5. Build tx:
   - Spend vault UTxO với redeemer Consolidate.
   - Output vault UTxO mới: datum giống hệt cũ, chỉ đổi loyalty_holdings.
   - Gắn owner signature vào extra_signatories.
6. Submit tx. Validator chạy:
   a. Kiểm tra owner ký (C-PC-V1).
   b. Đúng 1 input + 1 output theo script hash (chống double-satisfaction).
   c. Mọi field output == input NGOẠI TRỪ loyalty_holdings.
   d. |output| < |input| (C-CONSOLIDATE-4).
   e. Σ(output.amount) = Σ(input.amount) (C-CONSOLIDATE-5).
   f. Σ(locked output) = Σ(locked input) (C-CONSOLIDATE-6).
   g. Σ(output.amount) = lamp_balance (C-VAULT-10).
   h. lamp_locked ≤ lamp_balance (C-VAULT-8).
```

### 3b. Edge cases — MECE

| Case | Kết quả |
|---|---|
| `|holdings| = 1` | `canConsolidate` trả False; không build tx |
| Tất cả entry đều cách nhau > 1 epoch | `canConsolidate` trả False |
| Chỉ locked entries có thể merge, unlocked không | Chỉ locked group giảm; unlocked giữ nguyên |
| Same epoch, khác `is_locked` | KHÔNG merge (C-CONSOLIDATE-1) |
| Nhiều round hội tụ (cascade merge) | Vòng lặp while-changed trong `mergeGroup` chạy đến stable (T23) |
| Chủ vault quên ký | Validator reject tại kiểm tra `extra_signatories` |
| Attacker thêm 2 vault input (double-satisfaction qua stake cred) | `count_inputs_at_script` trả 2 → reject |
| Attacker đổi `profile` trong output | Validator so sánh field-by-field → reject |
| Attacker đổi `streak_state` trong output | Validator so sánh field-by-field → reject |
| Attacker rút bớt `magic_batches` trong output | Validator so sánh field-by-field → reject |
| Consolidate không giảm entries (|output| = |input|) | C-CONSOLIDATE-4 → reject |
| Tổng amount thay đổi | C-CONSOLIDATE-5 → reject |
| Locked amount thay đổi | C-CONSOLIDATE-6 → reject |

---

## 4. Invariants (normative)

Mã nguồn: `vault_consolidate.ak:43-98`, `consolidate.ts:86-115`.

| ID | Phát biểu |
|---|---|
| C-PC-V1 | `datum.owner ∈ tx.extra_signatories` |
| C-DOUBLE-SAT | `count_inputs_at_script(inputs, own_hash) = 1 ∧ count_outputs_at_script(outputs, own_hash) = 1` |
| C-FIELD-LOCK | Mọi field trong output == input ngoại trừ `loyalty_holdings` |
| C-CONSOLIDATE-1 | Chỉ merge holdings cùng `is_locked` |
| C-CONSOLIDATE-2 | `merged.acquired_epoch = min(A.acquired_epoch, B.acquired_epoch)` |
| C-CONSOLIDATE-3 | `merged.amount = A.amount + B.amount` |
| C-CONSOLIDATE-4 | `|output.loyalty_holdings| < |input.loyalty_holdings|` |
| C-CONSOLIDATE-5 | `Σ(output.loyalty_holdings[i].amount) = Σ(input.loyalty_holdings[i].amount)` |
| C-CONSOLIDATE-6 | `Σ{h∈output \| h.is_locked}(h.amount) = Σ{h∈input \| h.is_locked}(h.amount)` |
| C-VAULT-8 | `lamp_locked ≤ lamp_balance` (kiểm tra trên input, bất biến không thay đổi) |
| C-VAULT-10 | `Σ(output.loyalty_holdings[i].amount) = lamp_balance` |

---

## 5. Out-of-scope

- Thay đổi `lamp_balance` hoặc `lamp_locked` — ConsolidateHoldings KHÔNG di chuyển LAMP thực, chỉ tái cơ cấu danh sách kế toán.
- Merge holdings khi `|epoch_diff| > 1` — ngưỡng 1 epoch là thiết kế bảo thủ, tránh mất tuổi holding quá nhiều.
- Tự động consolidate — luôn cần chủ vault ký.
- Tạo MAGIC — Consolidate không tương tác với `magic_batches` hay bất kỳ GenMAGIC mechanism nào.
- Thay đổi profile, delegation, streak — tất cả đều bị khoá bởi `C-FIELD-LOCK`.
