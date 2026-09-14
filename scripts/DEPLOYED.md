# Bản ghi triển khai testnet — MagicLamp

Toàn bộ giá trị dưới đây là **công khai** (policy id, script hash, tx hash). Không có
secret nào ở đây, và kho này cố ý không ghi ở đâu có.

Chạy lại: `bash scripts/run_wakeme_e2e.sh Preview` · `bash scripts/run_wakeme_e2e.sh Preprod`.

> 🔴 **TỆP NÀY LÀ ẢNH CHỤP, KHÔNG PHẢI BẢNG TRA.** Mọi hash và UTxO dưới đây đúng tại thời
> điểm ghi cạnh nó, và **hết hạn mà không có gì báo**. Script hash đổi mỗi lần sửa
> validator hoặc đổi apply-param; NFT one-shot đổi mỗi lần deploy lại; UTxO đổi ngay khi
> có người tiêu. Đã xảy ra thật ngay trong tệp này: cụm shard Preview có **hai đời**, và
> đời thứ hai cũng đã cũ kể từ `c84e2ff5` — xem mục "Shard trên Preview đã sang ĐỜI THỨ
> HAI" bên dưới.
>
> Nên: **đừng chép giá trị từ đây vào một lần chạy mới.** Lấy từ `scripts/state.<Mạng>.sh`
> do chính lượt chạy sinh ra, hoặc dựng lại rồi đọc `plutus.json`. Tệp này để trả lời câu
> *"lần đó ra cái gì"*, không trả lời câu *"bây giờ là cái gì"*.

> **Beacon `backing` là DỰNG-TẠM.** Nó không phản ánh dự trữ nào. `br_q = 2.0` là con số
> bịa để mở cổng fail-closed §6.3 trên testnet, và `deploy/04_deploy_backing_fixture.ts`
> từ chối chạy khi `NETWORK=Mainnet`. Beacon thật do phía CARP/CarpetMint phát.

---

## Tên hiện ra trong ví KHÔNG phải định danh — 27 dòng tài sản mang tên của hệ này

Định danh một tài sản trên Cardano là **cặp `(policy id, asset name)`**. Tên hiển thị là một
nửa của cặp đó, và là nửa **không mang thông tin**: ở dòng `4c414d50`, vế asset name đúng
với cả hàng thật lẫn hàng nhái. Cách phát biểu chặt — nhận từ nhà LAMP, thư `lamp0914mg-d`,
và đã chép vào `MagicSDK/src/lampPolicy.ts`:

> **policy id là điều kiện ĐỦ, và asset name KHÔNG BAO GIỜ là điều kiện đủ.**

### Kiểm kê dưới policy `28e916b0…`

`28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4` là **chính sách chữ-ký-đơn suy từ
khoá của một ví triển khai trong kho này**: không trần phát hành, không `SupplyState`, ai giữ
khoá thì đúc thêm tuỳ ý. Nó không phải policy của LAMP, và không bao giờ là. Mọi số đo trong
sổ này đo trên token đó.

Đo 2026-09-14 bằng Blockfrost `/assets/policy/{policy}` — **trọn danh sách, không cắt**:

| Preview — 19 dòng | | | Preprod — 8 dòng | | |
|---|---|---|---|---|---|
| `4c414d50` | LAMP | 3 000 000 000 000 | `70726f644c414d50` | prodLAMP | 1 000 000 000 000 |
| `744c414d50` | tLAMP | 36 000 000 000 000 000 | `744c414d50` | tLAMP | 36 000 000 000 000 000 |
| `546573744c414d50` | TestLAMP | 1 000 000 000 000 | `4532454e4f544c414d50` | E2ENOTLAMP | 36 000 000 000 000 000 |
| `4d41474943` | MAGIC | 1 970 000 000 | `4b484f` | KHO | 1 |
| `43415250` | CARP | 10 000 000 000 | `524547` | REG | 1 |
| `4e49474854` | NIGHT | 10 000 000 000 | `535550504c59` | SUPPLY | 1 |
| `4b484f` · `524547` · `535550504c59` | KHO · REG · SUPPLY | 5 mỗi dòng | `44524f50` | DROP | 1 |
| `44524f50` | DROP | 2 | `425251` | BRQ | 1 |
| `4c4d504d` · `4c4d5050` · `4c4d5052` | LMPM · LMPP · LMPR | 1 mỗi dòng | | | |
| `4d524f4f54` · `4e4f4e4345` · `505041524d` | MROOT · NONCE · PPARM | 1 mỗi dòng | | | |
| `444944616c696365` | DIDalice | 1 | | | |
| `454e47414745` · `425251` | ENGAGE · BRQ | 1 mỗi dòng | | | |

Hai dòng đáng đọc kỹ, vì chúng là hai kiểu hiểu sai khác nhau:

- **`tLAMP` mang TRỌN 36 tỷ trên cả hai mạng** (3,6 × 10¹⁶ oildrop ÷ 10⁶ = 36 × 10⁹ LAMP).
  Ai đọc chuỗi mà không đọc spec sẽ kết luận **ngược hẳn** mô hình phát hành: LAMP dùng
  lazy-mint, 36 tỷ là **trần**, và bộ đếm `SupplyState` mới là thứ cưỡng chế nó
  (`BOUNDARIES.md §1`). Dòng này không có `SupplyState` nào đứng sau.
- **`E2ENOTLAMP` trên Preprod** mang đúng con số ấy: nó là một mẫu thử của chính kho này,
  cố ý đặt tên để không ai nhầm — và nó nằm cạnh `tLAMP` dưới **cùng một policy**, tức chính
  sách đó không phân biệt được "hàng thử" với "hàng thật" bằng bất cứ thứ gì ngoài tên.

Một policy nữa đã chết nhưng còn trong danh sách từ chối của SDK:
`7a1a7aed5ec47acc37b6fa82695c1219bf76895b505b01161367adf9` — bản diễn tập đời trước, đã bị
thay.

### Dòng `LAMP` trên Preview — ba lượt đúc, trải 26 ngày

`/assets/{unit}/history`, mốc thời gian từ `/txs/{hash}` ▸ `block_time`:

| TX | Lượng | Thời điểm |
|---|---|---|
| `320fb82ba8a07ecb3a5abd298a431c65f523545fbb47dc410ba3fe81a11f1923` | +1 000 000 000 000 | 2026-06-01 02:18 UTC · block 4336523 |
| `b3b931be027a5ebb057e23c46eb18322da411311a3daa76d07234cf0a0011bed` | +1 000 000 000 000 | 2026-06-18 19:34 UTC · block 4395416 |
| `a39e81a3281c7be68e9f0dff24947eafeb8d227a90d02051d6d96c54f69bd798` | +1 000 000 000 000 | 2026-06-27 16:12 UTC · block 4421172 |

`mint_or_burn_count = 3`, không lượt đốt nào. Ba lượt riêng biệt cách nhau nhiều tuần với
cùng khối lượng chẵn **không phải một lần gõ nhầm tên**: đó là một bước lặp lại trong một
kịch bản chạy nhiều đợt. Policy suy từ khoá ví triển khai của kho này, nên đây là việc của
phía MAGIC, không phải của người lạ.

### Dòng `MAGIC` trên Preview — hoá thạch của một đời thiết kế đã chết

| TX | Lượng | Thời điểm |
|---|---|---|
| `17e62102c0749371d1284cee3f5fb4d0d8d36952893c259c766dbdbc88ec9dd0` | +1 000 000 000 | 2026-06-14 15:15 UTC |
| `76759176a18c9b5655b0cc2cca2fcdc23438dc8b97b3e1c04d39414dd1fb52ed` | +1 000 000 000 | 2026-06-14 15:16 UTC |
| `d599e05f72d490b2078ece5327f976dd19d91680deb60530bb1d543c24521f73` | **−30 000 000** | 2026-06-14 15:17 UTC |

Ba giao dịch trong **hai phút**, kết thúc bằng một lượt **đốt**. Lượt đốt nói rõ nó diễn tập
cái gì: **tiêu MAGIC bằng cách đốt native token** — mô hình đã bị bỏ, trước khi chốt
`Gen ≠ Mint`. Nó không phải ai đó dựng để giả mạo; nó là hiện vật của chính kho này, nằm lại
trên chuỗi.

### Mức đúng của việc này: va chạm không gian tên, KHÔNG chạm giao thức

Sự tồn tại của một native token tên `MAGIC` **không** làm sai bất biến *"MAGIC không phải
token"*. Bất biến đó là phát biểu về **hành vi của validator**, không phải phát biểu về trạng
thái của mạng Cardano — cùng dạng với việc đúc một token tên `BITCOIN` trên Cardano không
phá bất biến 21 triệu của Bitcoin. Một bản ghi trước của việc này đặt nó ở mức *"đụng thẳng
một bất biến"*; **mức đó sai và đã rút**, vì nó là lỗi phạm trù.

Phép so sánh trên chỉ đứng được khi hệ **không bao giờ tra tài sản theo tên hiển thị**, và
điều kiện ấy kiểm được. Đo trên mã nguồn ngoài `Legacy/`:

```
$ grep -rn "4d41474943" --include='*.ak' --include='*.ts' . | grep -v /Legacy/ | wc -l
0                          # hex của chữ "MAGIC" không xuất hiện ở đâu trong mã

$ grep -rn "assets\.quantity_of(" --include='*.ak' . | grep -v /Legacy/ | wc -l
63
$ grep -rn "assets\.quantity_of([^,]*,[^,)]*)" --include='*.ak' . | grep -v /Legacy/
                           # rỗng — không lời gọi nào thiếu vế asset_name

$ grep -rnE "asset_name ==|[^_.]name ==" --include='*.ak' . | grep -v /Legacy/ | wc -l
0                          # không chỗ nào so tên tài sản một mình
```

Đo lại 2026-09-14. Ba lệnh này là **phép đo**, không phải trạng thái chép lại — chạy lại được
nên nó không già đi. Con số 63 gồm cả lời gọi trong khối `test` của chính tệp validator; điều
đang khẳng định không phải con số đó mà là **lệnh thứ hai trả về rỗng**.

Rủi ro **thật** thì vẫn còn, và nó nằm **ngoài** giao thức: ví và explorer hiện chữ `MAGIC`
cho một tài sản chuyển nhượng được, nên luận cứ đối ngoại *"MAGIC không chuyển nhượng, chỉ
tiêu-dịch-vụ"* khó trình bày hơn. Đó là việc vá bằng thao tác on-chain và bằng một trang công
bố lớp tài sản chuẩn, **không vá bằng validator** — thêm một phép kiểm tên vào validator là
đem cái nửa không mang thông tin vào chỗ quyết định.

### Hệ quả còn đang sống trong sổ này

Vault ScheduleGen Preview `7c42ace98d077292bf89dd17437e12f0e4ecc6231c9c515701a49865` nhận
policy nhái làm **apply-param**. Apply-param là tham số lúc biên dịch: nó nướng vào bytes ⟹
vào script hash ⟹ vào địa chỉ. Nên vault đó **không** đổi sang policy LAMP thật được bằng
cách sửa cấu hình — phải biên dịch lại và công bố script tham chiếu CIP-33 mới.

Cổng chặn tái phát: `MagicSDK/src/lampPolicy.ts` ▸ `assertLampPolicyId`, gọi ở
`MagicSDK/src/validatorScripts.ts` ▸ `buildParamsList` — chốt duy nhất mà mọi apply-param của
SDK đi qua. Đó là cổng chống **tái phát một sai lầm đã biết**, danh sách ĐÓNG; nó không phải
cổng xác thực, và một policy chữ-ký-đơn mới từ ví khác vẫn đi qua được.

---

## Bản dựng — ba thứ phải đủ mới tái lập được một địa chỉ

Byte của validator do **mã nguồn × trình biên dịch × bộ tham số apply-param** quyết định.
Thiếu một trong ba thì "dựng lại script cũ từ git" là một cuộc dò tìm, và trên Cardano dò
sai nghĩa là ra một **địa chỉ khác** — tiền ở địa chỉ cũ không ai mở được nữa.

| Thứ | Ghim ở đâu | Cổng kiểm |
|---|---|---|
| trình biên dịch | `compiler = "v1.1.21"` trong 9 `aiken.toml` của project **và** `preamble.compiler.version` của blueprint | `npm run verify:toolchain` (trong `scripts/`) — hai vế |
| bộ tham số | `scripts/deployParams.ts` — dùng CHUNG cho deploy và verify | `npm run check:params` · `npm run verify:hashes` |
| commit của bản đã deploy | **chưa ghim** — xem cảnh báo dưới | — |

> ⚠ `compiler =` trong `aiken.toml` **không phải cổng**. Đo trên aiken v1.1.21: ghim sai bản
> chỉ in `⚠ aiken.toml demands compiler version v1.0.0, but you are using v1.1.21.` rồi
> `aiken check` vẫn **`exit 0`**. Vì vậy có `scripts/verify_toolchain.sh` — nó `exit 1`.
> Cổng đã nối vào `npm run deploy:all` nên chạy trước mọi bước deploy.

**Các mục Preview/Preprod bên trên deploy TRƯỚC khi có ghim này** ⇒ bản trình biên dịch
dựng ra chúng không được ghi lại, và commit dựng cũng không. Chúng là bản ghi *đã xảy ra*,
không phải bản ghi *tái lập được*. Mọi mục deploy từ đây về sau phải kèm cả ba dòng:

```
commit    <sha ngắn>
compiler  v1.1.21+42babe5      ← ĐỦ HẬU TỐ, chép từ preamble.compiler.version
tham số   <tên + giá trị từng apply-param, theo thứ tự plutus.json>
```

> **Hai dòng đầu nay do MÁY sinh, đừng chép tay.** `npm run record:build` (trong `scripts/`)
> đọc `plutus.json` của cả 9 module rồi ghi chuỗi trình biên dịch đủ hậu tố + hash từng
> validator vào [`scripts/BUILD-RECORD.md`](BUILD-RECORD.md) — tệp CÓ version-control.
> `npm run verify:build-record` so lại và **exit 1** khi khối đó cũ hơn hiện vật; bước sinh
> đã nối vào `npm run deploy:all`.
> Còn lại phải chép tay: **bộ tham số apply-param** và **tx hash**, vì hai thứ đó chỉ có
> nghĩa gắn với một lần deploy cụ thể.
> Hash trong bản ghi là hash **CHƯA apply-param** — nó ghim *mã nguồn × trình biên dịch ×
> thư viện*, KHÔNG phải địa chỉ. Địa chỉ vẫn do `npm run verify:hashes` đối chiếu.

**Vì sao phải chép tay chuỗi đó vào đây** (lý do gốc, nay chỉ còn áp cho phần tham số + tx hash)**.** `plutus.json` **không** được version-control
(`.gitignore:19`) — nên nó là hiện vật duy nhất mang bằng chứng phiên bản, mà lại nằm ngoài
lịch sử. Một lượt `aiken build` bất kỳ ghi đè nó và `git status` vẫn **sạch trơn**, không báo
gì. Hệ quả: cổng chỉ chứng minh được *"lần dựng này khớp lần dựng ngay trước"*, KHÔNG chứng
minh được *"script đang chạy trên chuỗi dựng bằng bản nào"*. Chuỗi bảo đảm đứt đúng ở giữa và
không ai thấy chỗ đứt. Chép chuỗi vào sổ này — thứ CÓ version-control — là mắt nối lại.

**Hai vế của cổng khác nhau chỗ nào.** `aiken.toml` chỉ giữ được **semver**, vì phép kiểm
phiên bản của aiken là semver và `+42babe5` không phải semver. Nên vế `aiken.toml` chặn ca
"thiếu ghim" và "lệch bản phát hành"; nó **không** phân biệt được hai bản aiken cùng nhãn
`v1.1.21` dựng từ hai commit khác nhau. Vế blueprint chặn đúng ca đó. Kiểm thật:

```
D. UMKeeper/onchain/plutus.json khai v1.1.21+deadbee, máy chạy v1.1.21+42babe5
   → "LỆCH BẢN DỰNG … dựng bằng v1.1.21+deadbee · máy đang chạy v1.1.21+42babe5"   exit=1
```

---

## Preview — 2026-08-12

| Thứ | Giá trị |
|---|---|
| Ví deploy | `addr_test1qqh9u9qc4l2q9eyzx2c58pmpqn9vvxy2gjux0lah2wp33axx7cqq55f75fypagzqnelz3uzwxf764qzjx8kvaaw3q3yq8fyl7p` |
| ⚠ Token nhái đã dùng (KHÔNG phải LAMP) | `28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4` · asset `744c414d50` (hiện ra chữ `tLAMP`) — chính sách chữ-ký-đơn suy từ khoá ví deploy: không trần, không `SupplyState`, đã có lúc lên 72 tỷ. Mọi số đo ở bảng này được đo TRÊN token đó. |
| UM NFT policy | `85a89ded99d41e916dfbe872ae06d0dca6748338caeff10c405e2007` |
| UM script hash | `eb8b66b61636dde5ac73d2ca5c9c17f181205731d35483b4bfac716d` |
| Shard NFT policy | `67368ae03ab71778b28a87eb2c51b0942ddd1319e43967c6ebffcf8a` |
| Shard script hash | `165b30aaac98dd7bff1e95e9312e4619da3e0adc55255e33ec6057e0` |
| Backing beacon script (dựng-tạm) | `9788cd32aa4b695dff6d98c8d7805d5b758099139695fe6bff5c3902` |
| Vault ScheduleGen | `7c42ace98d077292bf89dd17437e12f0e4ecc6231c9c515701a49865` |
| Vault InstantGen | `61a736e585d92a1145981f40262f489844565885f0008af544abb1cf` |

**ScheduleCommit chạy được, tx thật:**
`9506bd3677aff5ed49b89ecf31c4d67d42180514c869b555cb560c07da5be575`
— L=10, λ=1 tLAMP, khoá 10 tLAMP, `rate_locked_q = 8_000_000_000`, shard 6/16,
schedule `0e8bde1cf2dc5997…`, fire đầu tiên epoch 20679.

**Chạy lại trọn chuỗi 2026-08-13** (00 → 0a…0e → 07 → commit → fire → 05 → instant),
vault mới, cùng kết quả:

| Bước | TX |
|---|---|
| vault ScheduleGen (07) | `eb32aa5801fff0e689b560ea662a7ec5168eddd0c43853cc5849f4800d106d4f` |
| ScheduleCommit | `80632ebfd5e65f6a1694c4c76f233ee77d82bab3a2d76620fab9ccf5ec814608` |
| BackingBeacon làm mới (04) | `9a60b79a0d5d2f445d4d9f57296d569bc06c4daa87ddaa8be398ed701beb6c61` |
| vault InstantGen (05) | `1fade5a23f18a992fd7e17c797b2e118f3b50648b154dcb2652c6ae6d7c92d51` |

Script tham chiếu CIP-33 dùng lại, không dựng mới:
`REF_VAULT_SCHEDULE_UTXO=d16d9a2384e91a4a6abd955b6a05e3cc11993c98a24be32990d5bd55f028a085#0` ·
`REF_SHARD_UTXO=5458caa235ac2326b1dbe13f0d445d2d6c16b96ba5277377818bb971b1606648#0`

### Shard trên Preview đã sang ĐỜI THỨ HAI — và đời thứ hai cũng đã cũ

Bảng trên là **đời 1**. Trạng thái cục bộ `scripts/state.Preview.sh` (ghi 2026-08-26, tệp
này bị gitignore nên không ai ngoài máy đó thấy) mang một bộ khác:

| Thứ | Đời 1 — 2026-08-12 | Đời 2 — 2026-08-26 |
|---|---|---|
| Shard NFT policy | `67368ae03ab71778b28a87eb2c51b0942ddd1319e43967c6ebffcf8a` | `98eb1bcb8e3f6970640ef2d28d50f38f84d1a9dc393139d03438609d` |
| Shard script hash | `165b30aaac98dd7bff1e95e9312e4619da3e0adc55255e33ec6057e0` | `f5769884276a51dd92258a87aa66fbf403087221de300a936785298f` |

`LAMP_POLICY_ID`, `UM_DATUM_HASH`, `UM_NFT_POLICY_ID` thì **không đổi** giữa hai đời — nên
thứ trôi là riêng cụm shard.

Ba điều đọc thẳng từ đó:

1. **Shard là one-shot, không mint lại được.** `shard_nft` nhận `genesis_ref` làm apply-param,
   nên mỗi lần dựng lại là một policy id mới và 16 NFT mới. 16 NFT của đời 1 vẫn nằm trên
   Preview, ở địa chỉ `165b30aa…`, và không validator nào đang chạy còn trỏ tới chúng. Chúng
   không mất — chúng mồ côi. Muốn dùng lại phải deploy lại đúng bản dựng đời 1, mà điều đó
   đòi ghim đủ ba thứ ở mục "Bản dựng" đầu tệp này.
2. **Đời 2 cũng đã cũ tính tới 2026-08-27.** `c84e2ff5` sửa `shard_nft.ak` (ràng datum khởi
   tạo, Nợ #33) ⟹ bytes biên dịch đổi ⟹ policy id đổi ⟹ `shard` (nhận `shard_policy_id` làm
   apply-param) đổi hash theo. Lần dựng tiếp theo trên Preview sẽ ra **đời 3**. Đừng dùng
   `f5769884…` làm mốc để nối tiếp việc.
3. **Vì sao ghi vào đây chứ không để trong tệp trạng thái.** `scripts/state.*.sh` là trạng
   thái cục bộ của MỘT máy, bị gitignore. Bản sao lưu `state.Preview.sh.bak-2026-08-20` từng
   là nơi duy nhất còn giữ cụm đời 1 ngoài tệp này — đã đối chiếu từng dòng, nó không mang
   dữ kiện nào mà bảng đời 1 ở trên chưa có, nên đã xoá để hai bản khác nhau thôi nằm cạnh
   nhau gây đọc nhầm.

## Preprod — 2026-08-12

| Thứ | Giá trị |
|---|---|
| Vault InstantGen | `94c0c8b232ff857595e1eb791c3866190a464fa8875c9f3b3ec76566` |
| Vault InstantGen (địa chỉ) | `addr_test1wz2vpj9jxtlc2av4u84hj8pcvcvs53j04zr4e8em8mrk2eskv53yn` |
| UM script (địa chỉ) | `addr_test1wryp6zjpejeysl9hvjfr7q0qf2zpn5faqjz6z6kq2j2ujdghvwvcw` |

**ScheduleCommit chạy được, tx thật:**
`8ffe6dc7288ac6b33e0599d093c1f8d71dc22e39fe2d7e28fff32d99abaa29dc`
— schedule `3649a67d9d6dd808…`, cùng tham số, cùng shard 6/16.

**Chạy lại trọn chuỗi 2026-08-13**, vault mới, cùng kết quả:

| Bước | TX |
|---|---|
| ScheduleCommit | `cc632831f56c584135f49aabc496b62867d657e14bbad4a87d37470b2142990c` |
| BackingBeacon làm mới (04) | `1903cef71d803d14db64f254bcb5768195f711fd7efb7b9db4761681ed320acd` |
| vault InstantGen (05) | `27530d3e884c10dc8711ac399be7c498641e4a450809f80e55b70fff70c4fba6` |

| Thứ | Giá trị |
|---|---|
| UM NFT policy | `8bd51c8ed0ae559acf13e7d12801e2635fe4ae30b8fe62a416cb6a25` |
| UM script hash | `c81d0a41ccb2487cb764923f01e04a8419d13d0485a16ac05495c935` |
| Shard NFT policy | `b6ea66ab9fe55747930294be0a74bc4eba1136c72e90c0585ee2bf7b` |

---

## Ba kết quả, đọc thẳng

**1. ScheduleGen ✅ chạy trên cả hai mạng.** Người dùng nạp LAMP (kể cả LAMP mượn-Wakeme)
vào vault ScheduleGen rồi cam kết lịch — tx đi qua thật, `gen_schedules` được ghi, shard
tổng hợp cập nhật, rate khoá vĩnh viễn theo T8.

**2. ScheduleFire ✅ Preview — đã bắn 8 lượt, sinh 64.000.000 nanogic.**

> Dòng cũ ở đây ghi *"⏳ chưa tới hạn"* kèm `No eligible fires: next fire at epoch 20679,
> current=20677`. Câu đó **đúng lúc chạy và sai từ lâu**: lịch đã tới hạn rồi bắn. Sổ này
> không được cập nhật sau lượt bắn, nên nó ghi một trạng thái CHỜ cho một việc ĐÃ XONG —
> và không có gì kêu lên. Đây đúng lớp "trạng thái chép lại thì già đi, phép đo thì không".

Đo lại trực tiếp trên chuỗi 2026-09-11 (`VaultReadAPI` ▸ `npm run probe`, Preview):

```
schedule_id            88ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3e
commit_epoch           20691      start_fire_epoch  20693     end_fire_epoch  20702
schedule_length        10         fired_count       8
lamp_per_epoch_oildrop 1000000    rate_locked_q     8000000000
accrued_nanogic        64000000   available_nanogic 0         expired_nanogic 64000000
```

**Cách kiểm lại** (phép đo, không phải trạng thái chép — nên nó không già đi):
`npm run probe -- <owner_pkh>` trong `VaultReadAPI/`, đọc trường `fired_count`.

🔴 **Nhưng cả 64 triệu nanogic đó đã hết hạn, và đó là phát hiện đáng nói hơn lượt bắn.**
`decay_window = 1` (`ScheduleGen/…/constants.ak`) ⟹ mỗi batch sống đúng **một** epoch
(`expires_at_epoch: 20701`, `live: false`). Người dùng sinh được MAGIC rồi mở ứng dụng muộn
một epoch là số đó bằng 0 — không phải lỗi đọc, mà là hệ quả của hằng số. Xem Nợ #46.

Hệ quả cho nghiệm thu: **không thể nghiệm thu ScheduleGen trọn vòng trong một buổi** —
`SCHEDULE_DELAY = 2` epoch với `ms_per_epoch` testnet = 86 400 000 (1 ngày) ⇒ chờ ~2 ngày
sau commit mới bắn được, rồi chỉ còn ~1 epoch để tiêu trước khi hết hạn.

**3. InstantGen ❌ không mở được, và không phải vì cấu hình.** Đo giống hệt nhau trên cả
hai mạng, hai ngày, bốn vault khác nhau: `reward=0 cap_surplus=33333333333 cap_pp=0`.
Beacon dựng-tạm ĐÃ mở cổng thặng dư (cap_surplus > 0), nên cái chặn nằm ở hai vế kia.
**HAI khoá độc lập, không phải một** (soát lại 2026-08-13):

- `cap_pp = 0` — `gen_schedules` bị genesis ép rỗng và không nhánh nào của validator
  InstantGen ghi vào được.
- `reward = 0` — `consumed_credit` chỉ tăng ở `BurnBatch`, mà `BurnBatch` cần
  `magic_batches` khác rỗng, mà `magic_batches` chỉ được ghi ở chính nhánh `InstantGen`.
  Vòng tự-tham-chiếu.

Vá `cap_pp` một mình KHÔNG mở được cửa. Xem `DevStatus.md` Nợ #19 + D1.

**Hệ quả cho thứ tự thao tác của người dùng:** InstantGen là **khoản ứng trước** trên dòng
ScheduleGen đã cam kết, không phải cửa độc lập. Kể cả sau khi vá, thứ tự tối thiểu vẫn là
`Wakeme → ScheduleCommit → chờ 2 epoch → ScheduleFire → BurnBatch → InstantGen`.
