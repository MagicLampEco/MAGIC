# LampDistribution — Live deploy Preview (record)

Ghi lại deploy + e2e THẬT trên Cardano **Preview** (2026-06). Để truy vết + sau này
chuyển sang ví/committee khác. State máy đọc được ở `deployed.json` (gitignored).

## Ví deploy (committee 1-of-1 self-test)
- Address: `addr_test1qqh9u9qc4l2q9eyzx2c58pmpqn9vvxy2gjux0lah2wp33axx7cqq55f75fypagzqnelz3uzwxf764qzjx8kvaaw3q3yq8fyl7p`
- PKH: `2e5e1418afd402e48232b143876104cac6188a44b867ffb7538318f4`
- Seed: trong `.env` key `WALLET_SEED` (KHÔNG commit).

## Script addresses (Plutus V3, applied params)
| Validator | Hash | Address |
|---|---|---|
| claim_account | `e5ee48e0…cd23ac1a` | `addr_test1wrj7uj8qxfhmr2dw0eky8yjm6z4kkjxqc7fnz0kye536cxsmktx95` |
| beacon | `09e26dfc…df8a3530` | `addr_test1wqy7ym0uq53gyhf2zesx67yu9scpxufx7j7n7ae5m79r2vqj6ul5g` |
| treasury | `634535c8…f05a1f20` | `addr_test1wp352dwggnhckv369dj66htazjmpvtfl0v5aqn807pdp7gq2u06sl` |

## Policy / asset
- test-LAMP: policy `28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4`, name `4c414d50` ("LAMP"). Native sig (ví deploy).
- beacon NFT: cùng native policy, names `505041524d`/`4e4f4e4345`/`4d524f4f54` (PPARAM/NONCE/MROOT).

## E2E live tx (verify trên cardanoscan.io/transaction/<hash>)
| Bước | TX hash |
|---|---|
| Mint test-LAMP (1M) | `320fb82ba8a07ecb3a5abd298a431c65f523545fbb47dc410ba3fe81a11f1923` |
| Genesis (3 beacon + treasury + 2 account) | `b6b773425ec866e9d884921c87edc8d05f6315ab603bcd8cc47ca6eeb9b7571f` |
| Post P beacon | `04219c684c473f2a48bf2003fe1ec392248d85df4101935474b3ea18af07b055` |
| Post Randomness (nonce Cardano thật) | `507e36a729a7fb91321f4d1916907d51ad1ab00808ee33d3168fd405607e68f4` |
| Post MerkleRoot | `b793e7ef4bebe69bd24837547162bc818514bf8848c9b689db31fc2f637d01d0` |
| **Redeem A (nhận 100 LAMP)** | `0a1c7e6eb633916c79a527f2a610ab7b79f9eeeb84c398ce13454c009af18dc8` |

Kết quả verify on-chain: ClaimAccount A redeemed=100 LAMP, ví A nhận +100 LAMP từ treasury.
Lottery: A 3 vé → 1 trúng → 100 LAMP; B 10 vé → 5 trúng → 500 LAMP.

## Chuyển sang ví / committee khác (sau này)
Đặt trong `.env` rồi chạy `npm run all`:
- `WALLET_SEED` (hoặc `PRIVATE_KEY`) — ví deploy mới.
- `COMMITTEE_KEYHASHES` (CSV keyhash) + `COMMITTEE_THRESHOLD` — committee thật M-of-N.
- `WALLET_SEED_B` — ví B nhận claim (thay placeholder).
- `LAMP_POLICY_ID` + `LAMP_ASSET_NAME` — dùng tLAMP thật thay test-LAMP (bỏ bước mint-lamp).
- `BEACON_NFT_POLICY` — wire policy Aiken one-shot `beacon_nft` (thay native sig).

Đổi committee/policy → script address đổi → deploy mới hoàn toàn (state cũ không lẫn).
