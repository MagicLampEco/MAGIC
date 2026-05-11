# MagicLamp Network — MAGIC Protocol
## GenMAGIC v3.3 · Cardano L1 (PlutusV3) · Preview Testnet

---

## Tổng quan kiến trúc

```
┌─────────────────────────────────────────────┐
│           App tích hợp (TonFarm, ...)       │
└─────────────────┬───────────────────────────┘
                  │ PhoenixKey SDK
┌─────────────────▼───────────────────────────┐
│         PhoenixKey (phoenixkey.me)           │
│         Quản lý danh tính & khoá onchain     │
└─────────────────┬───────────────────────────┘
                  │ MAGIC Protocol
┌─────────────────▼───────────────────────────┐
│         MagicLamp / MAGIC (repo này)         │
│   Smart contracts + Protocol math engine     │
└─────────────────┬───────────────────────────┘
                  │ Cardano L1
┌─────────────────▼───────────────────────────┐
│              LampNet                         │
│         Decentralized storage                │
└─────────────────────────────────────────────┘
```

**MagicLamp/MAGIC** = Protocol layer (smart contracts + math)
**PhoenixKey SDK** = Interface layer (apps tích hợp qua đây)
**Apps** = Không biết gì về MAGIC — chỉ gọi PhoenixKey SDK

---

## Trạng thái hiện tại

| Module | Spec | TypeScript Tests | Aiken Build | Testnet |
|---|---|---|---|---|
| InstantGen | §9 | ✅ 45/45 | ⬜ | ⬜ |
| SnapshotGen | §8 | ✅ 46/46 | ⬜ | ⬜ |
| VacuumGen | §10 | ✅ 30/30 | ⬜ | ⬜ |
| ScheduleGen | §11 | ✅ 29/29 | ⬜ | ⬜ |
| UMKeeper | §14 | ✅ 20/20 | ⬜ | ⬜ |
| Consolidate | §6.9 | ✅ 12/12 | ⬜ | ⬜ |
| ProfileChange | §12 | ✅ 8/8 | ⬜ | ⬜ |
| **TỔNG** | | **✅ 190/190** | | |

---

## Cấu trúc repo

```
MAGIC/
├── InstantGen/          # §9  — On-demand MAGIC purchase
│   ├── onchain/         # Aiken validator (PlutusV3)
│   ├── offchain/        # TypeScript SDK + tests
│   └── tests/           # Test vectors (normative App B)
├── SnapshotGen/         # §8  — Automatic epoch generation
├── VacuumGen/           # §10 — Two-phase lock-then-fire
├── ScheduleGen/         # §11 — Forward contract, rate locked
├── UMKeeper/            # §14 — Network Demand Multiplier updater
├── Consolidate/         # §6.9 — Holdings consolidation utility
├── ProfileChange/       # §12 — Activity profile switching
├── scripts/             # Deploy + test scripts cho testnet
│   ├── deploy/          # 4 bước deploy theo thứ tự
│   └── test/            # End-to-end flow test
├── DEVELOPER_GUIDE.md   # Hướng dẫn chi tiết cho dev
└── SnapshotGen-Simulator.HTML  # UI demo cho PM/user
```

---

## Chạy tests nhanh

```bash
# Chạy tất cả — phải ra 190/190
for dir in InstantGen SnapshotGen VacuumGen ScheduleGen UMKeeper Consolidate ProfileChange; do
  echo "=== $dir ===" && cd $dir/offchain && npm install --silent && npm test && cd ../..
done
```

---

## Bốn cơ chế sinh MAGIC

| Cơ chế | Trigger | LAMP cost | UM | Lifetime |
|---|---|---|---|---|
| **SnapshotGen** | Tự động mỗi epoch | Không | Không | N(profile) epoch |
| **InstantGen** | User on-demand | Transfer ngay | Có (stale check) | 2 epoch |
| **VacuumGen** | Commit → fire sau 2 epoch | Transfer tại fire | Có (no stale) | 1 epoch |
| **ScheduleGen** | Forward contract | Lock tại commit | Không (locked rate) | 1 epoch |

---

## Quick reference — Profile

| Profile | MAGIC/epoch (1000 LAMP) | Lifetime batch | Decay |
|---|---|---|---|
| Ember | ~5.98 MAGIC | 3 epoch | ×0.70/ep |
| Flame | ~4.62 MAGIC | 6 epoch | ×0.80/ep |
| Lantern | ~3.15 MAGIC | 9 epoch | ×0.90/ep |

*(LF=1.0, OAC=0.80, không có apps hoạt động)*

---

## Links

- Spec: GenMAGIC v3.3 (internal)
- PhoenixKey SDK: https://github.com/PhoenixKeyDID/PhoenixKey-SDK
- Cardano Preview Testnet Faucet: https://docs.cardano.org/cardano-testnet/tools/faucet
- Blockfrost: https://blockfrost.io
- Aiken: https://aiken-lang.org
