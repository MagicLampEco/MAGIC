# LampDistribution — Spec thuật toán phân bổ LAMP (Drop Lottery)

**Doctype:** MagicLamp Protocol — Onchain Spec
**Version:** v0.1 (Preview testnet MVP)
**Updated:** 2026-05-30
**Nguồn chuẩn:** `MagicLamp-Docs/docs/LAMP-Distribution.md` v1.0 (2026-05-27)

Tài liệu này đặc tả thuật toán + kiến trúc on-chain/off-chain để triển khai cơ chế
phân bổ LAMP qua **Probabilistic Drop Lottery** trên Cardano Preview. Mọi quyết định
kiến trúc đều ghi rõ lý do theo 4 trục: định hướng dài hạn, tư duy nguyên bản, tối ưu,
lợi ích người dùng + bền vững.

---

## 0. Phạm vi MVP

| Trong phạm vi (build + test) | Ngoài phạm vi (defer, có lý do) |
|---|---|
| ClaimAccount validator (state CLAIMED) | 7 validator riêng từng kênh (ISPO/Scavenger/…) |
| Redeem validator + Merkle proof verify | PhoenixKey on-chain DID proof |
| Beacon validators (P / Randomness / MerkleRoot) | On-chain P computation (đủ signal on-chain) |
| DistributionTreasury validator (release LAMP) | iVoteSpace / Treasury governance Phase 4 |
| Off-chain: P engine, Lottery engine, Merkle builder, tx builders | Slashing validator OrgDID |
| Aiken unit tests + vitest + integration test | Mainnet deploy |

**MECE decomposition (tư duy nguyên bản):** Cơ chế phân bổ tách 3 tầng độc lập:

```
  [TẦNG NGUỒN]          [TẦNG LÕI ENGINE]            [TẦNG DANH TÍNH]
  7 kênh activity   →   Claim→Lottery→Redeem    ⟂    PhoenixKey anti-sybil
  (adapter, sau)        (xương sống, build NGAY)      (policy off-chain validator)
```

Tầng lõi là `claimed_balance` abstraction — mọi kênh đều quy về "validator committee
xác nhận wallet X đáng nhận N LAMP". Lõi KHÔNG cần biết kênh nào, KHÔNG cần biết DID.
→ Đây là lý do build lõi trước được: nó là invariant chung, không block bởi 2 tầng kia.

---

## 1. Bảy quyết định kiến trúc

### QĐ1 — Tách core engine khỏi 7 kênh + PhoenixKey (DID-agnostic)
- **Nguyên bản:** `claimed_balance` là abstraction chung của mọi kênh. Drop Lottery chỉ
  thao tác trên con số này, không cần biết nguồn.
- **Định hướng dài hạn:** open SDK cho mọi Cardano team — không lock vào PhoenixKey.
- **Tối ưu:** không block bởi PhoenixKey on-chain proof (chưa có spec).
- Anti-sybil được enforce ở **tầng validator committee** (off-chain quyết ai đủ điều kiện
  claim — họ dùng PhoenixKey hoặc KYC gì tuỳ). Core engine chỉ trust multisig 2/3.

### QĐ2 — Epoch nonce qua RandomnessBeacon UTxO (committee post)
- **Vấn đề:** Plutus V3 script context KHÔNG expose Cardano epoch nonce.
- **Giải pháp MVP:** committee multisig đọc epoch nonce off-chain (Koios/cardano-cli),
  post vào `RandomnessBeacon` UTxO mỗi epoch.
- **Bền vững + minh bạch:** nonce là public — bất kỳ ai cũng verify committee post đúng
  giá trị Cardano thật (trust-but-verify). Gian lận bị phát hiện ngay.
- **V2:** nâng cấp khi Cardano expose nonce on-chain hoặc dùng VRF beacon contract.

### QĐ3 — P parameter off-chain compute + PParamBeacon (1-epoch announcement)
- Signals S1–S4 (§6.2 nguồn) một phần off-chain (S3 LampNet utilization). MVP: committee
  compute P theo công thức công khai + post vào `PParamBeacon` cuối epoch N cho epoch N+1.
- **Lợi ích user:** đúng spec §6.4 — user có trọn 1 epoch tự verify P + tự tính D.
- **V2:** on-chain compute khi mọi signal lên chain.

### QĐ4 — Merkle tree BLAKE2b-256, RFC 6962 domain separation
- Leaf  = `blake2b_256(0x00 ‖ owner_pkh ‖ won_cumulative_be8)`
- Node  = `blake2b_256(0x01 ‖ min(L,R) ‖ max(L,R))`  *(sorted-pair, không cần lưu vị trí)*
- **Nguyên bản (security):** prefix `0x00/0x01` chống second-preimage (leaf ≠ node).
  Sorted-pair → proof không cần bit chỉ hướng → đơn giản + nhỏ hơn.
- Aiken có `aiken/crypto.{blake2b_256}`; offchain dùng `@noble/hashes/blake2b`.

### QĐ5 — Per-wallet ClaimAccount UTxO (không global map)
- Mỗi wallet 1 UTxO tại `claim_account` script, datum giữ accounting riêng.
- **Tối ưu eUTXO:** claim/redeem của wallet khác nhau KHÔNG đụng cùng UTxO → song song,
  không contention. Global map UTxO sẽ là điểm nghẽn toàn hệ thống.
- **Bền vững:** scale tuyến tính theo số user.

### QĐ6 — Cumulative Merkle accounting (chống double-redeem + batch tự nhiên)
- Mỗi lottery epoch N, committee tính `won_cumulative[wallet]` = tổng redeemable
  **từ genesis tới N** (đơn điệu tăng). Merkle leaf = `{owner, won_cumulative}`.
- ClaimAccount datum giữ `redeemed_cumulative`.
- Redeem: submit proof epoch latest → `released = won_cumulative − redeemed_cumulative`,
  rồi set `redeemed_cumulative = won_cumulative`.
- **Nguyên bản:** đơn điệu tăng → dùng lại proof cũ cho `released ≤ 0` → tự chặn double.
  1 proof epoch mới nhất = gộp mọi epoch trước → **batch tự nhiên, 1 UTxO** (đúng §9.2).
- **Tối ưu:** O(1) redeem, không cần liệt kê từng epoch thắng.

### QĐ7 — DistributionTreasury nhiều UTxO (release LAMP, eUTXO-native song song)
- Pool 36B LAMP chứa trong N `treasury` UTxO (Preview MVP có thể 1–4). Redeem consume
  1 treasury UTxO đủ LAMP + trả phần dư về chính script.
- **Tối ưu:** nhiều UTxO → user khác nhau chọn UTxO khác nhau → song song. Không shard
  logic phức tạp cho MVP; validator chỉ cần bảo toàn `released ≤ proof_amount` và phần dư
  quay về treasury.

---

## 2. State machine (4 trạng thái nguồn §3)

```
 EARNED ──claim(committee 2/3)──▶ CLAIMED ──lottery(off-chain)──▶ REDEEMABLE ──redeem──▶ LIQUID
 (off-chain)                     (ClaimAccount UTxO)            (MerkleRoot beacon)     (ví user)
```

Accounting trên ClaimAccount (đơn điệu, mọi giá trị **oil**, 1 LAMP = 10^6 oil):

| Field | Ý nghĩa | Thay đổi |
|---|---|---|
| `claimed_cumulative` | tổng đã claim (committee confirm) | +amount khi claim |
| `redeemed_cumulative` | tổng đã rút ra ví | =won_cumulative khi redeem |
| `last_claim_epoch` | epoch claim gần nhất | =current khi claim |

Bất biến: `0 ≤ redeemed_cumulative ≤ won_cumulative ≤ claimed_cumulative`.
- `won_cumulative` KHÔNG lưu on-chain — đọc từ Merkle proof mỗi lần redeem (tối ưu datum).
- Tickets lottery epoch kế = `D = ceil((claimed_cumulative − won_cumulative) / P)` (committee
  tính off-chain; `claimed_cumulative` đọc on-chain, `won` từ history committee giữ).

---

## 3. Thuật toán Drop Lottery (off-chain, §5)

Cuối mỗi epoch N (sau khi `P_N` đã announce ở N−1):

```
input:  nonce_N           = RandomnessBeacon[N]          (32 bytes)
        P_N               = PParamBeacon[N]              (oil/drop)
        accounts          = { wallet → (claimed_cum, won_cum_prev) }
        p                 = target_rate (Q-format, ~0.33%)

for each wallet w:
    remaining = claimed_cum[w] − won_cum_prev[w]         // phần chưa thắng
    D = ceil(remaining / P_N)                            // số drops = tickets
    d = 0
    for i in 0 .. D-1:
        seed = blake2b_256(nonce_N ‖ w ‖ uint64_be(i))   // 256-bit
        if (seed_as_uint256 < p × 2^256):   d += 1        // ticket thắng
    won_this_epoch = min(d × P_N, remaining)             // §5.4 — không vượt remaining
    won_cum_new[w] = won_cum_prev[w] + won_this_epoch

build Merkle tree of leaves { (w, won_cum_new[w]) : won_cum_new[w] > 0 }
post MerkleRootBeacon[N] = root
```

**Xác suất threshold:** `p × 2^256` với p ở Q-format (Q=10^9). `p = 0.33% = 3_300_000 (Q)`.
Threshold = `seed < (p_q × 2^256) / Q`. So sánh trên BigInt 256-bit.

**Tính đơn điệu:** `won_cum_new ≥ won_cum_prev` luôn đúng → Merkle leaf đơn điệu → QĐ6.

---

## 4. Thuật toán P parameter (off-chain, §6)

Cuối epoch N → tính `P_{N+1}`:

```
S1 = MAGIC_consumed(N)        S2 = MAGIC_generated(N)
S3 = LampNet_utilization(N)   S4 = claimed_but_unredeemed(N)

demand_proxy = S1 + f(S3)                     // f: trọng số hạ tầng
ratio        = demand_proxy / S2              // Q-format
raw_delta    = (ratio − 1) × sensitivity      // Q-format, có dấu
smooth_delta = EMA(raw_delta, window=3)       // chống dao động
bounded      = clamp(smooth_delta, −0.10, +0.10)
P_next       = clamp(P_current × (1 + bounded), P_min=10, P_max=10_000)   // LAMP
```

Đơn vị P: spec gốc nói "LAMP/drop". On-chain lưu **oil** (P_oil = P_lamp × 10^6) để
khớp accounting. P_genesis = 100 LAMP = 100_000_000 oil.

**EMA:** `ema_t = α·x_t + (1−α)·ema_{t-1}`, window=3 → `α = 2/(3+1) = 0.5`. Q-format.

---

## 5. Onchain types (interface contract — `types.ak` ↔ `types.ts`)

```aiken
// ClaimAccount datum
type ClaimAccountDatum {
  owner               : ByteArray,   // PKH chủ ví
  claimed_cumulative  : Int,         // oil
  redeemed_cumulative : Int,         // oil
  last_claim_epoch    : Int,
}

// ClaimAccount redeemer
type ClaimAccountRedeemer {
  Claim { amount: Int }              // committee 2/3 confirm → claimed_cumulative += amount
  Redeem { won_cumulative: Int, lottery_epoch: Int, proof: List<ByteArray> }
}

// Beacon datum (P / Randomness / MerkleRoot dùng chung khung)
type BeaconDatum {
  epoch  : Int,
  kind   : BeaconKind,               // PParam | Randomness | MerkleRoot
  value  : ByteArray,                // P (uint), nonce (32B), hoặc merkle root (32B)
}
type BeaconKind { PParam | Randomness | MerkleRoot }

// Treasury datum
type TreasuryDatum {
  committee_hash : ByteArray,        // hash của committee multisig policy/script
}
```

**Committee authorization:** MVP dùng M-of-N native multisig. `Claim` + mọi beacon post +
treasury release đều yêu cầu ≥ 2/3 committee signatures (qua `tx.extra_signatories` so với
danh sách committee keyHash trong validator parameter). Redeem KHÔNG cần committee (user
tự redeem với Merkle proof) — chỉ cần owner sign.

---

## 6. Invariants (normative — đặt tên để test + audit truy vết)

| ID | Phát biểu |
|---|---|
| **C-CLAIM-1** | `Claim` yêu cầu ≥ ⌈2N/3⌉ committee signatures. |
| **C-CLAIM-2** | output.claimed_cumulative = input.claimed_cumulative + amount; amount > 0. |
| **C-CLAIM-3** | output.owner == input.owner; redeemed_cumulative unchanged. |
| **C-CLAIM-4** | output.last_claim_epoch == current_epoch (từ validity_range). |
| **C-CLAIM-5** | đúng 1 ClaimAccount input + 1 output cùng script (chống double-satisfaction). |
| **C-RDM-1** | Merkle proof hợp lệ cho leaf `(owner, won_cumulative)` against MerkleRootBeacon[lottery_epoch]. |
| **C-RDM-2** | won_cumulative > input.redeemed_cumulative (released > 0). |
| **C-RDM-3** | released = won_cumulative − input.redeemed_cumulative; user nhận đúng `released` LAMP. |
| **C-RDM-4** | output.redeemed_cumulative == won_cumulative; các field khác unchanged. |
| **C-RDM-5** | won_cumulative ≤ input.claimed_cumulative (không redeem quá đã claim). |
| **C-RDM-6** | owner signs (`tx.extra_signatories`). |
| **C-RDM-7** | đúng 1 ClaimAccount input + 1 output (single-satisfaction). |
| **C-TRE-1** | Treasury release ≤ tổng `released` của các Redeem trong cùng tx; phần dư về script. |
| **C-TRE-2** | Treasury datum (committee_hash) bảo toàn ở output. |
| **C-BCN-1** | Beacon post yêu cầu committee 2/3; epoch đơn điệu tăng; kind bảo toàn. |
| **C-MINT-0** | Mọi validator: `tx.mint == zero` (không validator nào liên quan mint LAMP). |
| **C-VAL-0** | Mọi spend: vault Value bảo toàn đúng (datum ↔ value khớp; treasury LAMP_out đúng). |

---

## 7. Tham số (`constants.ak` ↔ `constants.ts`)

| Tên | Giá trị | Đơn vị | Ghi chú |
|---|---|---|---|
| P_GENESIS | 100_000_000 | oil | 100 LAMP |
| P_MIN | 10_000_000 | oil | 10 LAMP |
| P_MAX | 10_000_000_000 | oil | 10_000 LAMP |
| MAX_P_DELTA_Q | 100_000_000 | Q | ±10% (0.10 × Q) |
| P_EMA_WINDOW | 3 | epoch | α = 0.5 |
| TARGET_RATE_Q | 3_300_000 | Q | 0.33% |
| MERKLE_LEAF_PREFIX | 0x00 | byte | domain sep |
| MERKLE_NODE_PREFIX | 0x01 | byte | domain sep |
| COMMITTEE_THRESHOLD | ⌈2N/3⌉ | sig | Byzantine 2/3 |
| LAMP total | 36×10^15 | oil | từ ProtocolUtils.S_LAMP_TOTAL |

---

## 8. Flow test (integration — phải pass)

```
1. Deploy: mint LAMP pool → treasury UTxO(s); set committee 3 keys (threshold 2).
2. Claim:  committee(2/3) confirm wallet A claim 250 LAMP, B claim 1000 LAMP.
3. Beacon: post P_1 = 100 LAMP, nonce_1 (fixed test vector).
4. Lottery (off-chain): compute won_cumulative cho A,B; build Merkle; post root_1.
5. Redeem: A submit proof → nhận đúng won_A LAMP; redeemed_cumulative = won_A.
6. Double-redeem: A submit lại proof_1 → reject (released = 0).
7. Batch: epoch 2 lottery → won grows; A submit proof_2 → nhận (won2 − won1).
8. Invariant check: Σ released ≤ Σ claimed; treasury bảo toàn.
```

Tất cả bước có unit test (Aiken + vitest) + 1 integration test mô phỏng full flow off-chain.
