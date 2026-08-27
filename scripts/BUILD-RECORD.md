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

### `Consolidate/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `vault_consolidate.vault_consolidate` | `cd5ebc26d3c8e8c3f403cee5a242ffde7cc232e6f8c5ff93b2fc152c` |

### `ConsumeMAGIC/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `consume.consume` | `b180e7293db5dc35c4885dd3232543c5325153ca01d7b8b8abbd9d33` |
| `price_nft.price_nft` | `82080eb9cb27d9eb7e603b7e3ecc460db12103b1829203b55d549d64` |
| `price_param.price_param` | `bc289f71cbfbbbb8e485c7699a9a3aef88ab92086bdb73f181a99906` |

### `GetMAGIC/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `magic_allocation.magic_allocation` | `59619dcf238a7874e973a0a4f0106c2a9cf0ef5e8889c32c5fbbf59c` |
| `otc_order.otc_order` | `a703c82ee50491e83b8bb430e1162311f74908d675f16b5d57073b5a` |

### `InstantGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `vault.vault` | `1b2d0de4512f8b3289f99cb7b59ae6c99518b94a5bed0f15c3aad5bb` |

### `Paymaster/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `paymaster.paymaster` | `ba57d636cccdeaf391aa6bee24c6da0644918faf08a70686a1554499` |

### `PrepaidGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `fund_nft.fund_nft` | `2a3195949a6417d8a08c082148d7f04f6fb0e2898fc9b7bb3aa2a7e1` |
| `prepaid.paid_fund` | `5f113b42535b0e0ecbe51c98a7327f82903260a2c978bd28f3e3119b` |
| `prepaid.prepaid_vault` | `bf1f2d97c1903e7229e1058e08d18aa65ba92529b0699b73d7ea5e4f` |

### `ProfileChange/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `vault_profile.vault_profile` | `4a1d925e27ca00ff75368eb4d90de08557a22a56d1c33823cd3131be` |

### `ScheduleGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `shard_nft.shard_nft` | `b81a8f09b234ad5de6be20cec7955fc710f211af08cb2136ca6d11d2` |
| `vault.shard` | `52128031da1835058e16a19bb63f517f1ca027456a2b193e3e398831` |
| `vault.vault` | `2de65bad93d570262116b4941c08da6031ba469123b4ce5768a5f7ef` |

### `UMKeeper/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `um_datum.um_datum_validator` | `38d6e740f5c2a75335eb36736e8d458e04b949ef5be7513f0be7c374` |
| `um_nft.um_nft` | `f38ed1b66fadd5f1da408519bf9a8966a409ae24e31e1cec7dbe09d3` |

<!-- MÁY SINH — HẾT -->
