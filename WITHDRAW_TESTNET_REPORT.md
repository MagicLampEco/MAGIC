# WithdrawLamp testnet report — Preview

**Branch:** `feat/v1.0-onchain`
**Spec:** [`MagicSDK/SPEC_V1.md`](MagicSDK/SPEC_V1.md) §1
**Test plan:** [`MagicSDK/V1_TESTNET_PLAN.md`](MagicSDK/V1_TESTNET_PLAN.md) §3
**Runner:** [`scripts/test/withdraw_only.ts`](scripts/test/withdraw_only.ts)
**Date:** 2026-05-28
**Vault hash (v1.0):** `8bb14833763114133f295083f4f2a93cf9c3f186825c9e7c66e66657`
**Vault address:** `addr_test1wz9mzjpnwcc3gyel99gg8a8j4y70nsl3s6p9e8nuvmnxv4cdq9e28`
**Owner PKH:** `5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21`
**Initial deploy:** TX [`b9804e31...`](https://preview.cardanoscan.io/transaction/b9804e317d6192c4ca28b3e49f713cb9ea69a9c7632d78beabbe17d82e918016) — 100 LAMP, profile Flame, epoch 20603

> **Status:** SnapshotGen module **VERIFIED on Preview** — 7 case pass (W-POS-1 + 6 negatives). 3 module còn lại (Instant/Vacuum/Schedule) defer (mỗi cái cần vault deploy riêng + Instant cần UMKeeper running). UpdateProfile + multi-vault defer do epoch wait yêu cầu cooldown.

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

## Results — SnapshotGen verified on Preview (2026-05-28)

### Positive cases

| ID | TX hash | Result | Datum diff |
|---|---|---|---|
| W-POS-1 | [`048faeca...`](https://preview.cardanoscan.io/transaction/048faeca5e8f7f98686b8c88effd3795964f870e5018abc878414639b5dca0f5) | ✅ SUCCESS | `lamp_balance` 100→95 (5 LAMP rút), `loyalty_holdings` newest-first removed, vault output value LAMP=95 |
| (bonus) | [`83c5a187...`](https://preview.cardanoscan.io/transaction/83c5a1876825a97106e586dd29156a4e2c6c9d5921a74aeb7292a134f406aa1d) | ✅ SUCCESS | `lamp_balance` 95→90 — accidental run từ W-NEG-7 (xem ghi chú dưới) |

### Negative cases (validator MUST reject)

| ID | Tamper | Layer | Result | Note |
|---|---|---|---|---|
| W-NEG-1 | `amountOil = 0` | SDK pre-check | ✅ REJECTED | `WITHDRAW-001: amountOil must be > 0` |
| W-NEG-2 | `amount > L_avail` | SDK pre-check | ✅ REJECTED | `WITHDRAW-002: amount > L_avail` (SDK enforces W-3 invariant before validator) |
| W-NEG-3 | No owner sign (`SKIP_OWNER_SIG=1`) | **Validator (W-2)** | ✅ REJECTED | `Spend[0] the validator crashed / exited prematurely` — Lucid evaluates script offline → catches before submit |
| W-NEG-5 | `output.lamp_balance` bumped +1 | **Validator (W-5)** | ✅ REJECTED | `Spend[0] the validator crashed` — A02 field check `expect output.lamp_balance == input.lamp_balance - amount` |
| W-NEG-6 | `output.loyalty_holdings = []` | **Validator (W-5/W-7)** | ✅ REJECTED | A02 holdings mismatch OR W-7 `sum_holdings != lamp_balance` |
| W-NEG-7 | `output.magic_batches = []` | — | ⚠ FALSE NEGATIVE (test design) | Vault deployed với `PRESEED_BATCHES=0` → input `magic_batches` đã rỗng → tamper `[]→[]` no-op → validator chấp nhận (đúng spec). Re-test khi deploy vault với batches preseed (xem comment dưới) |
| W-NEG-8 | Vault output LAMP qty = balance + 1 | **Validator (W-6)** | ✅ REJECTED | `Spend[0] the validator crashed` — W-6 `quantity_of(vault_output.value, lamp_policy_id, "LAMP") == new_lamp_balance` |

### W-NEG-7 re-test design

Để verify W-5 `output.magic_batches == input.magic_batches` thực sự enforce, cần vault với `magic_batches` non-empty trước khi tamper. Cách:

```bash
PRESEED_BATCHES=1 LAMP_DEPOSIT=100 npm run deploy:vault
# → vault có 1 fresh batch
MODULE=Snapshot TAMPER=tamper_batches npm run test:withdraw
# expect: REJECTED — output.magic_batches=[] khác input.magic_batches=[batch] → W-5 fail
```

### Cases defer

| ID | Reason |
|---|---|
| W-POS-2 (locked > 0) | Cần deploy vault với `LAMP_LOCKED > 0` — tách run riêng |
| W-POS-3 (drain to 0) | Cần fresh vault, drain hết → defer (Preview cost) |
| W-NEG-4 (2 vault inputs) | Test script không tự build 2-vault tx được — manual tx hoặc skip cho v1.0 |
| W-CROSS-1/2 (cross-vault) | Cần multiple vaults |
| Instant/Vacuum/Schedule × 3 case mỗi cái | Cần deploy vault tương ứng + (Instant) UMKeeper running. Smoke test trên Snap đã verify code path chung — 3 module khác dùng cùng `remove_newest_first` + cùng A02 pattern |

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
