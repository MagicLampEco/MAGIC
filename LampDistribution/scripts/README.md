# LampDistribution — Deploy + E2E live test (Cardano Preview)

Chạy full flow THẬT trên Preview: claim → beacon → lottery → redeem.
Không giả lập — mỗi bước in tx hash + link cardanoscan để kiểm chứng.

## Chuẩn bị `.env`

Tạo file `.env` trong thư mục này (hoặc ở repo root — `dotenv` tự tìm). Tối thiểu:

```bash
NETWORK=Preview
BLOCKFROST_KEY=previewXXXXXXXXXXXXXXXXXXXXXXXXXXXX   # blockfrost.io, project Preview
PRIVATE_KEY=ed25519_sk1...                           # HOẶC WALLET_SEED="word1 word2 ..."
```

Ví deploy cần ≥ 10 tADA (faucet: https://docs.cardano.org/cardano-testnet/tools/faucet).

### Tuỳ chọn (đều có mặc định self-contained)

| Key | Ý nghĩa | Mặc định |
|---|---|---|
| `WALLET_SEED` | seed phrase (thay PRIVATE_KEY) | — |
| `COMMITTEE_KEYHASHES` | CSV N keyhash hex (28-byte) committee | ví deploy (1-of-1 self-test) |
| `COMMITTEE_THRESHOLD` | override threshold | ⌈2N/3⌉ |
| `LAMP_POLICY_ID` / `LAMP_ASSET_NAME` | dùng token LAMP ngoài (vd tLAMP) thay test-LAMP | native sig của ví deploy |
| `BEACON_NFT_POLICY` | policy NFT beacon (khi agent beacon_nft ship) | native sig của ví deploy |
| `WALLET_SEED_B` / `PRIVATE_KEY_B` | ví B test (claim account thứ 2) | placeholder PKH |
| `TEST_LAMP_MINT` | LAMP mint (02), số nguyên | 1_000_000 |
| `TREASURY_FUND_OIL` | LAMP fund treasury (03), oil | 500_000 LAMP |
| `TARGET_RATE_Q_E2E` | tỉ lệ trúng lottery e2e (Q) | 500_000_000 (50%, để A chắc trúng) |

> **Committee self-test:** mặc định committee = 1 ví deploy (threshold 1) để demo full
> flow bằng 1 ví. Production: truyền `COMMITTEE_KEYHASHES` 3 keyhash. Lưu ý khi đó cần
> multi-sign thật (ngoài phạm vi runner 1-ví này).

## Chạy

```bash
npm install
npm run deploy      # 01: apply params 3 validator → deployed.json
npm run mint-lamp   # 02: mint test-LAMP fund treasury
npm run genesis     # 03: mint 3 beacon NFT + tạo beacon/treasury/2 claim-account UTxO
npm run e2e         # 04: claim → beacon → lottery → redeem → verify on-chain
# hoặc gộp:
npm run all
```

State giữa các bước nằm ở `deployed.json` (tự sinh, gitignore).

## Kiểm tra

```bash
npm run typecheck   # tsc --noEmit, phải sạch
```

## Ghi chú kiến trúc

- **test-LAMP vs tLAMP:** runner self-contained — mint test-LAMP riêng (native sig của
  ví deploy), KHÔNG phụ thuộc tLAMP của Tuân. Dùng tLAMP: set `LAMP_POLICY_ID` +
  `LAMP_ASSET_NAME` ở 01, fund treasury thủ công, bỏ qua 02.
- **beacon_nft policy:** blueprint hiện chưa có validator minting beacon_nft. Runner
  mint NFT bằng native one-shot sig policy (policy id deterministic theo keyhash ví →
  01 bake được vào claim_account/beacon trước khi 03 mint NFT thật). Khi agent kia ship
  beacon_nft minting validator: set `BEACON_NFT_POLICY` + thay `nativeSigPolicy` ở 03.
- **epoch nonce:** 04 thử đọc nonce Cardano thật qua Blockfrost
  `/epochs/latest/parameters` (field `nonce`); không lấy được → fallback test vector cố định.
- **epoch:** validator claim_account tính epoch từ validity_range POSIX ms
  (`ms_per_epoch` Preview = 86_400_000). Runner tính `currentEpoch = tip_posix_ms /
  ms_per_epoch`, khớp Lucid default validity range.
