# Testnet Results — SnapshotGen Working on Preview

**Date:** 2026-05-16
**Network:** Preview testnet (Conway era)
**Status:** ✅ SnapshotGen end-to-end SUCCESS

## Confirmed working

- **Vault create:** [`983d4313...`](https://preview.cardanoscan.io/transaction/983d43135cce44686ed4d9e8f3f050c8f533a75bf7395b5e2746c5176a5eaf64)
- **SnapshotGen spend:** [`bcd8cc98...`](https://preview.cardanoscan.io/transaction/bcd8cc9804cf328ba1eb327e0b83ac9063aaaedc6b3bd65f3dbb0244279e0af6) — vault spent, new MagicBatch created, last_updated_epoch advanced
- **Vault address (Preview, applied):** `addr_test1wrr6uxfl5gduhxxzzxty9laq48kd9r6vzed7erh5m4anr7qpd0wnd`
- **Vault script hash:** `c7ae193fa21bcb98c2119642ffa0a9ecd28f4c165bec8ef4dd7b31f8`

## What was NOT actually a "Conway bug"

Previous session's `UnConstrData` failures (documented in earlier `TESTNET_BLOCKED.md`, since deleted) were **not** caused by Aiken stdlib v2 / Conway PlutusV3 compatibility. Root cause was **incorrect spend handler signature**:

```diff
- spend(datum_opt, redeemer, own_ref, ctx: ScriptContext) {
-   let tx = ctx.transaction  // ← BUG
+ spend(datum_opt, redeemer, own_ref, tx: Transaction) {  // ← correct
```

Aiken's `validator { spend(...) }` named handler **already extracts `Transaction`** for the 4th arg. Declaring it as `ScriptContext` and reading `.transaction` actually re-reads the first field of `Transaction` (which is `inputs: List<Input>`). Any subsequent ctx.transaction.* access then calls `UnConstrData` on a `List`, producing the misleading error.

Bisect from previous session was correct in identifying *where* the crash happens but wrong about the cause.

## Fixes applied this session

| File | Change | Reason |
|---|---|---|
| `SnapshotGen/onchain/validators/vault.ak` | `spend(... ctx: ScriptContext)` → `spend(... tx: Transaction)`; removed `let tx = ctx.transaction`; removed unused `ScriptContext` import | Root-cause fix |
| `SnapshotGen/onchain/aiken.toml` | `aiken-lang/stdlib v2` → `v3.1.0` | Caught `IntervalBoundType<Int>` (v2) → `IntervalBoundType` (v3) breaking change at compile time |
| `SnapshotGen/onchain/validators/vault.ak` | `IntervalBoundType<Int>` → `IntervalBoundType` | stdlib v3.1.0 made it non-generic |
| `SnapshotGen/onchain/lib/.../snapshot.ak` | Removed unused `prune_stale_activity` import | stdlib v3.1.0 stricter warnings |
| Aiken validator parameter | `slots_per_epoch: Int` → `ms_per_epoch: Int` | PlutusV3 `validity_range` is POSIX milliseconds (per stdlib transaction.ak doc), not slots |
| `SnapshotGen/offchain/src/types.ts` | `VaultRedeemerSchema`: TS variants didn't match Aiken `pub type VaultRedeemer` | P8 invariant violation found while testing |
| `SnapshotGen/offchain/src/snapshot.ts` | Uses `tipPosixMs / msPerEpoch(network)` (matches validator); validFrom/validTo passed as POSIX ms | Validator/SDK epoch math must match bit-identical |
| `scripts/deploy/04_create_vault.ts` | Pre-seed `last_updated_epoch = currentEpoch - 1n` (where currentEpoch = tipPosixMs / ms_per_epoch) | SnapshotGen fires same epoch instead of waiting 1 day |
| `scripts/test/snapshot_only.ts` | Fetches tipPosixMs from Blockfrost REST, passes to SDK | Lucid Evolution's `lucid.provider.getBlock("latest")` falls back silently to wall-clock estimate, giving wrong epoch |
| `ProtocolUtils/src/index.ts` | Added `MS_PER_EPOCH_BY_NETWORK`, `msPerEpoch()`, `posixMsToEpoch()` | Single source of truth for POSIX-based epoch math |
| `scripts/config.ts` | Added `WALLET_SEED` + `selectWallet(lucid)` helper | `.env` had `WALLET_SEED` (no `PRIVATE_KEY`) |

## Caveats

1. **Epoch numbering changed.** Was: Cardano-genesis-relative ("epoch 1299" on Preview today). Now: POSIX-derived ("epoch 20589" on Preview today, ≈ days since 1970). Both validator and SDK agree, but human-facing display is no longer a "Cardano epoch number". For protocol invariants (monotonicity, deltas) this is fine.
2. **Trace statements still in validator.** Need to remove for production (cost extra execution units). Currently kept for debugging.
3. **Other 6 modules** (InstantGen, VacuumGen, ScheduleGen, UMKeeper, Consolidate, ProfileChange) likely have the **same** spend-handler signature bug. Each needs the same fix: `ctx: ScriptContext` → `tx: Transaction`. And same `ms_per_epoch` migration.
4. **Stranded UTxOs.** Multiple test vault UTxOs at old hashes exist (`fcc38498...`, `23c25a5e...`, `6ecfa7de...`, `96a42f76...`). Each has 10 000 tLAMP + 2 tADA. Total ~40 000 tLAMP + 8 tADA stranded. Can be ignored on testnet.

## Recommended next steps

1. **Strip traces** from `vault.ak` for production-quality build.
2. **Replicate fix to InstantGen / VacuumGen / ScheduleGen** validators (same handler signature bug expected).
3. **e2e_flow.ts** still buggy (uses removed `lucid.utils.validatorToAddress`) — replace with applied-script pattern from `snapshot_only.ts`.
4. **Document** POSIX-epoch semantics in DEVELOPER_GUIDE.md so downstream callers don't assume Cardano-style epoch numbers.

## Reproduction

```bash
cd MAGIC/SnapshotGen/onchain && aiken build -t verbose
cd ../../scripts && NETWORK=Preview npm run deploy:vault
NETWORK=Preview npm run test:snapshot
```

Expected output: `✅ SUCCESS` with TX hash, cardanoscan link. TX confirms within ~30s.
