# LampDistribution — Drop Lottery phân bổ LAMP

Triển khai cơ chế phân bổ LAMP theo **Probabilistic Drop Lottery** (nguồn chuẩn:
`MagicLamp-Docs/docs/LAMP-Distribution.md` v1.0). Core engine **DID-agnostic** — dùng
được cho mọi Cardano team, không lock vào PhoenixKey.

Đặc tả đầy đủ + 7 quyết định kiến trúc: **[SPEC.md](./SPEC.md)**.

## Kiểm tra (1 lệnh)

```bash
bash LampDistribution/verify.sh
```

Kết quả mong đợi: **22 Aiken test + 75 vitest test = 97 pass**, blueprint `plutus.json` sinh OK.

## Cấu trúc

```
LampDistribution/
  SPEC.md                       # thuật toán + 7 quyết định kiến trúc + invariants
  onchain/                      # Aiken (Plutus V3)
    lib/magiclamp/lampdist/
      constants.ak  types.ak  math.ak
      merkle.ak                 # BLAKE2b-256, RFC6962 domain-sep, sorted-pair
      util.ak                   # helper + chống double-satisfaction (script-hash count)
    validators/
      claim_account.ak          # Claim (committee) + Redeem (Merkle proof)
      beacon.ak                 # post P / nonce / MerkleRoot (committee, NFT-auth)
      treasury.ak               # release LAMP cho redeem (bảo toàn non-LAMP value)
  offchain/src/                 # TypeScript (Lucid Evolution)
    merkle.ts lottery.ts pparam.ts   # engine (mirror onchain byte-perfect)
    datum.ts committee.ts            # codec Data + committee threshold
    beaconBuilder.ts claimBuilder.ts redeemBuilder.ts   # tx builders
  tests/                        # vitest (foundation + builders + integration)
```

## Luồng (4 trạng thái)

```
EARNED → CLAIMED → REDEEMABLE → LIQUID
        (committee   (lottery off-chain    (user redeem,
         confirm)     + Merkle root)        1 UTXO batch)
```

1. **Claim** — committee 2/3 confirm activity → `claimed_cumulative += amount`.
2. **Beacon** — committee post `P_{N+1}` (1 epoch trước), `nonce_N`, `MerkleRoot_N`.
3. **Lottery** (off-chain) — `seed = blake2b(nonce ‖ wallet ‖ idx)`, win nếu `seed < p·2^256`;
   `won = min(d·P, remaining)`; build Merkle tree cumulative.
4. **Redeem** — user submit Merkle proof của `won_cumulative` → nhận `won − redeemed` LAMP.
   Cumulative ⇒ chống double-redeem + batch nhiều epoch trong 1 UTXO.

## An toàn (đã audit + fix)

Vòng audit adversarial đã phát hiện + sửa:
- **C1** double-satisfaction qua stake credential → đếm theo **payment script hash**, không full-address.
- **C2** treasury N× release → ràng đúng 1 treasury/tx theo script hash.
- **M1** treasury drain ADA → `tre_out.value == tre_in.value − released LAMP` (bảo toàn mọi asset khác).

Test `script_count_catches_stake_cred_double` (Aiken) chứng minh fix C1.
Test `leaf_hash_xcheck_offchain` (Aiken) chứng minh Merkle khớp byte-perfect với TypeScript.

## MVP — phạm vi & defer

| Có (build + test) | Defer (lý do trong SPEC §0) |
|---|---|
| Claim / Redeem / Beacon / Treasury validator | 7 validator riêng từng kênh (ISPO/Scavenger/…) |
| P engine + Lottery engine + Merkle | PhoenixKey on-chain DID proof (anti-sybil ở tầng committee) |
| Off-chain tx builders + 97 test | On-chain P computation; live Preview deploy (cần Blockfrost key) |

## Còn lại trước mainnet

- Deploy scripts Preview (cần Blockfrost key của anh) + chạy live end-to-end.
- Thêm validator-level Aiken mock-tx test (treasury double-release, redeem happy/sad path).
- Beacon NFT minting policy one-shot (genesis) — verify ở deploy.
- Tối ưu lottery cho whale (binomial sampling thay vì lặp từng ticket) khi balance lớn.
