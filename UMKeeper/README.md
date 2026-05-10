# UMKeeper — UM Datum Updater
## GenMAGIC v3.3 · §14 Network Demand Multiplier

---

## Tại sao cần UM Keeper?

- `InstantGen` dùng **C-UM-6**: nếu UM stale (staleness > 1 epoch) → fallback về `UM_MIN_Q = 0.5×`
- Keeper update UM mỗi epoch → users nhận rate đúng thực tế (0.5× – 2.0×)
- Không có keeper → mọi InstantGen luôn nhận rate tệ nhất (0.5×)

---

## Formula (§14.1)

```
um_raw      = ⌊ epoch_burns × Q / max(epoch_mints, 1) ⌋
um_smoothed = clamp(SMA(last_6_raw), 0.5Q, 2.0Q)
```

---

## Deploy

```bash
cd onchain && aiken build
# Lấy um_datum_validator script hash
```

Khởi tạo UM datum UTxO:
```typescript
const initialUM = {
  smoothed_q:         1_000_000_000n,  // neutral Q = 1.0 (§20.2)
  last_updated_epoch: BigInt(genesisEpoch),
  history:            [],
};
```

---

## Chạy Keeper

```typescript
import { createLucid, startUMKeeper } from "@magiclamp/umkeeper";

const lucid = await createLucid(process.env.BLOCKFROST_KEY!);
lucid.selectWallet.fromPrivateKey(process.env.KEEPER_KEY!);

const stop = startUMKeeper({
  lucid,
  umUtxoUnit:   process.env.UM_NFT_UNIT!,
  umScriptHash: process.env.UM_SCRIPT_HASH!,
  shardAddresses: [],   // replace với shard addresses thực
  intervalMs:   60_000, // check mỗi 1 phút
  onUpdate: (r) => console.log(`UM updated: ${r.oldSmoothed} → ${r.newSmoothed}`),
  onError:  (e) => console.error("Keeper error:", e),
});

// Stop khi cần: stop()
```

---

## Tests

```bash
cd offchain && npm install && npm test
```

---

## Quan trọng: `getEpochStats()` cần thay thế

File `src/keeper.ts` có stub `getEpochStats()`. Trước testnet mainnet cần replace bằng:
1. Query `MagicSupplyShard` UTxOs để lấy `shard_minted` và `shard_burned` của epoch trước
2. Hoặc dùng off-chain indexer tổng hợp từ on-chain tx history

Testnet v1: keeper có thể hardcode giá trị neutral (`burns = mints`) để UM giữ ở 1.0×.
