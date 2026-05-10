# ScheduleGen — Testnet Implementation Guide
## GenMAGIC v3.3 · §11 ScheduleGen · Cardano Preview Testnet

---

## ScheduleGen vs 3 cơ chế kia — tổng kết

| | ScheduleGen | VacuumGen | InstantGen | SnapshotGen |
|---|---|---|---|---|
| Phases | **2** (Commit → Fire ≥8) | 2 (Commit → Fire exact) | 1 | 1 |
| Rate | **Locked at commit (T8)** | Computed at fire | Computed at fire | Epoch rate |
| Fire | **C-FIRE-1 ≥ (catch-up)** | C-VAC-6 exact | N/A | N/A |
| Max fires/tx | **8** (catch-up) | 1 | 1 | 1 |
| UM | **Không** (locked rate) | Có (C-UM-7) | Có (C-UM-6) | Không (T16) |
| Cancel | **Không** (T10) | Không | N/A | N/A |
| Shard | **Có** (16 shards) | Không | Không | Không |
| Permissionless fire | **Có** (C-SCH-FIRE-PERMISSION) | Có | N/A | N/A |
| Batch cliff | **k≥1** | k≥1 | k≥2 (halving) | k≥N(P) |

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
import { createLucid, buildScheduleCommitTx, buildScheduleFireTx, signAndSubmit, lampToOil } from "@magiclamp/schedulegen-sdk";

const lucid  = await createLucid(process.env.BLOCKFROST_KEY!);
const shardUtxos = await lucid.utxosAt(shardScriptAddress);  // all 16

// ── Phase 1: Commit (user signs) ─────────────────────────────────
const commitResult = await buildScheduleCommitTx({
  lucid, vaultUtxo, shardUtxos,
  scheduleLength: 100n,         // L=100 orders (~500 days)
  lampPerEpoch:   lampToOil(4000n),  // λ=4000 LAMP per fire
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
// LAMP transferred: 16,000 tLAMP → Treasury
// Progress: 4/100 orders
// Note: NO owner signature required (C-SCH-FIRE-PERMISSION).

await signAndSubmit(lucid, fireResult.tx);
```

---

## 5 điểm quan trọng nhất cho dev

**1. T8: rate_locked_q là immutable.** Fire tx đọc `GenSchedule.rate_locked_q` từ datum — KHÔNG recompute từ R_snap. DAO nâng R_snap → chỉ affect commit mới, không affect existing schedules.

**2. C-FIRE-1 ≥ (catch-up).** Khác VacuumGen (exact epoch). Fire eligible khi `current_epoch ≥ e_i`. Nếu bỏ lỡ 5 epoch → 1 tx bắt kịp 5 orders (tối đa 8).

**3. C-FIRE-3 atomic.** Toàn bộ accounting phải được validator verify ĐỒNG THỜI: `output.fired_count = input + fires_in_tx`, `lamp_balance - fires_in_tx × λ`, `Treasury + fires_in_tx × λ`, `|new_batches| = fires_in_tx`, `∀ initial = M_i`.

**4. C-SCH-FIRE-SHARD (A19).** Keeper phải compute `shard_id = blake2b256(vault.owner)[0] % 16` và update đúng shard UTxO. Sai shard → validator reject.

**5. Shard có 2 validators.** Vault validator + Shard validator phải đều được deployed và referenced trong txs. Commit và Fire đều spend shard UTxO (không phải reference input).
