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
> không còn validator nào chạm `tx.mint` MAGIC; (4) `consume` từ "đốt token" → "engagement-state validator"
> ép cùng tx có 1 vault input spend bằng `BurnBatch` với `Σburns == required`; (5) `EngageDatum` thêm
> `did_commit` (field cuối, append-only); (6) over-burn `≥` (v1, đốt token mất luôn) → `==` (v2,
> accounting: over-burn = giảm MAGIC user vô cớ → CẤM).

> **THAY THẾ vòng 2026-08-09 (on-chain `04afe875`) — ghi rõ chỗ:** (7) `EngageDatum` thêm
> `consumed_nanogic` (field THỨ 5, append-only) + bất biến kế toán song song; (8) validator
> `engage_nft.ak` bị **XOÁ** — handler `mint` gộp vào chính `consume` (multi-purpose), policy thread
> NFT == script hash `consume` (tự tham chiếu), tên NFT = `blake2b_256(cbor(seed))`; (9) `consume` còn
> **7 apply-param** (bỏ `engage_nft_policy`, `engage_nft_name`; thêm `price_param_script_hash`);
> (10) bảng giá `op_prices` phải **TĂNG NGẶT** theo `op_type` và **≤ 16 dòng**.

## A. Định giá tiêu thụ (consume-side pricing) — interface `price_per_op`

Gap audit: hiện `computeFee` chỉ là phí % trên `serviceAmount` do **client tự đưa** → không chống spam
(client đặt amount tùy ý). Ghim mô hình có thẩm quyền:

```
price(op_type, t) = base_price[op_type] × demand_mult(t) / Q          (Q = 1e9, scale BigInt)
```

- **`base_price[op_type]`**: bảng giá danh nghĩa per loại nghiệp vụ, **governance param** (DAO chỉnh).
  Ví dụ MVP: `xử lý 1 ảnh = 0.01 MAGIC`, `neo 1 CID = 0.001 MAGIC`. Đơn vị nanogic (1 MAGIC = 1e9).
- **Sổ op_type — `Registry` giữ sổ toàn hệ (chủ nhân chốt 2026-09-02); bảng dưới là các mã
  MAGIC đang dùng, `base_price` là governance param do DAO chốt.**

  Trước đây dòng này ghi *"MAGIC là registrar duy nhất"*. Hết đúng từ 2026-09-02: cấp mã mới
  thì xin ở `Registry`, kèm đơn vị vật lý, ai đo được (phải là bên thứ ba, không phải lời khai
  bên bán), và neo `file:line` tới chỗ mã thật đang đếm đại lượng đó. Mã 1–8 dưới đây **giữ
  nguyên nghĩa** — `Registry` đã dời sáu định nghĩa trùng số của mình xuống 13–18, vì luật gỡ
  trùng là *số đã nối vào mã chạy thì giữ, định nghĩa chưa nối vào đâu thì nhường*.
  | op_type | tên | base_price MVP (nanogic) | cấp cho | ghi chú |
  |---|---|---|---|---|
  | 1 | `ảnh` | 10_000_000 (0.01 MAGIC) | (gốc) | khớp `OP_IMAGE` `pricing/src/price.ts` |
  | 2 | `CID` (neo bằng chứng) | 1_000_000 (0.001 MAGIC) | (gốc) | khớp `OP_CID`; mọi bên neo bằng chứng DÙNG LẠI mã này, KHÔNG xin mã mới |
  | 3 | `recognition_storage_event` | DAO chốt (tạm 1e9/lần) | OriLife/Registry | **một lần lưu**, không phải MB — xem cảnh báo dưới bảng |
  | 4 | `recognition_compute_event` | DAO chốt (tạm 1e9/lần) | OriLife/Registry | **một lần tính**, không phải MB — xem cảnh báo dưới bảng |
  | 5 | `job_post` | DAO chốt (tạm 2_000_000) | AladinWork | đăng+phát tán 1 tin việc |
  | 6 | `contract_settle` | DAO chốt (tạm 5_000_000) | AladinWork | tất toán 1 hợp đồng |
  | 7 | `did.rotate` | DAO chốt (tạm 2_000_000_000) | PhoenixKey | xoay khoá DID. **Thao tác an ninh** — xem cảnh báo dưới bảng |
  | 8 | `did.transfer` | DAO chốt (tạm 10_000_000_000) | PhoenixKey | chuyển DID; thương mại, chịu nhân theo cầu là đúng |
  Mọi fixture/beacon/redeemer onchain PHẢI dùng đúng key này; không được lệch sang `0/1`.

  > 🔴 **Mã 3 và 4 từng khai đơn vị là MB. Sai — mã không đếm MB ở bất kỳ nghĩa nào.**
  > `required_for` nhân `op_count` (`onchain/lib/magiclamp/consume/pricing.ak:204`), và
  > `op_count` là **số lần**, đã bị một bài test ghim lại:
  > `pricing.ak:249-251 required_for(pp, 1, 5) == Some(50_000_000)` — `op_type 1` là ảnh,
  > `op_count = 5` là **năm tấm ảnh**. Phép đo phủ định trên toàn kho, bỏ `node_modules/`
  > và `build/`: `grep -rn "storage_mb\|storageMb\|sizeMb\|megabyte" --include="*.ts"
  > --include="*.ak"` → **0 dòng**. Chuỗi `_mb` chỉ từng sống trong tên mã và trong bảng này.
  >
  > Hỏng ra sao nếu để nguyên: hai bên tích hợp đọc **cùng một dòng** rồi truyền hai thứ khác
  > nhau vào **cùng một tham số** — bên A truyền `op_count = 40` cho một tệp 40 MB, bên B
  > truyền `op_count = 1` cho một lần lưu. Cả hai đều đọc đúng tài liệu, hoá đơn chênh **40
  > lần**, và không cổng nào kêu vì `op_count` là `Int` và cả hai giá trị đều hợp lệ.
  >
  > Đã đổi tên thành `_event` và sửa cột đơn vị. Đổi tên còn miễn phí vì chưa tx nào submit:
  > `grep -rn "recognition_storage\|recognition_compute" --include="*.ts" --include="*.ak"`
  > → **0 dòng mã**. Sau lần submit đầu thì không còn miễn phí.
  >
  > **Cần đại lượng dung lượng thật (MB, GiB·giờ) thì đó là MÃ MỚI**, xin ở `Registry`, kèm
  > đơn vị vật lý và bên thứ ba đo được — không phải quy ước lại `op_count` cho một mã sẵn có.
  > Đã loại phương án "giữ tên `_mb`, quy ước `op_count` = số MB": nó làm `op_count` mang hai
  > nghĩa tuỳ `op_type`, và không cổng nào kiểm được điều đó.
  >
  > ⚠️ **Mã 3 và 4 hôm nay không phân biệt được với nhau bên trong `ConsumeMAGIC/`** — cùng
  > đơn vị, cùng giá tạm, cùng nhân `op_count`. Lý do tách hai mã nằm ở bên tiêu thụ (phân bổ
  > `LAMPNET_REWARD` cho node cấp lưu trữ so với node cấp tính toán), không nằm trong
  > `pricing.ak`. Ràng buộc TẠM: giá hai mã đang bằng nhau, nên chọn nhầm mã **không** làm
  > lệch hoá đơn — nó chỉ làm lệch phân bổ thưởng ở bên tiêu thụ.

  > ⚠️ **Đừng đọc `max_op_prices = 16` thành "sổ chỉ còn 8 ô".** Bản cũ của dòng này viết
  > *"Còn 8/16 dòng"* và câu đó sai theo chiều nguy hiểm nhất với một quyển sổ: nó dẫn tới
  > tiết kiệm số, rồi tái dùng số. Con số 16 ở
  > [`pricing.ak:53`](onchain/lib/magiclamp/consume/pricing.ak:53) là trần **kích thước datum
  > của MỘT bảng giá** — chú thích ngay trên nó ghi *"16 dòng ≈ 256 byte datum"*. Nó chặn số
  > **dòng một platform khai được**, không chặn **giá trị** của `op_type`: `op_type` là `Int`
  > thường và hàm tra là `list.find` tuyến tính
  > ([`pricing.ak:100-101`](onchain/lib/magiclamp/consume/pricing.ak:100)), không có chặn trên.
  > Sổ toàn hệ dài bao nhiêu cũng được.

  > 🔴 **`op_type=7` đang bị định giá SAI về nguyên tắc, và MAGIC ghi nhận điều đó.**
  > `price_of`/`required_for` (`onchain/lib/magiclamp/consume/pricing.ak`) nhân
  > `pp.demand_mult` vào `base_price` của **mọi** `op_type`, mà `demand_mult` tính từ
  > `ops_served_epoch` — bộ đếm **gộp toàn hệ**, không tách theo `op_type`. Hệ quả:
  > (a) ai bơm `op_type` rẻ khối lượng lớn cũng đẩy giá xoay khoá DID lên tới trần `2.0×`
  > cho tất cả mọi người, không cần biết PhoenixKey tồn tại; (b) một đợt lộ khoá hàng
  > loạt khiến nhiều người cùng Rotate ⇒ `ops_served_epoch` tăng ⇒ Rotate đắt lên —
  > **việc cần gấp nhất thành đắt nhất đúng lúc cần rẻ nhất**, và tự khuếch đại. Trần
  > `2.0×` chặn được độ lớn, không chặn được chiều. Phát hiện: Phoenix, thư 2026-08-10.
  >
  > Đường vá **chưa làm** — nó đụng validator nên GATED, chờ chủ nhân gật. Hai hình dạng:
  > thêm cờ `fixed: Bool` vào `OpPrice` (đổi lược đồ datum của beacon đang sống, phải
  > post lại mọi beacon), hoặc quy ước một **dải `op_type` là giá cố định** (đổi hàm giá,
  > KHÔNG đổi lược đồ datum, không phải migrate beacon). MAGIC nghiêng về dải quy ước.
  >
  > **Đính chính một suy luận:** cờ/dải giá cố định **không** làm tx thôi phải đọc beacon
  > — `base_price` vẫn nằm trong datum beacon. Muốn tx độc lập beacon thì phải bake
  > `base_price` thành apply-param, và như vậy là mất luôn quyền DAO chỉnh giá đó.
  **Ràng buộc khi mở op_type** (đề nghị AladinWork, MAGIC tán thành): nếu `base_price > 0` thì
  `base_price × m_min ≥ Q` — chặn giá-về-0 (#1b) ngay tại governance. Cưỡng chế on-chain: xem hạng-mục
  siết `price_param.ak` (GATED, đụng validator, chờ chủ nhân gật).
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

**Ràng buộc DẠNG CHUẨN TẮC của `op_prices` (bắt buộc, `pricing.ak:valid_param`):**

| Ràng buộc | Giá trị | Lý do |
|---|---|---|
| `op_type` **TĂNG NGẶT** theo chỉ số dòng | — | Trùng `op_type`: on-chain `list.find` lấy dòng ĐẦU, map off-chain lấy dòng CUỐI ⇒ lệch giá 10× mà không bên nào báo. Tăng ngặt bao hàm "không trùng" và loại luôn bảng cùng-tập-khác-thứ-tự |
| Trần số dòng | **16** (`max_op_prices`) | `valid_param` chạy 1 lần / Engage input ⇒ bảng phình = DoS ex-unit mọi tx consume, không hạ được vì beacon chỉ committee sửa. 16 chọn theo số đo `aiken check` (MEM là ràng buộc binding) |
| `m_min`/`m_max` PIN về hằng | `500_000_000` / `2_000_000_000` | Check tương-đối không chặn band-escape: `demand` bám theo `m_max` nên giá nổ ~1e6× mà vẫn "trong band" |
| GATE per-op | `base_price × m_min ≥ Q` | Giá 1 đơn vị ở demand thấp nhất vẫn ≥ 1 nanogic ⇒ đóng collapse-to-0. Bao hàm `base_price ≥ 0` và cấm luôn `base_price == 0` (nhánh chết — `consume` ép `required > 0`) |

**Hệ quả bắt buộc cho off-chain:** phải **sắp xếp bảng giá tăng dần theo `op_type` trước khi post**
(`pricing/src/price.ts:toCanonicalOpPrices`) và **kiểm bằng `assertValidPriceParam` trước khi post**
(bản gương của `valid_param`, ném `PRICE-010..015`). Bảng sai chỉ lộ ra khi mọi tx consume đã chết
hàng loạt — beacon lúc đó chỉ committee sửa được.

### B2. Redeemer + bất biến validator `consume` (engagement-state, Aiken Plutus V3)

**`consume` là MULTI-PURPOSE — 7 apply-param, ĐÚNG THỨ TỰ (đổi thứ tự = sai hash):**

```
price_nft_policy, price_nft_name, vault_script_hash, burn_batch_constr,
max_price_stale, ms_per_epoch, price_param_script_hash
```

`engage_nft_policy` / `engage_nft_name` **KHÔNG còn là param** và `engage_nft.ak` **không còn tồn
tại**. Lý do first-principles: mint-policy phải ép Engage UTxO genesis nằm ĐÚNG địa chỉ script
`consume` với datum SẠCH; muốn thế policy phải biết `consume_script_hash`, mà `consume_script_hash`
lại phụ thuộc policy nếu policy là param ⇒ **fixed-point blake2b, không deploy được**. Gộp handler
`mint` vào chính `consume` ⇒ `policy_id (mint) == script_hash == payment_credential của địa chỉ
spend`, biết qua **TỰ THAM CHIẾU** — không param, không vòng.

**Redeemer (mọi cái đều Constr 0):**

| Redeemer | Dạng | Chỗ dùng |
|---|---|---|
| `Consume` | `[op_type: Int, op_count: Int, price_ref: OutRef, vault_ref: OutRef]` | spend Engage UTxO |
| `MintEngage` | `[seed: OutRef]` | handler `mint` của chính `consume` (genesis thread) |
| `PostPrice` | `[]` | spend beacon PriceParam (`price_param.ak`) |
| `MintGenesis` | `[]` | `price_nft.ak` |

**`EngageDatum` — 5 trường, THỨ TỰ này là hợp đồng codec:**

```
EngageDatum {
  owner            : ByteArray,   // pkh chủ thread, bảo toàn qua mọi spend
  consumed_count   : Int,         // số LƯỢT tích luỹ  (thống kê/attribution)
  last_epoch       : Int,         // epoch consume GẦN NHẤT; genesis PHẢI == 0
  did_commit       : ByteArray,   // append-only, MVP = #""; đặt 1 lần lúc genesis, immutable
  consumed_nanogic : Int,         // GIÁ TRỊ (nanogic) tích luỹ đã tiêu  ← THÊM Ở CUỐI
}
```

Validator ÉP:

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
  + redeemer constr == `burn_batch_constr`.
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
  chống dùng giá cũ khi demand đã tăng. `current_epoch` lấy từ **upper bound** của `validity_range`;
  `util.get_epoch` đòi **cả hai biên Finite** và `⌊lo/mspe⌋ == ⌊hi/mspe⌋` (cửa sổ nằm **TRỌN trong
  MỘT epoch**). Off-chain dựng sai cửa sổ ⇒ tx chết ở đây.
> 🔴 **MÃ `C-CM-6` BỊ DÙNG CHO HAI RÀNG BUỘC KHÁC NHAU — Nợ #38.** Trên `origin/main`,
> `C-CM-6` là `INV-VAULT-IDENTITY` (mỗi vault input mang đúng 1 NFT one-shot). Trên nhánh
> này nó là bất biến kế toán `consumed_nanogic` ngay dưới. Bảng §7.4 của spec **cả hai bản**
> chỉ liệt tới `C-CM-5` nên không phân giải được. Hoà hai nhánh **theo tên mã** sẽ im lặng
> đánh rơi một trong hai ràng buộc — cả hai đều còn cần. Ai hoà nhánh phải cấp mã MỚI cho
> một trong hai và sửa mọi nơi trích, không được để trùng.

- **C-CM-6 (GIÁ TRỊ đã trả — `consumed_nanogic`):** bất biến kế toán **THỨ HAI**, song song với
  C-CM-3: `Σ consumed_nanogic(out@engage) == Σ(in@engage) + total_required`.
  **Chỉ đếm LƯỢT là KHÔNG ĐỦ:** `consumed_count` không phân biệt op rẻ / op đắt — kẻ gọi trả giá
  `op_type=2` (CID, 1e6) rồi để app đọc "+1 lượt" mà cấp dịch vụ `op_type=1` (ảnh, 1e7) ⇒ trả thiếu
  10× trong khi MỌI bất biến on-chain vẫn thoả. `consumed_nanogic` khoá đúng con số tiền đã trả vào
  state. **App PHẢI cấp dịch vụ theo DELTA của trường này** (xem EXEC.md §"Xác nhận thanh toán").
- **C-CM-7 (genesis SẠCH — handler `mint`):** thread NFT chỉ ra đời qua `MintEngage { seed }` của
  chính `consume`. Ép: `seed` bị TIÊU trong tx (one-shot ⇒ singleton vĩnh viễn); đúng 1 asset dưới
  policy, qty +1, tên = `blake2b_256(cbor.serialise(seed))`; **đúng 1 output tại địa chỉ script này**
  mang NFT (chống "mint sạch → dời nhà bẩn"); datum inline decode được `EngageDatum`; `owner ∈
  extra_signatories`; `consumed_count == 0 ∧ consumed_nanogic == 0 ∧ last_epoch == 0`; output genesis
  có nhiều nhất 2 policy (`{ADA, thread NFT}`).
  **Vì sao phải ép ở lúc MINT:** Cardano KHÔNG chạy validator lúc TẠO UTxO. Bất biến delta ở spend
  chỉ khoá phần TĂNG, **không khoá GỐC** — không có cổng mint thì kẻ tấn công đặt
  `consumed_nanogic` bịa (vd 1e18) ngay từ genesis và mọi app đọc "đã tiêu 1e18" sẽ cấp dịch vụ
  miễn phí mãi mãi.
- **C-CM-8 (mint và spend KHÔNG đi chung một tx):** `spend` ép
  `script_inputs_confined_to(inputs, own_hash, vault_script_hash)` (chống double-satisfaction
  xuyên-instance) + cổng "mọi input tại địa chỉ engage mang đúng 1 thread NFT"; tx `MintEngage` thì
  tiêu UTxO seed của VÍ. Hai việc tách hẳn — off-chain dựng hai tx riêng.

- **C-CM-9 (quyền ghi vào thread — Nợ #36):** nhánh `spend` ép
  `owner ∈ tx.extra_signatories` **HOẶC** `VaultDatum.owner == EngageDatum.owner` trên **MỌI**
  `vault_ref` phân biệt (đọc trường 0 của datum vault bằng `un_constr_data`, KHÔNG import
  `VaultDatum` — cùng khuôn `read_vault_burns`). Neo:
  `onchain/validators/consume.ak` (sau `expect total_burned == total_required`).

  *Vì sao cần:* C-CM-4 chỉ ép `owner` **bảo toàn** qua tx, không ép `owner` cho phép. Thiếu cổng
  này, bất kỳ ai có MAGIC trong vault của **chính mình** đều co-spend được thread Engage của người
  khác và cộng `consumed_count` / `consumed_nanogic` vào hồ sơ đó. `consumed_*` là đầu vào **C1**
  của quyền biểu quyết, mà hệ này cấm biểu quyết theo tiền — nên đó là đường mua phiếu bằng tiền,
  chỉ vòng qua một bước.

  *Vì sao KHÔNG chỉ đòi chữ ký:* đường sponsor Paymaster/Feecover cố ý để người dùng **không ký**
  (`Paymaster/FEAT.md:44`) — app chỉ là `personal_delegate` của vault **của chính người dùng**, và
  vault cho phép BurnBatch theo `owner HOẶC personal_delegate`
  (`InstantGen/onchain/validators/vault.ak:900`). Vế thứ hai nhận đúng đường đó mà không mở lại lỗ:
  MAGIC bị đốt là của chính chủ thread ⇒ không hồ sơ ai khác bị ghi vào. Ai được tiêu vault đó là
  việc của vault gác, không phải của lớp này — và vault gác bằng `owner HOẶC personal_delegate`,
  trong đó `personal_delegate` chỉ **đặt được bằng chữ ký owner** (`validate_set_delegate`). Nên
  vế 2 là **uỷ quyền tường minh** của chính chủ thread, không phải một lỗ bỏ ngỏ.

  *Vì sao ràng trên MỌI vault_ref, không phải "có một cái khớp":* tx trộn một vault của chủ thread
  với một vault của người lạ, không chữ ký, thì phần đốt ở vault người lạ vẫn chảy vào `consumed_*`
  của chủ thread. Test `consume_mixed_vault_owners_no_sig_fail` giữ đúng vế này — đổi `list.all`
  thành `list.any` là test đó đỏ ngay.

  *Off-chain:* `buildConsumeTx` mặc định thêm chữ ký chủ thread (vế 1). Đường sponsor đặt
  `sponsoredNoThreadSignature: true` và tự chịu trách nhiệm về điều kiện vế 2.

`did_commit` (MVP = `#""` rỗng): tương lai = blake2b256 commitment liên kết engagement ↔ DID sinh trắc
(PhoenixKey, Governance C1/C3 attribution). Đặt 1 lần lúc genesis, immutable sau đó. Validator KHÔNG
ràng buộc nội dung — kể cả ở handler `mint` (cố ý: nó là LỰA CHỌN của người dùng, không phải state
tích luỹ; pin cứng về `#""` sẽ khoá chết đường liên kết DID sau này mà không thêm chút an toàn nào).

### B3. Tx-builder offchain
- `buildMintEngageTx` (`offchain/src/consume.ts`): tx **RIÊNG** đúc thread Engage genesis
  (`MintEngage { seed }`), datum sạch, output tại địa chỉ `consume`, owner ký. Tên NFT qua
  `offchain/src/engageId.ts` (`blake2b_256(cbor(seed))` — cùng khuôn với NFT danh-tính vault).
- `buildConsumeTx`: đọc PriceParam ref-input, tính `required` (fold-floor-một-lần), dựng tx co-spend
  Engage UTxO (`Consume`) + vault UTxO (`BurnBatch`, redeemer do caller truyền), ghi
  `consumed_count += op_count` **và** `consumed_nanogic += required`, validity-range trọn một epoch.
  KHÔNG mint.
- e2e Preview live: chưa chạy — xem EXEC.md §4.

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
- **PRICING (offchain)**: `pricing/price.ts` (`price_per_op`, `demand_mult` FIR,
  `assertValidPriceParam` = bản gương `valid_param`) + vitest (đơn điệu, clamp biên, hội tụ, test
  vector ảnh 0.01 / CID 0.001, bảng giá không sắp xếp / > 16 dòng / rớt GATE → ném).
- **ONCHAIN**: `onchain/` Aiken — `types.ak` (PriceParam, OpPrice, Consume, `EngageMintRedeemer`,
  EngageDatum 5 trường), validator `consume.ak` (multi-purpose: `mint` genesis + `spend`
  engagement-state, C-CM-1..9, KHÔNG mint MAGIC), `price_param.ak` beacon one-shot, `price_nft.ak`
  one-shot NFT. **Không còn `engage_nft.ak`.**
- **OFFCHAIN**: `buildMintEngageTx` + `buildConsumeTx` + codec EngageDatum(5)/PriceParam/
  ConsumeRedeemer/EngageMintRedeemer + `engageId.ts` (tên thread NFT) + script deploy/e2e Preview.

Số ca test (aiken / offchain / pricing) KHÔNG ghi ở đây — nguồn duy nhất: [`DevStatus.md`](../DevStatus.md).

## E. Bất biến tuyệt đối (mọi spec/code)
- MAGIC = số kế toán trong vault datum; KHÔNG token, KHÔNG `tx.mint`. LAMP + ADA bảo toàn byte-perfect.
  LAMP cố định 36 tỷ KHÔNG burn.
- Giá lấy từ PriceParam beacon (có thẩm quyền), KHÔNG từ client.
- `Σ burns == required` (`==`, over-burn cấm); value preservation Engage UTxO bảo toàn tuyệt đối.
- `Σ consumed_nanogic(out) == Σ(in) + total_required` — GIÁ TRỊ đã trả nằm on-chain. App cấp dịch vụ
  theo **delta `consumed_nanogic`**, KHÔNG theo `consumed_count`.
- Policy thread NFT Engage == script hash `consume` sau apply 7 param; tên NFT =
  `blake2b_256(cbor(OutputReference seed))`. KHÔNG hằng tên, KHÔNG policy rời.
- `op_prices` sắp xếp `op_type` TĂNG NGẶT, ≤ 16 dòng, mọi dòng thoả `base_price × m_min ≥ Q`.
- Pure BigInt, không float. demand_mult FIR (không PI, không windup). **P8 chỉ đúng khi mọi toán
  hạng `≥ 0`** — Aiken `/` là floor, JS BigInt `/` là trunc-về-0 (MATH.md §5.1).
