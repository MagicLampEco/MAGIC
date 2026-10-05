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
| `consume.consume` | `b15c2a0e05e29a4ec3aafb1791e548a49e648fc1129e770f3de670de` |
| `price_nft.price_nft` | `8e75ac1dc3abcca85cbe62d8745ad939f3dbd78fe6423dda8d99ed96` |
| `price_param.price_param` | `b424138c1a82968eb3fcce0731034b0938031f8ff4705ec91dbb3f93` |

### `Eligibility/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|

### `GenBeacons/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `gb_shard.gb_shard` | `39e1ed54b82ccb8a810c88f245678b5da3dc05a5f79c64bc7a306834` |
| `greenback_beacon.greenback_beacon` | `cbdf18b3e12135f4d4625f333ad704a53ae28f3516bb41a7ff84e958` |
| `rate_param.rate_param` | `680b59a65f117e3e63628c300a0853c79af7845f79731adbe2d519ee` |
| `vault_registry.vault_registry` | `d3c73c8e3210eac51e3f8715c86ea4c520deabf321fcce8791bc2483` |

### `InstantGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `vault.vault` | `7bc836c50d365440b3c76c036e4eda2a42b231eb4f2be50dd5f386ef` |

### `Paymaster/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `paymaster.paymaster` | `94fcfa10e0e97859061e84b3279fbec58284b3a0e658bd514ef2d6b2` |

### `PrepaidGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `prepaid.paid_fund` | `dce086963b50bee18904bc35ece008dd2a686f6013745ceb1473167b` |
| `prepaid.prepaid_vault` | `6476592e4fd896fc0f848038ebfee9c52a7f91a857ccc9f8291abbae` |

### `ScheduleGen/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `shard_nft.shard_nft` | `9553132b54fce178732fdae7f95b9f1833349c087277e939c22a12ef` |
| `vault.commit` | `0baf478f7f997a3f2f1c61a2912dbc5cb5eed2d54d026ec7e39a6b17` |
| `vault.shard` | `409e4f4b614a3dab7de5cd97d15f5c18820e2c335092e9e9d6e82d7c` |
| `vault.vault` | `65536efc8e57076c583c2648a24051866498883308e665510ddff4cb` |

### `UMKeeper/onchain`

trình biên dịch `v1.1.21+42babe5`

| validator | hash (CHƯA apply-param) |
|---|---|
| `um_datum.um_datum_validator` | `789d0294b61f3abeeac7bedfa9c0a8121662adceaceb66a1a9bba276` |
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
