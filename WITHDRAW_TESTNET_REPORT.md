# WithdrawLamp testnet report — Preview

**Branch:** `feat/v1.0-onchain`
**Spec:** [`MagicSDK/SPEC_V1.md`](MagicSDK/SPEC_V1.md) §1
**Test plan:** [`MagicSDK/V1_TESTNET_PLAN.md`](MagicSDK/V1_TESTNET_PLAN.md) §3
**Runner:** [`scripts/test/withdraw_only.ts`](scripts/test/withdraw_only.ts)

> **Status:** templates ready, **testnet execution pending** — section "Results" sẽ fill sau khi run trên Preview với vault đã deploy.

---

## Test matrix — 20 case

### Positive cases (per module — 3 × 4 = 12)

| ID | Module | Setup | Run command |
|---|---|---|---|
| W-POS-1 | Snapshot | Vault 1000 LAMP unlocked, withdraw 500 | `MODULE=Snapshot AMOUNT_LAMP=500 npm run test:withdraw` |
| W-POS-2 | Snapshot | Vault 1000 LAMP + 300 locked, withdraw 700 | `MODULE=Snapshot AMOUNT_LAMP=700 npm run test:withdraw` |
| W-POS-3 | Snapshot | Vault 1000 LAMP unlocked, withdraw 1000 | `MODULE=Snapshot AMOUNT_LAMP=1000 npm run test:withdraw` |
| W-POS-1 | Instant | Vault 1000 LAMP unlocked, withdraw 500 | `MODULE=Instant AMOUNT_LAMP=500 npm run test:withdraw` |
| W-POS-2 | Instant | Vault 1000 LAMP + 300 locked, withdraw 700 | `MODULE=Instant AMOUNT_LAMP=700 npm run test:withdraw` |
| W-POS-3 | Instant | Vault 1000 LAMP unlocked, withdraw 1000 | `MODULE=Instant AMOUNT_LAMP=1000 npm run test:withdraw` |
| W-POS-1 | Vacuum | Vault 1000 LAMP unlocked, withdraw 500 | `MODULE=Vacuum AMOUNT_LAMP=500 npm run test:withdraw` |
| W-POS-2 | Vacuum | Vault 1000 LAMP + 300 locked, withdraw 700 | `MODULE=Vacuum AMOUNT_LAMP=700 npm run test:withdraw` |
| W-POS-3 | Vacuum | Vault 1000 LAMP unlocked, withdraw 1000 | `MODULE=Vacuum AMOUNT_LAMP=1000 npm run test:withdraw` |
| W-POS-1 | Schedule | Vault 1000 LAMP unlocked, withdraw 500 | `MODULE=Schedule AMOUNT_LAMP=500 npm run test:withdraw` |
| W-POS-2 | Schedule | Vault 1000 LAMP + 300 locked, withdraw 700 | `MODULE=Schedule AMOUNT_LAMP=700 npm run test:withdraw` |
| W-POS-3 | Schedule | Vault 1000 LAMP unlocked, withdraw 1000 | `MODULE=Schedule AMOUNT_LAMP=1000 npm run test:withdraw` |

### Negative cases (Snapshot full 8 + summary smoke for 3 other modules)

| ID | Tamper | Expected reject | Run command |
|---|---|---|---|
| W-NEG-1 | `amount = 0` | W-1 | `MODULE=Snapshot TAMPER=amount_zero npm run test:withdraw` |
| W-NEG-2 | `amount > L_avail` | W-3 | `AMOUNT_LAMP=99999999 npm run test:withdraw` |
| W-NEG-3 | No owner sign | W-2 | `SKIP_OWNER_SIG=1 npm run test:withdraw` |
| W-NEG-4 | 2 vault inputs (manual tx build — out of single-script scope) | W-4 | manual |
| W-NEG-5 | Tamper `output.lamp_balance` | W-5 | `TAMPER=tamper_balance npm run test:withdraw` |
| W-NEG-6 | Tamper `output.loyalty_holdings` | W-5 / W-7 | `TAMPER=tamper_holdings npm run test:withdraw` |
| W-NEG-7 | Tamper `output.magic_batches` | W-5 | `TAMPER=tamper_batches npm run test:withdraw` |
| W-NEG-8 | Tamper vault output LAMP qty | W-6 | `TAMPER=tamper_value npm run test:withdraw` |

---

## Results — FILL AFTER PREVIEW EXEC

| ID | Module | TX hash | Result | Datum diff |
|---|---|---|---|---|
| W-POS-1 | Snapshot | `pending` | — | — |
| W-POS-2 | Snapshot | `pending` | — | — |
| W-POS-3 | Snapshot | `pending` | — | — |
| ... | ... | ... | ... | ... |

---

## Onchain rules verified

- **W-1** `amount > 0` — `expect amount > 0` in 4 vault validators
- **W-2** Owner signs — `list.has(tx.extra_signatories, input_datum.owner)`
- **W-3** `amount ≤ L_avail` — `l_avail(lamp_balance, lamp_locked)` check
- **W-4** 1 vault input per tx — `list.count(...) == 1`
- **W-5** A02 field-by-field output datum check — 16 fields × 4 modules
- **W-6** Vault output LAMP value == new `lamp_balance` — `assets.quantity_of(...)`
- **W-7** Σholdings == lamp_balance — `sum_holdings(holdings) == lamp_balance`
- **P8 invariant** `remove_newest_first` Aiken algorithm byte-for-byte mirrors `MagicSDK/src/withdrawLamp.ts:206` `removeNewestFirst`

Implementation: `validate_withdraw_lamp` function in each of:
- `SnapshotGen/onchain/validators/vault.ak`
- `InstantGen/onchain/validators/vault.ak`
- `VacuumGen/onchain/validators/vault.ak`
- `ScheduleGen/onchain/validators/vault.ak`

Helper: `remove_newest_first` in each module's `lib/magiclamp/protocol/lock.ak` (Snap + Vacuum + Schedule) or `lamp.ak` (Instant).
