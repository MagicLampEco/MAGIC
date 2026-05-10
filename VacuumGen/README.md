# VacuumGen — Testnet Implementation Guide
## GenMAGIC v3.3 · §10 VacuumGen · Cardano Preview Testnet

---

## VacuumGen vs InstantGen vs SnapshotGen — so sánh nhanh

| | VacuumGen | InstantGen | SnapshotGen |
|---|---|---|---|
| Phases | **2** (Commit → Fire) | 1 | 1 |
| LAMP cost | Có (tại fire) | Có (tại commit) | Không |
| UM | **Smoothed, NO stale check** (C-UM-7) | Có stale check (C-UM-6) | Không (T16) |
| PM | **Không có** | Có | Có |
| LF | **Không có** | Không | Có |
| SM (Streak) | **Có** | Không | Không |
| Fire permission | **Permissionless** (C-VAC-FIRE-PERMISSION) | User only | User only |
| Cancel | **Không** (C-VAC-12) | N/A | N/A |
| Epoch match | **Exact** (C-VAC-6) | N/A | N/A |
| Batch cliff | k≥1 (1 epoch) | k≥2 | k≥N(P) |

---

## Cấu trúc project

```
VacuumGen/
├── onchain/
│   ├── lib/
│   │   ├── types.ak        # Data types (shared)
│   │   ├── constants.ak    # VBR, SM, VACUUM_DELAY, etc.
│   │   ├── math.ak         # computeVacuumMagic, getSmQ, C-UM-7
│   │   └── lock.ak         # youngest-first lock + remove_locked_amount
│   └── validators/
│       └── vault.ak        # VacuumCommit + VacuumFire redeemers
├── offchain/src/
│   ├── math.ts             # BigInt engine
│   ├── vacuum.ts           # buildVacuumCommitTx + buildVacuumFireTx
│   └── constants.ts
└── tests/
    ├── vectors.ts          # NORMATIVE test vectors
    └── vacuum.test.ts      # Unit + integration tests
```

---

## Bước 1: Chạy tests

```bash
cd offchain && npm install && npm run test
```

Deploy checklist (§E.3) — phải pass:
- `TV-VAC-01`: λ=10⁹, UM=1.5, SM=1.10 → 825M ✓
- `TV-VAC-CALIB`: §20.3 calibration → 0.5 MAGIC ✓
- `TV-SM-TABLE`: 4 streak tiers ✓
- `TV-UM-SPLIT-VACUUM`: stale UM → still smoothed (C-UM-7) ✓
- `TV-LOCK-01`: youngest-first lock (T5) ✓
- `TV-VAC-FULL`: vault full → M=0, LAMP still transfers (INV-43) ✓
- `TV-VAC-EPOCH`: exact epoch match (C-VAC-6) ✓
- `TV-VAC-PERM`: permissionless fire ✓

---

## Bước 2: Build + Deploy

```bash
cd onchain && aiken build
# Update TESTNET_CONFIG in src/constants.ts
```

---

## Bước 3: Run two-phase flow

```typescript
import { createLucid, buildVacuumCommitTx, buildVacuumFireTx, signAndSubmit, lampToOil } from "@magiclamp/vacuumgen-sdk";

const lucid = await createLucid(process.env.BLOCKFROST_KEY!);
lucid.selectWallet.fromPrivateKey(process.env.PRIVATE_KEY!);

// ── Phase 1: Commit (user signs) ──────────────────────────
const commitResult = await buildVacuumCommitTx({
  lucid,
  vaultUtxo: await lucid.utxoByUnit(vaultNFT),
  lambdaOil: lampToOil(1000n),   // 1000 LAMP
  userAddress: await lucid.wallet().address(),
});
console.log(commitResult.summary);
// ═══ VacuumGen Commit ═══
// Commit epoch: 100 | Fire epoch: 102 (~10 days)
// λ locked:     1000 tLAMP | Order ID: deadbeef...
// ✓ LAMP locked. Fire tx can be triggered by ANYONE at epoch 102.
// ⚠ Cannot cancel (C-VAC-12).

const commitTxHash = await signAndSubmit(lucid, commitResult.tx);

// ── Wait 2 epochs (~10 days) ──────────────────────────────
// (Keeper monitors fire_epoch and submits automatically)

// ── Phase 2: Fire (PERMISSIONLESS — anyone can submit) ────
lucid.selectWallet.fromPrivateKey(process.env.KEEPER_PRIVATE_KEY!);  // keeper wallet

const fireResult = await buildVacuumFireTx({
  lucid,
  vaultUtxo:   await lucid.utxoByUnit(vaultNFT),   // updated after commit
  orderId:     commitResult.orderId,
  umDatumUtxo: await lucid.utxoByUnit(umNFT),
});
console.log(fireResult.summary);
// ═══ VacuumGen Fire ═══
// λ transferred: 1000 tLAMP → Treasury
// UM used:       1.50× (C-UM-7: always smoothed)
// SM used:       1.10× (streak=8)
// MAGIC minted:  0.8250 MAGIC
// ✓ Batch created. Expires end of epoch 102 (cliff).
// Note: This tx required NO owner signature (C-VAC-FIRE-PERMISSION).

await signAndSubmit(lucid, fireResult.tx);
```

---

## Điểm quan trọng nhất cho dev

**C-VAC-6 (EXACT epoch match)**: Fire tx phải submit chính xác tại `fire_epoch`. Sớm hơn → reject. Muộn hơn → reject. Keeper phải monitor và submit đúng lúc. Đây là điểm khác biệt với ScheduleGen (C-FIRE-1 ≥ cho phép catch-up).

**C-VAC-FIRE-PERMISSION**: Validator KHÔNG check owner signature trong VacuumFire redeemer. Dev phải đảm bảo `.addSignerKey()` KHÔNG có trong fire tx (chỉ có trong commit tx).

**INV-43**: LAMP LUÔN transfer sang Treasury khi fire, kể cả khi M=0 (vault full). Không có điều kiện nào ngăn transfer này.

**C-UM-7**: `getUmForVacuum()` là hàm riêng, không share logic với `getUmForInstant()`. Không có stale check, không có fallback.

**Lock: youngest-first; Unlock: oldest-first**. Hai chiều khác nhau. `selectLampForLock` và `removeLockedAmount` phải bit-identical với Aiken (P8).
