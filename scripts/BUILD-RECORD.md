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
| `consume.consume` | `3bd9ae5ed66e6d496a22634257fcbfcd15fbb2ded8089c4d701196b9` |
| `price_nft.price_nft` | `82080eb9cb27d9eb7e603b7e3ecc460db12103b1829203b55d549d64` |
| `price_param.price_param` | `3ea8f97b561d71688e6c4b6aacf02e6879ad6cdc9d134d53ad07da28` |

### `Eligibility/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|

### `InstantGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `vault.vault` | `848da20f814b37d82bb3a7f09347474601f5579bf84bbd8eb3283cb2` |

### `Paymaster/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `paymaster.paymaster` | `ba57d636cccdeaf391aa6bee24c6da0644918faf08a70686a1554499` |

### `PrepaidGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `prepaid.paid_fund` | `901afa900f27355ff071f6490d550d17f5a565b476dce04313c80397` |
| `prepaid.prepaid_vault` | `a4048266fc77489206806212af1d5c1acab25b1734be8ca43e3fd3d7` |

### `ScheduleGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `shard_nft.shard_nft` | `b2211b6008397f1b5996f834e0d060bfff48a16a3dd971207c333e71` |
| `vault.shard` | `b1836db9658800284b43631ac1b44a8fb80c1d4f0fc0b6b9725fe63f` |
| `vault.vault` | `743d634eb14adf32003aceccbb98e0ac3a3c63f02faa0422df433c5f` |

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
