# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**MagicLamp / MAGIC Protocol** — Cardano L1 (PlutusV3) smart contracts implementing GenMAGIC v3.3, a four-mechanism MAGIC token generation system on Preview testnet. Each mechanism is its own module with parallel Aiken (on-chain) and TypeScript (off-chain) implementations.

The four generation mechanisms (and supporting modules):
- **SnapshotGen** (§8) — automatic per-epoch generation, no LAMP cost, no UM
- **InstantGen** (§9) — on-demand purchase, transfers LAMP immediately, uses UM with stale check
- **VacuumGen** (§10) — two-phase commit-then-fire (2 epoch delay)
- **ScheduleGen** (§11) — forward contract, rate locked at commit, uses 16-shard cap system
- **UMKeeper** (§14) — permissionless keeper that updates the Network Demand Multiplier (UM) every epoch
- **Consolidate** (§6.9) — merges fragmented loyalty holdings (sort-partition-merge)
- **ProfileChange** (§12) — 2-step lazy profile switching with cooldown

## Repository layout

Every module follows the same shape:

```
<Module>/
├── onchain/         # Aiken PlutusV3 validators
│   ├── aiken.toml
│   ├── lib/         # types.ak, constants.ak, math.ak, decay.ak, ...
│   └── validators/  # vault.ak (or module-specific validator)
├── offchain/        # TypeScript SDK (Lucid Evolution + vitest)
│   ├── src/         # math.ts, types.ts, constants.ts, <module>.ts
│   ├── package.json
│   └── vitest.config.ts
└── tests/           # NORMATIVE test vectors + *.test.ts files
    └── vectors.ts   # App B vectors from the spec
```

Top-level `scripts/` contains shared testnet deploy scripts (`deploy/01..04*.ts`) and an end-to-end flow (`test/e2e_flow.ts`). They depend on a `.env` at `scripts/.env` with `BLOCKFROST_KEY`, `PRIVATE_KEY`, `NETWORK=Preview`, plus hashes/policy IDs filled in after each deploy step.

## Commands

Tests are scoped per module — each `offchain/` is its own npm package. The `vitest.config.ts` in each module includes `../tests/**/*.test.ts`, so tests live one directory up from `package.json`.

```bash
# Run one module's tests
cd <Module>/offchain && npm install && npm test

# Run a single test file (vitest)
cd InstantGen/offchain && npx vitest run ../tests/math.test.ts

# Watch mode / typecheck (InstantGen has these — other modules expose only "test")
cd InstantGen/offchain && npm run test:watch
cd InstantGen/offchain && npm run typecheck

# Run ALL module tests sequentially — expected: 190/190 pass
for dir in InstantGen SnapshotGen VacuumGen ScheduleGen UMKeeper Consolidate ProfileChange; do
  echo "=== $dir ===" && cd $dir/offchain && npm install --silent && npm test && cd ../..
done
```

Aiken validators are not built into the repo — every module must be compiled before deploy:

```bash
cd <Module>/onchain && aiken build   # produces onchain/plutus.json
# Hash is read from plutus.json by deploy scripts
```

Testnet deploy (must run in order — each step writes outputs that the next consumes via `scripts/config.ts` env vars):

```bash
cd scripts && npm install
npm run deploy:lamp      # → set LAMP_POLICY_ID in .env
npm run deploy:um        # → set UM_NFT_POLICY_ID
npm run deploy:shards    # → set SHARD_NFT_POLICY_ID
npm run deploy:vault
npm run test:e2e         # end-to-end flow across all 4 gen mechanisms
```

The UMKeeper runs as a long-lived process in its own terminal (`UMKeeper/offchain` → `npx tsx src/keeper.ts`). Without it, InstantGen falls back to UM=0.5× after 1 epoch of staleness.

## Architecture invariants — read before changing math

These are not stylistic preferences. They are protocol-level constraints with named identifiers in the spec.

**Bit-identical math between Aiken and TypeScript (P8).** `offchain/src/math.ts` and `onchain/lib/math.ak` (plus `decay.ak`, `lf_oac.ak`, etc.) implement the same formulas. They must produce identical outputs for identical inputs. The TypeScript suite enforces this against normative test vectors in `tests/vectors.ts` (App B of the spec). If you change one side, change the other.

**BigInt everywhere for oildrop/nanogic/Q-format (C-OVERFLOW).** Never use `Number` for amounts. `Q = 10^9`, `oildrop = LAMP × 10^6`, `nanogic = MAGIC × 10^9`. Test vectors TV-OVERFLOW-01/02 specifically catch `Number` regressions.

**Q-format arithmetic uses sequential floor multiplications.** Formulas like `M = L × R × UM × PM / Q³` are applied as three separate `⌊ × / Q ⌋` steps, not one big multiply-then-divide. This bounds rounding error per spec §6.1 / L4.

**The mechanisms differ in non-obvious ways.** See `SnapshotGen/README.md` for the canonical 5-axis comparison (trigger, LAMP cost, UM usage, which LAMP is counted, formula shape). Do not assume two mechanisms share behavior — e.g. SnapshotGen uses full LAMP balance including locked (C-SS-5) and applies LF×OAC; InstantGen uses only `L_avail` and applies UM with a stale check (C-UM-6).

**Cardano datum constructor indices must match Aiken type ordering.** TypeScript schemas in `types.ts` use `Data.Enum`/`Data.Object` whose order encodes Plutus Data constructor tags. Reorder a variant on one side, you break decoding on the other.

**Hard limits enforced on-chain.** `MAX_BATCHES_PER_VAULT=32`, `MAX_LOYALTY_HOLDINGS=64`, `MAX_VACUUM_ORDERS=10`, `MAX_GEN_SCHEDULES=20`, `MAX_FIRES_PER_TX_CATCHUP=8`, `SHARD_COUNT=16`, `SHARD_CAP=4.5×10^14 oildrop`. Defined in both `constants.ts` and `constants.ak` per module — keep them in sync.

## Protocol rules that affect code changes

- **No commit-cancel for VacuumGen/ScheduleGen** (C-VAC-12, T10) — once committed, orders fire or expire, never refunded mid-flight.
- **ProfileChange has a cooldown** (§12) — cannot switch profile twice within 2 consecutive epochs.
- **`profile_at_creation` is immutable on a batch** (T4, TV-SAMENESS-01) — decay parameters are frozen at batch creation, never re-derived from current vault profile.
- **OAC window is half-open `[e-12, e)`** (TV-OAC-BOUNDARY) — burns at the current epoch are excluded.
- **UM staleness check is Instant-only** (C-UM-6). Snapshot deliberately does not use UM (T16).

## Tools / runtime

- **Aiken** ≥ 1.1.0 for on-chain. Each `onchain/aiken.toml` declares `plutus = "v3"`.
- **Node.js** ≥ 20, ES modules (`"type": "module"` in every package.json). Off-chain uses `@lucid-evolution/lucid` (Cardano tx builder) and `vitest` for tests. Deploy scripts use `tsx` directly (no compile step).
- **No top-level workspace.** Each module's `offchain/` is an independent npm package — installs and runs in isolation. The `scripts/` package is also independent and has its own `package.json`.
- **Status (per README.md):** all 190 TypeScript tests pass; Aiken validators are written but not yet compiled in CI; nothing is deployed to testnet yet.

# Commit
- Always commit code with username not claude code
