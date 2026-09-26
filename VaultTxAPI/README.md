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
POST /tx/instant-gen       { owner, [owner_witness], change_address | fee_payer }
POST /tx/schedule-commit   { owner, [owner_witness], change_address | fee_payer, schedule_length, lamp_per_epoch }
POST /tx/schedule-fire     { owner, [owner_witness], change_address | fee_payer, schedule_id }
POST /tx/consume           { owner, [owner_witness], change_address | fee_payer, op_type, op_count, [engage_ref] }
POST /tx/open-thread       { owner, [owner_witness], change_address }
POST /tx/create-vault      { kind, owner, [owner_witness], lamp_amount, change_address | funding, [profile] }
POST /tx/submit            { tx_cbor, witness_cbor }
POST /fee/utxo             { route }        [X-Feecover-Token]   — proxy ví trả phí, xem dưới
POST /fee/sign             { tx_cbor }      [X-Feecover-Token]
GET  /health
```

Chủ khoá được bỏ trống `change_address` (dịch vụ suy địa chỉ enterprise của khoá, §7); chủ
script thì phải gửi một trong hai trường.

Bốn đường dựng trên vault có sẵn trả:

```jsonc
{
  "tx_cbor": "84a4…",        // giao dịch CHƯA KÝ
  "tx_hash": "3f1c…",        // hash THÂN giao dịch — app đối chiếu sau khi ký
  "summary": { … },          // §2
  "expires_at": "2026-09-11T16:28:03.000Z",
  "ignored": [],             // UTxO ở địa chỉ vault cố ý không tính, kèm lý do
  "required_signers": ["…"], // đọc từ required_signers của CHÍNH tx_cbor
  "witness_notes": ["…"]     // việc phải làm ngoài chữ ký (chủ script: mục rút did_stake…)
}
```

### Chủ vault: `owner`, và bí danh `owner_pkh`

Chủ là một `Credential`, hai dạng:

```jsonc
"owner": { "type": "key",    "hash": "<56 hex thường>" }   // khoá thanh toán
"owner": { "type": "script", "hash": "<56 hex thường>" }   // script — hiện là did_stake của PhoenixKey
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
OWNER_AUTH_MISMATCH`, trước khi hỏi chuỗi bất cứ điều gì. Anchor phải mang tài sản dưới
`anchor_nft_policy` của mạng, không ⟹ `400 OWNER_ANCHOR_INVALID`. Tài khoản thưởng chưa đăng
ký ⟹ `422 OWNER_STAKE_NOT_REGISTERED`. Lượng rút là **đúng số dư thưởng lúc dựng** (ledger
đòi vậy), nên một ranh giới epoch có cộng thưởng xen giữa dựng và nộp làm tx hết hợp lệ —
dựng lại. Validator từ chối tx mang chứng chỉ đăng ký / huỷ đăng ký / uỷ thác cho chính
`Script(h)` — đó là hình dạng tx thu hồi, nên đổi vòng đời stake phải nằm ở tx riêng. Trạng
thái Active của anchor **không** kiểm ở đây: lược đồ datum anchor thuộc repo
danh tính, và `did_stake` từ chối trên chuỗi nếu anchor không Active.

Chủ khoá mà gửi `owner_witness` ⟹ `400 OWNER_WITNESS_UNEXPECTED`.

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
  "lamp_amount": "1001000000",                          // CHUỖI oildrop, > 0
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
               "lamp_deposit_oildrop": "…", "lamp_deposit_lamp": "…", "lovelace": "…", "ada": "…" },
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

### Ví trả phí bên thứ ba: `fee_payer`

Bốn đường dựng trên vault có sẵn (`instant-gen`, `schedule-commit`, `schedule-fire`,
`consume`) nhận `fee_payer` thay cho `change_address`:

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
(UTxO đang giữ cho ứng dụng khác). Feecover không trả lời trong hạn chót, trả 5xx, hoặc trả
thân sai hình dạng ⟹ `502 FEE_PROXY_UPSTREAM`.

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
| thiếu / sai `change_address` | `400 CHANGE_ADDRESS_REQUIRED` / `400 CHANGE_ADDRESS_INVALID` |
| `funding` sai hình dạng / trường lạ / chủ khoá thiếu anchor·controller·thiết bị | `400 FUNDING_SHAPE` |
| `did_payment_script_cbor` không băm ra payment credential `Script(h)` của `funding.address` | `400 FUNDING_SCRIPT_MISMATCH` |
| `fee_payer.address` không phải khoá / sai mạng; UTxO trả phí không ở đó hoặc không thuần ADA | `400 FUNDING_FEE_PAYER_INVALID` |
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
| chủ chưa có thread Engage | `404 ENGAGE_THREAD_NOT_FOUND` |
| chủ có nhiều thread, không kèm `engage_ref` | `409 ENGAGE_THREAD_AMBIGUOUS` |
| `/tx/open-thread` khi chủ đã có thread | `409 ENGAGE_THREAD_EXISTS` |
| `engage_ref` mang NFT nhưng datum không giải được | `422 ENGAGE_THREAD_DATUM_UNDECODABLE` |
| tx mở thread vừa dựng lệch (NFT / output / datum genesis) | `422 OPEN_THREAD_TX_MISMATCH` |
| `/tx/open-thread` kèm `funding` | `501 OPEN_THREAD_FUNDING_UNSUPPORTED` |
| `X-Feecover-Token` không khớp ứng dụng nào | `401 FEE_PROXY_APP_UNKNOWN` |
| ứng dụng chưa có mục đích cho route đó | `400 FEE_PROXY_PURPOSE_UNMAPPED` |
| mục đích thuộc ứng dụng khác / thiếu tiền tố tên ứng dụng | `403 FEE_PROXY_APP_PURPOSE` |
| `/fee/sign` cho tx không do dịch vụ phát, hoặc quá hạn ký | `403 FEE_PROXY_TX_NOT_ISSUED` |
| `/fee/sign` cho tx không dùng ví trả phí | `400 FEE_PROXY_NO_FEE_PAYER` |
| Feecover từ chối | mã 4xx của Feecover + `FEE_PROXY_REJECTED` |
| dịch vụ không cấu hình `feecover` | `501 FEE_PROXY_UNAVAILABLE` |
| Feecover không trả lời / 5xx / thân sai hình dạng | `502 FEE_PROXY_UPSTREAM` |
| Feecover ký một tx có hash khác | `502 FEE_PROXY_UPSTREAM_MISMATCH` |
| thiếu/sai thẻ bài | `401 UNAUTHORIZED` |
| chủ **chưa có** vault | `404 VAULT_NOT_FOUND` ← **không phải** `200` với tx rỗng |
| method sai | `405 METHOD_NOT_ALLOWED` |
| chủ đã có một tx dựng xong chưa nộp | `409 OWNER_TX_IN_FLIGHT` |
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

Nên `409 OWNER_TX_IN_FLIGHT`, và khoá **giữ tới lúc nộp**, không nhả ngay sau khi dựng:
nhả sớm thì không chặn được gì, vì UTxO vault vẫn chưa bị tiêu. Ba đường mở khoá:
`/tx/submit` đúng giao dịch đó · hết hạn (`VAULT_TX_API_LOCK_TTL_MS`, mặc định 180 s, cũng
là `expires_at`) · dựng hỏng thì nhả ngay.

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
| `VAULT_TX_API_TOKEN` | ngoài loopback thì **có** | rỗng |
| `VAULT_TX_API_BLOCKFROST_URL` | không | dẫn theo `NETWORK` |
| `VAULT_TX_API_TIMEOUT_MS` | không | `20000` |
| `VAULT_TX_API_LOCK_TTL_MS` | không | `180000` |
| `FEECOVER_APP_TOKEN` | khi cấu hình có `feecover.apps.magic` | — **GIÁ TRỊ** token ứng dụng Feecover (token API, không phải khoá ký) |

Cổng fail-closed lúc khởi động: thiếu biến bắt buộc · bind ngoài loopback mà thẻ bài rỗng ·
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
  "lamp":   { "policy_id": "28e916…", "asset_name_hex": "744c414d50" },
  "vaults": [{ "vault_type": "Schedule", "address": "addr_test1w…" }],
  "shard_address": "addr_test1w…",
  "ref_script_utxos": { "vault": "…#0", "shard": "…#1", "consume": "…#2" },
  "consume": {
    "engage_address": "addr_test1w…",       // thread Engage chọn theo chủ lúc chạy
    "price_beacon_address": "addr_test1w…", "price_beacon_nft_unit": "…"
  },
  "fee_payer_collateral_lovelace": "3000000",      // tuỳ chọn, CHUỖI; thế chấp khi có ví trả phí
  "did_stake": { "anchor_nft_policy": "<56 hex>" }, // tuỳ chọn — chủ script + funding did_payment
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
thread cố định chỉ phục vụ được một người). Trong `feecover.apps`, ứng dụng `magic` không có
`token_sha256` — token của nó vào qua `FEECOVER_APP_TOKEN`; ứng dụng khác khai SHA-256 của
token của họ, dịch vụ không giữ token đó. Mục đích cho `instant-gen` / `schedule-*` và
`open-thread` chưa có ở Feecover nên chưa có trong mẫu; route vắng khỏi bảng thì proxy trả
`400 FEE_PROXY_PURPOSE_UNMAPPED` cho tx của route đó.

`script_hash` **không** cấu hình riêng — nó suy từ chính địa chỉ. Hai trường cho một sự
thật là hai trường sẽ lệch nhau.

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
npm test          # 56 bài, không cần mạng, không cần khoá
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
"did_stake": { "anchor_nft_policy": "<56 hex thường>" }   // tham số theo mạng của did_stake
```

Có thì đủ trường và đúng hình dạng, không thì cổng khởi động ném. `scripts/gen_vault_tx_api_deployment.ts`
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
- **Proxy phí mới chạy với Feecover giả.** Bài kiểm tiêm một `fetch` giả; chưa có lượt ký thật
  nào qua Feecover. Proxy không soi nội dung `witness_set` Feecover trả (chỉ đối chiếu
  `txHash`); app ghép rồi nộp, và nút chuỗi là nơi bác một chữ ký sai.
- **Sổ phát-hành và bảng giữ chỗ nằm trong bộ nhớ một tiến trình**, như khoá mềm: hai bản sau
  bộ cân tải thì `/fee/sign` chỉ nhận tx do chính bản đó phát.

- **`SdkTxBuilder` CHƯA từng dựng một giao dịch thật trên chuỗi.** Nó qua `tsc --noEmit` và
  qua bài quét không-chạm-khoá, và nó gọi đúng bốn hàm của `@magiclamp/sdk` với chữ ký
  thật. Nhưng chạy nó cần một lần deploy sống (script tham chiếu, shard, beacon giá, thread
  Engage) mà lượt dựng gói này không có. **Đừng đọc "biên dịch xanh" thành "chạy đúng".**
  Phần đã đo bằng thực thi là: bộ định tuyến, khoá mềm, cổng cấu hình, và toàn bộ đường
  `summary` — chúng chạy trên CBOR thật dựng tại chỗ bằng CML.
- **Khoá mềm chỉ đúng với một tiến trình.** Hai bản sau bộ cân tải thì cần một chỗ giữ
  chung (Redis, hoặc một hàng đợi theo `owner_pkh`).
- **`lamp.policy_id` của tệp deploy chưa đi qua `assertLampPolicyId`.** Cổng ấy ở
  `MagicSDK/src/lampPolicy.ts` và nó chặn hai lớp giá trị mà mọi phép so hình dạng đều cho
  đi qua: policy nhái mang đúng chữ "tLAMP", và LAMP THẬT của một đời đã bị thay. Ở đây
  `parseDeployment` mới ép hình dạng (56 hex), tức đo một đại lượng khác. **Ràng buộc TẠM
  đang có hiệu lực (fail-closed):** `lamp.policy_id` là trường **bắt buộc** của tệp deploy
  — không có thì dịch vụ không khởi động, nên không có đường chạy bằng một giá trị mặc
  định. Mẫu của bộ kiểm dùng một policy id **tổng hợp** (`tests/fixtures/preview.ts`), cố
  ý không phải giá trị có thật trên mạng nào, để không ai chép nhầm từ đó ra.
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
