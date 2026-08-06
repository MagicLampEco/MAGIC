# ConsumeMAGIC — CONTRACT v2 "Tiêu MAGIC dạng kế toán + định giá" (rewrite D1, 2026-06-10)

**Trạng thái:** interface contract KHÓA, mọi spec/code bám file này. CONTRACT v1 (2026-06-07, PR #13)
dùng mô hình **token-burn** (`tx.mint` âm MAGIC) — **ĐÃ THAY** ở v2. Lý do: ràng buộc vĩnh viễn xác
định MAGIC = **số kế toán trong vault datum**, KHÔNG token, KHÔNG MintingPolicy, KHÔNG `tx.mint`. PR #13
`consume.ak` đốt-token vi phạm ràng buộc này → viết lại thành engagement-state validator.

> Nguyên tắc nền (CLAUDE.md): LAMP cố định 36 tỷ **KHÔNG BAO GIỜ burn**. MAGIC **KHÔNG là token** —
> nó là `current_amount` của `MagicBatch` trong `VaultDatum.magic_batches`. **Tiêu MAGIC = GIẢM
> `current_amount`** qua handler `BurnBatch` của VAULT validator (generator). ConsumeMAGIC TUYỆT ĐỐI
> không `tx.mint`, không chạm MAGIC trực tiếp; nó là lớp **PRICING + ENGAGEMENT/ATTRIBUTION** per-app.

> **THAY THẾ so với PR #13 (v1) — ghi rõ chỗ:** (1) bỏ tham số `magic_policy/magic_name`; (2) bỏ
> `check_only_magic_burn` / `magic_burned` / `non_magic_value_preserved` (đặc thù mint); (3) `consume.ak`
> không còn validator nào chạm `tx.mint`; (4) `consume` từ "đốt token" → "engagement-state validator"
> ép cùng tx có 1 vault input spend bằng `BurnBatch` với `Σburns == required`; (5) `EngageDatum` thêm
> `did_commit` (field cuối, append-only); (6) over-burn `≥` (v1, đốt token mất luôn) → `==` (v2,
> accounting: over-burn = giảm MAGIC user vô cớ → CẤM).

## A. Định giá tiêu thụ (consume-side pricing) — interface `price_per_op`

Gap audit: hiện `computeFee` chỉ là phí % trên `serviceAmount` do **client tự đưa** → không chống spam
(client đặt amount tùy ý). Ghim mô hình có thẩm quyền:

```
price(op_type, t) = base_price[op_type] × demand_mult(t) / Q          (Q = 1e9, scale BigInt)
```

- **`base_price[op_type]`**: bảng giá danh nghĩa per loại nghiệp vụ, **governance param** (DAO chỉnh).
  Ví dụ MVP: `xử lý 1 ảnh = 0.01 MAGIC`, `neo 1 CID = 0.001 MAGIC`. Đơn vị nanogic (1 MAGIC = 1e9).
- **op_type chuẩn (CHỐT, khớp offchain `OP_IMAGE`/`OP_CID` trong `pricing/src/price.ts`):**
  `1 = ảnh` (0.01 MAGIC = 10_000_000 nanogic), `2 = CID` (0.001 MAGIC = 1_000_000 nanogic).
  Mọi fixture/beacon/redeemer onchain PHẢI dùng đúng key này; không được lệch sang `0/1`.
- **`demand_mult(t)`**: hệ số co giãn cung-cầu, **TÁI DÙNG cấu trúc UMKeeper** (lọc FIR: SMA-N của
  `load_raw` rồi `clamp[m_min, m_max]`), **KHÔNG dùng PI**. Lý do (4 trục):
  (1) tối ưu eUTXO — FIR không cần biến trạng thái tích phân trên datum, ít byte;
  (2) ổn định BIBO vô điều kiện, không tinh chỉnh Kp/Ki — audit xác nhận UMKeeper hội tụ;
  (3) **anti-windup miễn phí** (không có khâu tích phân → không windup — đúng kết luận audit);
  (4) nhất quán toàn protocol (đã có tiền lệ UMKeeper chạy đúng, tái dùng `ProtocolUtils.clamp` + SMA).
  `load_raw = ops_served_epoch / target_capacity` (governance param). Mặc định `m_min=0.5, m_max=2.0`.
- **Bất biến:** `price` đơn điệu không-giảm theo `load`; bị chặn `[base×m_min, base×m_max]`; pure BigInt,
  không float; hội tụ về `base×SMA` trong ≤ N epoch khi load ổn định.

## B. Tiêu MAGIC dạng kế toán on-chain — validator + bất biến

### B0. Mô hình 2-validator co-spend (rewrite D1)
Tiêu MAGIC = **1 tx co-spend 2 validator**:
- **Vault input** (generator vault validator, module khác) spend bằng `BurnBatch { burns }` →
  GIẢM `current_amount` các `MagicBatch`. Vault là nơi DUY NHẤT giảm MAGIC.
- **Engage UTxO** (ConsumeMAGIC `consume.ak`) spend bằng `Consume { op_type, op_count, price_ref,
  vault_ref }` → ghi state per-app, ép `Σburns == required`.

`consume.ak` đọc redeemer `BurnBatch` của `vault_ref` qua `tx.redeemers` (purpose Spend), giải mã
`burns` bằng `builtin.un_constr_data` (param `burn_batch_constr` = constr index BurnBatch của vault đó:
Instant=2, Snapshot=1, Vacuum=4, Schedule=2 — per-vault deploy). Hai validator đọc **CÙNG** PriceParam
beacon + **CÙNG** `op_type/op_count` → giá không lệch. KHÔNG `tx.mint`.

### B1. Beacon `PriceParam` (reference input — CIP-31, KHÔNG tiêu)
DAO/keeper post 1 UTxO mang `PriceParam` NFT one-shot (mẫu `beacon_nft.ak`). Datum:
```
PriceParam {
  op_prices    : List<OpPrice>,   // OpPrice{ op_type: Int, base_price: Int }  — bảng giá danh nghĩa
  demand_mult  : Int,             // hệ số co giãn hiện hành (keeper cập nhật, scale Q)
  m_min, m_max : Int,             // chặn clamp (scale Q)
  epoch        : Int,             // epoch cập nhật gần nhất (chống stale)
}
```
Validator consume ĐỌC giá từ đây — **KHÔNG tin amount client mớm**. Giá có thẩm quyền = chống spam thật.

### B2. Redeemer + bất biến validator `consume` (engagement-state, Aiken Plutus V3)
Redeemer `Consume { op_type: Int, op_count: Int, price_ref: OutputReference, vault_ref: OutputReference }`.
`EngageDatum { owner, consumed_count, last_epoch, did_commit }`. Validator ÉP:

- **C-CM-1 (value preservation @engage):** Engage UTxO chỉ giữ ADA + thread NFT (KHÔNG MAGIC/LAMP);
  `Σ value(out@engage) == Σ value(in@engage)` TUYỆT ĐỐI → chống drain ADA/token (bài học M1 Treasury).
  KHÔNG `tx.mint`.
- **C-CM-2 (Σburns == Σrequired — AGGREGATE qua MỌI Engage input):** đọc `PriceParam` qua `price_ref`
  reference input (xác thực NFT). Bất biến KHÔNG so sánh per-invocation mà AGGREGATE (mirroring C-CM-3):
  `total_required = Σ trên MỌI Engage input [ price(op_type_i)×op_count_i ]` (mỗi input đọc redeemer
  `Consume` riêng, CÙNG beacon `price_ref` — ép `pr_i == price_ref` để không trộn nhiều bảng giá);
  `total_burned = Σ burns trên MỌI vault_ref PHÂN BIỆT` do các Engage input trỏ (mỗi vault đếm burns 1
  lần dù N Engage chia chung). Ép `total_burned == total_required` (`==`, KHÔNG `≥`: over-burn = giảm
  MAGIC vô cớ). Giá lấy từ beacon, KHÔNG từ redeemer amount. Mọi vault input phải ở `vault_script_hash`
  + redeemer constr == `burn_batch_constr` + **mang đúng 1 `vault_id_nft`** (xem C-CM-6).
- **C-CM-6 (INV-VAULT-IDENTITY, siết 2026-08-06):** mỗi vault input phải mang **đúng 1** NFT one-shot
  `(vault_nft_policy, vault_nft_name)` — hai apply-param mới của `consume.ak`. Chỉ khớp
  `vault_script_hash` là KHÔNG đủ: địa chỉ script công khai nên ai cũng trả ~2 ADA tạo UTxO ở đó với
  datum bịa `magic_batches:[{current_amount: 10^18}]` rồi co-spend Engage + BurnBatch để **tiêu MAGIC
  chưa từng được sinh** (PoC `poc_fabricated_magic_burns_ok`). NFT do `vault_id_nft.ak` phát, neo
  `OutputReference` genesis nên không mint lại được. Ép `== 1` chứ không `≥ 1` để chặn gom NFT nhiều
  vault vào một UTxO. Kiểm cả policy lẫn name — chỉ kiểm name thì kẻ tấn công tự mint token trùng tên.
  **Lý do AGGREGATE (chống pay-once-consume-N):** nếu chỉ ép per-invocation `burns(vault_ref) == required`
  của 1 Engage, thì N Engage input cùng `op_count=1` trỏ CHUNG 1 vault burn 10M sẽ mỗi cái pass độc lập
  (10M==10M) trong khi state ghi `Σconsumed += N` — N nghiệp vụ attributed nhưng chỉ 1 đơn vị MAGIC giảm,
  phá bất biến bảo toàn giá trị + bơm rẻ Governance C1 (MAGIC tiêu thụ). AGGREGATE: total_required=N×10M
  != total_burned=10M → REJECT. Per-invocation == aggregate → idempotent qua mọi invocation.
- **C-CM-3 (double-satisfaction @engage):** đếm theo **payment script hash**; bất biến AGGREGATE
  idempotent qua mọi invocation: `#out@engage == #in@engage` (no collapse); `Σ engageNFT(out) ==
  Σ engageNFT(in)` (không rút thread token); `Σ consumed_count(out) == Σ(in) + Σ op_count` (mọi consume
  ghi state). Bài học C1/C2 Distribution.
- **C-CM-4 (replay / state):** mỗi output@engage mang ĐÚNG 1 thread NFT one-shot, `owner` bảo toàn,
  `last_epoch == current_epoch`, `did_commit` **immutable** (`out == in`). State neo vào UTxO Engage
  RIÊNG (tách khỏi VaultDatum — quyết định D1: khác chủ thể, song song hoá, không tràn datum vault).
- **C-CM-5 (stale price):** ép `0 ≤ current_epoch − PriceParam.epoch ≤ MAX_PRICE_STALE` (param) —
  chống dùng giá cũ khi demand đã tăng.

`did_commit` (MVP = `#""` rỗng): tương lai = blake2b256 commitment liên kết engagement ↔ DID sinh trắc
(PhoenixKey, Governance C1/C3 attribution). Đặt 1 lần lúc genesis, immutable sau đó. Validator KHÔNG
ràng buộc nội dung ở MVP, chỉ ràng buộc bất biến.

### B3. Tx-builder offchain + e2e Preview (chưa làm — xem GAPS)
- `consumeBuilder(op_type, op_count)`: đọc PriceParam, dựng tx co-spend Engage UTxO (Consume) + vault
  UTxO (BurnBatch Σburns==required), neo state. KHÔNG mint.
- Script deploy + e2e Preview: tạo Engage UTxO + thread NFT → consume thật → verify `consumed_count`
  tăng + `magic_batches` vault giảm.

## C. Mối nối với module khác (ranh giới)
- **Pricing (A)** = thư viện tính giá, đặt `ConsumeMAGIC/pricing/` (offchain) + phơi `base_price` qua
  PriceParam beacon. Tái dùng `ProtocolUtils` (clamp, SMA, isqrt). KHÔNG đụng AppEconomics (reward-side)
  hay UMKeeper (mint-side) — chỉ MƯỢN cấu trúc FIR.
- **ConsumeMAGIC (B)** đọc giá từ PriceParam, ghi engagement-state + ép Σburns. KHÔNG định giá đối tượng
  (con bò vs gà) — đó là việc **app component** (OriLife `animal_fee`), ngoài phạm vi. MAGIC chỉ định giá
  **nghiệp vụ hạ tầng** (ảnh, CID).
- Generators sinh + giảm MAGIC (datum). ConsumeMAGIC định giá + ghi attribution; vault validator là nơi
  DUY NHẤT giảm `magic_batches`. KHÔNG token, KHÔNG `tx.mint`.
- **Paymaster (dài hạn):** app đặt `personal_delegate = Some(app_pkh)` qua `SetDelegate` ở vault → app
  ký `BurnBatch` tiêu MAGIC HỘ user (trả phí tx) mà MAGIC vẫn nằm trong vault user. UX paymaster đạt
  được KHÔNG vi phạm "MAGIC không transfer".

## D. Phải build (bám CONTRACT, có Agent audit phản biện mỗi vòng)
- **SPEC**: FEAT (luồng consume: app gọi → đọc giá → đốt → verify; bảng op_type) + MATH (chứng minh
  price đơn điệu/bounded/hội tụ FIR; required = Σ; an toàn BigInt).
- **PRICING (offchain)**: `pricing/price.ts` (`price_per_op`, `demand_mult` FIR) + vitest (đơn điệu,
  clamp biên, hội tụ, test vector ảnh 0.01 / CID 0.001).
- **ONCHAIN**: `onchain/` Aiken — `types.ak` (PriceParam, OpPrice, Consume, EngageDatum+did_commit),
  validator `consume.ak` (engagement-state, C-CM-1..6, KHÔNG mint), `price_param.ak` beacon one-shot,
  `price_nft.ak` one-shot NFT, `vault_id_nft.ak` one-shot NFT định-danh vault (C-CM-6); aiken test
  (Σburns==required, over/under-burn reject, double-sat reject, drain ADA/token reject, stale price
  reject, did_commit immutable, wrong vault constr reject, vault không NFT / 2 NFT / sai policy reject).
- **OFFCHAIN**: `consumeBuilder` (co-spend Engage+vault) + datum codec EngageDatum/PriceParam + script
  deploy/e2e Preview. (chưa làm — xem GAPS.)

## E. Bất biến tuyệt đối (mọi spec/code)
- MAGIC = số kế toán trong vault datum; KHÔNG token, KHÔNG `tx.mint`. LAMP + ADA bảo toàn byte-perfect.
  LAMP cố định 36 tỷ KHÔNG burn.
- Giá lấy từ PriceParam beacon (có thẩm quyền), KHÔNG từ client.
- `Σ burns == required` (`==`, over-burn cấm); value preservation Engage UTxO bảo toàn tuyệt đối.
- Pure BigInt, không float. demand_mult FIR (không PI, không windup).
