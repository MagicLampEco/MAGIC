# Bản ghi dựng — máy sinh, không chép tay

Sinh bằng `npm run record:build` (trong `scripts/`) từ `plutus.json` của từng module.
Đừng sửa khối dưới bằng tay: `npm run verify:build-record` so lại và **exit 1** khi lệch.

**Hash dưới đây là hash validator CHƯA apply-param** — nó ghim *mã nguồn × trình biên dịch ×
thư viện*, KHÔNG phải địa chỉ đã deploy. Địa chỉ còn cần bộ apply-param: xem
`npm run verify:hashes`.

Vì sao tệp này tồn tại: `plutus.json` bị `.gitignore`, nên chuỗi trình biên dịch đủ hậu tố
và hash validator chỉ sống trong một hiện vật nằm ngoài lịch sử git. Tệp này kéo hai thứ đó
vào lịch sử — bằng máy, để không ai phải chép.

<!-- MÁY SINH — BẮT ĐẦU. Đừng sửa tay: `npm run record:build` ghi đè. -->

### `ConsumeMAGIC/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `consume.consume` | `e6ef44a94f5352906f8629a0888c521892109c4ec47442a987f984ff` |
| `price_nft.price_nft` | `16e849f1952237ccc3baf57c7e35bcff9c0756e97e11671c3dee6287` |
| `price_param.price_param` | `065be9fb44b8badc2b4c3a360f44643b63912eccf0193aa091cdb514` |

### `Eligibility/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|

### `GenBeacons/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `gb_shard.gb_shard` | `78b49a7865e46288fc7dd6a3e967c9cc9bdcd312d72b0a592745121f` |
| `greenback_beacon.greenback_beacon` | `3937e4f4cdeb96396cc6e963b1a90e9ef8eabccdab01888f3e526c25` |
| `rate_param.rate_param` | `e9d42b6df5b3142af6e7073248de089ed85706569b524a56fcfa023b` |
| `vault_registry.vault_registry` | `91d942a007b1e041095e5cbc9fb61d627639e89cb70aa352e780b9e0` |

### `InstantGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `vault.vault` | `17f0e9faf8de8f2393db8d456b835fd246de72d677987eb15aa8f624` |

### `Paymaster/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `paymaster.paymaster` | `ba57d636cccdeaf391aa6bee24c6da0644918faf08a70686a1554499` |

### `PrepaidGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `prepaid.paid_fund` | `bf12f3a41d156da2bb7d1d2d5d25f1b1ca0542a4aa39e887bfa2aff7` |
| `prepaid.prepaid_vault` | `80d2ce808fc3ad91987660d2a17f5cba3ca6580e0c39276be88320e8` |

### `ScheduleGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `shard_nft.shard_nft` | `9553132b54fce178732fdae7f95b9f1833349c087277e939c22a12ef` |
| `vault.commit` | `cc51dfa727ddee00ae1fe4b77e087cdb80f7d05cd8fca691e50beda7` |
| `vault.shard` | `a1fef229005973298f91419a8dafb05b225529babda4d0c07ecb7203` |
| `vault.vault` | `c70927ca5afffa1ae1a06b4b704a73ecda9d79fd71680a38af1f3066` |

### `UMKeeper/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `um_datum.um_datum_validator` | `c4ff76ae5cb027ebdeda78b281364a86c2347d7c63a97fd664f181a0` |
| `um_nft.um_nft` | `f38ed1b66fadd5f1da408519bf9a8966a409ae24e31e1cec7dbe09d3` |

<!-- MÁY SINH — HẾT -->

---

## Ghi chú của người — nằm NGOÀI khối máy sinh, có chủ ý

Khối trên do `npm run record:build` ghi đè **toàn bộ**, nên mọi câu chữ đặt trong đó
sẽ biến mất ở lượt dựng lại kế tiếp mà không ai báo. Chỗ đúng để viết là dưới đây.

Điều này đã xảy ra một lần, và đáng ghi lại vì nó không tự lộ ra: một bản vá thêm chú
thích `(nay có CẢ handler mint)` vào ngay trong bảng máy sinh, cộng một khối văn xuôi
giải thích `fund_nft` biến mất. Lượt `record:build` đầu tiên sau đó xoá sạch cả hai. Bộ
kiểm không đỏ, `git status` vẫn sạch — thứ mất đi là văn xuôi, mà văn xuôi thì không có
bài kiểm nào canh.

### `fund_nft.fund_nft` đã BIẾN MẤT khỏi bảng trên, không phải bị bỏ sót

Bản `2a3195949a6417d8a08c082148d7f04f6fb0e2898fc9b7bb3aa2a7e1` (850 B) là script cuối
cùng của nó. Validator đứng riêng ấy không ép được địa chỉ của output mang NFT, nên cổng
genesis sổ quỹ của nó chỉ sống đúng một giao dịch (`DevStatus.md` ▸ Nợ #69). Việc của nó
chuyển vào `paid_fund` ▸ `validate_mint_fund_nft`, ở đó `policy_id` **chính là** script
hash của `paid_fund` nên phép ép địa chỉ tự trỏ vào mình.

Hệ quả cho ai dựng tham số deploy: `fund_nft_policy` **không còn là một apply-param** —
nó bằng `paid_fund_hash` theo định nghĩa.

| validator | apply-param, theo thứ tự |
|---|---|
| `prepaid.paid_fund` | `carp_policy_id · carp_asset_name · ms_per_epoch` |
| `prepaid.prepaid_vault` | `carp_policy_id · carp_asset_name · paid_fund_hash · ms_per_epoch` |

Hai dòng `prepaid.*` trong bảng máy sinh nay có **cả** handler `mint` — `paid_fund` phát
policy NFT quỹ, `prepaid_vault` phát policy NFT vault (`INV-VAULT-IDENTITY`).
