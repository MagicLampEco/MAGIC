# EXEC.md — ScheduleGen Execution Guide
## GenMAGIC v3.3 · §11 ScheduleGen · Cardano Preview Testnet

---

## 1. Deploy Steps (ordered)

### Bước 1: Build Aiken validator

```bash
cd /Users/ductiger/Projects/MAGIC/ScheduleGen/onchain
aiken build
# → plutus.json với 2 validators: vault, shard
```

Sau khi build, đọc script hash từ `plutus.json`:
```bash
cat plutus.json | jq '.validators[] | {title: .title, hash: .hash}'
```

### Bước 2: Thiết lập env vars

```bash
# scripts/.env
BLOCKFROST_KEY=previewXXXXXXXXXXXXXXXX
PRIVATE_KEY=<hex private key>
NETWORK=Preview

LAMP_POLICY_ID=<từ deploy LAMP>
VAULT_SCRIPT_HASH=<từ plutus.json — vault validator>
SHARD_SCRIPT_HASH=<từ plutus.json — shard validator>
SHARD_NFT_POLICY_ID=<one-shot minting policy cho 16 SHARD NFTs>
TREASURY_ADDRESS=<script address — PHẢI là Script credential>
MS_PER_EPOCH=86400000
```

### Bước 3: Deploy 16 Shard UTxOs

Mỗi shard cần 1 UTxO với inline datum và 1 SHARD NFT:

```typescript
for (let shardId = 0; shardId < 16; shardId++) {
  const shardDatum = {
    shard_id:                    BigInt(shardId),
    shard_locked_lamp:            0n,
    shard_active_count:           0n,
    shard_cumulative_committed:   0n,
    shard_cumulative_fired:       0n,
    last_updated_epoch:           BigInt(currentEpoch),
    shard_cap:                    450_000_000_000_000n,
  };
  // pay.ToAddressWithData(shardAddr, inline(shardDatum), { [SHARD_NFT]: 1n })
}
```

Sau khi deploy: ghi lại 16 UTxO refs vào `.env` hoặc `config.ts`.

### Bước 4: Verify deploy

```bash
# Kiểm tra 16 shard UTxOs tồn tại và đúng datum
curl "https://cardano-preview.blockfrost.io/api/v0/addresses/<shard_addr>/utxos" \
  -H "project_id: $BLOCKFROST_KEY" | jq 'length'
# Expected: 16
```

### Bước 5: Chạy test offchain

```bash
cd /Users/ductiger/Projects/MAGIC/ScheduleGen/offchain
npm install
npm test
# Expected: tất cả pass (TV-SCH-01..06 + CATCHUP + FIRE_PERM + T-DET + FIRE3 + BOUNDS)
```

### Bước 6: Test Commit + Fire flow

```bash
cd /Users/ductiger/Projects/MAGIC/scripts
npm install
npx tsx test/schedulegen_e2e.ts
# Hoặc dùng e2e_flow.ts nếu đã tích hợp
```

---

## 2. Test Plan

### 2.1 Unit tests (offchain, đã có trong tests/)

| Test ID | Loại | Mô tả | File |
|---|---|---|---|
| TV-SCH-01 | positive | S_Q(L) 5 values, T11/T12 | `vectors.ts:7` |
| TV-SCH-02 | positive | L=100, λ=4000 → 45 MAGIC/fire | `vectors.ts:23` |
| TV-SCH-03 | positive | Rate immutability T8 | `vectors.ts:46` |
| TV-SCH-04 | positive+negative | Shard cap accept/reject | `vectors.ts:59` |
| TV-SCH-05 | negative | C-SCH-RATE: M_i=0 → reject | `vectors.ts:82` |
| TV-SCH-06 | positive | Catch-up 4 epochs | `vectors.ts:99` |
| TV-SCH-CATCHUP-LIMIT | positive | 18 eligible → 8 fires (cap) | `vectors.ts:118` |
| TV-SCH-FIRE-PERM | positive | Permissionless fire | `vectors.ts:134` |
| TV-SCH-T-DET | positive | Tất cả M_i identical | `vectors.ts:151` |
| TV-SCH-FIRE3 | positive | C-FIRE-3 atomic assertions | `vectors.ts:165` |
| TV-SCH-BOUNDS | mixed | L<10, L>200, |sched|≥20 | `vectors.ts:183` |

### 2.2 Negative test cases (cần test kỹ trước deploy)

| Trường hợp | Redeemer | Expected | Invariant |
|---|---|---|---|
| `L = 9` (dưới min) | ScheduleCommit | REJECT | C-SCH-1 |
| `L = 201` (trên max) | ScheduleCommit | REJECT | C-SCH-1 |
| `λ = 999_999` (dưới 1 LAMP) | ScheduleCommit | REJECT | C-SCH-2 |
| `L×λ > l_avail` | ScheduleCommit | REJECT | C-SCH-3 |
| `|gen_schedules| = 20` | ScheduleCommit | REJECT | C-SCH-10 |
| Shard cap vượt (`shard_locked + L×λ > 4.5×10^14`) | ScheduleCommit + ShardUpdateCommit | REJECT | C-SCH-CAP / T13 |
| M_i = 0 (R_snap quá thấp) | ScheduleCommit | REJECT | C-SCH-RATE |
| Fire trước `start_fire_epoch` | ScheduleFire | REJECT | C-FIRE-1 |
| Fire với `fires_in_tx = 0` | ScheduleFire | REJECT | `vault.ak:240` |
| Treasury là wallet address | ScheduleFire | REJECT | PR #11 pt3 |
| Vault output datum sai field | ScheduleCommit/Fire | REJECT | A02 |
| 2 vault outputs | ScheduleCommit/Fire | REJECT | C-VAULT-OUT-1 |
| Không có chữ ký owner khi Commit | ScheduleCommit | REJECT | C-VAC-1 equiv |
| BurnBatch | BurnBatch | REJECT (fail hard) | v1.0 lock |
| WithdrawLamp amount = 0 | WithdrawLamp | REJECT | W-1 |
| WithdrawLamp vượt l_avail | WithdrawLamp | REJECT | W-3 |
| WithdrawLamp advance last_updated_epoch | WithdrawLamp | REJECT | W-5 |
| WithdrawLamp thêm phantom output | WithdrawLamp | REJECT | C-VAULT-OUT-1 |

### 2.3 Integration / e2e test

Sau deploy:

1. **Commit happy path:** Commit L=100, λ=4000, verify vault datum có đúng `GenSchedule`.
2. **Fire single:** Fire 1 order, verify MAGIC batch được tạo với `initial_amount = 45 MAGIC`.
3. **Catch-up fire:** Bỏ qua 4 epoch, fire 1 tx, verify `fires_in_tx = 4`.
4. **Permissionless:** Dùng private key khác (không phải owner) để fire, verify thành công.
5. **Complete schedule:** Fire đủ L orders, verify schedule bị xóa khỏi `gen_schedules`.
6. **Rate lock verify:** Sau khi DAO cập nhật `R_snap`, fire tiếp — verify `M_i` không đổi.

---

## 3. Known Limits

| Limit | Giá trị | Ghi chú |
|---|---|---|
| L_min | 10 orders | C-SCH-1 |
| L_max | 200 orders (~1000 ngày) | C-SCH-1 |
| λ_min | 1 LAMP (1_000_000 oil) | C-SCH-2 |
| MAX_GEN_SCHEDULES | 20 | Mỗi vault tối đa 20 schedules active |
| MAX_BATCHES_PER_VAULT | 32 | Cap batch budget trong 1 fire tx |
| MAX_FIRES_PER_TX | 8 | Catch-up cap — tránh tx quá nặng |
| SHARD_CAP | 450M LAMP per shard | T13: 20% of 36B / 16 shards |
| SCHEDULE_DELAY | 2 epoch | Từ commit đến first fire |
| BurnBatch | Locked | v1.0: fail hard — implement v1.1 |
| Cancel | Không tồn tại | T10: no-cancel invariant |

---

## 4. v-next (roadmap)

| Hạng mục | Lý do | Ưu tiên |
|---|---|---|
| **BurnBatch / ConsumeMAGIC (v1.1)** | Hiện locked, cần full A02 + apply_pending_profile | Cao |
| **TypeScript `WithdrawLamp` redeemer** | `types.ts:VaultRedeemerSchema` thiếu constr 3 | Trung bình |
| **Auto-burn integration** | `auto_burn_target` field trong datum chưa được xử lý | Thấp |
| **Shard cap governance** | Hiện hardcoded; cần DAO-updatable trong v2 | Thấp |
| **Multi-schedule fire** | Hiện 1 tx fire 1 schedule; có thể batch nhiều schedules cùng lúc | Thấp |
| **Deploy scripts hoàn chỉnh** | `VAULT_SCRIPT_HASH`, `SHARD_SCRIPT_HASH` chưa điền trong `TESTNET_CONFIG` | Cao (trước testnet) |
