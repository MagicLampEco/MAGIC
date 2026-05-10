# InstantGen — Testnet Implementation Guide
## GenMAGIC v3.3 · §9 InstantGen · Cardano Preview Testnet

---

## Cấu trúc project

```
instantgen/
├── onchain/                    # Aiken on-chain validators (PlutusV3)
│   ├── aiken.toml
│   ├── lib/
│   │   ├── types.ak            # Data types (§4.1, §5)
│   │   ├── constants.ak        # Protocol constants (§19)
│   │   ├── math.ak             # Q-format arithmetic (§6.1)
│   │   ├── decay.ak            # Decay + halving (§4, C-DECAY-*)
│   │   ├── um.ak               # UM handling (§14, C-UM-6)
│   │   └── lamp.ak             # Loyalty holdings helpers
│   └── validators/
│       └── vault.ak            # Vault spending validator (§9, §5.8)
├── offchain/                   # TypeScript SDK
│   ├── src/
│   │   ├── types.ts            # Lucid Data schemas
│   │   ├── constants.ts        # Shared constants
│   │   ├── math.ts             # BigInt math engine ← CORE
│   │   ├── instant.ts          # Transaction builder
│   │   └── index.ts
│   └── package.json
└── tests/
    ├── vectors.ts              # Test vectors (NORMATIVE — App B)
    ├── math.test.ts            # Unit tests — math engine
    └── instant.test.ts         # Integration tests — full flow
```

---

## Prerequisite

| Tool | Version | Install |
|---|---|---|
| Aiken | ≥ 1.1.0 | `curl -sSfL https://install.aiken-lang.org \| bash` |
| Node.js | ≥ 20 (LTS) | https://nodejs.org |
| Cardano CLI | latest | https://github.com/input-output-hk/cardano-node |
| Blockfrost API key | Preview testnet | https://blockfrost.io |

---

## Bước 1: Chạy unit tests trước (KHÔNG CẦN NETWORK)

```bash
cd offchain
npm install
npm run test
```

**Tất cả tests phải pass trước khi tiếp tục.**
Deploy checklist (§E.3):
- `TV-INST-01..03`: Instant lifecycle ✓
- `TV-UM-SPLIT`: UM stale fallback ✓
- `TV-OVERFLOW-01..02`: BigInt required ✓
- `TV-HALVED-INJECT`: C-DECAY-8 reject ✓
- `TV-CONS-01`: LAMP conservation ✓

---

## Bước 2: Build Aiken validator

```bash
cd onchain
aiken build
```

Output: `onchain/plutus.json` chứa validator script.

Lấy script hash:
```bash
aiken blueprint address --testnet-magic 2  # Preview testnet magic = 2
```

Cập nhật `offchain/src/constants.ts`:
```typescript
export const TESTNET_CONFIG = {
  vaultScriptHash: "abc123...",  // ← paste script hash ở đây
  lampPolicyId:    "...",
  ...
};
```

---

## Bước 3: Deploy LAMP token (testnet)

Tạo minting policy cho LAMP testnet token:
```bash
# Generate policy key
cardano-cli address key-gen \
  --verification-key-file lamp_policy.vkey \
  --signing-key-file lamp_policy.skey

# Get policy ID
cardano-cli transaction policyid \
  --script-file lamp_policy.json
```

Mint testnet LAMP:
```bash
cardano-cli transaction build \
  --testnet-magic 2 \
  --tx-in <your_utxo> \
  --mint "1000000000000 <lamp_policy_id>.4c414d50" \
  --mint-script-file lamp_policy.json \
  --change-address <your_address> \
  --out-file mint_tx.raw

cardano-cli transaction sign --signing-key-file payment.skey --signing-key-file lamp_policy.skey \
  --tx-body-file mint_tx.raw --out-file mint_tx.signed

cardano-cli transaction submit --testnet-magic 2 --tx-file mint_tx.signed
```

---

## Bước 4: Deploy UM Datum UTxO

UM datum phải tồn tại trên chain trước khi bất kỳ InstantGen nào có thể chạy.

Tạo UM datum initial state (UM = 1.0 = neutral, §20.2):
```typescript
import { Data } from "@lucid-evolution/lucid";
import { UMDatumSchema } from "./src/types.js";

const initialUM = {
  smoothed_q:         1_000_000_000n,   // UM = 1.0 (neutral)
  last_updated_epoch: BigInt(currentEpoch),
  history:            [],
};

const umDatumCbor = Data.to(initialUM, UMDatumSchema);
```

Gửi UTxO với datum này đến UM datum address, kèm UM NFT token.

---

## Bước 5: Tạo Vault UTxO

```typescript
import { createLucid } from "@magiclamp/instantgen-sdk";
import { Data } from "@lucid-evolution/lucid";
import { VaultDatumSchema } from "./src/types.js";

const lucid = await createLucid(process.env.BLOCKFROST_KEY!);
lucid.selectWallet.fromPrivateKey(process.env.PRIVATE_KEY!);

const initialVault = {
  owner:                 "your_pkh_hex",
  lamp_balance:          10_000_000_000n,  // 10,000 LAMP
  lamp_locked:           0n,
  loyalty_holdings:      [{
    amount:         10_000_000_000n,
    acquired_epoch: BigInt(currentEpoch),
    is_locked:      false,
  }],
  magic_batches:         [],
  next_batch_index:      0n,
  vacuum_orders:         [],
  gen_schedules:         [],
  profile:               "Flame",
  profile_changed_epoch: 0n,
  pending_profile:       null,
  last_updated_epoch:    BigInt(currentEpoch),
  delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
  activity_state:        { recent_burn_epochs: [], total_burns_count: 0n },
  streak_state:          { current_streak: 0n, last_active_epoch: 0n },
  personal_delegate:     null,
  attribution:           {
    attribution_root: "0".repeat(64),    // 32 zero bytes
    last_event_epoch: 0n,
    total_events:     0n,
  },
};

// Send vault UTxO to script address with LAMP + datum
```

---

## Bước 6: Chạy InstantGen

```typescript
import { createLucid, buildInstantGenTx, signAndSubmit, lampToOil } from "@magiclamp/instantgen-sdk";

const lucid = await createLucid(process.env.BLOCKFROST_KEY!);
lucid.selectWallet.fromPrivateKey(process.env.PRIVATE_KEY!);

// Read UTxOs
const vaultUtxo  = await lucid.utxoByUnit(yourVaultNFT);
const umDatumUtxo = await lucid.utxoByUnit(umNFT);

// Build tx
const result = await buildInstantGenTx({
  lucid,
  vaultUtxo,
  lampPaidOil: lampToOil(1000n),   // 1000 LAMP
  umDatumUtxo,
  userAddress: await lucid.wallet().address(),
});

console.log(result.summary);
// Example output:
// ═══ InstantGen Summary ═══
// Epoch:         100
// LAMP paid:     1000 tLAMP (1000000000 oil)
// UM used:       1.00× ✓
// MAGIC minted:  3.1500 MAGIC (3150000000 nanogic)
// Batch lifetime: 2 epochs (k=0: full, k=1: halved, k≥2: expired)

// Sign and submit
const txHash = await signAndSubmit(lucid, result.tx);
console.log("Tx submitted:", txHash);
```

---

## Các lỗi thường gặp

| Mã lỗi | Ý nghĩa | Xử lý |
|---|---|---|
| `GEN-INST-001` | lamp_paid < 10 LAMP | Tăng amount |
| `GEN-INST-002` | lamp_paid > MAX | Giảm amount |
| `GEN-INST-003` | lamp_paid > L_avail | LAMP đang bị lock? |
| `GEN-VAULT-001` | 32 batches trong vault | Burn bớt batches trước |
| `UM stale fallback` | UM chưa được update | Đợi keeper update UM, hoặc chấp nhận UM=0.5× |

---

## Ký hiệu quan trọng

| Ký hiệu | Giá trị | Nguồn |
|---|---|---|
| Q | 10^9 | Immutable (§19.8) |
| INSTANT_BASE_RATE_Q | 3_000_000_000 | §19.4 Constitutional |
| UM_MIN_Q / UM_FALLBACK_Q | 500_000_000 | §19.7 Constitutional |
| UM_MAX_STALENESS | 1 epoch | §19.7 Significant |
| MIN_INSTANT_PURCHASE | 10 LAMP (10^7 oil) | §19.4 Routine |
| INSTANT_DECAY_WINDOW | 2 epochs | §19.4 Constitutional |

---

## Kiểm tra sau khi deploy

```bash
# Kiểm tra vault UTxO datum
cardano-cli query utxo --address <vault_script_address> --testnet-magic 2 --out-file vault_utxo.json

# Verify LAMP ở Treasury
cardano-cli query utxo --address <treasury_address> --testnet-magic 2
```

---

## Files quan trọng cần review trước khi deploy

1. **`onchain/validators/vault.ak`** — tất cả C-INST-* constraints
2. **`offchain/src/math.ts`** — `computeInstantMagic()` must be bit-identical với Aiken
3. **`offchain/src/constants.ts`** — update `TESTNET_CONFIG` với deployed addresses
4. **`tests/vectors.ts`** — NORMATIVE, tất cả vectors phải pass

---

## Normative references

- GenMAGIC v3.3 §9 — InstantGen formula + constraints
- §4.3 — Instant batch decay + halving (T18, C-DECAY-7, C-DECAY-8)
- §14.4 — UM stale check C-UM-6 (Instant only)
- App B §B.3 — TV-INST-01..03
- App B §B.13 — TV-UM-SPLIT
- App B §B.14 — TV-OVERFLOW-01..02
- App B §B.17 — TV-HALVED-INJECT
- §E.3 — Deploy checklist
