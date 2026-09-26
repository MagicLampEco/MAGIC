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
>
> 🔴 **Và một script hash không nói được MẠNG, cũng không nói được ĐỜI.** Hai vế, vế thứ hai
> hay bị bỏ. Hash là hàm của *bytes validator sau khi apply-param*, nên hai đời trên **cùng một
> mạng** ra hai hash khác nhau — và điều đó có nghĩa là bạn không thể đi ngược: cầm một hash
> trong tay, tệp này là thứ duy nhất nói nó thuộc đời nào. **Tra theo MỤC ĐỜI, đừng tra theo
> hash.**
>
> `ms_per_epoch` cũng không phân biệt hộ: hai đời Preprod trong chính tệp này mang **cùng**
> giá trị đó mà khác hash — mục *"Preprod — 2026-08-12 · ĐỜI ĐÃ MỒ CÔI"* (`c81d0a41…`) và mục
> *"Preprod — đời tLAMP THẬT, 2026-09-16"* (`8fe2ae7d…`). Chọn nhầm đời không báo lỗi lúc dựng
> giao dịch: nó dựng xong, ký xong, rồi chết ở tầng sổ cái.
>
> Chiều NGƯỢC LẠI — *"hai lượt deploy có thể trùng hash không"* — thì **không**, và đừng dựng
> cảnh báo cho nó: mỗi lượt deploy tiêu một UTxO khác nhau cho NFT one-shot, mà UTxO tiêu được
> đúng một lần, nên một tham số one-shot khác nhau đã đủ làm bytes khác nhau. Cảnh giác đặt ở
> chiều đó là cảnh giác cho một ca không xảy ra được.

> **Beacon `backing` là DỰNG-TẠM.** Nó không phản ánh dự trữ nào. `br_q = 2.0` là con số
> bịa để mở cổng fail-closed §6.3 trên testnet, và `deploy/04_deploy_backing_fixture.ts`
> từ chối chạy khi `NETWORK=Mainnet`. Beacon THẬT do **keeper tầng GreenBack của chính kho
> này** ghi (`BOUNDARIES.md` ▸ *"`B` là một DANH MỤC token"*, chủ dự án chốt 2026-09-18;
> khoá ký là `greenback_beacon_writer`, SPEC v2.0 §6.3) — **không** phải thứ chờ nhà CARP
> giao. Còn nợ là một lượt ghi THẬT trên mainnet, và nó nằm trong tầm tay kho này.

---

## Tên hiện ra trong ví KHÔNG phải định danh — 27 dòng tài sản mang tên của hệ này

Định danh một tài sản trên Cardano là **cặp `(policy id, asset name)`**. Tên hiển thị là một
nửa của cặp đó, và là nửa **không mang thông tin**: ở dòng `4c414d50`, vế asset name đúng
với cả hàng thật lẫn hàng nhái. Cách phát biểu chặt — nhận từ nhà LAMP, thư `lamp0914mg-d`,
và đã chép vào `MagicSDK/src/lampPolicy.ts`:

> **policy id là điều kiện ĐỦ, và asset name KHÔNG BAO GIỜ là điều kiện đủ.**

### Ca mạnh nhất cho câu trên KHÔNG phải hàng nhái — là hai hàng THẬT

Kiểm kê dưới đây nói về một policy chữ-ký-đơn đúc hàng nhái, và ca đó dễ bác: *"ai lại đi tra
tài sản bằng tên"*. Ca sau thì không bác được, vì **cả hai bên đều hợp lệ** và không bên nào
làm gì sai.

Engine CARP dựng hai thực thể trên Preprod — một đang phục vụ, một chỉ dùng một lần để diễn
tập. Hai token neo của chúng (đo 2026-09-24, đọc từ sổ trạng thái của kho đó):

| thực thể | policy id | asset name |
|---|---|---|
| đang phục vụ | `86ea67178d3739965449535eb1f875b37ba2eede4ee5781f89bc310b` | `110d0c97df39bcee5ca6875485c493e7cd7608cac38c84b281d18c4f` |
| diễn tập | `3016010d2ba7a6c112c2dd8958da8b3ab4e4f4ae63d3cc60fdb5674d` | `110d0c97df39bcee5ca6875485c493e7cd7608cac38c84b281d18c4f` |

**Asset name trùng BYTE-CHO-BYTE, và trùng là ĐÚNG**: nó là `blake2b_224(instance_tag ++ did)`,
mà hai thực thể dùng cùng tag và cùng DID. Không ai đúc nhái; hàm băm làm đúng việc của nó.

Ba điều rút ra, và điều thứ ba mới là điều đắt:

1. Kho này miễn nhiễm ở tầng giao thức — policy khác nhau, và mã không bao giờ tra theo tên.
2. Một phép so **HOẶC** (`policy khớp` ∨ `tên khớp`) qua được mọi lần thử trên dữ liệu thật
   rồi hỏng đúng ở ca này. Đó là lý do câu bất biến viết là *"asset name không bao giờ là
   điều kiện đủ"* chứ không phải *"đừng tin tên"*.
3. **Một hàm băm xác định thì trùng tên là hệ quả THIẾT KẾ, không phải tai nạn.** Nên ca này
   tái diễn mỗi lần một thực thể được dựng lại với cùng tag + DID — nó không hiếm dần theo
   thời gian như hàng nhái, nó xuất hiện đúng theo lịch triển khai.

Cặp định danh dùng cho `carpAssetClass(network)` là hàng **đang phục vụ**; đời BASE mới sẽ
kèm cặp mới trước lượt chuyển đầu tiên.

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

Một policy nữa, và dòng cũ ở đây tả **sai theo hướng làm nhẹ đi**:
`7a1a7aed5ec47acc37b6fa82695c1219bf76895b505b01161367adf9`.

Bản cũ gọi nó là *"policy chữ-ký-đơn đã chết — bản diễn tập đời trước, đã bị thay"*. Hai
chỗ sai, đo lại trên Koios Preprod 2026-09-16:

- **KHÔNG phải chữ-ký-đơn.** `POST /script_info` trả `"type": "plutusV3"`; nó do `lamp_mint`
  bản 12 tham số đúc. Chỗ "native-sig" có thật nhưng nằm ở **bốn khe marker**
  (thread/registry/kho/meter), trỏ vào policy native-sig của ví deploy — không phải ở policy
  LAMP. Khác biệt này không phải chuyện chữ: chính sách chữ-ký-đơn thì đọc điều kiện đúc
  bằng mắt, còn Plutus thì **không ai biết có trần phát hành hay không nếu chưa giải mã
  2.919 byte script**.
- **KHÔNG "đã chết".** Vì bốn khe marker là native-sig, mà native-sig **không one-shot**,
  người giữ MỘT khoá đúc lại được SUPPLY NFT lượt hai, dựng `SupplyState` thứ hai với
  `dist_minted = 0`, rồi đúc lại **trọn cap**. Tức nó **không có trần phát hành thực thi
  được** — một câu mạnh hơn "đã chết", theo chiều xấu. `/asset_info`: `total_supply`
  10 000 000 000 · `mint_cnt` 1 · `burn_cnt` 0 · tạo 2026-07-13T16:03:33Z.

Và nó **không phải hàng nhái** — nó là một đời LAMP THẬT đã bị thay. Xếp nó vào danh sách
hàng nhái là xếp sai chỗ, lần sau tra không ra. Kho này đã tách đúng hai bảng từ trước
(`scripts/config.ts` ▸ `NON_LAMP_LOOKALIKE_POLICIES` so với `SUPERSEDED_LAMP_POLICIES`);
chỉ dòng sổ này còn kẹt ở bản cũ. Nguồn phân loại: kho LAMP ▸
`Genesis/offchain/src/lampPolicies.ts` ▸ bản ghi `preprod-native-sig-12param`, trạng thái
`SUPERSEDED`.

> Dòng sai ấy đang nói rằng một rủi ro **đã được hiểu**, trong khi nó chưa. Đó là kiểu sai
> đắt hơn một dòng trống. Hai nhà khác tìm ra nó độc lập trong cùng một ngày, mỗi nhà một
> phép đo riêng — và cả hai đều đọc dòng này trước khi đo.

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

$ grep -rnE "asset_name ==|[^_.]name ==" --include='*.ak' . | grep -v /Legacy/ | wc -l
0                          # không chỗ nào so tên tài sản một mình

$ python3 scripts/measure_asset_pair_arity.py
lời gọi assets.quantity_of : 51
  trong đó trải nhiều dòng : 4   (grep một dòng không đọc được)
  truyền đủ (value, policy_id, asset_name) : 51
  ✓ không lời gọi nào tra tài sản bằng policy id một mình
exit=0
```

Đo 2026-09-14. Đây là **phép đo**, không phải trạng thái chép lại — chạy lại được nên nó
không già đi.

> 🔴 **Vế thứ ba KHÔNG đo được bằng grep, và bản đầu của khối này đã đo bằng grep.**
> `assets.quantity_of(value, policy_id, asset_name)` nhận ba tham số; một phép grep một dòng
> không đọc được lời gọi trải nhiều dòng, nên nó trả về "sạch" cho một tập nó **chưa hề nhìn
> thấy**. Ở kho này có **4 trên 51** lời gọi như thế. Nhà LAMP nêu đúng chỗ hở này (thư
> `lamp0914mg-e`) khi tự đo kho của họ; câu đó áp cho cả hai nhà. Nay đo bằng phép cân ngoặc
> (`scripts/measure_asset_pair_arity.py`), đếm dấu phẩy ở mức ngoài cùng và bỏ dấu phẩy đuôi.
>
> Bản grep còn đếm đôi: `.claude/worktrees/` là **bản sao của chính kho này**, nên mọi con số
> quét toàn kho phải loại nó ra — không loại thì `51` thành `114`.
>
> **Và chỗ mù KHÔNG nằm ở phép ĐẾM — nó nằm ở phép SOI VẾ** (nhà LAMP sắc hoá, thư
> `lamp0914mg-f`, sau khi họ tự đo lại kho của họ: 98 lời gọi, 7 trải nhiều dòng, 0 thiếu vế).
> Grep đếm đúng số lời gọi, vì mỗi lời gọi bắt đầu ở một dòng nào đó; cái nó không làm được là
> **đọc đủ ba tham số** của những lời gọi trải nhiều dòng. Phân biệt này đổi cách đọc kết quả:
> một phép đếm bằng grep ra **đúng số** vẫn là một phép đo mù về điều đang hỏi, và nó mù một
> cách đặc biệt thuyết phục — con số khớp với bản cân ngoặc, nên **không có gì lệch để mà thấy**.
> Ai đối chiếu hai phép đo bằng cách so con số tổng sẽ kết luận cả hai đều đúng.
>
> Rút thành câu dùng được, đứng cạnh câu về policy id — cũng nhận từ nhà LAMP:
> **kiểm ĐỊNH DẠNG không bao giờ thay được ĐỐI CHỨNG.** Một giá trị chép nhầm luôn đúng định
> dạng, vì nó từng là một giá trị thật. Đó đúng là giới hạn của `assertLampPolicyId`: nó là
> danh sách từ chối cộng phép kiểm hình dạng, **không** phải phép đối chứng.

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

#### Cho việc rút đời-một về: đo 2026-09-14, và chỗ chặn KHÔNG nằm ở chỗ tưởng

Địa chỉ của vault đời-một trên Preview là
`addr_test1wp7y9t8f35rh9y4l38w3wsm7ztcwfmxxyvwfc52hqxjfseg6n5czz` (script-enterprise, suy
từ hash ở trên). Đo thẳng trên chuỗi hôm nay:

| | |
|---|---|
| UTxO vault đang nằm ở đó | **5** |
| Σ tLAMP **nhái** (`28e916b0…`) | **5005** |
| Σ `lamp_locked` | **30** — nằm ở 3 trong 5 vault, mỗi cái 10, mỗi cái 1 lịch |
| 2 vault còn lại | `lamp_locked = 0` ⟹ rút thẳng được, không cần fire |

Con số này **không mới**: `scripts/run_schedule_fire.sh` đã ghi đúng nó từ 2026-08-16, cùng
nguyên nhân — mỗi lượt nghiệm thu trọn chuỗi lại đẻ một vault mới. Hai phép đo độc lập, cách
nhau gần một tháng, ra cùng một con số. Đây là rác nghiệm thu trên một token nhái, **không
phải tài sản của ai**.

**Đường ra còn sống.** `l_avail = lamp_balance − lamp_locked` (`ScheduleGen/…/vault.ak` ▸
`validate_withdraw_lamp`, chốt W-3), nên 30 đang khoá kia chỉ hạ được ở `validate_fire`, mà
fire cần shard **cùng đời** với vault. Đo cùng ngày: cả hai đời shard trên Preview đều còn
nguyên **16/16** UTxO — đời ghi ở bảng trên (`165b30aa…`,
`addr_test1wqt9kv924jvd67llr627jvfwgcva50s2m32j2h3na3s90cqxntmgk`) lẫn đời ghi ở
`state.Preview.sh` (`f5769884…`). Nên đường fire→withdraw đi được: ~2 giao dịch fire mỗi
vault khoá (`max_fires_per_tx_catchup = 8`, mỗi lịch 10 lượt) cộng 5 lượt withdraw.

🔴 **Nửa CÔNG BỐ từng bị chặn, và chặn có chủ ý — trên Preview thì vẫn chặn.** Muốn có
vault đời-hai thì phải apply-param một policy id LAMP thật theo mạng, mà
`scripts/state.Preview.sh:3` **cố ý không giữ giá trị nào**, và `assertLampPolicyId` ném
đúng vào `28e916b0…` là thứ duy nhất kho này có cho mạng đó.

> **Trên PREPROD thì chỗ chặn này đã mở, 2026-09-16.** Kho LAMP đã đúc đời
> `preprod-oneshot-14param` (`8169b76c…`) và đã chuyển 30.000 tLAMP thật sang ví deploy.
> Câu *"kho LAMP chưa đúc"* ở bản trước của dòng này nay **sai** cho Preprod và vẫn
> **đúng** cho Preview — một câu, hai mạng, hai giá trị chân lý. Đời Preprod mới ghi ở
> mục *"Preprod — đời tLAMP thật"* bên dưới.

Hệ quả về THỨ TỰ, viết ra vì nó ngược với trực giác "dọn trước cho sạch": rút đời-một về
**trước** khi có đời-hai không thu lại giá trị nào (token nhái), mà bỏ lại một khoảng không
có vault ScheduleGen nào chạy được trên Preview — dài bằng thời gian chờ kho LAMP, tức
không có hạn. Việc rút nên đi **cùng đợt** với việc công bố đời-hai, không đi trước nó.

---

## Bảng giá đang deploy — một số `op_type` LẠ không ném lỗi, nó trả giá của mã khác

Rủi ro này không nằm trong kho, nên không phép kiểm nào ở đây bắt được, mà nó đáp xuống đúng
bảng giá đang chạy. Ghi ở đây vì đây là sổ của những thứ **đã deploy**.

`pricePerOp(op_type, …)` tra bảng theo số. Một bên tích hợp gửi số `3` thì hàm trả giá của
dòng `3` **trong bảng này** — nó không biết, và không thể biết, bên kia định nghĩa số 3 là gì.
Không có nhánh lỗi nào cho "mã không phải của bạn": nhánh duy nhất ném lỗi là "số không có
trong bảng".

Ca cụ thể, đếm 2026-09-24: một đặc tả ngoài kho tự đánh số và dùng **3** cho một nghiệp vụ
neo-ngay, trong khi dòng `3` của bảng đang deploy là `recognition_storage_event`, giá 1 MAGIC
(nguồn của bảng: `scripts/deploy/09_deploy_consume.ts`). Nếu bên đó phát số 3 ra thực địa,
mỗi lần neo sẽ thu **1 MAGIC** thay vì giá của chính nó, và cả hai phía đều thấy một giao dịch
hợp lệ. Bên đó hiện **chưa phát số nào** — chưa có chỗ nào trong mã của họ gán số cho `op_type`
— nên hôm nay chưa hỏng.

Hai điều phải giữ khi động vào bảng giá:

1. **Số trong bảng này chỉ có nghĩa khi nó đến từ sổ toàn hệ.** Một đặc tả tự đánh số là một
   không gian khoá thứ hai, và hai không gian khoá cùng đếm từ 1 thì va chạm là chắc chắn,
   không phải rủi ro.
2. **Đừng dựng cổng "từ chối mã lạ" ở tầng giá.** Validator không có cách nào biết ai được cấp
   số nào; cưỡng chế duy nhất về `op_type` trong mã là *không trùng TRONG MỘT bảng*. Chỗ chặn
   đúng là lúc cấp số, không phải lúc tra giá.

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

### Script hash KHÔNG nói được MẠNG, và cũng không nói được ĐỜI

Ba mục mạng dưới đây mỗi mục có một bảng hash. Đọc chúng theo chiều "hash này thuộc về đâu"
là đọc ngược: **hash là hàm của apply-param, không phải hàm của mạng.** Hai hệ quả, và cái
thứ hai mới là cái đã cắn một lần trong chính sổ này.

**(a) Hai mạng trùng tham số thì trùng hash.** `ms_per_epoch` của Preprod đổi thành
432.000.000 ngày 2026-09-20, bằng Mainnet. Với một validator mà `ms_per_epoch` là apply-param
DUY NHẤT khác nhau giữa hai mạng, hai mạng sẽ cho đúng một hash.

**(b) Nhưng phần lớn validator ở đây KHÔNG rơi vào (a) — và điều đó không an toàn hơn, chỉ
khác kiểu.** `UMKeeper/onchain/validators/um_datum.ak` ▸ `um_datum_validator` nhận **ba**
apply-param, trong đó `um_policy` là policy ONE-SHOT sinh từ một `genesis_ref` chọn lúc deploy
(`um_nft.ak` ▸ `um_nft`; `scripts/deploy/02_deploy_um.ts` ▸ `umDatumParams`). Một UTxO tiêu
được đúng một lần ⟹ **mỗi lượt deploy ra một hash khác, kể cả trên CÙNG một mạng với CÙNG
`ms_per_epoch`.**

Bằng chứng nằm ngay trong sổ này: mục *"Preprod — 2026-08-12 · ĐỜI ĐÃ MỒ CÔI"* và mục
*"Preprod — đời tLAMP THẬT, 2026-09-16"* cùng mạng, cùng nhịp epoch lúc đó, mà hai hàng
`UM script hash` khác nhau.

**Cách phân biệt, theo thứ tự tin cậy:** tx-hash trong mục deploy (gắn chặt một lần deploy)
→ địa chỉ bech32 (`addr_test…` vs `addr…`, phân biệt được mạng) → **script hash là thứ phân
biệt kém nhất**, đừng dùng nó làm khoá tra.

Ai vá một sự cố "hai mạng trùng hash" mà không đo trước xem validator đó có apply-param
one-shot nào không thì đang vá một thứ không hỏng, và cái giá là một đợt deploy lại.

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

## Preprod — 2026-08-12 · ĐỜI ĐÃ MỒ CÔI

> 🔴 **Mọi giá trị trong mục này dựng trên `28e916b0…`, KHÔNG phải LAMP.** Đó là chính sách
> chữ-ký-đơn suy từ khoá ví deploy — không trần, không `SupplyState`. Vì `lamp_policy_id` là
> apply-param (tham số lúc BIÊN DỊCH), mọi hash dưới đây là địa chỉ của một đời khác với đời
> đang chạy. Không dùng lại một giá trị nào ở đây. Đời đang chạy ở mục kế tiếp.
>
> Giữ mục này chứ không xoá, vì nó là thứ duy nhất giải thích được các UTxO còn nằm trên
> Preprod dưới những địa chỉ đó.

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

## Preprod — đời tLAMP THẬT, 2026-09-16

Đời đầu tiên của kho này dựng trên một policy LAMP thật. Nguồn giá trị:
kho LAMP ▸ `Genesis/offchain/src/lampPolicies.ts` ▸ bản ghi `preprod-oneshot-14param`,
trạng thái `ACTIVE`. **Bản sao có nhãn**, chép 2026-09-16 — không phải nguồn.

| Thứ | Giá trị |
|---|---|
| LAMP policy | `8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd` · asset `744c414d50` |
| UM script hash | `8fe2ae7dffab57a9ec03db6372d9f6633465d30bd52c3a80c3bdab53` |
| UM NFT policy | `057760113ea0a2f69566f8b3a07a505c7e2798d4d286343e0b89540a` |
| Shard script hash | `97e967d2570f195503dbcae9841e7d6ed776b49af4d82058f3234dfb` |
| Shard NFT policy | `e1642d073079945376e6b507d066c13fc8ac07a977b82863c2297e77` (16/16) |
| Vault ScheduleGen | `18375a7d46d4a1ba63e414c7cfa825a7de2531909769ee26534b3edd` |
| Vault ScheduleGen (địa chỉ) | `addr_test1wqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahga0t3ee` |
| ConsumeMAGIC script hash | `1d792c6f36828e45bd82212896ef95f3814a0a78ebf86b82c26cbb56` |
| ConsumeMAGIC (địa chỉ) | `addr_test1wqwhjtr0x6pgu3dasgsj39h0jheczjs20r4ls6uzcfktk4s6qqe4k` |
| PriceParam (địa chỉ) | `addr_test1wqhfsdg85h7ru6utfy8tts793trnmh6vj9juxv0za66drgqmv3c5t` |
| Price NFT policy | `7805e6909ba2f06f14ba342de7a9d3cc783066b4daa3d5fe35bf489b` |

| Bước | TX |
|---|---|
| `02_deploy_um` | `58650f35eaa289ffc0811d3a342c3ac70a88fe51a64babd4a55b75dd625e5a4b` |
| `03_deploy_shards` | `8071e44d6c3001f498bfd7bc00e38c180eba09e338461e9e73ecfb08810badc9` |
| `06_publish_ref_scripts` (vault) | `8ec9ae46389b594258cda7c315de6eb82eeabf72ec241a897563d5b8852847f6#0` |
| `06_publish_ref_scripts` (shard) | `b40b05749475a2395c21c40bc6cffdf09ce48f44a12b5407756c3b857a0aca5c#0` |
| `07_create_schedule_vault` | `338538968ea997b07d220402f22cfe4fcdf6b537813f636efb2704031cecc268` |
| `09_deploy_consume` | `999354825f15c32eeb57ee74fb0c7cfa4ef812095500b0fdd0e78689905e020b` |
| `09` ref-script consume | `628ff91ad8c483e6af97c577291b49c6c6e0f98bac7b3f0c8afeed597706bf91#0` |
| `ScheduleCommit` | `4ed8b6c40a5436468139337e5994b5e520f176d83504b86832b6a9ce33019ae6` |

🔴 **Câu ngay dưới đã HẾT HIỆU LỰC trong cùng ngày — đọc tiếp mục *"Cùng ngày, muộn hơn —
InstantGen đã cấp và đã bị tiêu THẬT"* trước khi dùng nó.** Bước 05 ĐÃ chạy lúc muộn hơn
2026-09-16, sau bản vá Nợ #19 (`2c4a173d`), và vault InstantGen nay có script hash
`56b83436…` trên Preprod. Giữ nguyên văn câu cũ vì lý do nêu trong nó vẫn đúng tại thời
điểm viết; nhưng một người đọc dừng ở đây sẽ kết luận ngược với trạng thái thật.

**Bước 05 (vault InstantGen) CỐ Ý chưa chạy ở đời này.** Nó không phải điều kiện tiên quyết
của bước 09: `scripts/deploy/09_deploy_consume.ts:91-94` đọc
`VAULT_HASH ?? VAULT_SCHEDULE_HASH ?? VAULT_INSTANT_HASH` — ba biến, một là đủ. Và đường
InstantGen chưa cấp nổi một nanogic (Nợ #19), nên khoá 10.000 tLAMP vào đó lúc này không
mua được gì cho vòng E2E.

**Lịch đã cam kết** — `L = 10`, `λ = 1 tLAMP` mỗi lượt, `rate_locked_q = 8000000000`
(0,008 MAGIC mỗi LAMP, bất biến theo T8), shard 6/16, tổng 0,08 MAGIC bảo đảm.
`commit_epoch = 20712` · fire đầu `20714` · fire cuối `20723`.

🔴 **Hai đồng hồ, đừng lẫn.** Epoch trong bảng trên là **epoch giao thức** của hệ này
(`ProtocolUtils/src/index.ts` ▸ `MS_PER_EPOCH_BY_NETWORK`, Preprod = 86 400 000 ms = 1 ngày),
**không** phải epoch mạng Cardano (Preprod = 5 ngày). Hai đại lượng còn khác cả gốc toạ độ:
`posixMsToEpoch` không trừ genesis, nên bước 02 in `Current epoch: 20712` trong khi Preprod
Cardano ở khoảng 233. Lấy nhịp mainnet (432 000 000) gán cho Preprod là ra lịch lệch gấp
năm — đã có hai nhà khác tính nhầm đúng chỗ này trong một ngày.

⟹ `schedule_delay = 2` epoch giao thức = **~2 ngày đồng hồ**, không phải 10 ngày. Và
`schedule_decay_window = 1` ⟹ một batch MAGIC chỉ sống **đúng một ngày UTC**: fire và tiêu
phải xong trong cùng epoch giao thức, nên bước 09 chạy TRƯỚC fire chứ không sau.

> 🔴 **Ba đoạn trên là bản ghi của ĐỜI NÀY, và con số của chúng đã CHẾT ngày 2026-09-20.**
> Giữ nguyên chữ vì đây là nhật ký một lượt triển khai, không phải hướng dẫn — nhưng đừng
> đọc nó thành nhịp hiện hành. `ms_per_epoch` của Preprod nay là **432 000 000 ms = 5 ngày**,
> bằng mainnet (`ProtocolUtils/src/index.ts` ▸ `MS_PER_EPOCH_BY_NETWORK`).
>
> Nhịp hiện hành, cùng hai hằng ấy: `schedule_delay = 2` ⟹ **10 ngày** tới fire đầu, và một
> vòng trọn vẹn (commit → chờ → fire-và-tiêu-trong-CÙNG-epoch) ⟹ **15 ngày**. Một batch
> MAGIC sống **5 ngày**, không phải một ngày UTC.
>
> Vế *"bước 09 chạy TRƯỚC fire chứ không sau"* thì **vẫn đúng** và không phụ thuộc nhịp —
> nó đến từ `schedule_decay_window = 1`, tức fire và tiêu phải cùng một epoch, dài bao nhiêu
> cũng thế.
>
> Và vế *"hai đồng hồ, đừng lẫn"* ở ngay trên **vẫn nguyên hiệu lực, nay còn dễ lẫn hơn**:
> hai con số đã trùng nhau về giá trị trên cả ba mạng, nên phép thử "khác số thì khác đồng
> hồ" hết dùng được. Gốc toạ độ vẫn khác (`posixMsToEpoch` không trừ genesis), nên epoch
> giao thức ~20713 so với epoch Cardano ~233 — đó mới là chỗ phân biệt còn sống.

⚠ **Đời này ĐANG sống trên Preprod, và nó KHÔNG phải đời cuối** (cập nhật 2026-09-22).

🔴 Bản trước của khối này kết luận ngược — *"đợt đúc cuối trên Preprod đúc THÊM dưới chính
policy đang chạy, không dựng policy mới"* ⟹ *"không phải dựng lại vì lý do này"* — dẫn thư
`lam921mag-a` (2026-09-21). Câu đó bị lật bởi `lam921mag-d` **trong cùng ngày**: kho LAMP
đóng băng ba validator Distribution rồi đúc genesis MỚI từ mã đã đóng băng ⟹ `lampPid` **sẽ**
đổi, và địa chỉ cụm Distribution đổi trong cùng lượt.

Chỗ đắt không phải một dòng sai trong chú thích — là **dòng sai này nằm ở sổ deploy**, tệp
người ta mở ra ngay trước khi chạy một lượt triển khai. Một đợt vá cùng ngày đã sửa
`scripts/config.ts` rồi đóng lại, và để nguyên bản sao ở đây: đợt vá lấy phạm vi bằng phạm
vi của **triệu chứng**, không bằng phạm vi của **nguyên nhân**. Lệnh đếm lại bất cứ lúc nào:

```
grep -rn "không phải dựng lại\|đúc THÊM dưới chính policy" . | grep -v node_modules
```

| | |
|---|---|
| policyId | `8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd` |
| assetName (hex) | `744c414d50` |
| trạng thái ở sổ nguồn | `ACTIVE`, `supersededBy: null` — `Genesis/offchain/src/lampPolicies.ts` ▸ `preprod-oneshot-14param` |

⟹ cụm vault **sẽ** phải dựng lại, và `lampPid` nay là một trong các lý do — cộng vào nhịp
epoch và hình dạng datum đã biết từ trước. **Ba lý do, MỘT lượt dựng lại**; đừng đếm thành ba
lượt. Policy id mới chưa tồn tại: nó chỉ sinh ra sau lượt đúc, và lượt đúc chưa chạy.

Mốc để sửa bảng trong `scripts/config.ts` và `MagicSDK/src/lampPolicy.ts` là **lá thư mang
policy id mới + tx hash**, không phải ngày quyết định của bên kia. Hai bảng đó là bản chép
tay không có đường nhập khẩu, nên **không cơ chế nào trong kho này tự khởi động việc sửa** —
xem dòng treo ở `scripts/config.ts` cạnh `SUPERSEDED_LAMP_POLICIES`.

**Đọc HẸP, đừng đọc rộng:** câu trên nói về **Preprod**. Policy mạng chính là một giá trị
KHÁC và **chưa tồn tại** — kho LAMP không khai nó là "sẽ giống". Nghĩa vụ báo trước khi giá
trị đổi vẫn nguyên hiệu lực; quyết định "không đổi" không huỷ nó, chỉ làm nó chưa tới lúc dùng.

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

### Cùng ngày, muộn hơn — InstantGen đã cấp và đã bị tiêu THẬT

Đoạn ngay trên viết *"Vá `cap_pp` một mình KHÔNG mở được cửa"* và *"thứ tự tối thiểu vẫn là
`Wakeme → ScheduleCommit → chờ 2 epoch → ScheduleFire → BurnBatch → InstantGen`"*. Vế thứ
nhất vẫn đúng. **Vế thứ hai đã sai** kể từ bản vá Nợ #19 chiều 2026-09-16: cửa vào của vòng
nay mở bằng một hằng biên dịch, nên InstantGen KHÔNG còn xếp sau ScheduleFire.

| việc | tx |
|---|---|
| 04 BackingBeacon | `642479ba1e7ee11ee95c67345bcede8197c357ac01207101757f5bd8245a99be` |
| 05 vault InstantGen (1001 LAMP) | `a4669a94485d16d700164cd3ff8e91dc8bb602fc9e19999c50f153a90862aad7` |
| ref-script vault instant | `9f737208c775e9283b5b5fdffa3b9c64e11c15f6c0318e15652b31bdae7b99ff#0` |
| **InstantGen cấp MAGIC** | `720e1817dc12a418751eb40326648bf5498d22d87c4f815a1089daf8622987f6` |
| 09 consume — bản cho vault InstantGen | `086a9a04c54b4703de135c2f926b44f197cf1009bd694c03f2988010e6440fdd` |
| ref-script consume instant | `6846f574c078877bf4b7e7ad07b9afa815a1bd5ead3a3eef36faf35b157caa2d#0` |
| **tiêu MAGIC thật** | `b60afb5294b39b7332e4748cf42b4281ef511c7ec503311707d36e68726a43da` |

| thứ | giá trị |
|---|---|
| vault InstantGen, script hash | `56b834369368a95e8be72782347f13e1432d0b14548f376f60cb2745` |
| vault InstantGen, địa chỉ | `addr_test1wpttsdpkjd52jh5tuuncydrlz0s5xtgtz32g7dm0vr9jw3gg88xph` |
| NFT danh-tính vault | `56b83436…c62257e4dde7a581d56d011ce0e2f6d08e55d6efb1b9e4071034d15444882129` |
| BackingBeacon, NFT policy | `28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4` |
| BackingBeacon, script hash | `9788cd32aa4b695dff6d98c8d7805d5b758099139695fe6bff5c3902` |
| consume (đời InstantGen), script hash | `4fcc3e843cd64cae10148dfcc5801d5f0f38d207f49a46f5d43c1053` |

**Số đo lượt cấp, in ra bởi chính lượt chạy:** `reward(consumed) 210.2100 ·
cap_surplus(br) 0.3333 · 0.5 × pp 4.0040 → GRANTED 0.3333 MAGIC (bound by cap_surplus)`.
Ba con số đó khớp từng đơn vị với bài kiểm `ig_prop_seed_is_not_the_binding_brake`, và
đó là chỗ đáng đọc: **hạt giống là vế LỚN NHẤT trong ba vế**, nên nới nó lên không nới
được đồng MAGIC nào. Hạt giống mở khoá, nó không trả.

**`28e916b0…` ở bảng trên là BackingBeacon NFT policy, KHÔNG phải một đời LAMP.** Cùng
chuỗi hex ấy xuất hiện ở mục `## Preprod — 2026-08-12 · ĐỜI ĐÃ MỒ CÔI` trong vai một tài
sản mang tên LAMP. Trùng là **theo cấu tạo**, không phải tình cờ: cả hai đều là policy
chữ-ký-đơn `{ type: "sig", keyHash: <pkh ví triển khai> }` (`deploy/04_deploy_backing_fixture.ts`
▸ `nftScript`), và ví triển khai Preprod có payment key hash
`2e5e1418afd402e48232b143876104cac6188a44b867ffb7538318f4`. Đo 2026-09-17:

```
mintingPolicyToId(scriptFromNative({ type: "sig", keyHash: "2e5e1418…318f4" }))
→ 28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4
```

Hệ quả: **mọi tài sản đúc bằng policy chữ-ký-đơn của ví này đều mang cùng policy id**, dù tên
tài sản là `BRQ` hay `tLAMP`. Policy id ở đây chỉ nói "ví này ký", không nói tài sản là gì.
Đổi ví triển khai thì beacon mới mang policy khác, và vault cũ không nhận nó.

**Bản `consume` phải deploy RIÊNG cho mỗi LOẠI vault.** `consume` bị apply-param bằng
`vault_script_hash` (`BOUNDARIES.md §2`), nên bản deploy cho ScheduleGen
(`1d792c6f36828e45bd82212896ef95f3814a0a78ebf86b82c26cbb56`) **không** tiêu được vault
InstantGen. Đây không phải ghi chú kiến trúc — nó là một bước thao tác, và bỏ qua nó thì
lượt tiêu chết ở chỗ trông như lỗi dựng giao dịch.

**Chưa ghim được, đừng đọc mục này rộng hơn nó nói:** hạt giống cấp một lần mỗi **VAULT**,
không phải mỗi **NGƯỜI**. Các validator ở đây không mang PersonDID, nên thứ chặn một người
mở N vault là chi phí mở vault chứ không phải một bất biến on-chain.

### 2026-09-17 — InstantGen cấp lại, lịch ScheduleGen thứ hai, và làm mới beacon bằng `PostPrice`

Epoch giao thức 20713. Mọi tx ký bằng ví triển khai pkh `2e5e1418…318f4`.

| việc | tx |
|---|---|
| 04 BackingBeacon, làm mới epoch 20713 | `ff0d28951cc9e38d0597a3f7381f8c400f2bbe988a49d7db32350332e24a1b82` |
| tách UTxO thuần ADA làm collateral (2 × 10 ADA) | `4462b57e58dc3d3daa885b66a90361a38d7b0ff2534eb33466f1b8793ce94322` |
| 05 vault InstantGen thứ hai (1001 tLAMP) | `acd7661d6559cf165ca31a1e4c82944f9a3cc724113a52249f565f43c2411a2c` |
| **InstantGen cấp 4,004 MAGIC** | `c888e76640b5ac591747f99182c57ed6867d2931d048d97aebb8f9adadadc670` |
| **tiêu 0,01 MAGIC** (consume `4fcc3e84…`) | `9e85fd59322f979e8770f7cbe66086623f509633404f6d912f1b048193309053` |
| ScheduleCommit thứ hai (λ = 400 tLAMP, L = 10) | `d476cf7e5f1947cc5a7cf9e655fd293e9571cc578f21aee31bc4361691c435a4` |
| `PostPrice` beacon của consume InstantGen, 20712 → 20713 | `553107ec6bb8bc28ea911225252dff006d2dc9531c5406048dc9342b56d15813` |
| `PostPrice` beacon của consume ScheduleGen, 20712 → 20713 | `bf9fc979e10c122d649d1c69dc17f27124e75a872e740dc7267df848ec1f70cd` |

| thứ | giá trị |
|---|---|
| Price NFT policy, consume InstantGen | `f9fef855237bd4bf6a5a5459ff18bb94628ad141b7a1afecd27fd9d7` |
| PriceParam script hash, consume InstantGen | `181a3c366bbd26e2bccf7381013c0a7ff4ff8af71efb6e2b97d09179` |
| PriceParam script hash, consume ScheduleGen | `2e983507a5fc3e6b8b490eb5c3c58ac73ddf4c9165c331e2eeb4d1a0` |

**Số đo lượt cấp:** 4,004 MAGIC, bị chặn bởi `cap_pp` (`⌊1001 × 0,008⌋ / 2`). Lượt 16/09
bị chặn bởi `cap_surplus` vì `magic_supply` của beacon khi đó nhỏ; beacon 17/09 đặt
`magic_supply = 10¹⁵`, nên vế ràng buộc chuyển sang `cap_pp`. Cả hai đều là số của beacon
DỰNG-TẠM, không phản ánh dự trữ thật.

**Hai lịch ScheduleGen trên cùng một vault** (vault UTxO sau commit: `d476cf7e…#0`):

| lịch | λ | L | fire đầu | MAGIC mỗi lượt |
|---|---|---|---|---|
| commit `4ed8b6c4…` (16/09) | 1 tLAMP | 10 | epoch 20714 | 0,008 |
| commit `d476cf7e…` (17/09) | 400 tLAMP | 10 | epoch 20715 | 3,2 |

**Làm mới price beacon: `PostPrice`, KHÔNG chạy lại bước 09.** Bước 09 đúc price NFT
one-shot mới ⟹ đổi hash `price_param` ⟹ đổi hash `consume` ⟹ mọi thread Engage đang sống
thành mồ côi. `PostPrice` tiêu beacon rồi tạo lại cùng địa chỉ, cùng value, chỉ đẩy `epoch`;
validator đòi chữ ký committee, `epoch` tăng ngặt và không vượt epoch của cửa sổ hiệu lực
(`ConsumeMAGIC/onchain/validators/price_param.ak` ▸ nhánh `PostPrice`).

**Một tx thừa, vô hại:** `c17913faadeb63ea0affad3085abce6b9690f85baefcf2975402b0ff8e1b5249` là
lượt chạy bước 04 bằng một ví KHÁC. Nó đúc một beacon dưới policy chữ-ký-đơn của ví đó
(`e5a606ff…`), mà vault InstantGen không đọc — vault chỉ nhận beacon dưới
`backing_nft_policy` đã apply-param. Beacon đó mồ côi; đừng dùng nó.

### 2026-09-18/19 — 🔴 ScheduleFire đã chạy trên **Preprod**, do keeper tự bắn

Sổ này cho tới hôm nay ghi *"ScheduleFire ✅ Preview"* — tức Preprod thì chưa. **Câu đó đã hết
đúng.** Keeper trên máy chủ (hẹn giờ mỗi giờ, phút 05 UTC) bắn ba lượt mà không ai bấm tay:

| tx | thời điểm (UTC) | epoch |
|---|---|---|
| `92a7093aead26721183539492389d960dc29ab106384ad385d4602af522dbb8f` | 2026-09-18 00:06:47 | 20714 |
| `11836b15c4538a6465c0e890df7726e26f63262dc0da7f388480ad6310cc2626` | 2026-09-19 00:08:10 | 20715 |
| `6a2c56eacd47d2b897635ae71cccf8ff7ec3f489f7805b91ed1c27159753f087` | 2026-09-19 00:08:28 | 20715 |

Mỗi tx tiêu **hai** script: vault ScheduleGen `18375a7d46d4a1ba63e414c7cfa825a7de2531909769ee26534b3edd`
và shard tổng hợp `97e967d2570f195503dbcae9841e7d6ed776b49af4d82058f3234dfb`. Chi phí đo được:
vault ~1,24–1,29 M mem / ~449–466 M step; shard ~0,72–0,75 M mem / ~234–246 M step.

**Cách kiểm lại — phép đo, không phải trạng thái chép:**

```
$ curl -H "project_id: <khoá>" \
    "https://cardano-preprod.blockfrost.io/api/v0/addresses/<VAULT_SCHEDULE_ADDR>/transactions?order=desc"
$ curl -H "project_id: <khoá>" "…/api/v0/txs/<hash>/redeemers"     # hai mục spend là dấu của fire
```

Trạng thái vault đọc bằng `VaultReadService` lúc 2026-09-19 (epoch 20715):

```
utxo_ref            6a2c56ea…#0
available_nanogic   3208000000      accrued 3208000000      expired 0
lamp_balance        10000 tLAMP     lamp_locked 3608 tLAMP
batch Schedule 20715 → 20716     8000000  live
batch Schedule 20715 → 20716  3200000000  live
sched ce29701b…  λ=1 tLAMP    L=10  fire đầu 20714  fired_count 2
sched d3fdcc7f…  λ=400 tLAMP  L=10  fire đầu 20715  fired_count 1
```

**Hai điều đọc được từ đây mà lượt Preview không cho:**

1. **`decay_window = 1` không giết MAGIC khi có lịch chạy đều.** Trên Preview, 64 triệu nanogic
   bắn một đợt rồi hết hạn trước khi ai tiêu kịp, và sổ đọc thành "hằng số này làm mất trắng".
   Ở đây lịch bắn **mỗi epoch**, nên luôn có một batch sống trong ngày. Hằng số không đổi; cái
   đổi là **nhịp**. Đừng trích dòng Preview như một phát biểu về hằng số.
2. **Chưa lượt nào TIÊU số MAGIC này.** Hai lượt tiêu đã ghi ở mục trên đều trên MAGIC của
   InstantGen, qua bản `consume` đời InstantGen `4fcc3e84…`. Bản đời ScheduleGen
   `1d792c6f36828e45bd82212896ef95f3814a0a78ebf86b82c26cbb56` đã deploy nhưng **chưa có lượt
   tiêu nào** — `run_consume_schedule_e2e.sh` dừng đúng ở *"No eligible fires … 20714"* hôm
   17/09 vì lúc đó chưa có batch. Nay có; vòng đó chạy được.

### 2026-09-19 — 🔴 Lần ĐẦU tiêu MAGIC do **ScheduleGen** sinh, trên Preprod

Hai lượt tiêu trước (16/09, 17/09) đều trên MAGIC của InstantGen. Lượt này đi qua bản `consume`
đời ScheduleGen `1d792c6f36828e45bd82212896ef95f3814a0a78ebf86b82c26cbb56` — bản đã deploy từ
16/09 và tới hôm nay chưa được dùng lần nào.

| việc | tx |
|---|---|
| **tiêu 0,01 MAGIC từ batch ScheduleGen** | `5004cbc89706136afda08a29d5828c1c8a96640f74e2decf4b64eabe4b63adbc` |

```
op_type=1 × op_count=1 → required = 10 000 000 nanogic
Gom 2 batch cho required: 809e6ac4→8 000 000 + 014f9072→2 000 000
  809e6ac4…   8 000 000 −   8 000 000 = 0
  014f9072… 3 200 000 000 −  2 000 000 = 3 198 000 000
consumed_count: 0 → 1        (Engage UTxO mới: 5004cbc8…#0)
beacon epoch 20715, stale 0  ·  vault UTxO vào: 6a2c56ea…#0
```

**Vì sao lượt này đo được nhiều hơn hai lượt trước:** nó **gộp HAI batch** trong một lần đốt, và
ưu tiên batch sắp chết trước (`809e6ac4…` bị vét sạch, phần thiếu lấy từ batch lớn). Hai lượt
InstantGen trước chỉ chạm một batch, nên đường đa-batch của `validate_burn_batch` chưa từng chạy
thật trên chuỗi. Nay đã chạy.

**Ba UTxO phải DÒ LẠI, không được đọc từ sổ** — `PRICE_BEACON_UTXO` trong `state.Preprod.sh` đã
chết từ lượt `PostPrice` đầu tiên. Đường đúng là `scripts/resolve_consume_state.ts` (chỉ đọc), dò
theo NFT danh tính — chỉ `CONSUME_SCRIPT_HASH` · `PRICE_PARAM_HASH` · `PRICE_NFT_UNIT` ·
`ENGAGE_NFT_UNIT` là bất biến:

```
$ bash _Agents/bin/preprod-env.sh npx tsx resolve_consume_state.ts
  beacon   d6a93107853df0dbb13bf165861e632612e5d71e43d6c88fe3aa832da7b72f83#0   ← đã đổi
  engage   999354825f15c32eeb57ee74fb0c7cfa4ef812095500b0fdd0e78689905e020b#1   ← chưa từng bị tiêu
```

**`decay_window = 1` nay đã được chứng minh bằng một vòng đầy-đủ trong CÙNG một epoch:** fire lúc
00:08 UTC và tiêu lúc ~11:00 UTC, cùng epoch 20715. Hằng số đó nói *"một lô chỉ sống trong đúng
epoch nó được sinh"* (`InstantGen/onchain/lib/magiclamp/protocol/constants.ak` ▸ `magic_decay_window`,
nhãn `[Constitutional]`) — và vòng này là bằng chứng nó dùng được, không chỉ là bằng chứng nó chặt.

**Trạng thái bốn thuật toán trên Preprod sau lượt này:** ScheduleGen ✅ commit·fire·consume ·
InstantGen ✅ cấp·consume · ConsumeMAGIC ✅ cả hai đời vault · PrepaidGen ⏸ đường deploy ĐÃ CÓ
(`scripts/deploy/10_deploy_prepaid.ts` + `scripts/run_prepaid_e2e.sh`), CHƯA chạy genesis.

> Bản trước của dòng này viết PrepaidGen *"❌ chưa có đường deploy"*. Sai, và sai theo kiểu
> đắt: *"chưa có"* bảo người đọc đi VIẾT một thứ đã tồn tại, còn *"có nhưng chưa chạy"* bảo họ
> đi chạy nó. Hai câu dẫn tới hai việc khác nhau, và chỉ một trong hai là việc cần làm.
>
> Dòng `PrepaidGen ⏸ … CHƯA chạy genesis` ở trên **hết đúng ngày 2026-09-20** — mục ngay dưới.
> Giữ nguyên văn vì nó tả đúng trạng thái SAU lượt 19/09, và vì câu đính chính bên trên nó vẫn
> còn hiệu lực.

---

## Preprod — 2026-09-20 · PrepaidGen genesis

Chủ dự án chạy tay `bash run_prepaid_e2e.sh Preprod --deploy` (quyết định 2026-09-20: deploy
Preprod là bất khả hồi nên mỗi lượt đi qua tay người, không nới quyền cho agent).

**Cặp định danh CARP mà hai hash dưới đây GHIM** — chép ngay cạnh chúng, đúng cảnh báo mà chính
bước deploy in ra, vì một dòng sổ không mang định danh thì lần sau không ai phân biệt nổi hai đời:

```
CARP policy id  : 4967df00c7e038fc7ce2abdc1e6d4c946342ffa905e059ab861dffc2
CARP asset name : 30cb6a6b6a1c9746bf9eb081d914d96ede4c4c13e661404678a933a6
```

> ⚠ **ĐỜI NÀY CÓ HẠN — hai hash dưới đây được biết trước là sẽ mồ côi.** Bên phát hành CARP đã
> rút lại lời mời ghim cặp trên: `DevStatus.md` ▸ Nợ #71 (d) 🔴 ghi rằng mặt-script `anchor` của
> engine đang đổi (`3672c05a…` → `90bb276e…`) ⟹ **policy id đổi cho MỌI instance**, kể cả
> instance không đổi tham số, vì byte-code đổi chứ không riêng tham số. Đời CARP đổi ⟹ apply-param
> #1/#2 đổi ⟹ script hash đổi ⟹ **địa chỉ đổi**, và toàn bộ những gì đỗ ở hai địa chỉ dưới đây
> nằm lại ở đời cũ.
>
> Nợ #71 (d) dặn *"KHÔNG chạy bước biên dịch-để-deploy cho tới khi có thư kế tiếp"*. Genesis
> 2026-09-20 **đã chạy bất kể dặn đó** — chủ dự án quyết, và cái giá là một lượt deploy lại khi
> đời CARP đứng yên. Ghi ra đây để hai sổ thôi nói ngược nhau: mục này **không** bác Nợ #71 (d),
> nó khai rằng đã đi ngược nó một lần có chủ ý.
>
> Việc phải làm khi có thư kế tiếp của bên phát hành: deploy lại cả cụm (mục 4 của **CÒN THIẾU**).
> Đừng vá bằng cách sửa giá trị trong sổ — sửa sổ không dời được UTxO.
>
> **Lý do mồ côi thứ hai, độc lập với đời CARP (2026-09-26):** mã của cả hai script đã đổi
> (chữ ký owner khi mở dòng hạn-mức mới; platform ký genesis quỹ; `PaidFundDatum` thêm
> `beneficiary` + `beneficiary_datum`). Quỹ 9 trường ở dưới không đọc được bằng lược đồ mới —
> deploy lại bằng mã cũ là dựng lại đúng lỗ vừa vá. Chi tiết + hash hai phía: `DevStatus.md` ▸ Nợ #85.

| thứ | giá trị |
|---|---|
| `paid_fund` hash | `cca47a2882f2f173507b39fa047961dd1ff0cd2b65ab3fa2e82e68ab` |
| `paid_fund` addr | `addr_test1wrx2g73gste0zu6s0vul5prev8w3luxd9dj6k0azaqhx32crxzvxj` |
| `paid_fund` NFT unit | `cca47a2882f2f173507b39fa047961dd1ff0cd2b65ab3fa2e82e68ab` + `b8738fb3c49e0ab0909275167b99ccd35676a9198c273ad2559aa4928bdcbd48` |
| (A) quỹ Paid genesis | tx `102ac34bde244a8a8fbb72db535a29dc501fdd2419bcc21283c0195d4f3df220` |
| `prepaid_vault` hash | `9dbb9a8d38545bf99ef3796cfb81d6cbd8de1bd16b5526895cf0efbd` |
| vault addr | `addr_test1wzwmhx5d8p29h7v77duke7up6m9a3hsm69442f5ftncwl0g83a9kr` |
| vault NFT unit | `9dbb9a8d38545bf99ef3796cfb81d6cbd8de1bd16b5526895cf0efbd` + `f57ca60c4b0118791ad037af2513de3d129401e30c000fc8ebf4f1dff85de526` |
| (B) vault trả trước genesis | tx `b516816554c0b54db43604b939df20a047ef9d6540b836d64dca5b8ee5aee82c` |
| tách 5 UTxO thuần ADA (bước dọn ví) | tx `b4888ee891c6d1f57dc71a1f1c269900e8c38e8203ca6b5b463cb90c4797b80b` |

Tham số lúc biên dịch: `ms_per_epoch = 86 400 000` (1 ngày — **khác** nhịp mạng Preprod 5 ngày,
xem `ProtocolUtils/src/index.ts` ▸ `MS_PER_EPOCH_BY_NETWORK`) · `platform pkh 2e5e1418…` ·
`buffer_bps = 1500`. Ví trả phí là ví triển khai testnet dùng chung Preview+Preprod.

**Thứ tự không đảo được**, và nó đã chạy đúng chiều: `paid_fund(carp…)` → `paid_fund_hash` →
`prepaid_vault(carp…, paid_fund_hash, …)`. Chiều ngược — quỹ ghim được vault thật — đi qua DỮ
LIỆU (`PaidFundDatum.vault_hash` ghim tại genesis), không qua tham số biên dịch.

Hai dòng **NFT unit** ở bảng trên không phải phần thừa: `INV-VAULT-IDENTITY` (`BOUNDARIES.md` §2)
lấy NFT one-shot làm thứ định danh một vault, **không lấy địa chỉ** — địa chỉ là script hash nên
mọi vault cùng loại dùng chung nó. Trước đây hai giá trị này chỉ sống ở một tệp trên đĩa đã
gitignore, tức bản duy nhất, tức mất máy là mất.

**CÒN THIẾU để MAGIC do PrepaidGen SINH RA tiêu được qua ConsumeMAGIC** (cả bốn đều chưa chạy,
đừng đọc mục này thành "xong"):

> Bản trước của dòng này viết *"để PrepaidGen tiêu được MAGIC"*, và câu đó khai sai việc của
> module. PrepaidGen **sinh**: `validate_draw` ghi một batch MAGIC vào `magic_batches` của vault
> và chuyển CARP tương ứng sang bên nhận. MAGIC nằm lại trong vault để **làm cơ sở đo mức tiêu
> thụ**; việc tiêu là của `ConsumeMAGIC`, script khác, giao dịch khác. Bốn mục dưới đây đều
> thuộc chặng TIÊU — không mục nào là thứ PrepaidGen còn thiếu.

1. một bản `consume` apply-param bằng `vault_script_hash = 9dbb9a8d…` — `consume` ghim vault theo
   LOẠI (`BOUNDARIES.md` §2), nên mỗi cửa gen cần một bản riêng;
2. một beacon giá còn tươi (`PostPrice`) — `max_price_stale = 1` epoch;
3. một thread Engage, và nó **không dùng chung được**: `ConsumeMAGIC/onchain/validators/consume.ak`
   ▸ `all_vault_owners_are` ép chủ Engage trùng chủ vault.
4. **deploy lại cả cụm khi đời CARP đứng yên** — xem khối ⚠ ở đầu mục. Ba việc trên làm trước
   cũng được, nhưng chúng ghim vào hai hash của đời CARP hiện tại, nên chúng sẽ phải làm lại
   cùng lượt deploy đó. Ai định bỏ công vào mục 1 thì cân nhắc thứ tự trước.

**Trạng thái bốn thuật toán trên Preprod, 2026-09-20:** ScheduleGen ✅ commit·fire·consume ·
InstantGen ✅ cấp·consume · ConsumeMAGIC ✅ hai đời vault · PrepaidGen ✅ genesis (quỹ + vault),
⏸ chưa tiêu được — thiếu đúng bốn thứ kể trên.
