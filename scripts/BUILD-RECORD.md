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
| `consume.consume` | `83cb86d3ed48c5301d7cbab42a09105facf7322db4d223357b9d3d1a` |
| `price_nft.price_nft` | `16e849f1952237ccc3baf57c7e35bcff9c0756e97e11671c3dee6287` |
| `price_param.price_param` | `afd75ea36b11aecb0854949f5dd14b4fd206f41739817b0ba18af755` |

### `Eligibility/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|

### `GenBeacons/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `gb_shard.gb_shard` | `78b49a7865e46288fc7dd6a3e967c9cc9bdcd312d72b0a592745121f` |
| `greenback_beacon.greenback_beacon` | `53069ea1a6b8a5fcd85b0cd20a6b3e388747c13334d904c5bd6644c9` |
| `rate_param.rate_param` | `add7ddbaa62275fad920c828e79354f229895412262229c9b839580a` |
| `vault_registry.vault_registry` | `91d942a007b1e041095e5cbc9fb61d627639e89cb70aa352e780b9e0` |

### `InstantGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `vault.vault` | `53a2b6519a45eeb98faa6a47062d203766898b8722a86e9dadd86617` |

### `Paymaster/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `paymaster.paymaster` | `52155a7a0f96225950b6d09c79978ecbd09576de09ce0788e026284b` |

### `PrepaidGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `prepaid.paid_fund` | `6ff7d74e37b4fcd7d32cbd0331c469c445810f4d40ba64a2c49378a2` |
| `prepaid.prepaid_vault` | `63e3919ef19f350865184e11638f255b50afa3588721b27650c8d898` |

### `ScheduleGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `shard_nft.shard_nft` | `9553132b54fce178732fdae7f95b9f1833349c087277e939c22a12ef` |
| `vault.commit` | `50a93fd1094b685486058dfa901d433973d8b68f5b62de3b57919b3c` |
| `vault.shard` | `a1fef229005973298f91419a8dafb05b225529babda4d0c07ecb7203` |
| `vault.vault` | `1e74f3a66de872f39aafe9583bf1354c1ac4b4d4437d59b1df2d0b09` |

### `UMKeeper/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `um_datum.um_datum_validator` | `c9d4203b09ce4ce298fa540d9b8989b2406588c744a2e6fb49b0a31a` |
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
