# MATH — ConsolidateHoldings (§6.9)
GenMAGIC v3.3 · C-CONSOLIDATE-1..6 · T23 · P8

> **Module MỒ CÔI — chưa được quyết hội tụ hay dời `Legacy/`.** Xem
> [`DevStatus.md`](../DevStatus.md). Nguồn chân lý mô hình:
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md);
> số mục "§6.9" là di sản đánh số GenMAGIC v3.3, không phải mục lục spec canonical.
> Validator ở đây là **script hash RIÊNG** (`vault_consolidate`), nên UTxO nằm ở địa chỉ
> vault InstantGen **không bao giờ chạy** validator này. Vector trong tệp này chưa được đối
> chiếu lại với mô hình ba token — dùng làm neo P8 cho module khác là neo vào thứ chưa chốt.

---

## 1. Định nghĩa hình thức

Gọi `H` là tập hợp holdings của vault tại thời điểm consolidate:

```
H = { (aᵢ, eᵢ, lᵢ) | i = 1..n }
```

Trong đó:
- `aᵢ ∈ ℕ` — số dư LAMP của holding i (đơn vị: oildrop = LAMP × 10⁶, kiểu BigInt)
- `eᵢ ∈ ℕ` — epoch khi holding được tạo (`acquired_epoch`)
- `lᵢ ∈ {True, False}` — cờ khoá (`is_locked`)

Các ký hiệu tổng:

```
S(H)   = Σᵢ aᵢ             (tổng tất cả)
S_L(H) = Σ{i | lᵢ=True} aᵢ (tổng locked)
S_U(H) = Σ{i | lᵢ=False} aᵢ (tổng unlocked)
```

Bất biến tối thiểu của vault hợp lệ trước khi consolidate:

```
lamp_balance = S(H)          (C-VAULT-10)
lamp_locked  = S_L(H)        (C-VAULT-9, implicit)
lamp_locked  ≤ lamp_balance  (C-VAULT-8)
```

---

## 2. Thuật toán Sort-Partition-Merge

Nguồn: `consolidate.ts:25-78`, `README.md:17-28`.

### Bước 1 — Partition (C-CONSOLIDATE-1)

```
H_L = { h ∈ H | h.is_locked = True  }
H_U = { h ∈ H | h.is_locked = False }
```

Lý do partition trước khi sort: tránh tie-breaking không xác định khi hai entry có cùng epoch nhưng khác `is_locked`. Ví dụ: `[5L, 6U, 6L, 7U]` — sort naïve tạo tình huống không xác định tại epoch=6 (P8 fix, `README.md:26-28`).

### Bước 2 — Sort trong từng nhóm

```
sort H_L by eᵢ ascending  →  H_L_sorted
sort H_U by eᵢ ascending  →  H_U_sorted
```

### Bước 3 — MergeGroup (lặp đến stable)

Hàm `mergeGroup(G)` áp dụng cho mỗi nhóm:

```
while ∃ adjacent pair (i, i+1) trong G sao cho e_{i+1} - eᵢ ≤ 1:
    Gộp cặp (i, i+1) thành entry mới:
        a'  = aᵢ + a_{i+1}          (C-CONSOLIDATE-3)
        e'  = min(eᵢ, e_{i+1})      (C-CONSOLIDATE-2: bảo thủ — giữ LF cao)
        l'  = lᵢ = l_{i+1}          (guaranteed cùng nhóm)
    Thay thế cặp bằng entry mới
    Lặp lại từ đầu
Trả về G khi không còn cặp nào gộp được
```

Nguồn code: `consolidate.ts:55-77`.

**Bất biến vòng lặp:** sau mỗi pass, `|G| giảm ≥ 1`. Số pass ≤ ⌊n/2⌋ → thuật toán kết thúc (T23 convergence).

**Tính idempotent:** `mergeGroup(mergeGroup(G)) = mergeGroup(G)` — áp dụng 2 lần cho ra cùng kết quả (test `consolidate.test.ts:156-167`).

### Bước 4 — Kết hợp và sort canonical

```
H' = sort( mergeGroup(H_L) ∪ mergeGroup(H_U) )
     theo (acquired_epoch asc, is_locked=True trước)
```

Nguồn code: `consolidate.ts:36-42`.

---

## 3. Điều kiện biên (Boundary conditions)

| Trường hợp | Kết quả |
|---|---|
| `|H| = 0` | `mergeGroup([]) = []`; không build tx (canConsolidate trả False) |
| `|H| = 1` | Không có pair → không merge; canConsolidate trả False |
| Tất cả entry locked, cascade: `[e, e+1, e+2, ...]` | Pass 1: gộp từng cặp → `⌊n/2⌋` entry; Pass 2: lại gộp → hội tụ |
| epoch_diff = 0 (cùng epoch, cùng locked) | Merge: `e' = min = e`, `a' = a₁ + a₂` |
| epoch_diff = 1 | Merge: `e' = eᵢ` (nhỏ hơn), `a' = aᵢ + a_{i+1}` |
| epoch_diff = 2 | KHÔNG merge |
| Locked và unlocked cùng epoch = e | KHÔNG merge (khác nhóm partition) |
| `a = 0` (holding rỗng) | Hợp lệ theo kiểu; sau merge `a' = 0 + a_{i+1}` — không tạo thêm entry rỗng |

---

## 4. Tính đúng của C-CONSOLIDATE-2 (bảo thủ LF)

`acquired_epoch` ảnh hưởng tới Loyalty Factor (LF) trong các cơ chế sinh MAGIC. LF thường tăng theo độ tuổi (epoch hiện tại − acquired_epoch). Lấy `min` epoch → holding merged có tuổi cao hơn → LF không bị giảm khi merge. Đây là quyết định bảo thủ theo hướng có lợi cho user.

```
age(h, e_now) = e_now - h.acquired_epoch
LF(age) nondecreasing theo age

∀ merge (A, B), e_now:
  age(merged) = e_now - min(eA, eB) = max(age(A), age(B)) ≥ max(age(A), age(B))
  → LF(merged.age) ≥ LF(smaller of the two)
```

---

## 5. Test vectors (verifiable, số thật)

### TV-CONSOLIDATE-01 — cascade locked merge

Nguồn: `consolidate.test.ts:20-33`.

```
Input:  [ {1, 5, L}, {1, 6, L}, {1, 7, L} ]
S(H)    = 3
S_L(H)  = 3

Pass 1:
  Pair (i=0,1): epoch_diff = 6-5 = 1 ≤ 1 → merge
    merged = {2, 5, L}
  Remaining: [ {2, 5, L}, {1, 7, L} ]

Pass 2:
  Pair (i=0,1): epoch_diff = 7-5 = 2 > 1 → no merge → stable

Output: [ {2, 5, L}, {1, 7, L} ]
S(H')   = 3 = S(H) ✓ (C-CONSOLIDATE-5)
S_L(H') = 3 = S_L(H) ✓ (C-CONSOLIDATE-6)
|H'| = 2 < 3 = |H| ✓ (C-CONSOLIDATE-4)
acquired_epochs: [5,7] — epoch 5 bảo thủ ✓ (C-CONSOLIDATE-2)
```

### TV-CONSOLIDATE-02 — mixed locked/unlocked, P8 determinism

Nguồn: `consolidate.test.ts:42-83`.

```
Input:  [ {1,5,L}, {1,6,U}, {1,6,L}, {1,7,U} ]
S(H)    = 4
S_L(H)  = 2  (5L + 6L)
S_U(H)  = 2  (6U + 7U)

Partition:
  H_L = [ {1,5,L}, {1,6,L} ]
  H_U = [ {1,6,U}, {1,7,U} ]

mergeGroup(H_L):
  Pair (0,1): diff = 6-5 = 1 → merge → {2, 5, L}
  → [ {2, 5, L} ]

mergeGroup(H_U):
  Pair (0,1): diff = 7-6 = 1 → merge → {2, 6, U}
  → [ {2, 6, U} ]

Combine + sort by (epoch, locked_first):
  Output: [ {2,5,L}, {2,6,U} ]
S(H')   = 4 = S(H) ✓
S_L(H') = 2 = S_L(H) ✓
|H'| = 2 < 4 ✓

P8: 3 permutation input → cùng output ✓ (consolidate.test.ts:61-77)
```

### TV-CONSOLIDATE-03 — consolidate + fire (App B §B.15)

Nguồn: `consolidate.test.ts:89-121`.

```
Input vault:
  holdings = [ {1000, 50, L}, {500, 51, L}, {200, 60, U} ]
  lamp_balance = 1700   (= 1000+500+200)
  lamp_locked  = 1500   (= 1000+500)

Consolidate:
  H_L = [ {1000,50,L}, {500,51,L} ] → diff = 1 → merge → {1500, 50, L}
  H_U = [ {200,60,U} ] → no pair → unchanged

Output holdings: [ {1500, 50, L}, {200, 60, U} ]
C-VAULT-10: 1500+200 = 1700 = lamp_balance ✓
C-CONSOLIDATE-6: S_L = 1500 = 1500 ✓

Simulate fire λ=200 (ScheduleGen):
  Deduct 200 from locked: {1500,50,L} → {1300,50,L}
  Cập nhật: lamp_locked' = 1300, lamp_balance' = 1500
  C-VAULT-9 maintained: lamp_locked' = S_L(after_fire) = 1300 ✓
```

---

## 6. Tính bảo toàn (chứng minh ngắn)

**C-CONSOLIDATE-5:** `mergeGroup` chỉ thực hiện `a' = aᵢ + a_{i+1}` (thay 2 entry bằng 1 entry với tổng bằng). Induction theo số cặp gộp: base case `0 cặp → S không đổi`; inductive step `gộp 1 cặp → S không đổi`. ∎

**C-CONSOLIDATE-6:** Partition đảm bảo H_L và H_U hoàn toàn tách biệt. `mergeGroup` không tạo entry mới với `is_locked` khác. Do đó `S_L(H') = S(mergeGroup(H_L)) = S(H_L) = S_L(H)`. ∎

**C-CONSOLIDATE-4:** Mỗi gộp thay 2 entry → 1 entry, giảm 1. Nếu ít nhất 1 gộp xảy ra → `|H'| < |H|`. `canConsolidate` kiểm tra điều này trước khi cho phép build tx.
