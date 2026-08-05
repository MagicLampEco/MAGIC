# MAGIC — Đặc-tả Thực-thi Hợp-nhất (Execution Spec)

> **Neo chuẩn tối thượng:** `SPEC/Whitepaper-MagicLamp-Tokenomic-Vi.md §7` (Cơ chế Gen MAGIC từ LAMP — ScheduleGen + InstantGen; §7.1 br/xanh-đỏ, §7.2 InstantGen trần-kép, §7.3 ScheduleGen κ-cổng). Chi tiết toán InstantGen: `InstantGen/MATH.md` (16/7). Firewall: Whitepaper §10 (F1–F9).
> **Ngày:** 2026-07-17 · **Mạng:** Cardano PlutusV3, Preview testnet · **Vai:** MAGIC = CREDIT của instance Carpet (LAMP=BASE, CARP=UNIT).

---

## Mục lục

1. Bản chất MAGIC + ranh giới hệ (boundary CARP/GreenBack)
2. Bất biến nền — baked (R1/R2/R3, Q-format, Firewall F1–F9)
3. Sáu cơ chế — tổng quan + so trục
4. Hợp-đồng-kiểu dữ liệu on-chain (datum/redeemer contracts)
5. InstantGen — toán gen (nắm-LAMP mở-tư-cách)
6. ScheduleGen — dòng pp × N epoch, cổng κ
7. ConsumeMAGIC — tiêu = BurnBatch + pricing beacon
8. Consolidate — gộp MagicBatch phân mảnh
9. Paymaster — delegate đốt MAGIC thay owner
10. FlowRate — keeper cập nhật demand_mult (dual-EMA)
11. Tham số instance testnet (tLAMP + hằng số)
12. Thứ tự deploy (compile → validator → GlobalState fixture → ví → gen)
13. Kịch bản gen tMAGIC (happy-xanh / van-đỏ / trần-kép) + test vectors
14. Verify on-chain (Koios no-key)
15. Phụ thuộc GreenBack/GlobalState + blocker mở
16. Chỉ mục [NEEDS-EVIDENCE]

---

## 1. Bản chất MAGIC + ranh giới hệ

**MAGIC = prepaid service credit (quyền-tiêu-dịch-vụ trả-trước).** Không policy-id, không token, không chuyển-nhượng. MAGIC = **entitlement trong datum vault** (`MagicBatch.current_amount`, đơn vị nanogic). Neo par `P* = 1` theo **sức-mua-dịch-vụ**, KHÔNG neo fiat (Whitepaper §4, §7.1).

**"Gen tMAGIC" trên chain KHÔNG mint token** [_Agents/topics/testnet-gen.md:15]. Gen = tạo/cập-nhật UTxO vault mang `MagicBatch` datum (tăng `current_amount`). Tx link cho thấy vault output + datum, KHÔNG phải token trong ví.

**Tiêu MAGIC = ĐỐT.** Nơi DUY NHẤT giảm `current_amount` = handler `BurnBatch` của validator vault (ConsumeMAGIC/EXEC.md:4-11). ConsumeMAGIC KHÔNG chạm `tx.mint`.

**Ranh giới với CARP-track (boundary — Carpet-Tech §T2):**
- **GreenBack / GlobalState = việc của CARP-track** (track CARP). Giữ `br_q`, `S` (cung MAGIC lưu hành), `pp_sched`, `gov_params(br_safe_q, f_max_q, eta_q)`, peg-state.
- **MAGIC-Gen là CLIENT đọc-only**: đọc `br_q / S / pp_sched / gov_params` qua **reference_input** từ GlobalState singleton (pin `Script(gs_script_hash)` + NFT — NFT-alone KHÔNG đủ, Carpet-Tech §T1.1).
- MAGIC KHÔNG xây GreenBack/GlobalState/PSM. `cap_surplus` pro-rata + `br` TWAP+đệm-trễ = việc GreenBack điều-phối (InstantGen/MATH.md:90-93).

---

## 2. Bất biến nền — baked (đã qua phản biện đối kháng 16/7)

Các bất biến này KHÔNG phải tùy chọn phong cách — là ràng buộc protocol có định danh.

| ID | Nội dung | Nguồn |
|---|---|---|
| **R1** value-reconciliation | MỌI lần đọc `lamp_balance` PHẢI ép `assets.quantity_of(vault_utxo, lamp_policy, lamp_name) == datum.lamp_balance` **tại chỗ đọc**. Cấm tin field datum bắc-cầu → chặn genesis-vault khai-khống LAMP để farm gen/VP. | MATH.md:42-46 |
| **R2** TWAB | `L_i` = **số-dư-trung-bình-thời-gian** LAMP đủ-tư-cách trong epoch `e−i` (không lấy mẫu-điểm), **cắt-đuôi-khi-bán** (bán ra → tụt NGAY, không kéo đuôi). Chống flash-hold + đuôi-hậu-thoát. | MATH.md:30-40 |
| **R3** per-DID | Tư-cách gen gắn **DID one-shot NFT**, KHÔNG `owner` pkh tự-khai. **1 suất-gen / DID / epoch** — chặn double-gen cùng-LAMP qua nhiều vault/tx. `L_i` gộp theo DID, không theo UTXO rời. | MATH.md:105-107 |
| **Q-format P8** | `math.ak` ↔ `math.ts` bit-identical. Q-format = **sequential-floor multiplications** (từng bước `⌊ × / Q ⌋`, không multiply-then-divide một lần). | CLAUDE.md, MATH.md:8 |
| **C-OVERFLOW** | BigInt mọi nơi. `Q=10^9`, oildrop = LAMP×10^6, nanogic = MAGIC×10^9. TV-OVERFLOW bắt regression `Number`. | MATH.md:183-188 |

**Firewall F1–F9** (Whitepaper §10 — vi phạm = sập kiến trúc):
- **F1** MAGIC một-chiều: không có dòng MAGIC → CARP/LAMP/tiền.
- **F3** không-lợi-tức-thụ-động: nắm LAMP/đặt Schedule là **chủ động** (gate/cam kết), KHÔNG yield theo số-dư.
- **F4** MAGIC closed-loop: không-chuyển-nhượng + decay + không-chuộc-tiền + tiêu-trong-hệ.
- **F6** không-yếu-tố-ngoài: cổng/ngưỡng chỉ căn số-dư-nội-bộ (đọc `br` so `br_safe`), KHÔNG để oracle-giá điều-khiển bật/tắt gen.
- **F8** `INV-MAGIC-CITIZEN`: mọi reward/VP keyed **MAGIC-TIÊU-THỰC** (burn-ID), CẤM keyed số-dư-nắm-giữ LAMP/CARP.

**Đơn vị & idiom validator chung** (Carpet-Tech §T0):
- Epoch = `get_current_epoch(tx, ms_per_epoch)` — ràng **cả hai bound** `Finite` + `e_lo == e_hi` (chống validity-range gaming, MAINNET-BLOCK). Không đọc lower-only.
- Value-leak guard: mọi output tiếp-diễn `assets.quantity_of(output.value, policy, name) == datum.balance_field`.
- Anti-tamper: `count(inputs at addr)==1`, `count(outputs at addr)==1`, `output.reference_script == None`.
- Redeemer **append-only** (biến-thể mới ở CUỐI enum). Datum field-order **NORMATIVE**.

---

## 3. Sáu cơ chế — tổng quan + so trục

| # | Module | Trigger | LAMP di chuyển? | Đọc GlobalState? | Chạm `tx.mint`? | Kết quả |
|---|---|---|---|---|---|---|
| 1 | **InstantGen** (gộp Snapshot cũ) | nắm LAMP đủ-tư-cách + tiêu-thật epoch | KHÔNG (ở-yên-ví) | Có (`br_q/S/pp_sched`) | Không | `MagicBatch.current_amount` += `M_grant` |
| 2 | **ScheduleGen** | khoá tư-cách LAMP → dòng pp × N | KHÔNG (ở-yên-ví, khoá logic) | Có (cổng κ) | Không | mỗi epoch += `pp`, tối đa `pp` |
| 3 | **ConsumeMAGIC** | tiêu dịch-vụ | Không | Không (đọc PriceParam beacon) | **Không** | `current_amount` −= `required` (BurnBatch) |
| 4 | **Consolidate** | gộp mảnh | Không | Không | Không | giảm số `MagicBatch` entries |
| 5 | **Paymaster** | delegate đốt thay owner | Không | Không (đọc Sponsor beacon) | Không (chỉ NFT one-shot) | đốt MAGIC thay owner (fee abstraction) |
| 6 | **FlowRate** | keeper mỗi epoch | Không | Không | Không (post beacon) | cập-nhật `demand_mult` cho pricing |

**Chỉ có InstantGen + ScheduleGen tạo MAGIC** — cả hai chỉ gen **trong thặng-dư backing**, van-đỏ khoá toàn mạng khi `br ≤ br_safe` (Whitepaper §7). ConsumeMAGIC/Consolidate/Paymaster/FlowRate KHÔNG tạo MAGIC.

**ĐÃ BỎ HẲN — KHÔNG có trong hệ mới:** UM/UMKeeper/hệ-số-cầu-mạng · profile Ember/Flame/Lantern + PM · LF (loyalty factor theo tuổi-nắm) · VacuumGen/vacuum_orders (thuộc CARP-track, không MAGIC-gen) · halving/ApplyHalving · mô hình InstantGen-mua-trả-LAMP cũ (`M = L_paid×R×UM×PM/Q³`) · rate_locked/16-shard của ScheduleGen cũ.

---

## 4. Hợp-đồng-kiểu dữ liệu on-chain

Constr-index theo thứ tự khai báo, byte-perfect Aiken ↔ TypeScript codec (P8).

### 4.1 VaultDatum + MagicBatch (generator vault)

MAGIC = số kế-toán trong VaultDatum; mô hình "số trong datum" tái-dùng được, chỉ CARP cần native-token-mới (MagicLamp-3Token-DacTa §186).

Cấu trúc **khái niệm** bắt buộc (mọi entry MagicBatch tối thiểu):
```
MagicBatch {
  current_amount : Int,      // nanogic — quyền-tiêu còn lại (BurnBatch giảm)
  gen_epoch      : Int,      // epoch tạo batch
  // owner/DID linkage: gắn DID one-shot NFT (R3), KHÔNG owner pkh tự-khai
}
VaultDatum {
  owner          : ByteArray,
  lamp_balance   : Int,      // oildrop — ép R1 tại mọi chỗ đọc
  magic_batches  : List<MagicBatch>,
  loyalty_holdings : List<...>,  // repurpose: nguồn TWAB (amount+acquired_epoch+mốc); KHÔNG dùng làm LF
  ...
}
```
> **[NEEDS-EVIDENCE]** Layout field CHÍNH XÁC + constr-index của `MagicBatch`/`VaultDatum` cho mô hình MỚI chưa có file type chuẩn. `InstantGen/onchain/lib/types.ak` hiện tại còn field ĐÃ BỎ (`profile_at_creation`, `halved`, LF/decay_window) từ mô hình cũ → **KHÔNG dùng làm khuôn**. Phải viết lại types.ak (bỏ profile/halved/LF) trước compile. `plutus.json` MAGIC toàn bản CŨ tháng 6 (UM/purchase) — KHÔNG dùng để gen (testnet-gen.md:12).

### 4.2 EngageDatum + PriceParam (ConsumeMAGIC — bản v2, đã đúng mô hình mới)

Từ `ConsumeMAGIC/onchain/lib/magiclamp/consume/types.ak` (bản D1 rewrite, KHÔNG mint):
```aiken
pub type OpPrice { op_type: Int, base_price: Int }          // base_price nanogic
pub type PriceParam {                                        // beacon reference_input
  op_prices: List<OpPrice>, demand_mult: Int,
  m_min: Int, m_max: Int, epoch: Int,
}
pub type EngageDatum {                                       // state per-app (UTxO riêng)
  owner: ByteArray, consumed_count: Int, last_epoch: Int,
  did_commit: ByteArray,                                     // APPEND-ONLY, MVP=#""
}
pub type ConsumeRedeemer {
  Consume { op_type: Int, op_count: Int, price_ref: OutputReference, vault_ref: OutputReference }
}
```
`price(op_type) = base_price[op_type] × demand_mult / Q` (Q=1e9, BigInt). `required = price × op_count`.

### 4.3 Paymaster beacon (SponsorPolicy/Meter/ProtocolFeeParams)

Từ `Paymaster/onchain/lib/magiclamp/paymaster/types.ak`:
- `SponsorPolicy{ app_id, app_authority, max_per_did_per_epoch(oildrop), max_global?, lamp_per_magic_q, ada_per_magic_q, oracle_nft_policy=None(MVP), epoch }`
- `SponsorMeter{ app_id, epoch, did_lamp_map, global_lamp_epoch, global_magic_epoch }`
- `ProtocolFeeParams{ min_lamp_per_magic_q, protocol_fee_active, epoch }` — sàn `lamp_per_magic_q ≥ min_lamp_per_magic_q`.
- Trần: `lamp_this ≤ lamp_cap(magic_consumed, lamp_per_magic_q) = ⌊magic_consumed × lamp_per_magic_q / Q⌋` (paymaster/math.ak).

---

## 5. InstantGen — toán gen (nguồn: InstantGen/MATH.md, neo Whitepaper §7.2)

Mô hình **nắm-LAMP mở-TƯ-CÁCH** (LAMP ở-yên-ví, KHÔNG chuyển đi). Điều-kiện cần cả hai: (1) nắm LAMP đủ tư-cách; (2) **tiêu-thật MAGIC** trong epoch qua nền-tảng-đăng-ký (Whitepaper §7.2).

### 5.1 Ký hiệu
`Q=10^9` · `W=7` (i=0..6) · `L_i` = LAMP đủ-tư-cách TWAB epoch `e−i` (oildrop) · `R_gen_q` = suất-nền gen (governance) · `br_q=B/S` · `br_safe_q=1_500_000_000` (1.5×) · `f_max_q=100_000_000` (0.10×) · `S` = cung MAGIC lưu hành (nanogic) · `pp_sched` = dòng MAGIC/epoch ScheduleGen (nanogic).

> **GIẢ ĐỊNH** (benchmark sau, KHÔNG hằng chốt — [NEEDS-EVIDENCE] giá trị cuối): `R_gen_q = Q = 10^9` → 1000 LAMP nắm-giữ ≈ 1 MAGIC/epoch quyền-tiêu (TRƯỚC cổng). `W=7`, `w_i=1/7` phẳng (chốt 15/7 — kháng-game, không spike 1 epoch).

### 5.2 Công thức (sequential-floor, BigInt)
```
L_i  = ⌊ ( Σ_j balance_j × dur_j ) / len_epoch ⌋     -- TWAB (R2), cắt-đuôi-khi-bán
M(L) = ⌊ L × R_gen_q / Q ⌋                            -- gen-nền 1 epoch (oildrop→nanogic)
M_raw = ⌊ ( Σ_{i=0..6} M(L_i) ) / 7 ⌋                 -- trung-bình phẳng, sum-then-floor (1 floor cuối)

Chế độ: xanh nếu br_q > br_safe_q ; đỏ nếu br_q ≤ br_safe_q
Van đỏ:  M_grant = 0                    khi ĐỎ  (khoá gen toàn mạng)
Depeg:   M_grant = 0                    khi CARP/MAGIC < P* (đọc GlobalState)
Xanh:
  cap_surplus = ⌊ ⌊ f_max_q × S / Q ⌋ × (br_q − br_safe_q) / br_safe_q ⌋
  double_cap  = ⌊ pp_sched / 2 ⌋        (InstantGen ≤ 0.5× Schedule — trần-kép)
  M_grant     = min( M_raw , cap_surplus , double_cap )
```
- `M(L)` tuyến-tính theo L → chẻ ví KHÔNG nhân được lượng (floor còn lỗ ≤1 nanogic).
- `cap_surplus` triệt-tiêu-trơn khi `br → br_safe⁺` (không vách cung). Chỉ gen vào thặng-dư `B − br_safe·S`; sau gen `br' ≥ br_safe`.
- Lỗi rounding tổng `M_grant` ≤ vài nanogic, luôn `≤ M_true` (bảo thủ, thuận protocol — L4).

### 5.3 Freshness + Decay
- **Freshness GlobalState** (chống ref-input cũ đọc `br` giả cao): `expect gs.epoch == e` (hoặc `e − gs.epoch ≤ MAX_GS_STALENESS` nếu GreenBack cập nhật trễ 1 epoch — chốt theo nhịp keeper CARP → [NEEDS-EVIDENCE]).
- **Decay = RESET mỗi epoch** (pin-mặt-trời, chốt 16/7): `M_grant` = **TRẦN-SUẤT epoch này**, KHÔNG cộng-dồn thành bể-quyền. Không tiêu hết trong epoch `e` → phần dư = 0 ở `e+1`. Use-it-or-lose-it (Whitepaper §7.2). BỎ hẳn halving + decay-hình-học nhiều-epoch + profile decay_window.
- **INV-CASHBACK-BOUND** (kiểm ở lớp tiêu/hoàn, KHÔNG ở gen): hoàn/thưởng mỗi DID ≤ phí-thật-đã-ĐỐT của DID đó.

### 5.4 Cross-track (KHÔNG do InstantGen thực thi — GreenBack lo)
`cap_surplus` là **ngân-sách-mạng** → phân bổ **pro-rata theo M-đủ-tư-cách** (KHÔNG FCFS, chống bot giành sạch) do GreenBack điều-phối (budget-UTxO/2-pha). InstantGen chỉ đọc phần còn khả-cấp + draw ≤ đó. `br_q`/peg = TWAP + đệm-trễ N epoch (GlobalState).

---

## 6. ScheduleGen — dòng pp × N epoch (Whitepaper §7.3)

**Mục đích:** khoá TƯ-CÁCH LAMP (**ở-yên-ví**, khoá logic) → hệ bảo-đảm dòng `pp` MAGIC/epoch × `N` epoch. LAMP trả nguyên vẹn khi hết hợp đồng.

**Bốn bước:**
1. **Ký hợp đồng:** đăng ký `pp` MAGIC/epoch × `N`. Kiểm cổng-κ (dưới). Đủ chỗ → nhận; không → xếp-hàng/từ-chối.
2. **Tạo MAGIC vào quỹ GreenBack** (chưa lưu-thông, chưa tính vào cung cần-bảo-chứng).
3. **Đệm an-toàn `buffer_ep = 2`:** luôn giữ đủ tiền cho 2 epoch tới; phần xa-hạn GreenBack dùng bình-ổn.
4. **Trả dần — TRẦN CỨNG:** mỗi epoch tiêu **tối đa `pp`** (không rút-dồn nhiều epoch). Muốn nhiều hơn → ký hợp-đồng gối-đầu (qua cổng lại). Tiêu xong → đốt.

**Cổng giới hạn (vì sao Schedule NHỎ):**
```
Σ nghĩa-vụ-còn-lại  ≤  κ × Sức-tải-các-quỹ-cứu       (κ = 0.6, CỐ ĐỊNH, cấm đổi giữa vòng đời)
```
- Sức-tải = số-dư quỹ-cứu nội-bộ (RedBack + kho dự phòng platform + Kho bạc MagicLamp). **TUYỆT ĐỐI KHÔNG dùng giá LAMP/dữ-liệu-giá-thị-trường** (F6). Quỹ cứu nhỏ → số hợp-đồng nhận nhỏ (co-giãn theo sức-khoẻ thật).
- **Bậc-thang-cứu 5 bậc** (khi GreenBack thiếu tiền trả) = **việc GreenBack/CARP-track**, KHÔNG do ScheduleGen thực thi (Whitepaper §7.3): (1) điều-chỉnh tỷ-giá hợp-đồng; (2) bán LAMP thặng-dư; (3) RedBack; (4) kho dự phòng platform; (5) Kho bạc.

**ĐÃ BỎ so bản cũ:** khoá-tỷ-giá (`rate_locked`/T8) · hệ 16-shard (`SHARD_COUNT`/`SHARD_CAP`) · commit-cancel (giữ nguyên **no-cancel** T10: đã ký → fire hoặc expire, không refund mid-flight).

> **[NEEDS-EVIDENCE]** Datum `GenSchedule` mới (pp, N, start_epoch, remaining_obligation) chưa có file type chuẩn sau khi bỏ shard/rate_locked. `ScheduleGen/onchain` hiện còn 2-validator vault+shard của bản cũ → viết lại 1-validator (bỏ shard) trước compile.

---

## 7. ConsumeMAGIC — tiêu = BurnBatch + pricing beacon (nguồn: ConsumeMAGIC/EXEC.md + types.ak)

**Model v2 (rewrite D1):** tiêu MAGIC = co-spend Engage UTxO (`consume.ak`) + vault input (BurnBatch) với `Σ burns == required`. **KHÔNG `tx.mint`, KHÔNG `MAGIC_POLICY_ID`.** Validator vault là nơi DUY NHẤT giảm MAGIC.

**Pricing (có thẩm quyền — đọc beacon, KHÔNG tin client):**
```
price(op_type) = base_price[op_type] × demand_mult / Q         (Q=1e9, BigInt)
required       = price(op_type) × op_count
```
`demand_mult` clamp `[m_min, m_max]`, keeper cập-nhật (§10).

**Bất biến (C-CM-*):**
- **C-CM-2** `Σburns == required` — **`==` chặt**, KHÔNG `≥` (over-burn CẤM = accounting; under-burn reject).
- **C-CM-1** value-preservation: ADA + token lạ ở Engage UTxO bảo-toàn qua output.
- **C-CM-5** freshness: `cur_epoch − pp.epoch ≤ max_price_stale`.
- **C-CM-3/4** thread-token + state: 2 input → 2 output, mỗi output tăng `consumed_count`; Σnft bảo-toàn.
- Validity-range chặt ≤1 epoch (`get_epoch` cả 2 bound Finite + `e_lo==e_hi`).

**`did_commit` PROVIDER-AGNOSTIC** (CONTRACT — hệ nhiều nhà cung cấp DID): ràng qua **beacon resolver + allow-list DAO**, KHÔNG hardcode PhoenixKey. Resolve DID↔signer là việc PhoenixKey **ngoài scope MAGIC**. burn-ID phát `consumer_did/provider_did/service_id/resource_type`. MVP `did_commit = #""` (append-only, immutable sau genesis). **INV-CASHBACK-BOUND:** hoàn/DID ≤ phí-thật-đã-đốt.

**Deploy per-vault:** `consume.ak` parameterized bởi `vault_script_hash` + `burn_batch_constr` (khác nhau per vault-loại) → **1 deploy ConsumeMAGIC / 1 loại vault**. Instant/Schedule burn_batch_constr = 2 (theo EXEC cũ — [NEEDS-EVIDENCE] xác nhận lại constr sau khi viết lại types).

---

## 8. Consolidate — gộp MagicBatch phân mảnh (nguồn: Consolidate/EXEC.md)

Redeemer `Consolidate` của vault script chính (không deploy contract riêng). Gộp entries phân mảnh (sort-partition-merge). CHỈ được đổi field danh sách batch/holdings; mọi field khác KHOÁ.

**Bất biến:**
- **Conservation** (W-21): Σ trước == Σ sau (cấm rút lén).
- **Phải giảm entries** (W-20): `|output| < |input|`.
- Merge chỉ khi cùng key (epoch/loại) và `epoch_diff ≤ 1` (hardcode; nới ≤2 = v-next).
- Owner phải ký (W-1). Anti double-satisfaction: `count_inputs_at_script == 1` (kể cả qua stake credential khác nhau — W-2).
- `MAX_LOYALTY_HOLDINGS = 64`; gợi-ý consolidate khi ≥ 50; số pass `mergeGroup ≤ ⌊n/2⌋` (T23 convergence).

> **Loại bỏ so EXEC cũ:** test/field liên quan `profile`/`streak_state`/LF (TN-01/TN-02 kiểm profile/streak tamper) — mô hình mới không có profile/LF nên các field khoá đó không tồn tại. Giữ nguyên tinh thần "chỉ đổi danh sách batch, mọi field khác immutable".

---

## 9. Paymaster — delegate đốt MAGIC thay owner (nguồn: Paymaster/EXEC.md)

**Fee abstraction:** App (delegate) đốt MAGIC THAY owner, **KHÔNG chuyển MAGIC** (F1). Tiền-đề: owner đặt App làm `personal_delegate` qua `SetDelegate` của vault.

**Luồng `buildSponsorTx`:** Meter UTxO + 1 generator-vault (BurnBatch CBOR) + 2 beacon ref (SponsorPolicy + ProtocolFeeParams) → App ký → submit.

**Bất biến (PM-*):**
- **PM-3** trần: `lamp_this ≤ ⌊magic_consumed × lamp_per_magic_q / Q⌋`.
- **PM-3.5** sàn: `policy.lamp_per_magic_q ≥ protocol.min_lamp_per_magic_q`.
- Cap per-DID: `did_spent + lamp_this ≤ max_per_did_per_epoch`.
- Vault `current_amount` giảm = `magic_consumed`; Meter `global_lamp_epoch += lamp_this`; Meter NFT + ADA bảo-toàn.

**Gap v1.x** (known-limit): validator chưa ép App THỰC chuyển LAMP/ADA tới user (MVP = kế-toán Meter + trust App cosign; `lamp_policy_id` param giữ sẵn cho guard value v1.x). Deploy scripts + e2e runner chưa viết.

---

## 10. FlowRate — keeper cập nhật demand_mult (dual-EMA) (nguồn: FlowRate/offchain/src/math.ts + keeper.ts)

Keeper permissionless (như UMKeeper cũ nhưng khác cơ chế): mỗi epoch đọc mọi `SponsorMeter` UTxO → gộp `(Σ lamp_oildrop, Σ magic_ng)` → cập-nhật `FlowRateDatum` beacon → feed pricing ConsumeMAGIC.

**Dual-EMA + adaptive-cap + blend** (math.ts):
```
raw_rate_q = ⌊ total_lamp_oildrop × Q / total_magic_ng ⌋      (LAMP/MAGIC Q-format)
ema_fast   = α_fast·raw + (1−α_fast)·ema_fast   ; α_fast = Q/3  (≈0.333)
ema_slow   = α_slow·raw + (1−α_slow)·ema_slow   ; α_slow = Q/12 (≈0.083, cửa-sổ 12-epoch)
div_q      = |ema_fast − ema_slow| × Q / ema_slow
cap_q      = clamp( BASE_CAP × Q / (Q + 3·div_q), MIN_CAP=5%, BASE_CAP=25% )   -- rate-of-change cap
w_fast     = (10% − div_q)/10% × 70%  (0 khi div ≥ 10%)   -- tin fast khi calm, slow khi bị thao-túng
rate       = clamp( blend(w_fast·ema_fast + w_slow·ema_slow), prev·(1−cap), prev·(1+cap) )
lamp_per_magic_q = clamp( rate, HARD_FLOOR=0.01, HARD_CEIL=10 LAMP/MAGIC )
```
**Guard:** activity tối thiểu `total_magic_ng ≥ MIN_MAGIC_EPOCH = 1000 MAGIC` (dưới ngưỡng → chỉ advance epoch, giữ EMA). `raw > HARD_CEIL` → coi là dữ-liệu-thao-túng, giữ EMA cũ. Epoch phải tiến (`flow.epoch > last_epoch`). Bootstrap: DAO đặt `initial_rate_q`, `cap=25%`.

> **[NEEDS-EVIDENCE]** Wiring chính xác `FlowRateDatum.lamp_per_magic_q → PriceParam.demand_mult`: code có beacon FlowRate riêng (dual-EMA) VÀ `PriceParam.demand_mult` với comment "FIR (SMA-N)". CONTRACT chốt **dual-EMA** là chuẩn → comment SMA-N trong `consume/types.ak:27` là mô-tả cũ cần đồng-bộ. Cần chốt: FlowRate beacon feed thẳng `demand_mult`, hay 2 beacon tách + keeper cầu-nối.

---

## 11. Tham số instance testnet

| Tham số | Giá trị | Nguồn |
|---|---|---|
| Mạng | Preview (magic 2) | scripts/README.md |
| **tLAMP policy** | `7a1a7aed5ec47acc37b6fa82695c1219bf76895b505b01161367adf9` | testnet-gen.md:8 |
| tLAMP asset name | `744c414d50` ("tLAMP"), decimals 6 | testnet-gen.md:8 |
| **tCARP policy (Preview)** | `074cf29c…` (đã mint thật) | testnet-gen.md:9 |
| `ms_per_epoch` (Preview) | `86_400_000` (1 ngày) | ConsumeMAGIC/EXEC:63 |
| `ms_per_epoch` (Mainnet) | `432_000_000` (5 ngày) | ConsumeMAGIC/EXEC:63 |
| `Q` | `1_000_000_000` | MATH.md:14 |
| `br_safe_q` | `1_500_000_000` (1.5×) | MATH.md:22 |
| `f_max_q` | `100_000_000` (0.10×) | MATH.md:23 |
| `W` (cửa-sổ gen) | `7` epoch | MATH.md:18 |
| `R_gen_q` (GIẢ ĐỊNH) | `1_000_000_000` (=Q) | MATH.md:26 |
| `κ` (cổng Schedule) | `0.6` cố định | Whitepaper §7.3 |
| `buffer_ep` | `2` | Whitepaper §7.3 |
| `MAX_BATCHES_PER_VAULT` | `32` | CLAUDE.md |
| `MAX_LOYALTY_HOLDINGS` | `64` | CLAUDE.md |
| `max_price_stale` (Preview) | `1` epoch | ConsumeMAGIC/EXEC:62 |
| PriceParam beacon `demand_mult` init | `1_000_000_000` (=Q) | ConsumeMAGIC/EXEC:34 |
| NFT asset names | ENG `454e47` · PRICE `5052494345` · POL `504f4c` · MET `4d4554` · PRO `50524f` | EXEC files |

Creds testnet: **Koios no-key** (như CarpetMint) HOẶC `BLOCKFROST_KEY` (Agents/.env). MAGIC scripts hiện dùng Blockfrost; CarpetMint dùng Koios + ví VEDATA (testnet-gen.md:11).

---

## 12. Thứ tự deploy (compile → validator → GlobalState fixture → ví → gen)

> **Điều kiện tiên quyết:** viết lại types.ak (bỏ profile/halved/LF/UM/shard) cho InstantGen + ScheduleGen TRƯỚC — `plutus.json` cũ KHÔNG dùng được (testnet-gen.md:12,18).

```
# 0. Toolchain: aiken ≥1.1.0 (đã có v1.1.21), node ≥20 (đã có v24), npx.

# 1. COMPILE validators (mỗi module riêng)
cd InstantGen/onchain   && aiken build && aiken check   # → plutus.json + tests pass
cd ScheduleGen/onchain  && aiken build && aiken check
cd ConsumeMAGIC/onchain && aiken build && aiken check   # 4 validator: consume/price_nft/price_param/engage_nft
cd Consolidate/onchain  && aiken build && aiken check
cd Paymaster/onchain    && aiken build && aiken check
# Đọc hash: jq '.validators[] | {title,hash}' plutus.json

# 2. Env (scripts/.env) — KHÔNG có UM_NFT_POLICY_ID / SHARD_* (đã bỏ)
BLOCKFROST_KEY=preview...      (hoặc dùng Koios no-key)
PRIVATE_KEY=ed25519_sk...
NETWORK=Preview
LAMP_POLICY_ID=7a1a7aed5ec47acc37b6fa82695c1219bf76895b505b01161367adf9
LAMP_ASSET_NAME=744c414d50
MS_PER_EPOCH=86400000
GLOBALSTATE_NFT_POLICY=<sau bước 3>
GLOBALSTATE_SCRIPT_HASH=<sau bước 3>
VAULT_SCRIPT_HASH=<sau bước 4>

# 3. GlobalState fixture (br_q/gov_params/S/pp_sched — schema Carpet-Tech §T2)
#    CARP-track chưa cấp canonical GreenBack cho MAGIC → deploy FIXTURE test
#    (green-mode giả định) để self-contained gen ngay khi code xong. Xem §15.
#    Post GlobalDatum{ br_q=2e9, br_safe_q=1.5e9, f_max_q=1e8, S=..., pp_sched=...,
#                      epoch=<hiện tại> } + mint gs_nft one-shot, pin script addr.

# 4. Ví test + nạp tLAMP đủ-tư-cách (nguồn tLAMP: LAMP track/transfer — phụ thuộc ngoài §15)
#    Tạo vault UTxO: VaultDatum{ owner, lamp_balance == quantity_of(tLAMP thật) (R1),
#                                magic_batches=[], ... } gắn DID one-shot NFT (R3).

# 5. Deploy ConsumeMAGIC beacon (nếu test tiêu):
#    price_nft (one-shot) → engage_nft (one-shot, genesis_ref RIÊNG) →
#    price_param (post PriceParam{demand_mult=1e9,epoch=now}) → consume (apply 8 param) →
#    engage-init (EngageDatum{consumed_count:0,did_commit:#""})

# 6. GEN happy-path (green) → tx thật #1. Rồi red-mode M=0, cap_surplus, Schedule pp×N.
```

**Định nghĩa thành công mỗi bước** (scripts/README.md): mỗi bước có TX hash + UTxO đúng datum trên explorer; chờ ~20s confirm giữa các bước.

---

## 13. Kịch bản gen tMAGIC + test vectors (NORMATIVE — App B, R_gen_q=Q)

Nguồn: InstantGen/MATH.md §9. **"Gen tMAGIC" = vault output mang MagicBatch datum, KHÔNG token.**

### 13.1 Happy-XANH — nắm ổn định, không chạm cap (TV-GEN-FLAT-01)
```
L_0..L_6 = 1_000_000_000 oildrop (1000 tLAMP, TWAB giữ nguyên 7 epoch); R_gen_q = 1e9
M(L_i) = ⌊1e9 × 1e9 / 1e9⌋ = 1_000_000_000  (mỗi i)
M_raw  = ⌊(7 × 1e9)/7⌋ = 1_000_000_000  (= 1 MAGIC)
GlobalState: br_q=2e9 (2.0× XANH), S=1e14, pp_sched=1e10
cap_surplus = ⌊⌊1e8×1e14/1e9⌋ × (2.0−1.5)/1.5⌋ = 3_333_333_333_333
double_cap  = ⌊1e10/2⌋ = 5_000_000_000
M_grant = min(1e9, 3.33e12, 5e9) = 1_000_000_000  (= 1 MAGIC)  → batch.current_amount += 1e9
```

### 13.2 Van-ĐỎ (TV-GEN-RED-02)
```
br_q = 1_400_000_000 (1.4× ≤ br_safe 1.5×) → ĐỎ
M_grant = 0  (bất kể L_i, bất kể M_raw)  → validator từ chối gen / batch không tăng
```

### 13.3 Trần-kép cột vào Schedule (TV-GEN-DOUBLECAP-03)
```
M_raw = 8_000_000_000 (nắm nhiều tLAMP), XANH, cap_surplus lớn
pp_sched = 6_000_000_000 → double_cap = 3_000_000_000
M_grant = min(8e9, cap_surplus, 3e9) = 3_000_000_000  (InstantGen bị cột ≤ 0.5× Schedule)
```

### 13.4 Cổng thặng-dư mỏng (TV-GEN-SURPLUS-04)
```
M_raw=2e9, br_q=1.55e9 (xanh mỏng), S=1e14
cap_surplus = ⌊⌊1e8×1e14/1e9⌋ × (1.55−1.5)/1.5⌋ = 333_333_333_333
M_grant = min(2e9, 333e9, 5e9) = 2_000_000_000   (cap cắn khi S nhỏ / br sát ngưỡng)
```

### 13.5 TWAB cắt-đuôi (R2) (TV-GEN-TAIL-05)
```
Epoch e−0: giữ 1000 tLAMP nửa đầu, BÁN HẾT nửa sau
L_0 = ⌊(1e9 × len/2 + 0 × len/2)/len⌋ = 500_000_000  → M(L_0)=5e8 (nửa), đuôi hậu-bán = 0
```

### 13.6 R1 chặn khai-khống (TV-GEN-VALUE-RECON-06)
```
datum.lamp_balance = 1_000_000_000_000 (khai khống 1 triệu LAMP)
assets.quantity_of(vault_utxo, tLAMP) = 2_000_000 (thật: 2 LAMP min-UTxO)
→ R1: 2e6 ≠ 1e12 → VALIDATOR REJECT
```

### 13.7 BigInt bắt buộc (TV-OVERFLOW-07)
```
L_i = 36e15 oildrop (toàn cung LAMP), R_gen_q=Q → trung gian 36e15×1e9 = 3.6e25 > MAX_SAFE(~9e15)
→ phải BigInt (Number regression = sai kết quả).
```

### 13.8 ScheduleGen fire (integration)
Commit `pp`, N → mỗi epoch fire tối đa `pp` MAGIC vào batch; cổng `Σ nghĩa-vụ ≤ 0.6 × sức-tải-quỹ-cứu`; no-cancel; LAMP tư-cách trả lại khi hết N.

### 13.9 ConsumeMAGIC (tiêu)
`op_type=1, op_count=1, demand=Q, stale=0` → `required = base_price × 1`; co-spend Engage + vault BurnBatch với `Σburns == required` → `current_amount` giảm đúng, `consumed_count += 1`. Negative: under/over-burn → reject (C-CM-2 `==`).

---

## 14. Verify on-chain (Koios no-key)

Không cần key — dùng Koios API công cộng (như CarpetMint). Thay Blockfrost khi không có key.

```bash
# Vault UTxO + datum sau gen (đọc inline datum)
curl -s "https://preview.koios.rest/api/v1/address_info" \
  -H "content-type: application/json" \
  -d '{"_addresses":["<vault_script_addr>"]}' | jq '.[0].utxo_set[] | {value, inline_datum}'
# → kiểm MagicBatch.current_amount tăng đúng M_grant (nanogic); KHÔNG có token MAGIC (đúng thiết kế)

# tLAMP thật trong vault (R1 reconcile)
# → asset 7a1a7aed…744c414d50 quantity == datum.lamp_balance

# GlobalState freshness
curl -s ".../address_info" -d '{"_addresses":["<gs_addr>"]}' | jq '... | .inline_datum'  # epoch == e ?

# Tx trên explorer
echo "https://preview.cardanoscan.io/transaction/<TX_HASH>"
```
Tiêu chí xanh: (1) vault output có MagicBatch datum đúng lượng; (2) tLAMP không rời ví (InstantGen/Schedule ở-yên-ví); (3) treasury/mint KHÔNG xuất hiện MAGIC token; (4) sau ConsumeMAGIC `current_amount` giảm đúng `required`, `consumed_count` tăng.

---

## 15. Phụ thuộc GreenBack/GlobalState + blocker mở

**Phụ thuộc NGOÀI tay MAGIC** (chờ/leo thang — testnet-gen.md:24-31):
1. **GlobalState br_q/gov_params:** GlobalState đã deploy của CARP hiện là **CDP-pricing 5-field** (twap/spot/breaker/nsf/valid_until) — **KHÔNG có `br_q`/`gov_params`** MAGIC-Gen cần (testnet-gen.md:10). Đã gửi hỏi CARP: `CARP/_Agents/inbox/magic-globalstate-brq-2026-07-16.md` (P1, chờ). → Escalation (a): dùng **fixture GlobalState giả định** (self-contained, tx thật ngay) hay đợi canonical GreenBack CARP?
2. **Nguồn tLAMP** vào ví test MAGIC: cần transfer/faucet (LAMP track hoặc ví VEDATA). → Escalation (b).
3. **Creds testnet:** Koios no-key OK; hoặc BLOCKFROST_KEY ở Agents/.env.

**Blocker `did_commit`** (Carpet-Tech §T9, áp cho R3 + Governance C1/C3): schema DID on-chain chưa chốt. MVP `did_commit=#""` (append-only, immutable). R3 per-DID cần DID one-shot NFT — PhoenixKey backend **ngoài scope MAGIC** (tạo Issue giao Long, không tự cài schema DID). ConsumeMAGIC provider-agnostic: allow-list DAO + beacon resolver, KHÔNG hardcode PhoenixKey.

---

## 16. Chỉ mục [NEEDS-EVIDENCE]

| # | Mục | Vì sao chưa chắc |
|---|---|---|
| 1 | Layout field + constr-index CHÍNH XÁC `MagicBatch`/`VaultDatum` mô hình mới (§4.1) | Chưa có file type chuẩn; `InstantGen/onchain/lib/types.ak` + `plutus.json` còn field ĐÃ BỎ (profile/halved/LF/UM). Phải viết lại trước compile. |
| 2 | Datum `GenSchedule` mới của ScheduleGen (§6) | onchain hiện là bản 2-validator vault+shard cũ; cần viết lại 1-validator bỏ shard/rate_locked. |
| 3 | Giá trị chốt `R_gen_q` (§5.1) | MATH.md ghi rõ = GIẢ ĐỊNH benchmark, chưa phải hằng chốt. |
| 4 | `MAX_GS_STALENESS` freshness GlobalState (§5.3) | Chốt theo nhịp keeper CARP — chưa xác định. |
| 5 | Wiring `FlowRateDatum.lamp_per_magic_q → PriceParam.demand_mult` (§10) | Code có beacon FlowRate (dual-EMA) VÀ demand_mult comment "SMA-N"; CONTRACT chốt dual-EMA — cần đồng-bộ + chốt cầu-nối. |
| 6 | `burn_batch_constr` per-vault sau viết lại types (§7) | Giá trị cũ (Instant=2/Schedule=2) từ EXEC bản cũ — xác nhận lại sau khi bỏ profile/halved. |
| 7 | GlobalState `br_q`/`gov_params` schema canonical (§15) | GlobalState CARP đã deploy KHÔNG có field MAGIC-Gen cần; chờ CARP trả inbox hoặc anh duyệt fixture. |
| 8 | Nguồn tLAMP cho ví test (§15) | Phụ thuộc LAMP track/transfer — ngoài tay MAGIC. |
