# VaultTxAPI — dịch vụ DỰNG GIAO DỊCH CHƯA KÝ cho app di động

App là React Native trên Hermes. **Hermes không có WebAssembly**, mà bộ dựng giao dịch
(`@lucid-evolution/lucid`) là WASM — nên app không dựng nổi giao dịch tại chỗ. Dịch vụ này
là lớp trung gian: nó dựng, app ký, app nộp lại qua đây.

---

## 1. 🔴 Bất biến số một

**Dịch vụ KHÔNG BAO GIỜ giữ, đọc, nhận hay chạm vào vật liệu ký.** Nó trả về **CBOR của
một giao dịch CHƯA KÝ**; app ký trong Secure Enclave của máy, nơi khoá không rời khỏi.

Cụ thể, và kiểm được:

| điều được khẳng định | chỗ cưỡng chế |
|---|---|
| không tham số / biến môi trường / trường JSON nào là vật liệu ký | `tests/noSigningMaterial.test.ts` quét toàn bộ `src/**` + `tests/**` |
| không đường ký nào của lucid được gọi | cùng bài quét đó |
| ví của lucid là ví **chỉ-đọc** (`selectWallet.fromAddress`) | `src/txBuilder.ts` |
| chỉ `config.ts` chạm biến môi trường, và tập biến là danh sách **ĐÓNG** | cùng bài quét đó |
| bí mật duy nhất là **GIÁ TRỊ** khoá Blockfrost, không phải đường dẫn tới kho khoá | `src/config.ts` |

Bài quét ghép mẫu cấm **từ mảnh** thay vì viết thẳng chuỗi. Viết thẳng thì chính tệp kiểm
vi phạm phép quét của nó, và lối thoát duy nhất là loại tệp kiểm ra khỏi vùng quét — tức
tự đục một lỗ đúng bằng kích thước của thứ đang canh.

Ký là việc của app. Nộp thì đi qua `/tx/submit`, nơi dịch vụ **ghép** bộ chứng ký của app
vào thân giao dịch và **đối chiếu hash thân trước/sau** — không phải giả định nó không đổi.

---

## 2. 🔴 `summary` suy TỪ `tx_cbor`, không chép lại yêu cầu

App hiện `summary` cho người dùng đọc **trước khi họ ký**. Nếu `summary` dựng từ tham số
của chính yêu cầu thì nó **không chứng minh gì** về thứ sắp được ký: một máy chủ bị chiếm
dựng một giao dịch khác hẳn rồi kèm một `summary` đẹp đẽ chép lại đúng thứ người dùng vừa
nhập, và màn hình xác nhận trông y hệt lúc bình thường.

Nên mọi con số trong `summary` đi qua đúng một đường: **giải mã lại chính CBOR vừa dựng**.
Chữ ký của `summarizeTx` là chỗ ràng buộc đó được cưỡng chế — hàm **không nhận** tham số
yêu cầu nào để mà chép:

```ts
summarizeTx(txCborHex, { vaultAddress, inputVaultDatumHex, lampUnit, network, requestedIntent })
```

Thứ duy nhất đi vào ngoài CBOR là `inputVaultDatumHex` — datum của UTxO vault **đang bị
tiêu**, đọc từ chuỗi trước lúc dựng. Đó là dữ kiện của chuỗi, không phải thứ người gọi
khai. Không có nó thì chỉ nói được số tuyệt đối sau giao dịch, không nói được *khoá THÊM
bao nhiêu*.

`requested_intent` mang tên như thế vì nó là **nhãn của đường HTTP đã gọi**, thứ duy nhất
trong `summary` không suy từ CBOR. Mọi con số thì có.

### Phép đo cắn được

`tests/service.test.ts` ▸ *"summary KHÔNG phải tiếng vọng của yêu cầu"* bơm vào một tầng
dựng trả về giao dịch khoá `3 × λ` trong khi yêu cầu xin `17 × λ`, rồi đòi bản tóm tắt nói
`21 000 000` và **không** nói `119 000 000`.

Đã chạy phép đo đột biến, không chỉ đọc màu: thay `after` (datum trong output của giao
dịch) bằng `before` — tức bỏ đúng tính chất "suy từ CBOR" — thì **7 bài đỏ** trên hai tệp
kiểm. Hoàn nguyên thì 56/56 xanh.

---

## 3. Bề mặt HTTP

```
POST /tx/instant-gen       { owner, [owner_witness], change_address | fee_payer, m, [wakeme_vault_ref] }
POST /tx/refresh-checkpoint { owner, [owner_witness], change_address | fee_payer, [wakeme_vault_ref] }
POST /tx/schedule-commit   { owner, [owner_witness], change_address | fee_payer, schedule_length, lamp_per_epoch }
POST /tx/schedule-fire     { owner, [owner_witness], change_address | fee_payer, schedule_id }
POST /tx/consume           { owner, [owner_witness], change_address | fee_payer, op_type, op_count | pairs, [engage_ref], [wakeme_vault_ref] }
POST /tx/open-thread       { owner, [owner_witness], change_address }
POST /tx/bind-did          { owner, [owner_witness], [change_address], did_commit, [engage_ref] }
POST /tx/create-vault      { kind, owner, [owner_witness], lamp_amount, change_address | funding, [profile], [did_commit] }
POST /tx/submit            { tx_cbor, witness_cbor }
POST /tx/quote             { route, params, [owner_fee_addresses] } — báo giá phí, xem dưới
POST /fee/utxo             { route }        [X-Feecover-Token]   — proxy ví trả phí, xem dưới
POST /fee/sign             { tx_cbor }      [X-Feecover-Token]
GET  /health
```

Chủ khoá được bỏ trống `change_address` (dịch vụ suy địa chỉ enterprise của khoá, §7); chủ
script thì phải gửi một trong hai trường.

`/health` khai commit của mã đang chạy để bên gọi tự đối chiếu, khỏi hỏi người vận hành:
`commit` (40 hex), `commit_dirty` (cây có tệp track bị sửa tại chỗ ⟹ commit không đủ mô tả mã
chạy), `commit_source`. Commit ĐO bằng `git rev-parse HEAD` ở cây mã lúc khởi động, không nhận
qua biến môi trường (`src/buildInfo.ts`). Không đo được thì `commit: null`,
`commit_source: "unavailable"` kèm `commit_unavailable_reason` — không đoán.

`/health` còn khai tài sản LAMP mà bản deploy nướng vào mọi két, dạng máy đọc:
`"lamp": { "policy_id": "<56 hex>", "asset_name_hex": "<hex>" }` — cùng nguồn với bộ dựng
(khối `lamp` của tệp deploy), không gõ tay. App so `policy_id` này với policy LAMP mà két Wakeme
phát trước khi mở luồng Sinh MAGIC. `deployment_source` (nhãn chữ) giữ nguyên văn như cũ.

`/health` còn khai GỐC KỲ giao thức, để app tính kỳ mà khỏi gõ cứng hằng theo mạng. Kỳ trên
chuỗi là `⌊(t − O) / P⌋` với `O = window_origin_ms`, `P = ms_per_epoch` — KHÔNG phải lưới Unix
`⌊t / P⌋` (lệch ~3.800 kỳ trên Preprod: t=1_790_553_600_000 là kỳ **316**, lưới Unix cho 4144).
`O` và `P` lấy từ `windowOriginMs` / `msPerEpoch` của `@magiclamp/protocol-utils` — CÙNG hàm mà
bộ dựng tx dùng để apply-param validator (`genV2.ts` ▸ `instantVaultParamsOf`), không có bản chép
thứ hai (`src/http.ts` ▸ `epochHealthFields`):

```jsonc
"epoch": {
  "origin_ms": "1654041600000",   // O — chuỗi số
  "ms_per_epoch": "432000000",    // P — chuỗi số
  "current": 316,                 // kỳ hiện tại theo GIỜ MÁY CHỦ (chỉ số kỳ nhỏ ⟹ số JSON)
  "start_ms": "1790553600000",    // O + current·P, ĐẦU kỳ (gồm mốc này)
  "end_ms": "1790985600000"       // O + (current+1)·P: kết thúc ĐỘC QUYỀN = start_ms của kỳ kế
}
```

Khoảng của kỳ là nửa mở `[start_ms, end_ms)`: `t = end_ms` đã thuộc kỳ kế. App tính kỳ cho một
mốc bất kỳ `t` bằng `⌊(t − origin_ms) / ms_per_epoch⌋` (chia sàn; `t < O` cho số âm) từ chính
hai trường này. Mạng không có gốc (**Preview**, `WIN-PREVIEW` — LAMP `Specs/Window/CONTRACT.md`
v1.0 §4) thì `/health` VẪN trả 200 nhưng khai tường minh, không đệm 0:
`"epoch": null, "epoch_unavailable_reason": "WINDOW_ORIGIN_UNAVAILABLE"`. Các đường dựng tx trên
mạng đó vẫn trả 501 cùng mã như trước.

Năm đường dựng trên vault có sẵn (`instant-gen`, `refresh-checkpoint`, `schedule-commit`,
`schedule-fire`, `consume`) trả:

```jsonc
{
  "tx_cbor": "84a4…",        // giao dịch CHƯA KÝ
  "tx_hash": "3f1c…",        // hash THÂN giao dịch — app đối chiếu sau khi ký
  "summary": { … },          // §2
  "expires_at": "2026-09-11T16:28:03.000Z",
  "ignored": [],             // UTxO ở địa chỉ vault cố ý không tính, kèm lý do (trừ vault của chủ khác)
  "ignored_other_owner_count": 0, // vault của CHỦ KHÁC ở cùng địa chỉ — chỉ đếm, không liệt kê
  "required_signers": ["…"], // đọc từ required_signers của CHÍNH tx_cbor
  "witness_notes": ["…"]     // việc phải làm ngoài chữ ký (chủ script: mục rút did_stake…)
}
```

### Gen v2.0: `summary.gen` trên mọi đường dựng vault

`summary.gen` đọc năm ô sinh từ datum ĐẦU RA giải mã lại từ `tx_cbor` (`summary.ts` ▸
`TxSummary.gen`), không từ tham số yêu cầu:

```jsonc
"gen": {
  "cap_epoch": "1234",          // két Schedule ⟹ null (ô đó không tồn tại ở két Schedule)
  "cap_nanogic": "750750000",   // két Schedule ⟹ null
  "wakeme_link": "",            // "" = chưa ghim két Wakeme; két Schedule ⟹ null
  "usage_window_epoch": "1234",
  "usage_factor_q": "1000000000" // `usageFactorQ(usage_window)` của instantgen-sdk, Q = 10⁹
}
```

### `POST /tx/instant-gen`: `m` do chủ chọn, trần `max_m`

Từ Gen v2.0 lượng sinh `m` (nanogic) là **bắt buộc** và do chủ chọn; validator chỉ ép TRẦN.
`m` là CHUỖI chữ số thập phân `> 0` — vắng / số JSON / không phải chữ số / `"0"` ⟹
`400 INSTANT_GEN_M_INVALID`. Dịch vụ đọc beacon ρ, beacon GreenBack, sổ két và shard GB của
két MỘT lần, tính `max_m` bằng `@magiclamp/instantgen-sdk` ▸ `instantGenLimits` trên đúng các
UTxO đó rồi giao chúng xuống bộ dựng (`genV2.ts`). `m > max_m` ⟹ `422 INSTANT_GEN_M_ABOVE_MAX`
kèm `details.max_m` và `details.m` — bộ dựng không được gọi. App chưa biết `max_m` thì hỏi
`POST /tx/quote` route `instant-gen` KHÔNG gửi `m` (hoặc `"0"`): báo giá dựng tại `m = max_m` và
trả trần trong `summary.gen_limits` (xem §Báo giá). Đường dựng thật vẫn đòi `m`. Dựng xong,
`summary.gen_limits`:

```jsonc
"gen_limits": {
  "max_m_nanogic": "750750000",
  "remaining_after_nanogic": "746750000",  // max_m − lượng đúc đọc từ CBOR (âm ⟹ 422 TX_SUMMARY_UNDECODABLE)
  "l_lent_oildrop": "0",
  "gen_so_far_nanogic": "0",
  "cap_nanogic": "750750000",
  "cap_lamp_nanogic": "4004000000",
  "gb_available_nanogic": "1000000000000000",
  "checkpoint_refreshed": true             // lượt này làm mới checkpoint ⟹ beacon ρ vào tx
}
```

Cần khối `gen_v2` và `ref_script_utxos.gb_shard` trong bản deploy (§6); thiếu ⟹
`501 CONFIG_MISSING` với `details.missing` nêu đúng khoá. Mạng chưa có két Wakeme ⟹
`501 WAKEME_VAULT_UNAVAILABLE` (apply-param #8 của két không có giá trị).

**Két cũ chưa nối két Wakeme (`wakeme_link` rỗng): chạy RefreshCheckpoint trước.** Từ
2026-10-03 lượt sinh (và lượt tiêu) **không nối link** được nữa (`checkpoint.ak` ▸
`resolve_link`, luật 6): két IG link rỗng mà kèm `wakeme_vault_ref` trỏ tới một két Wakeme
không ghim két này ⟹ `422 WAKEME_LINK_CHANGE_REJECTED`, bộ dựng không được gọi. Lượt nối đầu
chỉ qua genesis (`did_commit` ở `/tx/create-vault`) hoặc `POST /tx/refresh-checkpoint` kèm
`wakeme_vault_ref`; xong thì gọi lại `instant-gen`. Bỏ `wakeme_vault_ref` thì lượt sinh vẫn
chạy với `L_lent = 0`. Ngoại lệ duy nhất: lượt sinh làm mới checkpoint mà két Wakeme đưa vào
đang ghim chính két này (`L_lent > 0`) — validator nhận, dịch vụ cũng nhận. `/tx/consume` thì
không có ngoại lệ đó (bộ dựng consume không tính `L_lent`), nên ở đó luôn RefreshCheckpoint trước.

### `POST /tx/refresh-checkpoint`

Chủ ký, két Instant làm mới năm ô checkpoint (`cap_epoch`, `cap_nanogic`, `usage_window`,
`usage_window_epoch`, `wakeme_link`) mà không sinh/tiêu gì. Luôn đọc beacon ρ (vắng trên
chuỗi ⟹ `502 CHAIN_UNAVAILABLE`, không dựng). `wakeme_vault_ref` có ⟹ ghim/giữ két Wakeme đó;
vắng ⟹ gỡ ghim (`wakeme_link := ""`). Cần khối `gen_v2` (thiếu ⟹ `501 CONFIG_MISSING`).

### `POST /tx/consume` trên két Instant sang epoch mới

Lượt tiêu đầu tiên trong epoch mới (`cap_epoch < e`) của két Instant làm mới checkpoint ở nhánh
BurnBatch ⟹ tx cần beacon ρ ở reference input (vắng ⟹ `502 CHAIN_UNAVAILABLE`), và két Wakeme
nếu két đã nối link (`wakeme_link` khác ""). Ca đó mà thân bài không kèm `wakeme_vault_ref` thì
dịch vụ tự định vị két (mục `wakeme_vault_ref` dưới); không tìm thấy két nào ⟹
`400 WAKEME_VAULT_REF_REQUIRED` (`details.wakeme_link`, `details.located_count`), không dựng một
tx chắc chắn chết. Cùng
epoch, hoặc két Schedule ⟹ không đọc gì thêm (ScheduleGen không đọc két Wakeme).

### `POST /tx/consume` nhiều loại nghiệp vụ trong MỘT tx: `pairs`

Thân bài nhận **một trong hai** dạng: cặp đơn `"op_type": 1, "op_count": "2"`, hoặc `pairs`. Ví dụ
một tác vụ OriLife dùng bốn mã nghiệp vụ:

```json
{ "owner": { "type": "key", "hash": "<56 hex>" }, "fee_payer": { … },
  "pairs": [ { "op_type": 1, "op_count": "1" }, { "op_type": 2, "op_count": "1" },
             { "op_type": 3, "op_count": "1" }, { "op_type": 4, "op_count": "3" } ] }
```

Luật (nguồn duy nhất: `assertValidPairs`, gương `pricing.valid_pairs` on-chain; ánh xạ mã ở
`src/consumeLine.ts`): 1..8 cặp (`MAX_CONSUME_PAIRS`); `op_type` là số nguyên JSON trong
[0, 1000000], **tăng ngặt** — trùng loại thì gộp `op_count` lại; `op_count` là **chuỗi** chữ số ≥ 1.
Gửi `pairs` cùng `op_type`/`op_count` ⟹ `400 CONSUME_PAIRS_CONFLICT`: dịch vụ không chọn hộ bên
nào thắng. Mọi lỗi hình dạng ra 400 TRƯỚC khi giữ khoá chủ và trước khi đọc chuỗi.

**`required` của ConsumeMany = Σ sàn TỪNG cặp** (`requiredFromBeaconPairs`, gương
`required_for_pairs`) — KHÁC quy tắc gộp-rồi-sàn của Consume đơn. Hai quy tắc lệch tới (n−1)
nanogic, và validator đòi `Σburns == required` (dấu bằng). Bài Emulator
(`MagicSDK/tests/sponsorJourney.test.ts`, khối ConsumeMany) chọn giá lẻ để hai quy tắc lệch đúng
1 nanogic: két đốt theo gộp-rồi-sàn ⟹ validator từ chối; đốt theo sàn-từng-cặp ⟹ qua.

**`pairs` đúng MỘT phần tử ⟹ dựng `Consume` đơn (constr 0)**, không dựng ConsumeMany một cặp: kế
toán giống hệt (một cặp sàn một lần ở cả hai quy tắc), còn chi phí thì không. Đo 2026-10-03 trên
Emulator (script `consume` + vault Prepaid chạy thật, cùng op 2 × 1, tổng mọi redeemer của tx):

| redeemer | byte tx | mem | steps |
|---|---|---|---|
| `Consume` (constr 0) | 1.193 | 1.698.217 | 608.679.596 |
| `ConsumeMany` 1 cặp (constr 3) | 1.199 | 1.795.933 | 638.418.101 |
| `ConsumeMany` 4 cặp (op 1–4) | 1.217 | 2.152.109 | 755.134.607 |

Bài đo khẳng định ConsumeMany một cặp đắt hơn ở cả ba trục; số đo lật chiều thì bài đỏ và quyết định
này phải xét lại. Bên gọi không phải rẽ nhánh: `summary.consume` luôn in `pairs` dạng danh sách.

**`summary.consume`** đọc lại TỪ CBOR (`checkConsumeTx`), cho MỌI lượt tiêu — cả cặp đơn:
`redeemer` (`Consume` | `ConsumeMany`), `pairs`, `required_nanogic`/`required_magic`,
`engage_input_ref`. Phép đọc lại ép: thread là input và mang đúng một redeemer Spend; redeemer
đúng dạng + đúng các cặp đã yêu cầu, `vault_ref` = két đang tiêu, `price_ref` trong
`reference_inputs`; đúng một output ở địa chỉ engage, mang NFT thread, value bảo toàn tuyệt đối;
datum thread giữ chủ, `consumed_count` tăng Σ `op_count`, `consumed_nanogic` tăng `required` > 0
và bằng `magic.burned_nanogic` của két. Lệch ⟹ `422 CONSUME_TX_MISMATCH`, không có tx nào để ký.

### `POST /tx/schedule-commit`: validator `commit`

Nhánh ký của két Schedule v2.0 uỷ cho validator withdraw-zero `commit`, và lượt commit đọc
beacon ρ + beacon GreenBack + sổ két, TIÊU shard GB. Cần khối `gen_v2`,
`ref_script_utxos.commit` và `ref_script_utxos.gb_shard`; thiếu khoá nào ⟹ `501 CONFIG_MISSING`
với `details.missing` nêu đúng khoá đó. Stake credential của `commit` phải được đăng ký trước
(`buildRegisterCommitStakeTx` của SDK) — dịch vụ không dựng lượt đăng ký.

### `wakeme_vault_ref`: két Wakeme cho mượn LAMP

Két InstantGen v2.0 đọc `(owner_commit, L_lent)` từ **đúng một** két Wakeme nằm trong
**reference inputs** của giao dịch — két có `gen_vault` (datum trường 11) ghim chính vault
này — ở lượt làm mới checkpoint và ở nhánh sinh. Không két ⟹ `L_lent = 0`, hợp lệ; hai két
trở lên ⟹ chuỗi từ chối. Mã đọc: `@magiclamp/instantgen-sdk` ▸ `explainWakemeVault` (gương
`checkpoint.ak` ▸ `wakeme_lent.ak` ▸ `wakeme_read`). Trường này nhận ở `instant-gen`,
`refresh-checkpoint` và `consume`.

- **Có** `"wakeme_vault_ref": "<tx_hash 64 hex>#<i>"` ⟹ dịch vụ dùng đúng UTxO đó (ưu tiên), kiểm
  trước khi dựng: mạng có két Wakeme (`@magiclamp/protocol-utils` ▸ `wakemeVaultHash`), UTxO còn
  sống, nằm ở script két, datum đọc được. Vế nào hỏng thì trả lỗi có mã (bảng dưới), không dựng
  một tx mà chuỗi sẽ từ chối.
- **Vắng**, két IG **đã nối link** (`wakeme_link` = `owner_commit` của DID chủ két) ⟹ dịch vụ
  **tự định vị** két Wakeme bằng NFT định danh `(policy = wakeme_vault_hash, name = wakeme_link)`
  — tra theo đơn vị tài sản, chi phí theo MỘT két, không quét địa chỉ script dùng chung. Chỉ giữ
  UTxO có payment credential = script két Wakeme (validator lọc reference input đúng như thế).
  Tìm thấy 1 ⟹ đọc + kiểm như trên, `summary.wakeme.source = "located"`; 2 trở lên ⟹
  `409 WAKEME_VAULT_AMBIGUOUS` (`details.candidates`); 0 ⟹ `reason: "wakeme_vault_not_found"`,
  trừ khi lượt này làm mới checkpoint (validator đòi két) ⟹ `400 WAKEME_VAULT_REF_REQUIRED`.
- **Vắng**, két IG chưa nối link ⟹ không két nào, `L_lent = 0`,
  `summary.wakeme = { lent_lamp: "0", counted: false, reason: "vault_not_linked" }`.
- `refresh-checkpoint` cố ý **không** tự định vị: ở đường đó vắng `wakeme_vault_ref` mang nghĩa
  "gỡ ghim" (`wakeme_link := ""`).

Ba ca chuỗi **cho qua với `L_lent = 0`** thì dịch vụ cũng cho qua, nhưng nói ra:

```jsonc
"summary": {
  …,
  "wakeme": {
    "ref": "<tx_hash>#<i>",
    "lent_lamp": "500000000",   // oildrop, chuỗi — đúng con số validator tính
    "counted": true
    // "source": "located"         chỉ khi dịch vụ tự định vị (app không gửi ref)
    // counted: false ⟹ lent_lamp: "0" và "reason":
    //   "not_pinned_to_this_vault"  két chưa ghim vault này (kèm "seen_pin", null = chưa ghim) —
    //                               KHÔNG còn là lỗi 409: chủ két IG nối link trước, két Wakeme ghim sau
    //   "pinned_in_current_period"  két ĐỔI ghim sang vault này trong chính kỳ đang sinh
    //   "lamp_short_of_datum"       value két giữ ít LAMP hơn conditional + owned của datum
    //   "wakeme_vault_not_found"    tự định vị không thấy két nào (không có "ref")
    //   "vault_not_linked"          két IG chưa nối link, app không gửi ref (không có "ref")
  }
}
```

Dịch vụ đọc lại `tx_cbor`: két phải nằm trong `reference_inputs` và không nằm trong `inputs`
(lệch ⟹ `422 WAKEME_VAULT_TX_MISMATCH`). `lent_lamp`/`counted` là dữ kiện chuỗi đọc trước lúc
dựng — CBOR chỉ mang tham chiếu, không mang nội dung reference input.

### Chủ vault: `owner`, và bí danh `owner_pkh`

Chủ là một `Credential`, hai dạng:

```jsonc
"owner": { "type": "key",    "hash": "<56 hex thường>" }   // khoá thanh toán
"owner": { "type": "script", "hash": "<56 hex thường>" }   // script — hiện là did_stake của PhoenixKey
"owner": { "type": "did",    "did": "did:…" }              // DID — dịch vụ tự suy Script(did_stake), xem dưới
```

`owner_pkh: "<56 hex>"` vẫn nhận, và nghĩa là đúng `{ "type": "key", "hash": owner_pkh }`.
Gửi cả hai mà chúng chỉ hai chủ khác nhau ⟹ `400 OWNER_ALIAS_MISMATCH`. Hai chủ cùng 28 byte
khác tag là **hai chủ khác nhau**: không vault nào của người này khớp yêu cầu của người kia,
và khoá mềm (§4) cũng tách riêng.

**Chủ script cần nhân chứng.** Validator đòi giao dịch rút từ tài khoản thưởng `Script(h)`.
Dịch vụ không ký và không giữ khoá, nên nó chỉ dựng được mục rút đó khi có đủ hai thứ:

1. cấu hình triển khai có mục `did_stake` (§6) — thiếu ⟹ `501 OWNER_SCRIPT_WITNESS_UNAVAILABLE`;
2. yêu cầu mang `owner_witness` — thiếu ⟹ `400 OWNER_SCRIPT_WITNESS_UNAVAILABLE`:

```jsonc
"owner_witness": {
  "did_stake_script_cbor": "…",          // did_stake ĐÃ apply tham số của DID này
  "anchor_ref": "<tx_hash 64 hex>#<i>",  // UTxO anchor DID, đi vào tx làm reference input
  "controller_pkh": "<56 hex>",
  "device_key_hash": "<56 hex>"
}
```

Script app gửi **không được tin**: dịch vụ băm lại, lệch `owner.hash` ⟹ `400
OWNER_AUTH_MISMATCH`. Anchor phải mang một NFT anchor (tên 32 byte, số lượng 1) dưới
`anchor_nft_policy` của mạng, không ⟹ `400 OWNER_ANCHOR_INVALID`; token shard/cursor của
`taad` cùng policy KHÔNG phải anchor. Thứ tự kiểm: đọc anchor TRƯỚC, so hash SAU — nên một
yêu cầu sai cả hai nhận `OWNER_ANCHOR_INVALID`. Tài khoản thưởng chưa đăng
ký ⟹ `422 OWNER_STAKE_NOT_REGISTERED`. Lượng rút là **đúng số dư thưởng lúc dựng** (ledger
đòi vậy), nên một ranh giới epoch có cộng thưởng xen giữa dựng và nộp làm tx hết hợp lệ —
dựng lại. Validator từ chối tx mang chứng chỉ đăng ký / huỷ đăng ký / uỷ thác cho chính
`Script(h)` — đó là hình dạng tx thu hồi, nên đổi vòng đời stake phải nằm ở tx riêng. Trạng
thái Active của anchor **không** kiểm ở đây: lược đồ datum anchor thuộc repo
danh tính, và `did_stake` từ chối trên chuỗi nếu anchor không Active.

Chủ khoá mà gửi `owner_witness` ⟹ `400 OWNER_WITNESS_UNEXPECTED`.

#### Chủ khai bằng DID: `owner: { "type": "did" }` — app chỉ gửi DID

Mọi hành động MAGIC ký bằng khoá DID PhoenixKey; chủ vault trên chuỗi là `Script(did_stake)`
(`InstantGen/onchain/lib/magiclamp/protocol/owner_auth.ak` ▸ `owner_authorized`). App không phải
tự dựng `owner_witness`:

```jsonc
"owner": { "type": "did", "did": "did:…", "device_key_hash": "<56 hex>" }   // device_key_hash tuỳ chọn
```

Dịch vụ suy, ở ĐẦU mỗi đường dựng và TRƯỚC khi giữ khoá mềm (`src/didOwner.ts` ▸ `DidOwnerResolver`):
tên NFT anchor = `blake2b_256(utf8(did))` · đọc UTxO đang giữ `anchor_nft_policy ‖ tên` · đọc datum
inline như `TAADDatum` 18 trường (PhoenixKey-Validator ▸ `lib/phoenixkey/types.ak` @ `c9050b9`:
`controller_pkh` #2, `status` #5 với Active = constructor 0, `device_pkh` #14, `aux_device_pkhs` #15)
· script = `did_stake` chưa apply (cấu hình, §6) apply `(anchor_nft_policy, tên)`. Kết quả giao cho
CÙNG đường nhân chứng với chủ script tường minh ở trên — mọi phép kiểm sau đó (NFT anchor, tài khoản
thưởng đã đăng ký, `required_signers`) là một đường mã. Một yêu cầu `{type:"did"}` và cùng yêu cầu viết
tường minh ra **cùng `tx_cbor` từng byte** và cùng khoá mềm `script:<hash>` (bài
`tests/didOwner.test.ts` ▸ *TƯƠNG ĐƯƠNG*). Thân trả về: `owner` là `Script(hash)` đã suy,
`summary.owner_did` là DID đã khai, `required_signers` là controller + khoá thiết bị đã chọn.

- `device_key_hash` vắng ⟹ `device_pkh` chính của anchor; có thì phải là `device_pkh` hoặc nằm trong
  `aux_device_pkhs`, không ⟹ `400 OWNER_DEVICE_NOT_LISTED`.
- `did` phải bắt đầu bằng `did:`, chỉ ký tự ASCII in được không khoảng trắng, 5..256 byte ⟹ không thì
  `400 OWNER_DID_SHAPE`. Kèm `owner_witness` hoặc `owner_pkh` ⟹ `400 OWNER_DID_CONFLICT` (hai nguồn cho
  một chủ, chọn một bên là đoán).
- Anchor: không có ⟹ `422 OWNER_ANCHOR_NOT_FOUND`; nhiều hơn một UTxO giữ NFT ⟹ `422
  OWNER_ANCHOR_AMBIGUOUS`; datum không phải Constr đúng 18 trường đúng kiểu ⟹ `422 OWNER_ANCHOR_SCHEMA`
  (lược đồ bên PhoenixKey đổi thì lỗi kêu ở đây, không dựng trên trường đọc nhầm chỗ); không Active ⟹
  `422 OWNER_ANCHOR_NOT_ACTIVE`. Với chủ DID, trạng thái Active **được** kiểm lúc dựng — khác chủ script
  tường minh ở trên.
- Bản deploy không khai `did_stake.unapplied_script` ⟹ `501 OWNER_SCRIPT_WITNESS_UNAVAILABLE`; chủ script
  tường minh vẫn chạy.
- Mọi đường nhận `owner` đều nhận dạng DID: bảy đường `/tx/*`, `/tx/quote` (qua `params`),
  `/tx/create-vault`, và `/tx/sponsor/*` (kể cả `plan`, cần dịch vụ tài trợ bật để suy).

**Điều kiện TRƯỚC khi tạo vault: `did_stake` phải ĐÃ ĐĂNG KÝ làm stake credential.** Genesis cũng gọi
`owner_authorized` (`InstantGen/onchain/validators/vault.ak` ▸ nhánh mint `MintVaultId`, dòng `expect owner_authorized(tx, vd.owner)` của genesis), nên tx tạo
vault đã cần mục rút `Script(h)`, và mục rút chỉ hợp lệ trên tài khoản đã đăng ký. Đăng ký **không gộp
được** vào tx của vault: `owner_auth` từ chối tx mang chứng chỉ vòng đời stake cho chính `Script(h)`,
và ledger xử lý mục rút TRƯỚC chứng chỉ nên một tx "đăng ký + rút" vẫn rút trên tài khoản chưa có.
Đăng ký là một tx riêng do máy chủ PhoenixKey dựng ngay sau genesis DID (cọc do PhoenixKey trả);
chưa đăng ký ⟹ dịch vụ này trả `422 OWNER_STAKE_NOT_REGISTERED` như trước.

**Ai ký.** Dịch vụ không ký gì. App đưa `tx_cbor` cho PhoenixKey ký bằng controller + khoá thiết bị đã
chọn — đúng hai khoá trong `required_signers` của thân trả về.

**Đối chiếu phép suy.** Máy chủ PhoenixKey có `GET /api/v1/identity/{did}/stake-script-hash`, trả hash
`did_stake` ĐÃ apply cho từng DID; nó phải bằng `owner.hash` mà dịch vụ này trả cho cùng DID. Lệch ⟹
`did_stake.unapplied_script` của bản deploy không cùng đời với bên PhoenixKey.

**`change_address`**: chủ khoá bỏ trống thì dịch vụ suy theo chiến lược ở §7 như trước. Chủ
script **bắt buộc** gửi (`400 CHANGE_ADDRESS_REQUIRED`) — một script hash không suy ra được ví
nào. Gửi thì địa chỉ phải đúng mạng và phần thanh toán phải là khoá (`400
CHANGE_ADDRESS_INVALID`): UTxO trả phí + tài sản thế chấp lấy từ đó, nên khoá ấy cũng phải ký.

### `POST /tx/create-vault`

```jsonc
// vào
{
  "kind": "instant" | "schedule",
  "owner": { "type": "key" | "script", "hash": "…" },   // hoặc bí danh owner_pkh
  "owner_witness": { … },                               // chỉ chủ script
  "lamp_amount": "1001000000",                          // CHUỖI oildrop: > 0 két schedule, ≥ 0 két instant
  "did_commit": "<64 hex thường>",                      // chỉ két instant, tuỳ chọn ⟹ wakeme_link của datum genesis
  "change_address": "addr_test1…",                      // ĐÚNG MỘT trong change_address / funding
  "funding": { … },                                     // nạp từ ví Phoenix — xem dưới
  "profile": "Ember" | "Flame" | "Lantern"              // bỏ trống = Flame
}
// ra 200
{
  "tx_cbor": "…", "tx_hash": "…",
  "vault_nft": "<policy><asset_name>",      // NFT danh-tính one-shot, đúc trong chính tx này
  "vault_address": "addr_test1w…",
  "owner": { "type": "…", "hash": "…" },
  "required_signers": ["…"],                // đọc từ tx_cbor
  "witness_notes": ["…"],
  "summary": {
    "requested_intent": "create_vault", "network": "Preview",
    "fee_lovelace": "…", "fee_ada": "…",
    "vault": { "address": "…", "output_index": 0, "nft_unit": "…", "owner": { … },
               "lamp_deposit_oildrop": "…", "lamp_deposit_lamp": "…", "lovelace": "…", "ada": "…",
               "wakeme_link": "" },                // két instant: "" hoặc did_commit đọc lại từ CBOR; két schedule ⟹ null
    "required_signers": ["…"], "outputs": [ … ]
  },
  "expires_at": "…"
}
```

Bộ dựng là `@magiclamp/sdk` ▸ `createVault`, với script vault lấy từ ref-script của bản deploy
(`ref_script_utxos.vault`) và băm lại để so với địa chỉ vault đã cấu hình. `summary` đọc thẳng
output vault trong `tx_cbor`: đúng một output ở địa chỉ vault, mang đúng 1 NFT, NFT được đúc
trong chính tx, trường 0 của datum là `Credential`, `lamp_balance` bằng LAMP trong output. Sau
đó dịch vụ đối chiếu chủ trong datum với `owner` yêu cầu và lượng LAMP với `lamp_amount`; lệch
⟹ `422 TX_SUMMARY_UNDECODABLE`, không phát tx. `kind` không có vault tương ứng trong cấu hình
⟹ lỗi cấu hình, không chọn đại một địa chỉ.

**Két instant của người mới** (chỉ có PersonDID + LAMP mượn ở két Wakeme): `lamp_amount: "0"`
hợp lệ với `kind: "instant"` (két schedule vẫn đòi `> 0`, sai ⟹ `400 LAMP_AMOUNT_INVALID`);
output két khi đó không mang LAMP. `did_commit` (64 hex thường, tuỳ chọn, CHỈ két instant —
gửi cho schedule ⟹ `400 DID_COMMIT_UNEXPECTED`) được ghi vào ô `wakeme_link` của datum genesis,
để két Wakeme của DID đó ghim được két này. `summary.vault.wakeme_link` đọc lại TỪ CBOR (két
schedule ⟹ `null`); lệch `did_commit` ⟹ `422 TX_SUMMARY_UNDECODABLE`.

Trước khi dựng két instant, dịch vụ đọc địa chỉ két: chủ đã có két instant, hoặc (khi gửi
`did_commit`) đã có két nối đúng DID đó ⟹ `409 VAULT_ALREADY_EXISTS` với
`details.existing: [{ vault_ref, vault_nft, matched_by: "owner" | "did_commit" }]`, bộ dựng
không được gọi. Đây là lưới an toàn của DỊCH VỤ (chống bấm hai lần), **không** phải cổng chống
Sybil — `INV-ONE-PERSON-ONE-VAULT` chưa được ép on-chain; tx tạo két vừa nộp mà chưa vào khối thì
phép đọc này không thấy (khoá mềm theo chủ, §4, chặn ca đó ở lúc NỘP: tx tạo két thứ hai, dựng trước
khi tx thứ nhất được nộp, nhận `409 TX_SUPERSEDED`).

#### Nguồn LAMP: `change_address` (đường cũ) hoặc `funding` (ví Phoenix)

Không có `funding` ⟹ hành vi cũ: LAMP, phí và tài sản thế chấp lấy từ UTxO ở `change_address`,
tiền thối về đó.

Có `funding` ⟹ LAMP đến từ ví Phoenix, một địa chỉ **script** `did_payment`. Tài sản thế chấp
không được là UTxO script, nên phí + thế chấp buộc phải từ một ví khoá ký thứ hai (mô hình
bên trả phí):

```jsonc
"funding": {
  "type": "did_payment",
  "did_payment_script_cbor": "<hex>",      // did_payment ĐÃ apply (anchor_nft_policy, blake2b_256(utf8(did)))
  "address": "addr_test1w…",               // ví Phoenix: payment credential = Script(hash của cbor trên)
  "fee_payer": {
    "utxo": "<tx_hash 64 hex>#<i>",        // ĐÚNG MỘT UTxO thuần ADA: trả phí + thế chấp + seed NFT
    "address": "addr_test1v…"              // địa chỉ khoá ký chứa UTxO đó
  },
  // Ba trường dưới: chủ SCRIPT có owner_witness ⟹ bỏ trống, dùng chung bộ của owner_witness
  // (khai thì phải TRÙNG). Chủ KHOÁ ⟹ BẮT BUỘC (did_payment vẫn đòi anchor + hai chữ ký).
  "anchor_ref": "<tx_hash 64 hex>#<i>",
  "controller_pkh": "<56 hex>",
  "device_key_hash": "<56 hex>"
}
```

Vai của từng ví, và dịch vụ ĐỌC LẠI từ `tx_cbor` rằng giao dịch đúng như thế (lệch bất kỳ vế
nào ⟹ `422 FUNDING_TX_MISMATCH`, không phát tx):

| | ví Phoenix (`funding.address`) | ví trả phí (`fee_payer`) |
|---|---|---|
| input | UTxO `did_payment`, mỗi cái redeemer `Spend` = `Constr 0 []` (`d87980`), script đính inline | đúng `fee_payer.utxo` |
| chọn UTxO | tiền tố ngắn nhất của dãy sắp theo LAMP giảm dần đủ LAMP + min-ADA vault + min-ADA phần thối (tối thiểu với riêng vế LAMP; có vế ADA thì là tham lam) | không chọn — chỉ UTxO đã khai |
| trả cho | LAMP + min-ADA của output vault | phí; là tài sản thế chấp |
| tiền thối | LAMP / token khác / ADA còn lại, cộng mục rút `did_stake` nếu chủ là script ⟹ **về `funding.address`**, không bao giờ về ví trả phí | ADA thối + `collateral_return` ⟹ về `fee_payer.address`; ví này góp đúng `phí + thối`, không đồng nào vào vault |
| reference input | anchor DID (Active) | — |
| ký | controller + khoá thiết bị | khoá thanh toán của `fee_payer.address` |

Output nào khác ba địa chỉ vault / `funding.address` / `fee_payer.address` ⟹ `422`. Hạn dùng
(`validTo`) ≤ 1 giờ kể từ đỉnh chuỗi lúc dựng. Dịch vụ **không** gọi dịch vụ trả phí nào — nó
chỉ nhận UTxO của bên trả phí qua tham số.

**`change_address` cùng `funding` ⟹ `400 FUNDING_CHANGE_ADDRESS_CONFLICT`.** Ở đường cũ
`change_address` gánh ba vai (nguồn LAMP, nguồn phí, đích tiền thối); `funding` đã tách ba vai
đó ra hai địa chỉ có tên. Nhận thêm `change_address` là nhận một địa chỉ không có vai nào — chọn
nghĩa cho nó là đoán ý người gọi, và đoán sai là thối tiền về một ví không ai khai.

`summary` có thêm khối `funding` (mọi số là chuỗi):

```jsonc
"funding": {
  "type": "did_payment", "address": "addr_test1w…",
  "did_payment_inputs": ["<tx>#<i>", …],                       // UTxO ví Phoenix bị chi
  "spent":    { "lovelace": "…", "lamp_oildrop": "…", "other_assets": [ … ] },  // tổng chi
  "returned": { "lovelace": "…", "lamp_oildrop": "…", "other_assets": [ … ] },  // thối về ví Phoenix
  "withdrawal_lovelace": "…",                                  // mục rút did_stake (chủ script), đã tính vào phần thối
  "fee_payer": { "address": "…", "utxo": "…", "input_lovelace": "…", "fee_lovelace": "…",
                 "change_lovelace": "…", "collateral_return_lovelace": "…" | null },
  "valid_to_posix_ms": "…"
}
```

**Thứ tự ký.** Mọi chữ ký ký trên hash THÂN giao dịch (`tx_hash`):

1. Dịch vụ dựng; thân giao dịch trả về là bản **chốt**.
2. Ví Phoenix ký bằng controller + khoá thiết bị (và, nếu chủ là khoá, khoá chủ).
3. Bên trả phí ký UTxO của họ bằng khoá thanh toán của `fee_payer.address`.
4. Ghép mọi chứng ký rồi `/tx/submit`.

Bước 2 và 3 đổi chỗ cho nhau được; điều không được là **đổi thân sau khi đã có chữ ký**: đổi
một byte của thân (kể cả để "sửa phí") là đổi `tx_hash`, và mọi chữ ký đã có mất hiệu lực —
phải dựng lại, không vá.

#### Ví Phoenix tự trả phí: `funding.fee_source = "did_payment"` (opt-in)

`fee_source` vắng hoặc `"fee_payer"` ⟹ đúng như trên. `"did_payment"` ⟹ ví Phoenix trả **mọi
thứ** — LAMP, min-ADA của vault và **phí**; tiền thối về `funding.address`. Ví khoá của người
dùng chỉ **đứng thế chấp** (ledger cấm thế chấp là UTxO script, nên vẫn cần một ví khoá ký):

```jsonc
"funding": {
  "type": "did_payment",
  "did_payment_script_cbor": "<hex>",
  "address": "addr_test1w…",
  "fee_source": "did_payment",
  "collateral": {
    "utxo": "<tx_hash 64 hex>#<i>",        // ĐÚNG MỘT UTxO thuần ADA, không script tham chiếu: CHỈ làm thế chấp
    "address": "addr_test1v…"              // địa chỉ KHOÁ chứa UTxO đó; nhận collateral_return
  },
  "anchor_ref": "…", "controller_pkh": "…", "device_key_hash": "…"   // như trên
}
```

Hai chế độ loại trừ nhau về TRƯỜNG: `fee_source: "did_payment"` kèm `fee_payer`, hoặc chế độ
mặc định kèm `collateral` ⟹ `400 FUNDING_SHAPE` (một trường không có vai là dấu người gọi đang
tưởng mình ở chế độ kia). `fee_source` khác hai giá trị trên ⟹ `400 FUNDING_SHAPE`.
`collateral.address` không phải khoá / sai mạng, hoặc UTxO không ở đó / không thuần ADA ⟹
`400 FUNDING_COLLATERAL_INVALID`.

| | ví Phoenix (`funding.address`) | ví thế chấp (`collateral`) |
|---|---|---|
| input | UTxO `did_payment` đã chọn — **không input nào khác** | không input tiêu nào; chỉ `collateral_inputs` = `collateral.utxo` |
| seed NFT két | tên NFT = `blake2b_256(cbor(seed))` với seed là **một UTxO did_payment bị chi** | — |
| trả cho | LAMP + min-ADA vault + phí | không đồng nào (trừ khi script thất bại: mất phần thế chấp) |
| tiền thối | mọi phần dư ⟹ về `funding.address` | chỉ `collateral_return`; **không output nào** về ví này |
| ký | controller + khoá thiết bị | khoá thanh toán của `collateral.address` (input thế chấp đòi chữ ký) |

Phép đọc lại CBOR của chế độ này (`funding.ts` ▸ `checkSelfFundedTx`) ném `422
FUNDING_TX_MISMATCH` khi: có input ngoài tập did_payment đã biết (kể cả UTxO của ví thế chấp) ·
tên NFT két không băm từ đúng một input did_payment · thế chấp không phải `collateral.utxo` hoặc
`collateral_return` không về `collateral.address` hoặc lượng có thể mất vượt
`fee_payer_collateral_lovelace` · có output về ví thế chấp hay địa chỉ lạ · bảo toàn lệch
(`did_payment chi + mục rút = vault (trừ NFT) + thối + phí`) · thiếu chữ ký controller/thiết bị ·
hạn dùng quá 1 giờ.

`summary.funding` ở chế độ này KHÔNG có khối `fee_payer`; thay bằng:

```jsonc
"self_funded": {
  "fee_source": "did_payment",
  "seed_utxo": "<tx>#<i>",                  // một phần tử của did_payment_inputs
  "fee_lovelace": "…",                      // phí đọc từ CBOR, trả từ ví Phoenix
  "collateral": { "address": "…", "utxo": "…",
                  "collateral_at_risk_lovelace": "…",       // Σ collateral_inputs − collateral_return
                  "collateral_return_lovelace": "…" | null }
}
```

**Giới hạn của Lucid Evolution 0.4.30 — vì sao bộ dựng đi hai lượt.** `complete()` dùng MỘT địa
chỉ cho cả tiền thối lẫn `collateral_return`. Đặt nó là `funding.address` thì thối đúng chỗ nhưng
`collateral_return` rơi vào ví Phoenix; đặt là ví thế chấp thì phần dư bị thối sang ví thế chấp.
Nên SDK (`MagicSDK/src/createVault.ts` ▸ `completeSelfFunded`) dựng hai lượt, cả hai không tự chọn
coin và chỉ cho lucid thấy đúng `collateral.utxo`: lượt ĐO với địa chỉ thối = ví Phoenix để lấy
phí, rồi lượt THẬT với địa chỉ thối = ví thế chấp và output thối về ví Phoenix ghi TƯỜNG MINH =
phần dư − phí đo (bù chênh độ dài địa chỉ; hụt vài byte thì cộng dần, tối đa 4 lượt). Hình dạng
cuối được SDK đọc lại (`assertSelfFundedShape`) rồi dịch vụ đọc lại lần nữa (`checkSelfFundedTx`).
Việc CHỌN UTxO did_payment giữ chỗ phí bằng `DID_PAYMENT_FEE_HEADROOM_LOVELACE` (3 ADA — biên an
toàn, không phải số đo); phí đo vượt phần giữ chỗ ⟹ `422 FUNDING_INSUFFICIENT`.

`/tx/quote` không áp cho chế độ này (không có ví trả phí nào để báo giá) ⟹ `400
FEE_QUOTE_SELF_FUNDED`; phí thật nằm ở `summary.funding.self_funded.fee_lovelace`.

### Ví trả phí bên thứ ba: `fee_payer`

Năm đường dựng trên vault có sẵn (`instant-gen`, `refresh-checkpoint`, `schedule-commit`,
`schedule-fire`, `consume`) nhận `fee_payer` thay cho `change_address`:

```jsonc
"fee_payer": {
  "utxo": "<tx_hash 64 hex>#<i>",   // ĐÚNG MỘT UTxO thuần ADA của ví trả phí
  "address": "addr_test1v…"         // địa chỉ khoá ký chứa UTxO đó
}
```

UTxO đó trả phí và làm tài sản thế chấp; tiền thối ADA và `collateral_return` về đúng
`fee_payer.address`. Lượng thế chấp đặt **tường minh** bằng `fee_payer_collateral_lovelace`
của cấu hình (§6), và cũng là trần mà phép đọc lại ép lên phần thế chấp có thể mất. Dịch vụ
đọc lại `tx_cbor` (input, output, thế chấp, hạn dùng) và trả `summary.fee_payer`; lệch ⟹
`422 FEE_PAYER_TX_MISMATCH`, không phát tx. Ví trả phí chỉ được mất đúng bằng phí.

- `fee_payer` cùng `change_address` ⟹ `400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT`.
- `/tx/create-vault` nhận ví trả phí qua `funding.fee_payer`, không qua `fee_payer` ở gốc
  thân bài ⟹ `400 FEE_PAYER_UNSUPPORTED`.
- `/tx/open-thread` khoá min-ADA vào output thread, mà ví trả phí chỉ được mất đúng bằng phí
  ⟹ `fee_payer` một mình trả `422 FEE_PAYER_DEPOSIT_UNSOURCED`; gửi `change_address`.
- `/tx/bind-did` chưa nhận `fee_payer` ⟹ `501 BIND_DID_FEE_PAYER_UNSUPPORTED` (bộ dựng BindDID
  chưa đặt hạn dùng mà luật ví trả phí đòi); gửi `change_address` hoặc bỏ trống với chủ khoá.

**Ví trả phí không nhất thiết là Feecover.** Một UTxO thuần ADA trên **địa chỉ khoá của chính
chủ** dùng được làm `fee_payer` (hoặc `funding.fee_payer`), cùng luật như trên. Khi đó không cần
Feecover: app tự ký phần ví trả phí bằng khoá của chủ, **không** gọi `/fee/sign` (đường đó xin
Feecover ký cho một UTxO không phải của Feecover).
`POST /tx/quote` báo trước UTxO của chủ có đủ không (`owner_address.available`) và chọn sẵn
UTxO đó (`owner_address.fee_payer`).

### Báo giá phí: `POST /tx/quote`

```jsonc
// vào
{ "route": "consume",                       // một trong tám đường dựng
  "params": { "owner_pkh": "…", "op_type": 1, "op_count": "2" },   // đúng thân bài của đường đó,
                                                                   // KHÔNG kèm fee_payer / funding.fee_payer
  "owner_fee_addresses": ["addr_test1v…", "addr_test1q…"] }        // tuỳ chọn: 1..10 địa chỉ khoá của chủ
// ra (số minh hoạ)
{ "feecover":      { "fee_lovelace": "175016", "available": true },
  "owner_address": { "fee_lovelace": "172552", "available": true, "needed_lovelace": "3969750",
                     "collateral_lovelace": "3000000",
                     "fee_payer": { "utxo": "0e0e…0e#2", "address": "addr_test1v…" } },
  "valid_until": "2026-09-27T10:03:00.000Z" }
```

**Route `instant-gen`: báo giá được khi chưa biết `m`.** `params.m` vắng hoặc `"0"` ⟹ báo giá
dựng tại `m = max_m` (trần còn lại của epoch, tính như đường dựng thật). Phản hồi của route này
có thêm khối `summary`, lấy từ lượt dựng đầu:

```jsonc
"summary": {
  "m_nanogic": "4000000",        // lượng đúc đọc lại TỪ CBOR của lượt dựng báo giá
  "m_source": "max_m",           // "max_m" = người gọi không gửi m; "request" = m người gọi gửi
  "gen_limits": { "max_m_nanogic": "…", "remaining_after_nanogic": "…", … }   // y khối gen_limits ở trên
}
```

`max_m = 0` mà không gửi `m` ⟹ `422 INSTANT_GEN_MAX_M_ZERO` (kèm trần trong `details`): không có
`m > 0` nào dựng được, và báo giá trên một `m` bịa là con số phí cho một giao dịch không tồn tại.

Dịch vụ chạy **đúng đường dựng** của `route` với `params` cộng một `fee_payer` do nó chèn, rồi
đọc phí lại **từ CBOR** như `summary`. Báo giá **không** giữ khoá của chủ, **không** giữ chỗ
UTxO nào, **không** ghi sổ phát-hành (tx của báo giá không nộp được, không xin ký được),
**không** xin Feecover UTxO hay chữ ký — không `/v1/utxo`, không `/v1/sign`, nên hỏi giá không
làm cạn kho UTxO của Feecover. Lượt gọi Feecover duy nhất là câu hỏi `GET /v1/fee-sources`
(dưới đây), vốn không giữ chỗ.

- **`feecover`** — dựng trên một UTxO **tổng hợp** (không có trên chuỗi; lucid đánh giá script
  cục bộ từ UTxO được đưa). `fee_lovelace` là **ước lượng chặn trên**: UTxO tổng hợp lấy địa chỉ
  base (dài hơn enterprise), lượng và chỉ số output có mã hoá rộng nhất, khoá khác khoá chủ. Đo
  (lucid 0.4.30): cao hơn phí thật trên một ví enterprise chỉ số nhỏ tối đa 3 168 lovelace, không
  thấp hơn theo các trục đó (trục chưa ghim: địa chỉ con trỏ); số đo + cách đo lại ở khối chú thích `SYNTH_*` trong `src/feeQuote.ts`.
  - **Nguồn của `available`: chính Feecover.** Dịch vụ tra mục đích của `route` trong bảng
    `feecover.apps.magic.purposes` (cùng bảng `/fee/utxo` dùng), rồi hỏi
    `GET <feecover.url>/v1/fee-sources?purpose=<mục đích>` với `Authorization: Bearer
    <FEECOVER_APP_TOKEN>`, hết giờ `min(feecover.timeout_ms, FEE_SOURCES_TIMEOUT_MS = 3 000 ms)`.
    Câu trả lời `{ purpose, feecover: { available, rule?, message? } }` được chuyển **nguyên**:
    `available`, và `rule` / `message` khi Feecover gửi. Feecover không giữ chỗ UTxO cho câu hỏi
    này. Lượt dựng đầu chạy trước: `params` hỏng thì Feecover không bị hỏi.
  - **Fail-closed:** `available=true` **chỉ** khi Feecover trả 200, đúng hình dạng, đúng mục đích
    đã hỏi, và `feecover.available === true`. Mọi lối khác là `available=false` kèm `reason`:

    | `reason` | khi nào | trường kèm |
    |---|---|---|
    | `FEE_QUOTE_FEECOVER_DECLINED` | Feecover trả lời `available: false` (ví dụ `rule: "L14"`, cửa sổ Catalyst) | `rule`, `message` nếu Feecover gửi |
    | `FEE_QUOTE_FEECOVER_UNCONFIGURED` | bản deploy không khai `feecover` | — |
    | `FEE_QUOTE_FEECOVER_NO_DEFAULT_APP` | không có ứng dụng mặc định `magic` | — |
    | `FEE_QUOTE_FEECOVER_TOKEN_ABSENT` | có ứng dụng `magic` nhưng dịch vụ không cầm token của nó | — |
    | `FEE_QUOTE_FEECOVER_PURPOSE_UNMAPPED` | ứng dụng `magic` chưa có mục đích cho `route` | — |
    | `FEE_QUOTE_FEECOVER_PURPOSE_FOREIGN` | mục đích mang tiền tố của ứng dụng khác | — |
    | `FEE_QUOTE_FEECOVER_TIMEOUT` | Feecover không trả lời trong hạn | — |
    | `FEE_QUOTE_FEECOVER_UNREACHABLE` | không gọi được (DNS, TCP, TLS…) — câu lỗi thư viện không chuyển | — |
    | `FEE_QUOTE_FEECOVER_HTTP_STATUS` | Feecover trả mã khác 200 | `upstream_status`; với 4xx thêm `rule`, `message` nếu có |
    | `FEE_QUOTE_FEECOVER_BAD_RESPONSE` | 200 nhưng thân không phải JSON, thiếu/sai kiểu `feecover.available`, `rule`/`message` không phải chuỗi, hoặc `purpose` khác mục đích đã hỏi | — |

    Năm lý do cấu hình (`UNCONFIGURED` tới `PURPOSE_FOREIGN`) quyết tại chỗ, Feecover **không**
    bị hỏi.
    Token không đi vào phản hồi: một `rule`/`message` của Feecover chứa token thì câu trả lời 200
    bị coi là `BAD_RESPONSE`, còn ở 4xx thì hai trường đó bị bỏ.
  - Phí vẫn có khi `available=false`.
- **`owner_address`** — nguồn trả phí là **ví khoá của chính chủ**.
  - `needed_lovelace` là lượng tối thiểu một UTxO thuần ADA phải có để tx dựng được với nó làm
    `fee_payer`: `max(phí, thế chấp) + min-ADA`, suy từ cách lucid chọn input trả phí và thế chấp
    trên cùng một UTxO (không cộng dồn phí với thế chấp: hai khoản không bị thu cùng lúc). Mỗi
    địa chỉ có ngưỡng riêng (phí phụ thuộc độ dài địa chỉ), tính bằng một lượt dựng tổng hợp ở
    đúng địa chỉ đó.
  - `collateral_lovelace` **luôn có**: trần thế chấp bản deploy đặt cho ví trả phí
    (`VAULT_TX_API_DEPLOYMENT.fee_payer_collateral_lovelace`) — khoản UTxO trả phí mất nếu script chết ở
    pha 2. Là cấu hình, không đọc từ tx.
  - `owner_fee_addresses`: mảng 1..10 địa chỉ, không trùng, mỗi phần tử phải là địa chỉ khoá
    đúng mạng. Dịch vụ đọc UTxO ở mọi địa chỉ (chỉ đọc) rồi **chọn** theo quy tắc:
    1. chỉ UTxO **thuần ADA, không script tham chiếu** — UTxO mang token bị bỏ qua dù lớn đến đâu;
    2. chỉ UTxO có lovelace ≥ `needed_lovelace` **của chính địa chỉ chứa nó**;
    3. chọn UTxO **nhỏ nhất** còn lại (giữ UTxO lớn cho việc khác);
    4. hoà lovelace ⟹ địa chỉ đứng trước trong mảng; cùng địa chỉ ⟹ `tx_hash` nhỏ hơn, rồi chỉ số
       output nhỏ hơn (so theo **số**: `#9` trước `#10`).
  - Chọn được ⟹ `available=true`, `fee_lovelace` là phí của lượt dựng với chính UTxO đó, và
    `fee_payer` = `{ "utxo": "<tx_hash>#<i>", "address": "<địa chỉ chứa UTxO>" }` — đúng hình dạng
    thân `fee_payer` của đường dựng, app chép thẳng. `fee_payer` **chỉ có** khi `available=true`.
  - Không chọn được ⟹ `available=false`, không `fee_payer`; `fee_lovelace` và `needed_lovelace` là
    số **lớn nhất** qua mọi địa chỉ (một UTxO thuần ADA cỡ đó gửi tới địa chỉ nào trong mảng cũng
    đủ). Lý do: `FEE_QUOTE_OWNER_ADDRESSES_ABSENT` (không gửi mảng, hoặc mảng rỗng — hai con số là
    của ví tổng hợp, một ước lượng), `FEE_QUOTE_OWNER_NO_ADA_UTXO` (không địa chỉ nào có UTxO thuần
    ADA), `FEE_QUOTE_OWNER_INSUFFICIENT` (có UTxO thuần ADA nhưng không cái nào đủ ngưỡng).
  - Dùng UTxO đó làm `fee_payer`: app **tự ký** phần ví trả phí bằng khoá của chủ, **không** gọi
    `/fee/sign`. Báo giá không giữ chỗ UTxO: giữa lúc hỏi và lúc dựng, UTxO có thể đã bị tiêu.
- **`valid_until`** — hạn ngắn nhất giữa hạn dùng (`validTo`) của tx trong CBOR và `expires_at`
  mà đường dựng trả, qua mọi lượt dựng của lần hỏi. Báo giá không sống lâu hơn tx nó mô tả.

**Phí thật luôn là `summary.fee_payer.fee_lovelace`** (hoặc `summary.funding.fee_payer.fee_lovelace`)
của lượt dựng thật — chuỗi thay đổi giữa lúc hỏi giá và lúc dựng thì hai số lệch nhau.

Lỗi của thân báo giá mang mã `FEE_QUOTE_*`; lỗi của `params` (vault không có, số JSON cho trường
tiền, …) mang **đúng mã** mà đường dựng trả. Hai ca đặc biệt:
- `/tx/create-vault` chỉ báo giá được khi `params` có `funding` (đường duy nhất có ví trả phí);
  vắng ⟹ `400 FEE_QUOTE_FUNDING_REQUIRED`.
- `/tx/open-thread` không nhận ví trả phí (xem trên) ⟹ báo giá trả đúng `422
  FEE_PAYER_DEPOSIT_UNSOURCED` của đường đó.
- `/tx/bind-did` chưa nhận ví trả phí ⟹ báo giá trả đúng `501 BIND_DID_FEE_PAYER_UNSUPPORTED`.

### Thread Engage: chọn theo chủ, `engage_ref`, `POST /tx/open-thread`

`/tx/consume` cần thread Engage của **chính chủ** (validator `consume` ép chủ thread == chủ
vault). Dịch vụ tìm thread theo chủ ở địa chỉ `consume.engage_address`, với policy NFT thread
= script hash của `consume` (suy từ địa chỉ, không cấu hình riêng).

- Chủ chưa có thread ⟹ `404 ENGAGE_THREAD_NOT_FOUND` — mở bằng `POST /tx/open-thread`.
- Chủ có nhiều thread ⟹ `409 ENGAGE_THREAD_AMBIGUOUS`; gửi `"engage_ref": "<tx_hash>#<i>"`
  để chỉ đích danh. `engage_ref` không phải thread của chủ ⟹ `400 ENGAGE_REF_MISMATCH`.

`POST /tx/open-thread` dựng giao dịch đúc NFT thread và tạo output thread genesis cho chủ.
Chủ đã có thread ⟹ `409 ENGAGE_THREAD_EXISTS`. Dịch vụ đọc lại NFT, output và datum genesis
từ `tx_cbor` (lệch ⟹ `422 OPEN_THREAD_TX_MISMATCH`). Lời đáp:

```jsonc
{
  "tx_cbor": "…", "tx_hash": "…",
  "engage_nft": "<policy 56 hex><tên>", "engage_address": "addr_test1w…",
  "owner": { "type": "key", "hash": "…" },
  "required_signers": ["…"], "witness_notes": ["…"], "summary": { … }, "expires_at": "…"
}
```

`funding` ở đường này chưa hỗ trợ ⟹ `501 OPEN_THREAD_FUNDING_UNSUPPORTED`.

### Gắn DID vào thread: `POST /tx/bind-did`

Dựng giao dịch `BindDID` (redeemer `Constr 1 []` của `consume`) trên thread Engage của chủ, bằng
`@magiclamp/consumemagic` ▸ `buildBindDidTx`. Script `consume` đọc qua ref CIP-33 ở
`ref_script_utxos.consume`, như `/tx/consume`. Một chiều, đúng một lần: đã gắn thì không đổi được,
kể cả ghi lại chính giá trị cũ.

```jsonc
// vào
{ "owner": { "type": "key", "hash": "<56 hex>" },   // hoặc "owner_pkh"
  "did_commit": "<ĐÚNG 64 ký tự hex thường — 32 byte>",
  "change_address": "addr_test1v…",                 // tuỳ chọn với chủ khoá (§7); chủ script phải gửi
  "engage_ref": "<tx_hash>#<i>",                    // tuỳ chọn: chỉ khi chủ có nhiều thread
  "owner_witness": { … } }                          // chỉ chủ script
// ra
{
  "tx_cbor": "…", "tx_hash": "…",
  "engage_nft": "<policy 56 hex><tên>", "engage_address": "addr_test1w…",
  "owner": { "type": "key", "hash": "…" },
  "did_commit": "<64 hex — đọc lại từ datum output trong tx_cbor>",
  "required_signers": ["…"], "witness_notes": ["…"], "expires_at": "…",
  "summary": {
    "requested_intent": "bind_did", "network": "Preview", "fee_lovelace": "…",
    "engage": { "nft_unit": "…", "address": "…", "input_ref": "<tx_hash>#<i>", "output_index": 0,
                "lovelace": "…", "owner": { … }, "consumed_count": "…", "last_epoch": "…",
                "consumed_nanogic": "…", "did_commit_before": "", "did_commit": "…" },
    "required_signers": ["…"]
  }
}
```

| tình huống | mã |
|---|---|
| `did_commit` vắng / rỗng / không đúng 64 ký tự / không phải hex thường | `400 DID_COMMIT_INVALID` |
| chủ chưa có thread | `404 ENGAGE_THREAD_NOT_FOUND` |
| chủ có nhiều thread, không kèm `engage_ref` | `409 ENGAGE_THREAD_AMBIGUOUS` |
| thread đã gắn DID | `409 DID_ALREADY_BOUND` — `details.did_commit` = giá trị đang trên chuỗi, kèm `engage_ref`, `engage_nft` |
| tx vừa dựng lệch (redeemer · value thread · datum · chữ ký chủ) | `422 BIND_DID_TX_MISMATCH` |
| kèm `fee_payer` | `501 BIND_DID_FEE_PAYER_UNSUPPORTED` |

Dịch vụ đọc lại `tx_cbor` trước khi trả: thread là input với redeemer đúng `BindDID`; không đúc/đốt
gì dưới policy consume; đúng một output ở địa chỉ engage, mang NFT thread, value BẰNG tuyệt đối value
thread đầu vào; datum giữ nguyên chủ + ba trục kế toán, chỉ `did_commit` đổi sang đúng giá trị yêu
cầu; chủ khoá nằm trong `required_signers`. Validator đòi chữ ký của CHÍNH chủ — không có đường ký
thay (`personal_delegate`) như `/tx/consume`.

Khoá mềm theo chủ (§4): hai lượt gắn DID — hoặc gắn DID và tiêu MAGIC — cho cùng chủ trước khi nộp
đều dựng được; lượt NỘP sau của tx dựng trước ⟹ `409 TX_SUPERSEDED`.

### Proxy phí Feecover: `POST /fee/utxo`, `POST /fee/sign`

Feecover là dịch vụ ký phần ví trả phí của giao dịch, theo **mục đích**, và nhận ra ứng
dụng gọi bằng token. Token nằm trong app di động là token công khai, nên token của ứng dụng
`magic` chỉ nằm ở dịch vụ này (`FEECOVER_APP_TOKEN`); app đi qua hai đường proxy. Cả hai vẫn
đòi thẻ bài của dịch vụ (`Authorization: Bearer …`) như mọi đường khác.

**`POST /fee/utxo {route}`** — `route` là tên đường dựng sẽ dùng (`"consume"`,
`"create-vault"`…). Dịch vụ tra mục đích theo bảng của ứng dụng, gọi `GET /v1/utxo` của
Feecover, và trả đúng hình dạng mà `fee_payer` / `funding.fee_payer` nhận — app chép thẳng:

```jsonc
{
  "fee_payer": { "utxo": "<tx_hash>#<i>", "address": "addr_test1v…" },
  "reserved_until": "2026-09-26T12:10:00.000Z",   // Feecover giữ UTxO này cho ứng dụng tới mốc đó
  "purpose": "consume_magic"
}
```

**`POST /fee/sign {tx_cbor}`** — chỉ cho giao dịch **chính dịch vụ này đã phát**, có ví trả
phí, và còn hạn ký. App **không** gửi `purpose` hay `ref`: dịch vụ lấy route (⟹ mục đích) và
mã ghi sổ từ sổ phát-hành của mình, nên app không giả được cả hai. Mã ghi sổ (`ref`) gửi
Feecover: `create-vault` ⟹ tên NFT vault (64 hex cuối `vault_nft`); `open-thread` ⟹ tên NFT
thread; route khác ⟹ hash thân tx. Lời đáp:

```jsonc
{ "tx_hash": "…", "witness_set": "<CBOR hex>", "net_lovelace": "…", "fee_lovelace": "…" }
```

`witness_set` là bộ chứng ký của ví trả phí. Dịch vụ đối chiếu `txHash` Feecover trả với hash
thân tự tính; lệch ⟹ `502 FEE_PROXY_UPSTREAM_MISMATCH`, không trả chữ ký.

**Hạn ký.** UTxO lấy qua `/fee/utxo` thì tx tiêu nó chỉ xin ký được tới `reserved_until`; sau
mốc đó ⟹ `403 FEE_PROXY_TX_NOT_ISSUED` (Feecover có thể đã giao UTxO cho người khác) — xin
UTxO mới và dựng lại. `fee_payer` app tự đưa (không qua `/fee/utxo`) thì hạn ký là hạn của sổ
phát-hành.

**Ứng dụng khác `magic`.** Không gửi tiêu đề `X-Feecover-Token` ⟹ đi dưới ứng dụng `magic`.
Ứng dụng khác (ví dụ `orilife`) gửi token Feecover **của chính họ** ở `X-Feecover-Token`;
dịch vụ băm SHA-256, tra ra ứng dụng khai `token_sha256` đó, dùng bảng mục đích của ứng dụng
đó và chuyển tiếp đúng token người gọi gửi (không lưu, không ghi nhật ký). Mục đích mang tiền
tố `<app>_` chỉ đi với đúng ứng dụng `<app>`, và ứng dụng khác `magic` chỉ dùng mục đích tiền
tố tên mình; vi phạm ⟹ `403 FEE_PROXY_APP_PURPOSE`. Token không khớp ứng dụng nào ⟹ `401
FEE_PROXY_APP_UNKNOWN`, Feecover không bị gọi.

**Lời từ chối của Feecover** (4xx) đi ra nguyên mã trạng thái dưới `FEE_PROXY_REJECTED`, với
`details` = `{ upstream_status, rule?, message?, reasons? }` — ví dụ `422` kèm `rule: "L12"`,
`403 rule: "L14"` (ứng dụng bị chặn trong cửa sổ Catalyst), `429` (hết suất giữ chỗ), `409`
(UTxO đang giữ cho ứng dụng khác), `400`. Feecover không trả lời trong hạn chót, trả 5xx, trả
thân sai hình dạng, hoặc trả **`401`/`404`** (token của DỊCH VỤ với Feecover hỏng, đường sai —
lỗi cấu hình phía dịch vụ, chuyển nguyên thì app đọc `401` thành "token của app sai") ⟹
`502 FEE_PROXY_UPSTREAM`, `details.upstream_status` giữ mã gốc. Chuỗi nào trong
`rule`/`message`/`reasons` chứa token của dịch vụ thì bị bỏ, không đi ra app.

### Luồng cho app dùng ví PhoenixKey

1. `POST /fee/utxo {"route": "consume"}` ⟹ `fee_payer`, `reserved_until`.
2. Gọi đường dựng với đúng `fee_payer` đó (`/tx/consume` … `"fee_payer": {…}`; với
   `/tx/create-vault` đặt vào `funding.fee_payer`) ⟹ `tx_cbor`, `tx_hash`.
3. App ký phần của chủ trên `tx_hash` (khoá chủ, hoặc controller + khoá thiết bị của ví
   Phoenix) ⟹ bộ chứng ký của chủ.
4. `POST /fee/sign {"tx_cbor": …}` ⟹ `witness_set` của ví trả phí. Bước 3 và 4 đổi chỗ được;
   cả hai phải xong trước `reserved_until`.
5. Ghép hai bộ chứng ký thành một `TransactionWitnessSet`, rồi
   `POST /tx/submit {"tx_cbor": …, "witness_cbor": …}`.

Không bước nào được đổi thân giao dịch: đổi một byte là đổi `tx_hash`, và mọi chữ ký đã có
mất hiệu lực — dựng lại, không vá.

### Route tài trợ consume đầu: `POST /tx/sponsor/*`

Người mới chưa có CARP vẫn làm được lượt consume đầu: bên tài trợ góp CARP vào một quỹ
`paid_fund` đã ghim, két Prepaid của người mới rút MAGIC từ hạn mức đó rồi tiêu ngay trong cùng
kỳ. Chỉ chạy trên bản deploy có khối két Prepaid (§6, khối `paid_fund` kèm `carp_unit`) và trên
mạng có gốc kỳ (Preprod, Mainnet); Preview ⟹ `501 SPONSOR_NETWORK_UNSUPPORTED`.

**Ai được tài trợ, bao nhiêu lần, KHÔNG do dịch vụ này quyết.** Feecover vận hành chính sách
tài trợ và đếm **một lần mỗi DID**, theo anchor DID mà T2 mang ở `reference_inputs`. Dịch vụ chỉ
dựng hình dạng giao dịch; nó không giữ sổ đếm nào. (Chặn két thứ hai ở T1 —
`409 VAULT_ALREADY_EXISTS` — là lưới an toàn cho thao tác bấm lặp, không phải chính sách.)

| đường | bước | dựng gì | ai ký (theo thứ tự) |
|---|---|---|---|
| `/tx/sponsor/plan` | — | kế hoạch thuần: ai ký bước nào, đường của bước; không chạm chuỗi | — |
| `/tx/sponsor/t1-open` | T1 | đúc két Prepaid + thread consume trong MỘT tx; `did_commit` ghi vào **thread** (két genesis giữ `did_commit` rỗng) | ví trả phí · chủ |
| `/tx/sponsor/t2-fund` | T2 | `PrepaidLock` + `FundLock`: CARP từ UTxO bên tài trợ vào quỹ đã ghim, thối về bên tài trợ; anchor DID ở `reference_inputs` | ví trả phí · **bên tài trợ** · chủ |
| `/tx/sponsor/t3-draw` | T3 | `PrepaidDraw` ⟹ một lô MAGIC sống đúng kỳ hiện tại | ví trả phí · chủ |
| `/tx/sponsor/t4-first-consume` | T4 | consume đầu + `BurnBatch` trên két Prepaid | ví trả phí · chủ |

Nguồn bảng đường → bước: `src/sponsor.ts` ▸ `SPONSOR_STEP_OF_PATH`. Vai ký đọc ở mảng `signers`
của từng đáp ứng; `required_signers` đọc từ chính CBOR vừa dựng. Ví trả phí và bên tài trợ ký
vì tx chi UTxO khoá của họ — chúng **không** nằm trong `required_signers`; chủ khoá thì có.

**Ràng buộc cùng kỳ.** Lô MAGIC Prepaid chỉ sống đúng kỳ rút. T3 trả `summary.epoch` và
`summary.epoch_end_ms` (biên kỳ sau, POSIX mili-giây). T4 — và genesis Wakeme nếu app làm tiếp
— phải vào khối **trước** `epoch_end_ms`. T4 gửi `draw_epoch` = đúng `summary.epoch` của T3;
lệch kỳ hiện tại ⟹ `409 SPONSOR_EPOCH_MISMATCH`, không dựng gì.

**Thân yêu cầu.** Mọi bước nhận `owner` (+ `owner_witness` nếu chủ là script) và ĐÚNG MỘT trong
hai cách trả phí — gửi cả hai ⟹ `400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT`. Tiền là chuỗi chữ số.

- `change_address` = địa chỉ KHOÁ của ví trả phí; bộ dựng chọn UTxO tự do trong ví đó (chủ
  script bắt buộc gửi một trong hai cách).
- `fee_payer` (Feecover) — cùng hình dạng với mục "Ví trả phí bên thứ ba" ở trên, đặt ở **gốc**
  thân bài; `funding` ở route này ⟹ `400 SPONSOR_REQUEST_SHAPE`:

  ```jsonc
  "fee_payer": { "utxo": "<tx_hash>#<i>", "address": "addr_test1v…" }
  ```

  Dịch vụ chi ĐÚNG UTxO đó (thuần ADA), dùng nó làm tài sản thế chấp DUY NHẤT với lượng
  `fee_payer_collateral_lovelace` của cấu hình, đặt hạn dùng ≤ 1 giờ (T2/T3 vẫn theo cửa sổ
  10 phút của kỳ), và trả mọi tiền thối ADA về `fee_payer.address`. Chủ **không** góp lovelace
  nào: người mới 0 ADA đi trọn T1→T4 (bài `tests/sponsorEmulator.test.ts` ▸ hành trình
  `fee_payer`, ví chủ còn 0 UTxO sau T4). Khác các route ở trên, **ở đây ví trả phí ỨNG
  min-ADA** cho output két + thread ở T1 — vì người mới không có ADA, không ai khác trả được;
  T2–T4 ứng phần min-ADA tăng thêm ở output của luồng (datum két lớn lên, output quỹ ở T2) —
  `fronted_lovelace` = Σ lovelace output địa chỉ luồng − Σ lovelace input địa chỉ luồng.

  Phép đọc lại CBOR (`src/sponsor.ts` ▸ `checkSponsorFeePayerTx`) chạy sau mỗi lượt dựng, lệch ⟹
  `422 FEE_PAYER_TX_MISMATCH`, không trả tx:
  1. input = UTxO trả phí + UTxO ở các địa chỉ của luồng (T1: két, thread · T2: két, quỹ, bên
     tài trợ · T3: két · T4: két, thread). Không input nào khác của khoá ví trả phí.
  2. thế chấp đúng UTxO đó, phần có thể mất ≤ lượng cấu hình (luật chung `checkCollateral`).
  3. output về ví trả phí chỉ mang ADA; không output nào ra ngoài ví trả phí + địa chỉ luồng.
  4. bên tài trợ (T2) nhận lại ĐÚNG số lovelace nó góp (phần CARP do các ghim T2 kiểm) — ví trả
     phí không chảy ADA sang đó, bên tài trợ không trả phí; `fee_in = phí + thối + phần ứng`, và
     phần ứng ≥ 0.
  5. hạn dùng ≤ 1 giờ (luật chung `checkValidTo`).

  `summary.fee_payer` trả: `address`, `utxo`, `input_lovelace`, `fee_lovelace`,
  `change_lovelace`, `fronted_lovelace` (min-ADA đã ứng), `collateral_at_risk_lovelace`,
  `collateral_return_lovelace`, `valid_to_posix_ms`. UTxO trả phí mang khoá `utxo:<ref>`: một lượt khác dựng lại trên cùng UTxO
  vẫn dựng được và THAY lượt cũ; nộp tx cũ sau khi tx mới đã nộp ⟹ `409 TX_SUPERSEDED` (§4).

**Vai ký không đổi theo cách trả phí.** Mảng `signers` vẫn mang vai `fee-wallet` (khoá thanh toán
của `fee_payer.address`, hoặc của `change_address`), rồi `sponsor` (chỉ T2), rồi `owner`. Ví trả
phí ký vì tx chi UTxO của nó; nó không vào `required_signers`.

| bước | trường riêng |
|---|---|
| T1 | `did_commit` (64 hex thường), `thread_lovelace` (tuỳ chọn) |
| T2 | `fund_id`, `carp_amount`, `sponsor: { utxo_refs: ["<tx>#<i>", …] (1–20) }`, `vault_ref` (tuỳ chọn) — **không** có `sponsor.change_address` (gửi ⟹ `400 SPONSOR_REQUEST_SHAPE`) |
| T3 | `fund_id`, `carp_amount`, `vault_ref` (tuỳ chọn) |
| T4 | `op_type`, `op_count`, `draw_epoch` (số nguyên), `vault_ref` / `engage_ref` (tuỳ chọn) |

**T2 chi tiền bên tài trợ ⟹ mọi thứ quyết tiền lấy từ CẤU HÌNH, không từ thân bài.**

- **Đích thối không do người gọi viết.** Phần thối của bên tài trợ về lại ĐÚNG địa chỉ chung của
  các UTxO trong `sponsor.utxo_refs`; `summary.sponsor_change_address` trả địa chỉ đó. Bản trước
  nhận `sponsor.change_address` từ thân bài, nên người gọi lái được toàn bộ phần thối về ví mình.
- **Ghim ở bản deploy** — khối `paid_fund.sponsor` (§6): `fund_units` (tập quỹ được nạp),
  `addresses` (địa chỉ khoá bên tài trợ, dạng bech32 chính tắc), `max_carp_amount` (trần một lượt,
  chuỗi chữ số carpdrop). Vắng khối ⟹ T2 trả `501 CONFIG_MISSING`. Cổng: `src/sponsor.ts` ▸
  `assertT2PinnedInputs` (quỹ + trần, trước khi giữ khoá), `assertSponsorUtxosPinned` (UTxO chung
  một địa chỉ đã ghim, cái nào cũng mang CARP), `assertT2PinnedOutputs` (đọc lại CBOR: đúng một
  output quỹ nhận đúng `carp_amount`; đúng một output thối có giá trị trọn = Σ vào − `carp_amount`;
  không output nào khác mang CARP).
- **Thẻ vai.** `/tx/sponsor/t2-fund` chỉ mở bằng thẻ `VAULT_TX_API_SPONSOR_TOKEN` (§6) — thẻ
  thường ⟹ `403 SPONSOR_ROLE_REQUIRED`; dịch vụ chưa đặt thẻ vai ⟹ `501 CONFIG_MISSING`, kể cả trên
  loopback. Thẻ vai dùng ở route khác ⟹ `401`. Nguồn: `src/http.ts` ▸ `SPONSOR_ROLE_PATHS`,
  `requireRole`. T1/T3/T4 giữ thẻ thường.
- **Khoá theo UTxO.** Mỗi T2 giữ khoá `utxo:<ref>` cho từng UTxO bên tài trợ (cùng TTL với khoá
  chủ): hai T2 cùng một UTxO đều dựng được, lượt sau THAY lượt trước; tx nộp sau ⟹ `409 TX_SUPERSEDED` (§4).
- **Chủ phải là DID.** T1/T2 chỉ nhận chủ `Script(did_stake)` kèm `owner_witness` (chủ khoá ⟹
  `422 SPONSOR_OWNER_NOT_DID`), và tên anchor trong nhân chứng phải bằng `did_commit` của hành
  trình (T1: của thân bài; T2: của thread) — lệch ⟹ `422 SPONSOR_OWNER_DID_MISMATCH`. Nguồn:
  `src/sponsor.ts` ▸ `assertOwnerDid`. Lối chủ khoá chỉ mở qua tham số hàm dựng `allowKeyOwner`
  của `SponsorTxService`, thứ `server.ts` không truyền — nó chỉ để bài kiểm dùng.

Đáp ứng mọi bước: `{ step, tx_cbor, tx_hash, required_signers, signers, witness_notes, summary,
expires_at }`. Mẫu dưới là một lượt T2 THẬT trong `tests/sponsorEmulator.test.ts` (Emulator,
UPLC thật; khoá thử sinh trong bộ nhớ nên các hash đổi mỗi lần chạy; `tx_cbor` cắt ngắn, mảng
`outputs` lược còn ba phần tử đầu). Mẫu chụp TRƯỚC bản vá ghim T2 và đã chỉnh tay đúng hai chỗ cho
khớp hình dạng mới: bỏ `sponsor.change_address` khỏi yêu cầu, thêm `summary.sponsor_change_address`
(giá trị lấy từ output thối `#0` của chính mẫu):

```json
{
  "owner": { "type": "key", "hash": "73736f1884b5adf25b7245235e9bbb864673b417edf00bb1e6926377" },
  "change_address": "addr_test1vzfsrm9aycqfxyhx75wh6s25mt35ky6ys8vdqdcrd3lm62szqa8j4",
  "fund_id": "2ce668504a204db3f693f7ed11a024cc5525b76c5222d4e740976267d0a49d37",
  "carp_amount": "1000000000",
  "sponsor": {
    "utxo_refs": ["390b7bd625f93ad3386141661e99602aa9184e359895ce135ae9e31b8f8b2425#1"]
  }
}
```

```json
{
  "step": "T2",
  "tx_cbor": "84ab00d90102848258200000…",
  "tx_hash": "fdae3dba48890d544a38c0bfa7cbf329279123585270aee54a9c58bf4bd8f2ca",
  "required_signers": ["73736f1884b5adf25b7245235e9bbb864673b417edf00bb1e6926377"],
  "signers": [
    { "role": "fee-wallet", "key_hashes": ["9301ecbd26009312e6f51d7d4154dae34b134481d8d037036c7fbd2a"],
      "how": "ví khoá addr_test1vzfsrm9aycqfxyhx75wh6s25mt35ky6ys8vdqdcrd3lm62szqa8j4: phí + thế chấp + tiền thừa" },
    { "role": "sponsor", "key_hashes": ["23ae09893e7ec45cf59a76bd8e490de3eeec054769779613678629b8"],
      "how": "chi các UTxO CARP đã đưa trong sponsor.utxo_refs" },
    { "role": "owner", "key_hashes": ["73736f1884b5adf25b7245235e9bbb864673b417edf00bb1e6926377"],
      "how": "chữ ký khoá 73736f1884b5adf25b7245235e9bbb864673b417edf00bb1e6926377" }
  ],
  "witness_notes": [
    "Chủ khoá: ký bằng khoá 73736f1884b5adf25b7245235e9bbb864673b417edf00bb1e6926377.",
    "Ví trả phí: input phí + tài sản thế chấp lấy từ addr_test1vzfsrm9aycqfxyhx75wh6s25mt35ky6ys8vdqdcrd3lm62szqa8j4; khoá thanh toán 9301ecbd26009312e6f51d7d4154dae34b134481d8d037036c7fbd2a phải ký.",
    "Bên tài trợ ký bằng 23ae09893e7ec45cf59a76bd8e490de3eeec054769779613678629b8 (chi các UTxO CARP đã đưa); phần thối về addr_test1vq36uzvf8elvgh84nfmtmrjfph37amq9ga5h09snv7rznwqqj7lal.",
    "Thứ tự: thân giao dịch này là bản CHỐT — mọi bên ký trên đúng tx_hash trả về; đổi bất kỳ byte nào của thân thì mọi chữ ký đã có mất hiệu lực."
  ],
  "summary": {
    "step": "T2",
    "epoch": 330,
    "epoch_end_ms": "1797033600000",
    "vault_out_ref": "fdae3dba48890d544a38c0bfa7cbf329279123585270aee54a9c58bf4bd8f2ca#1",
    "fund_id": "2ce668504a204db3f693f7ed11a024cc5525b76c5222d4e740976267d0a49d37",
    "fund_unit": "e73e5fe0b2707e119482c6405d6c528233071dafa82d5323b15278f52ce668504a204db3f693f7ed11a024cc5525b76c5222d4e740976267d0a49d37",
    "carp_amount": "1000000000",
    "opens_new_line": true,
    "anchor_ref": "2498905883e5ec227bcb4d6947a381ecfebede4943bfb9eb74b8fa43cbab2d30#0",
    "owner_commit": "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
    "sponsor_signers": ["23ae09893e7ec45cf59a76bd8e490de3eeec054769779613678629b8"],
    "sponsor_change_address": "addr_test1vq36uzvf8elvgh84nfmtmrjfph37amq9ga5h09snv7rznwqqj7lal",
    "withdrawals": 0,
    "outputs": [
      { "index": 0, "address": "addr_test1vq36uzvf8elvgh84nfmtmrjfph37amq9ga5h09snv7rznwqqj7lal",
        "assets": { "lovelace": "4872111902", "2222…5a5a": "99000000000" } },
      { "index": 1, "address": "addr_test1wpxkdmuftxelrq3c9rpnvpf83ysfq4lg8xxq3d62s7x26fg2jakda",
        "assets": { "lovelace": "1637800", "4d66ef89…12392a": "1" } },
      { "index": 2, "address": "addr_test1wrnnuhlqkfc8uyv5stryqhtv22prxpca475z65erk9f83agwr5fw5",
        "assets": { "lovelace": "2155000", "e73e5fe0…a49d37": "1", "2222…5a5a": "1000000000" } }
    ]
  },
  "expires_at": "2026-12-07T00:04:40.000Z"
}
```

`summary.owner_commit` đọc từ `did_commit` của **thread** của chủ, rồi dịch vụ tìm đúng một UTxO
mang NFT `did_stake.anchor_nft_policy ‖ owner_commit`. Bản deploy không khai
`did_stake.anchor_nft_policy` ⟹ T2 trả `501 CONFIG_MISSING` — dịch vụ không bao giờ đoán policy
anchor.

**Mã lỗi.** Nguồn mức HTTP của mọi mã do SDK ném: `src/sponsor.ts` ▸ `SPONSOR_ERROR_STATUS`
(bảng kín theo kiểu: thêm mã ở SDK mà không thêm ở đây thì không biên dịch được); danh sách mã
của dịch vụ: khối chú thích đầu `src/errors.ts`. Phần người gọi thường gặp:

| mã | HTTP | nghĩa / sửa thế nào |
|---|---|---|
| `SPONSOR_REQUEST_SHAPE` · `DID_COMMIT_INVALID` · `SPONSOR_CHANGE_ADDRESS_INVALID` | 400 | thân bài sai hình dạng; `details.field` chỉ trường |
| `VAULT_ALREADY_EXISTS` | 409 | chủ đã có két Prepaid — đi tiếp từ T2 với két đang có |
| `SPONSOR_ANCHOR_NOT_FOUND` · `SPONSOR_FUND_NOT_FOUND` | 404 | chưa có anchor DID / quỹ `fund_id` trên chuỗi |
| `SPONSOR_EPOCH_MISMATCH` | 409 | `draw_epoch` không phải kỳ hiện tại — lô đã hết hạn, rút lại ở T3 |
| `SPONSOR_VALIDITY_SPANS_EPOCHS` | 422 | đang sát biên kỳ; thử lại sau biên |
| `SPONSOR_CARP_INSUFFICIENT` · `SPONSOR_FUND_NOT_PINNED` | 422 | UTxO bên tài trợ không đủ CARP / quỹ không đúng quỹ đã ghim |
| `SPONSOR_FUND_NOT_ALLOWED` · `SPONSOR_CARP_ABOVE_CAP` | 422 | `fund_id` ngoài `paid_fund.sponsor.fund_units` / `carp_amount` vượt `max_carp_amount` |
| `SPONSOR_UTXO_NOT_ALLOWED` · `SPONSOR_UTXO_NO_CARP` | 422 | `utxo_refs` không chung một địa chỉ đã ghim / có UTxO không mang CARP |
| `SPONSOR_UTXO_NOT_KEY` | 400 | UTxO bên tài trợ không do khoá giữ |
| `SPONSOR_UTXO_NOT_FOUND` | 404 | có `utxo_refs` không phải UTxO chưa tiêu |
| `SPONSOR_FEE_WALLET_IS_SPONSOR` | 422 | ví trả phí (`change_address` hoặc `fee_payer.address`) trùng địa chỉ bên tài trợ, HOẶC cùng khoá thanh toán với nó (khác phần stake vẫn bị chặn) — dùng ví trả phí khác |
| `FEE_PAYER_CHANGE_ADDRESS_CONFLICT` | 400 | gửi cả `fee_payer` lẫn `change_address` — chọn một |
| `FEE_PAYER_SHAPE` · `FEE_PAYER_INVALID` | 400 | `fee_payer` sai khuôn / sai mạng / không phải khoá; UTxO trả phí không phải UTxO chưa tiêu, không ở `fee_payer.address`, hoặc không thuần ADA |
| `FEE_PAYER_TX_MISMATCH` | 422 | tx vừa dựng lệch một trong năm luật đọc lại ở trên — lỗi phía dịch vụ, báo vận hành |
| `SPONSOR_BUILD_FAILED` | 422 | bộ dựng không cân được tx — thường là UTxO trả phí không đủ ADA cho phí + thế chấp + min-ADA phải ứng; nạp UTxO lớn hơn |
| `SPONSOR_OWNER_NOT_DID` · `SPONSOR_OWNER_DID_MISMATCH` | 422 | T1/T2 với chủ khoá / anchor của nhân chứng không mang tên `did_commit` |
| `SPONSOR_ROLE_REQUIRED` | 403 | T2 gọi bằng thẻ thường — cần thẻ vai sponsor |
| `TX_SUPERSEDED` | 409 | lúc NỘP: tx đã bị thay — một tx khác chung khoá (chủ, quỹ, UTxO bên tài trợ / ví trả phí) đã được nộp, hoặc input của nó vừa bị tx khác tiêu (§4) |
| `OWNER_TX_IN_FLIGHT` | 409 | **đã nghỉ** — bản cũ trả ở lúc DỰNG; nay không đường nào trả (§4) |
| `SPONSOR_THREAD_DID_INVALID` | 422 | thread của chủ không mang `did_commit` 32 byte — két không mở bằng T1 |
| `SPONSOR_TX_MISMATCH` | 422 | tx vừa dựng không có đúng output két/thread ở địa chỉ đã cấu hình — lệch cấu hình, báo vận hành |
| `SPONSOR_PREPAID_UNAVAILABLE` · `SPONSOR_PREPAID_SCRIPTS_MISMATCH` · `CONFIG_MISSING` · `SPONSOR_UNAVAILABLE` | 501 | bản deploy không phục vụ được hành trình này |

Lỗi của bộ dựng đi qua `src/sponsor.ts` ▸ `asSponsorApiError`, một danh sách ĐÓNG: chỉ
`PrepaidTxError` và `PrepaidRuleError` (lỗi luật của PrepaidGen, mang `code`) thành `422`; mọi
`Error` thường khác ra `500` kèm `reference_code` — bản trước đổi mọi lỗi thành `422`, nên một
lỗi nội bộ đọc thành "yêu cầu sai" và người gọi đi sửa thân bài.

### 🔴 Số tiền là CHUỖI chữ số, cả vào lẫn ra

Trần LAMP là `36×10^15` oildrop; `2^53 ≈ 9,007×10^15`. Một trường oildrop **có thật** vượt
được ngưỡng an toàn của số dấu-phẩy-động, và lúc vượt thì nó **không lỗi — nó làm tròn**.
Một con số đã tròn vẫn dựng ra một giao dịch hợp lệ khoá nhầm số LAMP.

Nên:

- **Gửi lên**: `schedule_length`, `lamp_per_epoch`, `op_count` phải là **chuỗi** thập phân.
  Gửi số JSON thì nhận `400` kèm lý do. `op_type` là số nguyên — nó là nhãn (1 = ảnh,
  2 = CID), không phải tiền.
- **Nhận về**: mọi trường tiền là chuỗi. Đơn vị nằm ở **tên trường**, không nằm ở giá trị:
  `_oildrop` / `_nanogic` / `_lovelace` là số nguyên thô; `_lamp` / `_magic` / `_ada` là
  cùng con số đó đã đặt dấu phẩy, để hiển thị.

### Mã trả về

| tình huống | mã |
|---|---|
| dựng xong | `200` |
| tham số sai khuôn, số JSON cho trường tiền, bộ chứng ký rỗng | `400 BAD_REQUEST` |
| `owner` sai hình dạng / hash sai khuôn | `400 OWNER_CREDENTIAL_SHAPE` / `400 OWNER_HASH_INVALID` |
| `owner` và `owner_pkh` chỉ hai chủ khác nhau | `400 OWNER_ALIAS_MISMATCH` |
| `owner_witness` sai hình dạng / chủ khoá mà gửi kèm | `400 OWNER_WITNESS_SHAPE` / `400 OWNER_WITNESS_UNEXPECTED` |
| chủ script, thiếu `owner_witness` | `400 OWNER_SCRIPT_WITNESS_UNAVAILABLE` |
| script gửi lên không băm ra `owner.hash` | `400 OWNER_AUTH_MISMATCH` |
| UTxO anchor không mang tài sản dưới `anchor_nft_policy` | `400 OWNER_ANCHOR_INVALID` |
| chủ `did`: `did` sai khuôn / kèm `owner_witness` hay `owner_pkh` / thiết bị không có trong anchor | `400 OWNER_DID_SHAPE` / `400 OWNER_DID_CONFLICT` / `400 OWNER_DEVICE_NOT_LISTED` |
| chủ `did`: anchor không có / nhiều hơn một / datum không phải `TAADDatum` 18 trường / không Active | `422 OWNER_ANCHOR_NOT_FOUND` / `422 OWNER_ANCHOR_AMBIGUOUS` / `422 OWNER_ANCHOR_SCHEMA` / `422 OWNER_ANCHOR_NOT_ACTIVE` |
| chủ `did`, bản deploy thiếu `did_stake.unapplied_script` | `501 OWNER_SCRIPT_WITNESS_UNAVAILABLE` |
| thiếu / sai `change_address` | `400 CHANGE_ADDRESS_REQUIRED` / `400 CHANGE_ADDRESS_INVALID` |
| `funding` sai hình dạng / trường lạ / chủ khoá thiếu anchor·controller·thiết bị | `400 FUNDING_SHAPE` |
| `did_payment_script_cbor` không băm ra payment credential `Script(h)` của `funding.address` | `400 FUNDING_SCRIPT_MISMATCH` |
| `fee_payer.address` không phải khoá / sai mạng; UTxO trả phí không ở đó hoặc không thuần ADA | `400 FUNDING_FEE_PAYER_INVALID` |
| `funding.fee_source = "did_payment"`: `collateral.address` không phải khoá / sai mạng; UTxO thế chấp không ở đó hoặc không thuần ADA | `400 FUNDING_COLLATERAL_INVALID` |
| `funding.fee_source` lạ · thiếu `collateral` (tự trả phí) · trộn `fee_payer` với `fee_source: "did_payment"` · `collateral` ở chế độ mặc định | `400 FUNDING_SHAPE` |
| `funding` cùng `change_address` | `400 FUNDING_CHANGE_ADDRESS_CONFLICT` |
| `funding` khai anchor/controller/thiết bị khác `owner_witness` | `400 FUNDING_WITNESS_MISMATCH` |
| anchor của `funding` không mang tài sản dưới `anchor_nft_policy` | `400 FUNDING_ANCHOR_INVALID` |
| ví `did_payment` không đủ LAMP + min-ADA | `422 FUNDING_INSUFFICIENT` |
| tx vừa dựng lệch hợp đồng `funding` (input/output/redeemer/thế chấp/chữ ký/hạn dùng) | `422 FUNDING_TX_MISMATCH` |
| `funding`, dịch vụ chưa cấu hình `did_stake` (đọc anchor) | `501 FUNDING_UNAVAILABLE` |
| tài khoản thưởng `Script(h)` chưa đăng ký | `422 OWNER_STAKE_NOT_REGISTERED` |
| chủ script, dịch vụ chưa cấu hình `did_stake` | `501 OWNER_SCRIPT_WITNESS_UNAVAILABLE` |
| `fee_payer` sai khuôn / sai mạng · không phải khoá · UTxO không ở đó hoặc không thuần ADA | `400 FEE_PAYER_SHAPE` / `400 FEE_PAYER_INVALID` |
| `fee_payer` cùng `change_address` | `400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT` |
| `fee_payer` ở gốc thân bài của `/tx/create-vault` | `400 FEE_PAYER_UNSUPPORTED` |
| tx vừa dựng lệch luật ví trả phí | `422 FEE_PAYER_TX_MISMATCH` |
| `/tx/open-thread` chỉ có `fee_payer` (không ai trả min-ADA thread) | `422 FEE_PAYER_DEPOSIT_UNSOURCED` |
| `engage_ref` sai khuôn / không phải thread của chủ | `400 ENGAGE_REF_SHAPE` / `400 ENGAGE_REF_MISMATCH` |
| `/tx/instant-gen`: `m` vắng / số JSON / không phải chữ số / `"0"` | `400 INSTANT_GEN_M_INVALID` |
| `/tx/instant-gen`: `m > max_m` (`details.max_m`, `details.m`) | `422 INSTANT_GEN_M_ABOVE_MAX` |
| `/tx/quote` route `instant-gen` không gửi `m`, trần còn lại = 0 | `422 INSTANT_GEN_MAX_M_ZERO` |
| `/tx/create-vault`: `lamp_amount` sai (schedule cần > 0, instant cần ≥ 0) | `400 LAMP_AMOUNT_INVALID` |
| `/tx/create-vault`: `did_commit` không đúng 64 hex thường / gửi cho két schedule | `400 DID_COMMIT_INVALID` / `400 DID_COMMIT_UNEXPECTED` |
| `/tx/create-vault` instant: chủ (hoặc `did_commit`) đã có két (`details.existing`) | `409 VAULT_ALREADY_EXISTS` |
| bản deploy thiếu `gen_v2` / `ref_script_utxos.commit` / `ref_script_utxos.gb_shard` mà đường cần (`details.missing`, `details.route`) | `501 CONFIG_MISSING` |
| bản deploy là khối két Prepaid mà route chưa có bộ dựng cho loại két đó (`details.route`) | `501 VAULT_KIND_UNSUPPORTED` |
| beacon ρ / GreenBack / sổ két vắng trên chuỗi, hoặc hai UTxO cùng NFT (`details.what`) | `502 CHAIN_UNAVAILABLE` |
| `/tx/instant-gen` · `/tx/consume` làm mới checkpoint của két đã nối link, không gửi `wakeme_vault_ref` và dịch vụ không tìm thấy két (`details.located_count`) | `400 WAKEME_VAULT_REF_REQUIRED` |
| tự định vị thấy ≥ 2 UTxO mang NFT két Wakeme của `wakeme_link` (`details.candidates`) | `409 WAKEME_VAULT_AMBIGUOUS` |
| `wakeme_vault_ref` sai khuôn | `400 WAKEME_VAULT_REF_SHAPE` |
| `wakeme_vault_ref` trên mạng chưa có két Wakeme | `501 WAKEME_VAULT_UNAVAILABLE` |
| `wakeme_vault_ref` không có trên chuỗi / đã bị tiêu | `404 WAKEME_VAULT_NOT_FOUND` / `409 WAKEME_VAULT_SPENT` |
| `wakeme_vault_ref` không nằm ở script két Wakeme | `409 WAKEME_VAULT_SCRIPT_MISMATCH` |
| datum / NFT két không đạt luật đọc `L_lent` | `422 WAKEME_VAULT_UNREADABLE` |
| tx vừa dựng tiêu két, hoặc thiếu két trong `reference_inputs` | `422 WAKEME_VAULT_TX_MISMATCH` |
| `wakeme_vault_ref` không phải két đã nối (`wakeme_link` rỗng hoặc khác) và lượt này không nối/đổi link được, luật 6 (`details.wakeme_link`, `details.owner_commit`, `details.next_route`) — chạy `/tx/refresh-checkpoint` trước | `422 WAKEME_LINK_CHANGE_REJECTED` |
| chủ chưa có thread Engage | `404 ENGAGE_THREAD_NOT_FOUND` |
| chủ có nhiều thread, không kèm `engage_ref` | `409 ENGAGE_THREAD_AMBIGUOUS` |
| `/tx/consume`: `pairs` đi cùng `op_type`/`op_count` | `400 CONSUME_PAIRS_CONFLICT` |
| `pairs` không phải mảng / phần tử sai hình (null, mảng, khoá lạ) | `400 CONSUME_PAIRS_SHAPE` |
| `pairs` rỗng / quá 8 cặp | `400 CONSUME_PAIRS_EMPTY` / `400 CONSUME_PAIRS_TOO_MANY` |
| `op_type` không tăng ngặt (kể cả trùng) | `400 CONSUME_PAIRS_NOT_INCREASING` |
| `op_count` không phải chuỗi chữ số ≥ 1, ≤ 20 chữ số / `op_type` ngoài số nguyên [0, 1000000] | `400 CONSUME_PAIR_COUNT_INVALID` / `400 CONSUME_PAIR_TYPE_INVALID` |
| tx tiêu vừa dựng lệch lượt tiêu đã yêu cầu (thread, redeemer, output, datum, Σburns) | `422 CONSUME_TX_MISMATCH` |
| `/tx/open-thread` khi chủ đã có thread | `409 ENGAGE_THREAD_EXISTS` |
| `engage_ref` mang NFT nhưng datum không giải được | `422 ENGAGE_THREAD_DATUM_UNDECODABLE` |
| tx mở thread vừa dựng lệch (NFT / output / datum genesis) | `422 OPEN_THREAD_TX_MISMATCH` |
| `/tx/open-thread` kèm `funding` | `501 OPEN_THREAD_FUNDING_UNSUPPORTED` |
| `/tx/bind-did`: `did_commit` không đúng 64 ký tự hex thường | `400 DID_COMMIT_INVALID` |
| `/tx/bind-did`: thread đã gắn DID | `409 DID_ALREADY_BOUND` (`details.did_commit`) |
| tx gắn DID vừa dựng lệch (redeemer / value / datum / chữ ký chủ) | `422 BIND_DID_TX_MISMATCH` |
| `/tx/bind-did` kèm `fee_payer` | `501 BIND_DID_FEE_PAYER_UNSUPPORTED` |
| `/tx/quote`: thân sai hình dạng · `route` lạ | `400 FEE_QUOTE_SHAPE` / `400 FEE_QUOTE_ROUTE_UNKNOWN` |
| `/tx/quote`: `params` mang `fee_payer` / `funding.fee_payer` | `400 FEE_QUOTE_FEE_PAYER_IN_PARAMS` |
| `/tx/quote` cho `create-vault` không có `params.funding` | `400 FEE_QUOTE_FUNDING_REQUIRED` |
| `/tx/quote` cho `create-vault` với `params.funding.fee_source = "did_payment"` | `400 FEE_QUOTE_SELF_FUNDED` |
| `/tx/quote`: gửi trường cũ `owner_fee_address` (số ít) · `owner_fee_addresses` không phải mảng chuỗi | `400 FEE_QUOTE_SHAPE` |
| `/tx/quote`: một phần tử `owner_fee_addresses` không phải địa chỉ khoá / sai mạng | `400 FEE_QUOTE_OWNER_ADDRESS_INVALID` |
| `/tx/quote`: `owner_fee_addresses` quá 10 phần tử | `400 FEE_QUOTE_OWNER_ADDRESSES_TOO_MANY` |
| `/tx/quote`: `owner_fee_addresses` có địa chỉ trùng | `400 FEE_QUOTE_OWNER_ADDRESSES_DUPLICATE` |
| `X-Feecover-Token` không khớp ứng dụng nào | `401 FEE_PROXY_APP_UNKNOWN` |
| ứng dụng chưa có mục đích cho route đó | `400 FEE_PROXY_PURPOSE_UNMAPPED` |
| mục đích thuộc ứng dụng khác / thiếu tiền tố tên ứng dụng | `403 FEE_PROXY_APP_PURPOSE` |
| `/fee/sign` cho tx không do dịch vụ phát, hoặc quá hạn ký | `403 FEE_PROXY_TX_NOT_ISSUED` |
| `/fee/sign` cho tx không dùng ví trả phí | `400 FEE_PROXY_NO_FEE_PAYER` |
| Feecover từ chối (`400`/`403`/`409`/`422`/`429`) | mã đó + `FEE_PROXY_REJECTED` |
| dịch vụ không cấu hình `feecover` | `501 FEE_PROXY_UNAVAILABLE` |
| Feecover không trả lời / 5xx / `401` / `404` / thân sai hình dạng | `502 FEE_PROXY_UPSTREAM` |
| tham chiếu UTxO (ví trả phí, anchor) không có trên chuỗi / sai số output | `400 UTXO_NOT_FOUND` |
| tham chiếu UTxO đã bị tiêu | `409 UTXO_SPENT` (`details.consumed_by_tx`) |
| UTxO vault là input của một tx vừa nộp qua dịch vụ mà chưa vào khối | `409 PREVIOUS_TX_PENDING` — thử lại sau khi tx đó vào khối |
| beacon giá trễ quá `consume.max_price_stale` epoch | `422 TX_BUILD_REJECTED` với câu `CONSUME-011` |
| Feecover ký một tx có hash khác | `502 FEE_PROXY_UPSTREAM_MISMATCH` |
| thiếu/sai thẻ bài | `401 UNAUTHORIZED` |
| chủ **chưa có** vault | `404 VAULT_NOT_FOUND` ← **không phải** `200` với tx rỗng |
| method sai | `405 METHOD_NOT_ALLOWED` |
| nộp một tx đã bị tx khác chung khoá (đã NỘP) thay, hoặc input đã bị tx vừa nộp tiêu | `409 TX_SUPERSEDED` (`details.superseded_by` / `details.conflicting_inputs`) |
| chủ đã có một tx dựng xong chưa nộp | **không còn lỗi** — lượt dựng mới thay lượt cũ; `OWNER_TX_IN_FLIGHT` đã nghỉ (§4) |
| hai UTxO cùng một NFT danh-tính | `409 VAULT_IDENTITY_DUPLICATE` |
| chủ có nhiều vault, yêu cầu không nói cái nào | `409 VAULT_AMBIGUOUS` |
| giao thức từ chối (L×λ > L_avail, MAGIC sống < required, shard hết chỗ) | `422 TX_BUILD_REJECTED` |
| dựng ra CBOR mà không đọc lại được | `422 TX_SUMMARY_UNDECODABLE` |
| không đọc được chuỗi | `502 CHAIN_UNAVAILABLE` |
| datum vault không khớp lược đồ | `502 VAULT_DATUM_UNDECODABLE` |
| nút chuỗi từ chối tx | `502 SUBMIT_REJECTED` |
| ngoài dự kiến | `500 INTERNAL` + **mã tham chiếu** |

> **Đừng gộp `404 VAULT_NOT_FOUND` với `502 CHAIN_UNAVAILABLE`.** Gộp là dựng một màn hình
> mời người dùng tạo vault thứ hai trong khi vault thứ nhất vẫn ở đó, chỉ là đường đọc gãy.

`500` **không** trả traceback, không trả đường dẫn nội bộ, không trả tên biến môi trường.
Nó trả `reference_code` dạng `ref_<12 hex>`, và mã đó tra ngược được ở nhật ký của chính
dịch vụ. Có bài kiểm đòi đúng điều đó: mã trả ra ngoài phải bằng mã đã ghi vào nhật ký.
Câu của **nút chuỗi** thì ngược lại — nó được giữ nguyên văn ở `SUBMIT_REJECTED`, vì
"giá trị đã bị tiêu" nói được người dùng phải làm gì, còn "có lỗi xảy ra" thì không.

---

## 4. Đua UTxO — vì sao có khoá mềm và vì sao nó giữ lâu

Mỗi chủ có một UTxO vault. Dựng giao dịch nghĩa là **chọn** đúng UTxO đó làm input. Hai
yêu cầu tới gần nhau cho cùng `owner_pkh` chọn **trùng** input, và eUTXO chỉ cho một trong
hai lên chuỗi. Cái thua **không hỏng lúc dựng** — nó hỏng *sau khi người dùng đã ký*, và
câu của chuỗi lúc đó không nhắc gì tới chuyện có hai giao dịch.

**Xung đột bắt ở lúc NỘP, không ở lúc dựng** (đổi 2026-10-03, `src/locks.ts` đầu tệp). Bản cũ
trả `409 OWNER_TX_IN_FLIGHT` cho lượt DỰNG thứ hai suốt TTL; nhưng chủ là công khai, dựng tx không
cần chữ ký chủ, và dịch vụ có một thẻ Bearer dùng chung ⟹ ai có thẻ gọi lặp là khoá két người khác
vô thời hạn. Luật hiện hành:

- lượt dựng mới cho một khoá **không bao giờ** nhận 409 vì một lượt dựng khác: nó lấy khoá, lượt cũ bị
  THAY, mọi khoá phụ lượt cũ còn giữ (UTxO quỹ / UTxO ví trả phí ở `/tx/sponsor/*`) nhả ngay, và chỗ
  giữ phí của tx bị thay được trả lại;
- một tx chỉ bị coi là đã thay khi một tx KHÁC chung khoá với nó được **NỘP** (cần chữ ký chủ), không
  phải khi được dựng — nên người lạ dựng lặp không làm tx của chủ bị từ chối;
- `/tx/submit` (và `/fee/sign`) với tx đã bị thay, hoặc tx có input đã bị một tx vừa nộp (chưa vào khối)
  tiêu ⟹ `409 TX_SUPERSEDED` với `details.superseded_by` (hash tx đã nộp) và/hoặc
  `details.conflicting_inputs`. App dựng lại từ đầu.

Mã `OWNER_TX_IN_FLIGHT` đã nghỉ: không đường nào trả nữa, giữ lại trong tài liệu để app đời cũ còn
nhận ra. Khoá vẫn **giữ tới lúc nộp** để `/tx/submit` biết tx nào chung khoá. Ba đường mở khoá:
`/tx/submit` đúng giao dịch đó · hết hạn (`VAULT_TX_API_LOCK_TTL_MS`, mặc định 180 s, cũng
là `expires_at`) · dựng hỏng thì nhả ngay · nút chuỗi TỪ CHỐI giao dịch lúc nộp (mất kết nối
lúc nộp thì KHÔNG nhả — không biết giao dịch đã vào mempool chưa). Khoá mang thẻ thế hệ: một
lượt dựng chậm quá hạn không nhả, cũng không gắn hash lên khoá của lượt sau.

**Sau khi nộp**, khoá nhả nhưng nút đọc chuỗi chỉ thấy input bị tiêu khi giao dịch vào khối.
Trong khe đó dịch vụ giữ input của giao dịch vừa nộp (cùng TTL khoá): dựng lại trên đúng UTxO
vault ấy ⟹ `409 PREVIOUS_TX_PENDING`; bộ dựng không chọn lại UTxO ví/shard ấy làm input.

**Giới hạn đã biết:** khoá nằm trong bộ nhớ của **một tiến trình**. Chạy hai bản sau một
bộ cân tải thì hai bảng khoá không thấy nhau và khoá không còn nghĩa. Xem §8.

---

## 5. Vault nào được chọn làm input

Một UTxO ở địa chỉ vault chỉ được tính khi mang **NFT danh-tính vault**: đúng một tài sản
có `policy_id == script hash của vault`, số lượng 1 (`INV-VAULT-IDENTITY`).

Lọc theo `datum.owner` **không đủ**: địa chỉ script là công cộng, ai cũng đặt được một
UTxO ở đó với datum tự soạn khai `owner` là PKH của người khác. Validator từ chối đúng
những UTxO ấy (`ScheduleGen/onchain/validators/vault.ak` ▸ `validate_vault_value`,
▸ `has_vault_id_nft` — neo bằng **tên hàm**, không bằng số dòng), nên bên dựng phải từ chối
y hệt. UTxO bị bỏ được **đếm và khai** ở `ignored[]` kèm lý do.

Một chủ có **nhiều** vault là hợp lệ, và bên **đọc** cộng dồn chúng. Bên **dựng** thì
không cộng được: phải chọn một UTxO. Chọn đại là chọn hộ người dùng một cái vault họ không
nhắc tới — nên `409 VAULT_AMBIGUOUS`, kèm danh sách để bên gọi chọn. Xem §8.

---

## 6. Chạy

### Biến môi trường — đặt ngay trước lệnh, đừng ghi vào tệp

| biến | bắt buộc | mặc định |
|---|---|---|
| `VAULT_TX_API_NETWORK` | có | — (`Preview` \| `Preprod` \| `Mainnet`) |
| `BLOCKFROST_PROJECT_ID` | có | — **GIÁ TRỊ** khoá, không phải đường dẫn |
| `VAULT_TX_API_DEPLOYMENT` | có | — JSON, xem dưới |
| `VAULT_TX_API_CHANGE_ADDRESS_STRATEGY` | có | — **không có mặc định**, xem §7 |
| `VAULT_TX_API_VAULT_PLUTUS_JSON` | có | — đường dẫn `plutus.json` của module vault |
| `VAULT_TX_API_HOST` | không | `127.0.0.1` |
| `VAULT_TX_API_PORT` | không | `8788` |
| `VAULT_TX_API_BASE_PATH` | không | rỗng — tiền tố đường khi đứng sau proxy định tuyến theo đường, ví dụ `/vaulttx/preprod`; dịch vụ tự cắt nó (`src/basePath.ts`), vẫn nhận đường không tiền tố từ loopback |
| `VAULT_TX_API_TOKEN` | ngoài loopback thì **có** | rỗng |
| `VAULT_TX_API_SPONSOR_TOKEN` | khi phục vụ T2 | rỗng ⟹ `/tx/sponsor/t2-fund` trả `501 CONFIG_MISSING`. **GIÁ TRỊ** thẻ vai sponsor, đưa cho bên vận hành tài trợ; trùng `VAULT_TX_API_TOKEN` ⟹ từ chối khởi động |
| `VAULT_TX_API_BLOCKFROST_URL` | không | dẫn theo `NETWORK` |
| `VAULT_TX_API_TIMEOUT_MS` | không | `20000` |
| `VAULT_TX_API_LOCK_TTL_MS` | không | `180000` |
| `FEECOVER_APP_TOKEN` | khi cấu hình có `feecover.apps.magic` | — **GIÁ TRỊ** token ứng dụng Feecover (token API, không phải khoá ký) |

Cổng fail-closed lúc khởi động: thiếu biến bắt buộc · bind ngoài loopback mà thẻ bài rỗng ·
policy LAMP nhái hoặc thuộc một đời đã bị thay (`assertLampPolicyId`; lối tập dượt xem dưới) ·
tên tài sản LAMP không khớp mạng (`tLAMP` testnet / `LAMP` mainnet — apply-param #2) · địa
chỉ sai tiền tố mạng · địa chỉ không phải địa chỉ script · hai mục vault trùng địa chỉ ·
blueprint không đọc được · khối `feecover` có ứng dụng `magic` mà `FEECOVER_APP_TOKEN` rỗng ·
URL Feecover không phải `https://` (hoặc `http://` loopback) · bảng mục đích nêu route không
có. Tất cả **từ chối khởi động**, không cảnh báo rồi chạy tiếp — người
bị chặn lúc khởi động là người vận hành, còn hoãn sang lúc chạy thì người bị chặn là người
dùng.

```jsonc
// VAULT_TX_API_DEPLOYMENT
{
  "source": "Preview, deploy 2026-09-11, tx e5fd34b1…",   // BẮT BUỘC — xem dưới
  "lamp":   { "policy_id": "<56 hex>", "asset_name_hex": "744c414d50" },  // + "rehearsal_ack" tuỳ chọn — xem dưới
  "vaults": [{ "vault_type": "Schedule", "address": "addr_test1w…" }],
  "shard_address": "addr_test1w…",
  "ref_script_utxos": {
    "vault": "…#0", "shard": "…#1", "consume": "…#2",
    "commit": "…#3",     // tuỳ chọn — validator withdraw-zero `commit` (ScheduleGen v2.0); vắng ⟹ schedule-commit 501
    "gb_shard": "…#4"    // tuỳ chọn — validator `gb_shard`; vắng ⟹ instant-gen + schedule-commit 501
  },
  "gen_v2": {                                   // tuỳ chọn; CÓ thì đủ mọi trường — vắng ⟹ các đường Gen v2.0 trả 501
    "rate_beacon_address": "addr_test1w…",      // Script(rate_script_hash) — hash suy từ địa chỉ
    "rate_nft_policy": "<56 hex>",              // NFT "RHO"
    "greenback_beacon_address": "addr_test1w…", // Script(gb_beacon_script_hash)
    "greenback_beacon_nft_policy": "<56 hex>",  // NFT "GBB"
    "gb_shard_address": "addr_test1w…",         // Script(gb_shard_policy_id) — 16 shard NFT "GBS"‖id
    "gb_shard_cap_nanogic": "1000000000000000", // CHUỖI chữ số > 0, đúng apply-param của gb_shard
    "vault_registry_address": "addr_test1w…"    // sổ két, NFT "VRG"
  },
  "consume": {
    "engage_address": "addr_test1w…",       // thread Engage chọn theo chủ lúc chạy
    "price_beacon_address": "addr_test1w…", "price_beacon_nft_unit": "…",
    "max_price_stale": "1"                  // tuỳ chọn — apply-param #5 của consume; có ⟹ từ chối sớm CONSUME-011
  },
  "fee_payer_collateral_lovelace": "3000000",      // tuỳ chọn, CHUỖI; thế chấp khi có ví trả phí
  "did_stake": { "anchor_nft_policy": "<56 hex>", "unapplied_script": { "cbor": "<hex>", "hash": "<56 hex>" } }, // tuỳ chọn — chủ script + funding did_payment; unapplied_script bật chủ {type:"did"}
  "feecover": {                                     // tuỳ chọn — proxy phí, xem §3
    "url": "https://feecover.example",              // https://, hoặc http:// tới loopback
    "timeout_ms": 15000,                            // tuỳ chọn, mặc định 15000
    "apps": {
      "magic":   { "purposes": { "create-vault": "create_vault", "consume": "consume_magic" } },
      "orilife": { "token_sha256": "<SHA-256 hex của token orilife>",
                   "purposes": { "consume": "orilife_consume_magic" } }
    }
  }
}
```

Khoá cũ `consume.engage_nft_unit` đã bị gỡ: khai nó thì dịch vụ từ chối khởi động (một NFT
thread cố định chỉ phục vụ được một người). Khoá cũ `instant` (datum UM + beacon backing, Gen
v1) cũng vậy: UM không còn trong công thức sinh, beacon backing thay bằng beacon GreenBack +
shard GB của khối `gen_v2` — khai `instant` thì dịch vụ từ chối khởi động và câu lỗi nêu các
trường `gen_v2` cần khai. Script hash / policy của `gen_v2` suy từ địa chỉ, như `vaults`. Trong `feecover.apps`, ứng dụng `magic` không có
`token_sha256` — token của nó vào qua `FEECOVER_APP_TOKEN`; ứng dụng khác khai SHA-256 của
token của họ, dịch vụ không giữ token đó. Mục đích cho `instant-gen` / `schedule-*` và
`open-thread` chưa có ở Feecover nên chưa có trong mẫu; route vắng khỏi bảng thì proxy trả
`400 FEE_PROXY_PURPOSE_UNMAPPED` cho tx của route đó.

`lamp.policy_id` đi qua `@magiclamp/sdk` ▸ `assertLampPolicyId` ngay lúc khởi động
(`parseDeployment`): policy nhái đã biết và LAMP THẬT của một đời đã bị thay đều bị từ chối,
dù chúng đúng 56 hex. Mẫu cũ ở đây ghi `28e916…` — đó chính là một policy nhái trong bảng
chặn, nên nay nó làm dịch vụ từ chối khởi động; đừng chép nó ra.

`lamp.rehearsal_ack` (tuỳ chọn, chuỗi) mở **lối tập dượt** cho một đời đã bị thay: chỉ có
tác dụng khi policy nằm trong `MagicSDK/src/lampPolicy.ts` ▸ `REHEARSAL_LAMP_POLICIES`,
giá trị bằng **ĐÚNG** `lamp.policy_id`, và `VAULT_TX_API_NETWORK` là `Preview`/`Preprod`.
Thiếu một điều thì dịch vụ vẫn từ chối khởi động với câu lỗi đời-đã-bị-thay. Khi được cho
qua, dịch vụ in một dòng `⚠ [config] TẬP DƯỢT` ra stderr, và ack đi tiếp tới `createVault`
của SDK (cổng chạy lại ở đó). Bảng tập dượt hiện chỉ có `8169b76c…`. Policy tLAMP Preprod
cuối đã tới (`493002cc…cfac`, 2026-10-03; genesis chưa gửi, nên chưa có tLAMP nào dưới nó),
và hai đời `53bc12ad…` · `7ecbffe2…` đã vào bảng đã-bị-thay của SDK; khoá `8169b76c…` gỡ khi
runner của cụm tập dượt dừng hẳn. Policy cuối KHÔNG gõ cứng trong dịch vụ hay SDK — nó đi vào
qua `lamp.policy_id`. `scripts/gen_vault_tx_api_deployment.ts` phát trường
này khi lượt sinh chạy với `LAMP_REHEARSAL_ACK` trong môi trường — không lấy từ sổ trạng thái.

`script_hash` **không** cấu hình riêng — nó suy từ chính địa chỉ. Hai trường cho một sự
thật là hai trường sẽ lệch nhau.

**Khối két Prepaid** (`vault_type: "Prepaid"`, đường tài trợ PrepaidGen) có khuôn riêng,
quyết theo `vault_type` chứ không theo khoá nào có mặt:

```jsonc
{
  "vaults": [{ "vault_type": "Prepaid", "address": "addr_test1w…" }],   // Script(prepaid_vault)
  "paid_fund": { "address": "addr_test1w…",                            // BẮT BUỘC — Script(paid_fund)
                 "carp_unit": "<policy‖tên CARP>",                     // route /tx/sponsor/* cần; vắng ⟹ 501 CONFIG_MISSING
                 "sponsor": {                                          // ghim của T2; vắng ⟹ T2 trả 501 CONFIG_MISSING
                   "fund_units": ["<policy paid_fund‖fund_id>"],       // quỹ được nạp; policy phải là script paid_fund
                   "addresses": ["addr_test1v…"],                      // địa chỉ KHOÁ bên tài trợ, bech32 chính tắc, đúng mạng
                   "max_carp_amount": "1000000000" } },                // trần một lượt, CHUỖI 1–20 chữ số carpdrop, > 0
  "did_stake": { "anchor_nft_policy": "<56 hex>" },                    // T2 cần để định vị anchor DID
  "ref_script_utxos": {
    "vault": "…#0",       // ref-script prepaid_vault
    "paid_fund": "…#0",   // BẮT BUỘC — ref-script paid_fund
    "consume": "…#2"      // bản consume apply-param bằng hash két Prepaid
  }
  // KHÔNG có "shard_address" / "ref_script_utxos.shard": két Prepaid không có shard — khai ⟹ từ chối khởi động
}
```

Ba luật, mỗi luật từ chối khởi động khi vi phạm: két Prepaid không đứng chung khối với
loại khác (một ô `ref_script_utxos.vault`, một bản `consume` cho một loại két); khối không
phải Prepaid mà mang `paid_fund` là cấu hình lạc chỗ; khối Instant/Schedule vẫn **bắt buộc**
`shard_address` + `ref_script_utxos.shard` như cũ. Hiện chưa route nào dựng tx cho két
Prepaid ngoài `/tx/sponsor/*`: mọi route khác đụng tới nó trả `501 VAULT_KIND_UNSUPPORTED`. Bộ sinh:
`scripts/gen_vault_tx_api_deployment.ts --vault Prepaid`.

> Mọi địa chỉ và UTxO ở đây là **bản chép**: nguồn thật là lần deploy (`aiken build` +
> apply-param). Nên `source` là bắt buộc và `/health` in lại nguyên văn. Không có nhãn thì
> vài tháng nữa không ai trả lời được câu *"địa chỉ này còn đúng không"* — và một địa chỉ
> hết đúng thì dịch vụ trả `VAULT_NOT_FOUND` mãi mãi, im lặng, giống hệt "chủ này chưa có
> vault".

`ref_script_utxos` **không phải tối ưu**: đính kèm cả hai validator vào một giao dịch cho
**17 303 byte** đo thật trên Preview, vượt trần giao thức 16 384 — không có script tham
chiếu thì ScheduleCommit và Consume *không dựng nổi giao dịch nào*. Dịch vụ lấy chính
`scriptRef` từ các UTxO đó và **đối chiếu hash** với script hash của địa chỉ đang dùng;
lệch thì từ chối, vì một cấu hình trỏ nhầm sang lần deploy cũ vẫn dựng ra giao dịch trông
bình thường.

### Lệnh

```bash
npm install
npm test          # không cần mạng, không cần khoá — số bài: đọc dòng `Tests` của lệnh, đừng chép ra đây
npm run typecheck
npm start
```

---

## 7. 🔴 Một dữ kiện dịch vụ KHÔNG có: địa chỉ nhận tiền thừa

Khi app không gửi `change_address` (§3), yêu cầu chỉ mang khoá băm của chủ. Từ đó suy ra địa chỉ ví của người
dùng **chỉ đúng khi ví ấy là địa chỉ enterprise của đúng khoá đó**. Ví dùng địa chỉ **base**
(có phần stake) thì địa chỉ suy ra là một địa chỉ **khác**: tiền thừa rơi vào chỗ người dùng
không kiểm soát bằng ví đang dùng, và không có gì kêu lên cho tới khi họ đi tìm số dư.

Nên `VAULT_TX_API_CHANGE_ADDRESS_STRATEGY` **không có mặc định**. Người vận hành phải viết
ra chiến lược, tức phải biết mình đang khẳng định điều gì về ví của app. Hiện có đúng một
giá trị: `enterprise_from_owner_pkh`. `/health` in lại chiến lược đang chạy.

App nay gửi được `change_address` của chính nó (§3), và nên gửi. Chiến lược suy địa chỉ
chỉ còn áp cho chủ khoá không gửi trường đó; chủ script và `/tx/create-vault` luôn đòi nó.

Mục `did_stake` tuỳ chọn của `VAULT_TX_API_DEPLOYMENT`:

```jsonc
"did_stake": {
  "anchor_nft_policy": "<56 hex thường>",                    // tham số theo mạng của did_stake
  "unapplied_script": { "cbor": "<hex>", "hash": "<56 hex>" } // tuỳ chọn — bật chủ {type:"did"}
}
```

Có thì đủ trường và đúng hình dạng, không thì cổng khởi động ném. `unapplied_script` là `did_stake`
CHƯA apply tham số, lấy từ sổ deploy của PhoenixKey-Validator cho đúng mạng; hai trường đi cặp (thiếu
một ⟹ lỗi cấu hình), và lúc khởi động dịch vụ băm lại `cbor` — lệch `hash` ⟹ **từ chối khởi động**
(mọi chủ DID sẽ được suy ra một script không phải của họ). Hash này đổi theo đời validator bên
PhoenixKey, nên nó chỉ sống ở cấu hình theo mạng, không ở mã. `scripts/gen_vault_tx_api_deployment.ts`
**chưa** sinh mục này — xem §8.

---

## 8. Còn thiếu — nói thẳng, không để người sau tự phát hiện

- **`scripts/gen_vault_tx_api_deployment.ts` chưa sinh mục `did_stake`.** Chưa có nó thì mọi
  yêu cầu chủ script nhận `501`. Giá trị `anchor_nft_policy` thuộc bản deploy của repo danh
  tính; bộ sinh cần một nguồn đọc được cho nó trước khi thêm dòng này.
- **Trạng thái Active của anchor không kiểm off-chain.** Anchor bị thu hồi thì tx dựng xong
  vẫn bị `did_stake` từ chối lúc nộp, không phải lúc dựng.
- **Chưa có lượt nộp thật nào của đường chủ script hay `/tx/create-vault`.** Bài kiểm dùng
  bộ dựng ghi sẵn và nhân chứng giả; `SdkTxBuilder.createVault` chưa chạy trên Preview.

- **`funding` did_payment và `fee_payer` chưa qua Lucid thật, chưa lên chuỗi.** Bài kiểm của
  SDK dùng một trình dựng ghi lại lượt gọi, bài kiểm của dịch vụ đọc lại CBOR dựng bằng CML.
  Thế chấp được đặt tường minh (`fee_payer_collateral_lovelace`) chứ không để trình dựng tự
  chọn, và phép đọc lại CBOR ném `422` nếu thế chấp không lấy từ `fee_payer.utxo` hoặc
  `collateral_return` không về `fee_payer.address`. Chưa đo: ExUnit của `did_payment`; trạng
  thái Active của anchor không kiểm ở đây.
- **`fee_source: "did_payment"` chưa lên chuỗi, và dịch vụ chưa chạy nó qua Lucid.** Bài kiểm
  SDK (`MagicSDK/tests/didPaymentSelfFunded.test.ts`) dựng bằng Lucid thật, ngoại tuyến, với hai
  script luôn-đúng — nên nó kiểm HÌNH DẠNG giao dịch, không kiểm validator thật. Bài kiểm dịch vụ
  dùng CBOR ghi sẵn dựng bằng CML; `SdkTxBuilder.createVault` ở chế độ này chưa chạy lần nào. Chưa
  đo: phí thật khi đính inline vault + did_payment thật so với phần giữ chỗ 3 ADA; ExUnit.
- **Proxy phí mới chạy với Feecover giả.** Bài kiểm tiêm một `fetch` giả; chưa có lượt ký thật
  nào qua Feecover. Proxy không soi nội dung `witness_set` Feecover trả (chỉ đối chiếu
  `txHash`); app ghép rồi nộp, và nút chuỗi là nơi bác một chữ ký sai.
- **Sổ phát-hành và bảng giữ chỗ nằm trong bộ nhớ một tiến trình**, như khoá mềm: hai bản sau
  bộ cân tải thì `/fee/sign` chỉ nhận tx do chính bản đó phát.

- **`SdkTxBuilder` đã dựng giao dịch thật trên Preprod cho BỐN route, và chỉ bốn route đó.**
  Ngày 2026-09-27, trên một cụm tập dượt (tLAMP `8169b76c…`, chủ vault dạng khoá), dịch vụ
  chạy cục bộ đã dựng, được ký, nộp và vào khối: `create-vault` `7eed3990…` (khối 5225018),
  `instant-gen` qua `fee_payer` `66185661…`, `open-thread` qua `change_address` `a5c59940…`,
  `consume` qua `fee_payer` `64d33314…`. Hash đầy đủ tra được trên explorer Preprod theo tiền
  tố. Ba lỗi lộ ra ở lượt đó đã vá ở `370d3b49`.
  **Chưa chạy thật:** `schedule-commit`, `schedule-fire`, `burn-batch`, chủ dạng script
  (`did_stake`), `funding` did_payment (xem trên), và mọi route qua Feecover thật. Phần
  không-chuỗi (bộ định tuyến, khoá mềm, cổng cấu hình, đường `summary`) đo bằng CBOR thật dựng
  tại chỗ bằng CML.
- **Khoá mềm chỉ đúng với một tiến trình.** Hai bản sau bộ cân tải thì cần một chỗ giữ
  chung (Redis, hoặc một hàng đợi theo `owner_pkh`).
- **Cổng policy LAMP lúc khởi động chỉ chặn những gì ĐÃ BIẾT là sai.** `parseDeployment`
  nay gọi `assertLampPolicyId` (`MagicSDK/src/lampPolicy.ts`) — policy nhái đã biết và LAMP
  thật của một đời đã bị thay bị từ chối khởi động (`tests/config.test.ts` ▸ khối
  *"cổng policy LAMP"*). Nó KHÔNG chứng minh policy là chính danh: một policy nhái mới, chưa
  vào bảng, vẫn qua. Mẫu của bộ kiểm dùng một policy id **tổng hợp**
  (`tests/fixtures/preview.ts`), cố ý không phải giá trị có thật trên mạng nào, để không ai
  chép nhầm từ đó ra. Lối tập dượt (`lamp.rehearsal_ack`) là ngoại lệ **tạm**: policy Preprod
  cuối đã tới 2026-10-03, nhưng khoá `8169b76c…` còn giữ tới khi runner của cụm tập dượt dừng
  hẳn — gỡ khoá khỏi bảng của SDK là đủ, không phải sửa dịch vụ.
- **Thẻ bài là MỘT bí mật dùng chung, không gắn với `owner_pkh` nào.** Đường `/tx/submit`
  đã chặn việc mượn dịch vụ để nộp giao dịch lạ (chỉ nộp thứ chính nó vừa dựng), nhưng
  người cầm thẻ bài vẫn dựng được giao dịch mang `owner_pkh` của người khác và qua đó giữ
  khoá mềm của họ. Trạng thái và hình dạng bản vá ghi ở `DevStatus.md` ▸ Nợ #78.
- **Chủ có nhiều vault chưa dựng được.** Hiện trả `409 VAULT_AMBIGUOUS`. Gỡ nó cần một
  trường định danh vault trong thân bài — lại là một quyết định về hình dạng API.
- **Thread Engage chọn theo chủ, chưa theo app.** Một chủ dùng nhiều app thì có nhiều thread
  và phải gửi `engage_ref`; dịch vụ chưa tự biết *tiêu cho app nào*.
- **Chưa có bộ nhớ đệm.** Mỗi lượt dựng là vài lượt gọi Blockfrost.
- **Chỉ Blockfrost.** `ChainReader` là giao diện; thêm Kupo/Ogmios là thêm một lớp hiện
  thực, không phải sửa lõi.
- **`DecodedVaultDatum` (`src/vaultDatumShape.ts`) là bản chép hình dạng.** Lược đồ thì
  dùng lại của MagicSDK, nhưng kiểu `VaultDatum` mà SDK xuất là kiểu của **lược đồ**, không
  phải của **giá trị** giải mã ra (`Data.from<T>(raw, type?: T): T`). Cái canh bản chép ấy
  là `tests/summary.test.ts`: mẫu ở đó đi qua chính `Data.to(…, VaultDatumSchema)`, nên
  lược đồ đổi hình là mẫu đổi theo.

---

## 9. Vì sao KHÔNG nhập vào `VaultReadAPI`

`VaultReadAPI` cố ý **ĐỌC-THÔI**: chỉ `GET`, không nhận khoá, không dựng giao dịch, không
ghi gì. Thêm một đường ghi vào đó là phá đúng thuộc tính khiến nó an toàn — và thuộc tính
ấy đọc được từ bề mặt của gói, không phải từ một lời hứa trong tài liệu.

Hai gói đứng cạnh nhau, không gói nào phụ thuộc gói nào. Vài hằng của Preview trong
`tests/fixtures/preview.ts` là **bản chép có nhãn** từ bộ mẫu của gói kia, và nhãn ghi rõ
chép từ đâu, ngày nào.
