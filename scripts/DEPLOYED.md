# Bản ghi triển khai testnet — MagicLamp

Toàn bộ giá trị dưới đây là **công khai** (policy id, script hash, tx hash). Không có
secret nào ở đây; secret chỉ nằm ở `$AGENT_SECRETS`.

Chạy lại: `bash scripts/run_wakeme_e2e.sh Preview` · `bash scripts/run_wakeme_e2e.sh Preprod`.

> **Beacon `backing` là DỰNG-TẠM.** Nó không phản ánh dự trữ nào. `br_q = 2.0` là con số
> bịa để mở cổng fail-closed §6.3 trên testnet, và `deploy/04_deploy_backing_fixture.ts`
> từ chối chạy khi `NETWORK=Mainnet`. Beacon thật do phía CARP/CarpetMint phát.

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
| LAMP policy | `28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4` · asset `744c414d50` (tLAMP) |
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

**2. ScheduleFire ⏳ chưa tới hạn, đúng thiết kế.** `No eligible fires: next fire at epoch
20679, current=20677`. `SCHEDULE_DELAY = 2` epoch, mà `ms_per_epoch` testnet = 86 400 000
(1 ngày) ⇒ phải chờ ~2 ngày sau commit. Đây không phải lỗi; nhưng nghĩa là **không thể
nghiệm thu ScheduleGen trọn vòng trong một buổi.**

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
