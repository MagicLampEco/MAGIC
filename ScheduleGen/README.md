# ScheduleGen — Testnet Implementation Guide
## GenMAGIC v3.3 · §11 ScheduleGen · Cardano Preview Testnet

> ⚠ **Đã đổi ở PHA 2 (xem `InstantGen/DESIGN-PHASE2.md` §2, §3, §5).**
> `ScheduleFire` KHÔNG chuyển LAMP về Treasury nữa: nó chỉ **giải phóng khoá**
> (I-ACT-7). `lamp_balance` bất biến; `lamp_locked` giảm `fires × λ`; holdings
> chỉ lật `is_locked`. Batch sinh ra sống đúng 1 epoch (§4.2 use-or-lose) —
> catch-up nhiều đơn vẫn đóng dấu epoch HIỆN TẠI, không hồi sinh MAGIC bỏ lỡ.
> Validator `vault` nhận **4** apply-param, đúng thứ tự: `lamp_policy_id`,
> `lamp_asset_name`, `shard_policy_id`, `ms_per_epoch` — `treasury_addr` đã xoá,
> `lamp_asset_name` là tham số theo mạng (`tLAMP` testnet / `LAMP` mainnet).
> **Danh sách này chỉ là ảnh chụp.** Nguồn thật là mảng `parameters[]` trong
> `onchain/plutus.json` do `aiken build` sinh; cổng đối chiếu tên + thứ tự:
> `cd scripts && npm run check:params`.
> Bám bảng chép tay là hỏng tiền thật: `applyParamsToScript` không kiểm arity, thiếu
> hoặc lệch một tham số vẫn ra script hash 28 byte trông hợp lệ — vault mainnet không
> nhìn thấy LAMP của chính nó và mọi tx spend về sau fail vĩnh viễn.

---

## ScheduleGen vs cửa sinh còn lại — tổng kết

Chỉ còn **hai** cửa sinh sống: `ScheduleGen` và `InstantGen`. Bảng trước ở đây còn hai cột
`VacuumGen` và `SnapshotGen` trình bày ngang hàng như đang chạy — cả hai đã chết, nằm ở
`Legacy/genmagic-v3.3/`. Ai đọc bảng cũ sẽ đi thiết kế cho một cơ chế không tồn tại, hoặc
tưởng mình phải chọn giữa bốn đường.

| | ScheduleGen | InstantGen |
|---|---|---|
| Pha | **2** (Commit → Fire, catch-up ≥8) | 1 |
| Suất | **Khoá lúc commit (T8)** | Tính lúc gọi |
| Fire | **C-FIRE-1 ≥ (catch-up)** | không có pha fire |
| Tối đa fire/tx | **8** (catch-up) | — |
| UM | **Không** — suất đã khoá | Có (C-UM-6) |
| Huỷ giữa chừng | **Không** (T10) | — |
| Shard | **Có** (16 shard) | Không |
| Fire không cần chủ ký | **Có** (C-SCH-FIRE-PERMISSION) | — |
| Batch cliff | **k≥1** | k≥1 |

`InstantGen` cột "Batch cliff" trước ghi `k≥2 (halving)`. Mô hình halving đã bỏ:
`magic_decay_window = 1` cho mọi cửa, batch chỉ sống đúng epoch sinh ra nó. Chờ tới `k=2` để
tiêu là chờ quá hạn — batch đã chết và bị dọn.

---

## Cấu trúc project

```
ScheduleGen/
├── onchain/
│   ├── lib/
│   │   ├── types.ak        # VaultDatum, GenSchedule, ScheduleAggregateShardDatum
│   │   ├── constants.ak    # S(L) segments, caps, delays
│   │   ├── math.ak         # computeSQ, computeRateLockedQ, computeMi, shardId
│   │   └── lock.ak         # youngest-first lock (same as VacuumGen)
│   └── validators/
│       └── vault.ak        # ScheduleCommit + ScheduleFire + Shard validator
├── offchain/src/
│   ├── math.ts             # BigInt: S(L), rate_locked_q, M_i, shard_id, lock
│   ├── schedule.ts         # buildScheduleCommitTx + buildScheduleFireTx
│   └── constants.ts
└── tests/
    ├── vectors.ts          # TV-SCH-01..06 + CATCHUP_LIMIT + FIRE_PERM (NORMATIVE)
    └── schedule.test.ts    # Unit + integration tests
```

---

## Bước 1: Tests

```bash
cd offchain && npm install && npm run test
```

Deploy checklist phải pass:
- `TV-SCH-01`: S_Q(L) 5 values, T11 continuity, T12 diminishing ✓
- `TV-SCH-02`: L=100, λ=4000 LAMP → 45 MAGIC/fire ✓
- `TV-SCH-03`: T8 rate immutability ✓
- `TV-SCH-04`: Shard cap T13 ✓
- `TV-SCH-05`: C-SCH-RATE M_i≥1 ✓
- `TV-SCH-06`: 4 catch-up fires ✓
- `TV-SCH-CATCHUP-LIMIT`: 18 eligible → 8 fires ✓
- `TV-SCH-FIRE-PERM`: permissionless ✓
- `TV-SCH-T-DET`: all M_i identical ✓
- `TV-SCH-FIRE3`: C-FIRE-3 atomic ✓

---

## Bước 2: Build + Deploy

```bash
cd onchain && aiken build
```

Cần deploy 2 validators: `vault` và `shard`. Cần deploy 16 shard UTxOs (one per shard_id 0..15).

**Khởi tạo 16 shard UTxOs:**
```typescript
for (let shardId = 0; shardId < 16; shardId++) {
  const initialShard = {
    shard_id:                    BigInt(shardId),
    shard_locked_lamp:            0n,
    shard_active_count:           0n,
    shard_cumulative_committed:   0n,
    shard_cumulative_fired:       0n,
    last_updated_epoch:           BigInt(currentEpoch),
    shard_cap:                    450_000_000_000_000n,   // §20.2
  };
  // Deploy to shard script address with SHARD NFT
}
```

---

## Bước 3: Run two-phase flow

```typescript
import { createLucid, buildScheduleCommitTx, buildScheduleFireTx, signAndSubmit, lampToOildrop } from "@magiclamp/schedulegen-sdk";

const lucid  = await createLucid(process.env.BLOCKFROST_KEY!);
const shardUtxos = await lucid.utxosAt(shardScriptAddress);  // all 16

// ── Phase 1: Commit (user signs) ─────────────────────────────────
const commitResult = await buildScheduleCommitTx({
  lucid, vaultUtxo, shardUtxos,
  scheduleLength: 100n,         // L=100 orders (~500 days)
  lampPerEpoch:   lampToOildrop(4000n),  // λ=4000 LAMP per fire
  userAddress:    await lucid.wallet().address(),
});
console.log(commitResult.summary);
// rate_locked_q: 11_250_000_000 (immutable forever — T8)
// M_i per fire:  45.0000 MAGIC
// Total MAGIC:   4500.0000 MAGIC (guaranteed)
// Total locked:  400,000 tLAMP
// ⚠ Cannot cancel (T10). Permissionless from epoch 52.

await signAndSubmit(lucid, commitResult.tx);

// ── Phase 2: Fire (PERMISSIONLESS — keeper submits) ───────────────
// Keeper monitors: current_epoch ≥ start_fire_epoch + fired_count
lucid.selectWallet.fromPrivateKey(process.env.KEEPER_KEY!);

const fireResult = await buildScheduleFireTx({
  lucid,
  vaultUtxo:   updatedVaultUtxo,
  shardUtxos,
  scheduleId:  commitResult.scheduleId,
});
console.log(fireResult.summary);
// Fires in tx:   4 (catch-up — C-FIRE-1 ≥)
// Total MAGIC:   180.0000 MAGIC (4 × 45)
// LAMP giải phóng khoá: 16,000 tLAMP (vẫn nằm nguyên trong vault — I-ACT-7)
// Progress: 4/100 orders
// Note: NO owner signature required (C-SCH-FIRE-PERMISSION).

await signAndSubmit(lucid, fireResult.tx);
```

---

## 5 điểm quan trọng nhất cho dev

**1. T8: rate_locked_q là immutable.** Fire tx đọc `GenSchedule.rate_locked_q` từ datum — KHÔNG recompute từ R_snap. DAO nâng R_snap → chỉ affect commit mới, không affect existing schedules.

**2. C-FIRE-1 ≥ (catch-up).** Khác VacuumGen (exact epoch). Fire eligible khi `current_epoch ≥ e_i`. Nếu bỏ lỡ 5 epoch → 1 tx bắt kịp 5 orders (tối đa 8).

**3. C-FIRE-3 atomic (bản PHA 2).** Toàn bộ kế toán phải được validator kiểm ĐỒNG THỜI: `output.fired_count = input + fires_in_tx`, **`lamp_balance` bất biến**, `lamp_locked -= fires_in_tx × λ`, các holding tương ứng lật `is_locked = False`, `|new_batches| = fires_in_tx`, `∀ initial = M_i`. Không có chân Treasury: một fire không chuyển LAMP đi đâu cả (I-ACT-7). Dựng output Treasury theo bản cũ là tx bị từ chối — value-preservation không khớp.

**4. C-SCH-FIRE-SHARD (A19).** Keeper phải compute `shard_id = blake2b256(vault.owner)[0] % 16` và update đúng shard UTxO. Sai shard → validator reject.

**5. Shard có 2 validators.** Vault validator + Shard validator phải đều được deployed và referenced trong txs. Commit và Fire đều spend shard UTxO (không phải reference input).
