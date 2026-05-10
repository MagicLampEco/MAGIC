# SnapshotGen — Testnet Implementation Guide
## GenMAGIC v3.3 · §8 SnapshotGen · Cardano Preview Testnet

---

## SnapshotGen vs InstantGen — 5 điểm khác biệt cốt lõi

| | SnapshotGen | InstantGen |
|---|---|---|
| Trigger | Epoch boundary (lazy) | User on-demand |
| LAMP cost | **Không có** | Transfer ngay |
| UM | **Không có** (T16, P10) | Có (C-UM-6 stale check) |
| LAMP dùng | **Full** (incl. locked) — C-SS-5, L3 | Chỉ L_avail |
| Công thức | L × R × **LF × OAC** × PM × B / Q⁵ | L_paid × R × **UM** × PM / Q³ |

---

## Cấu trúc project

```
SnapshotGen/
├── onchain/
│   ├── lib/
│   │   ├── types.ak        # Data types (§4.1, §5)
│   │   ├── constants.ak    # Protocol constants (§19)
│   │   ├── lf_oac.ak       # LF (§6.3) + OAC (§6.4) ← KEY
│   │   ├── decay.ak        # Geometric decay (§4.2) + scale-back burn (§6.6)
│   │   └── snapshot.ak     # SnapshotGen formula + catch-up (§8)
│   └── validators/
│       └── vault.ak        # Vault validator (C-SS-1..8)
├── offchain/src/
│   ├── math.ts             # BigInt engine: LF, OAC, formula, decay, burn
│   ├── snapshot.ts         # Transaction builder
│   └── constants.ts
└── tests/
    ├── vectors.ts          # NORMATIVE test vectors (App B)
    ├── math.test.ts        # Unit tests (TV-SS-01..04, TV-LF-01..03, TV-SNAPGEN-01...)
    └── snapshot.test.ts    # Integration tests
```

---

## Bước 1: Chạy tests (KHÔNG cần network)

```bash
cd offchain && npm install && npm run test
```

Deploy checklist (§E.3) — phải pass trước khi deploy:
- `TV-SS-01`: Lantern decay k=0..9 (10 steps)
- `TV-SS-02`: Flame decay
- `TV-SS-03`: Ember decay
- `TV-SS-04`: Scale-back burn, diff=0 ✓ (T17)
- `TV-LF-01..03`: LF formula
- `TV-SNAPGEN-01`: 1000 LAMP Flame LF=1.0 OAC=0.8 → 4.62 MAGIC
- `TV-SNAPGEN-MATURE`: Ember LF=1.5 OAC=1.0 → 11.2125 MAGIC
- `TV-CATCHUP-01`: Δe=5 → 28.586 MAGIC
- `TV-SAMENESS-01`: profile_at_creation immutable (T4)
- `TV-OAC-BOUNDARY`: burn at current epoch excluded
- `TV-CONS-SNAPSHOT`: LAMP unchanged (T16)

---

## Bước 2: Build Aiken

```bash
cd onchain && aiken build
```

---

## Bước 3: Trigger SnapshotGen on testnet

```typescript
import { createLucid, buildSnapshotGenTx, signAndSubmit } from "@magiclamp/snapshotgen-sdk";

const lucid = await createLucid(process.env.BLOCKFROST_KEY!);
lucid.selectWallet.fromPrivateKey(process.env.PRIVATE_KEY!);

const vaultUtxo = await lucid.utxoByUnit(vaultNFT);

const result = await buildSnapshotGenTx({ lucid, vaultUtxo, userAddress });
console.log(result.summary);
// ═══ SnapshotGen Summary ═══
// Epoch:          100
// Profile:        Flame  (r=2, N=6 epoch, decay ×0.8)
// LAMP balance:   100,000 tLAMP (incl. locked — C-SS-5)
// LF:             1.00×
// OAC:            0.80×
// M₀/epoch:       4.6200 MAGIC
// Δ epochs:       1  (catch-up — C-SS-6)
// MAGIC minted:   4.6200 MAGIC  (4620000000 nanogic)
// ✓  Batch created with 6-epoch lifetime.
// Note: No LAMP moved. SnapshotGen is free (T16 — no UM).

const txHash = await signAndSubmit(lucid, result.tx);
```

---

## Các điểm quan trọng cần nhớ

**C-SS-8 — Generation lost permanently**: Nếu vault có đủ 32 batches khi SnapshotGen trigger, batch KHÔNG được tạo và KHÔNG thể backfill. `last_updated_epoch` vẫn update. Wallet phải warn user khi `|batches| ≥ 28`.

**T4 — profile_at_creation immutable**: Batch Flame với N=6 vẫn giữ N=6 dù user đổi sang Ember (N=3). Không thể extend lifetime bằng cách đổi profile.

**C-SS-5 + L3 — full lamp_balance**: SnapshotGen dùng toàn bộ `lamp_balance` kể cả phần locked (đang trong Schedule/Vacuum). KHÔNG dùng `L_avail`. Đây là điểm khác biệt quan trọng với InstantGen.

**T16 — Không có UM**: Validator KHÔNG nhận UM reference input. Không cần UM datum UTxO trong tx.

**OAC window [e-12, e)**: Burns TẠI current epoch KHÔNG được tính vào OAC của epoch hiện tại (chỉ tính cho epoch sau).
