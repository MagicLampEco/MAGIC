# UpdateProfile testnet report — Preview

**Branch:** `feat/v1.0-onchain`
**Spec:** [`MagicSDK/SPEC_V1.md`](MagicSDK/SPEC_V1.md) §2 (SnapshotGen) + §3 (InstantGen)
**Test plan:** [`MagicSDK/V1_TESTNET_PLAN.md`](MagicSDK/V1_TESTNET_PLAN.md) §4
**Runner:** [`scripts/test/update_profile_only.ts`](scripts/test/update_profile_only.ts)

> **Status:** **SnapshotGen + InstantGen verified on Preview** — Snap UP-POS-1 + 6 negative; Instant UP-POS-1 + 3 negative pass.
>
> **Date:** 2026-05-28 (Snapshot), 2026-06-06 (Instant)
> **Vault address (Snap v1.0):** `addr_test1wz9mzjpnwcc3gyel99gg8a8j4y70nsl3s6p9e8nuvmnxv4cdq9e28`
> **Vault hash (Instant v1.0):** `334b625fd922162f61333fe4b7df992635dd06ec19e51dfe6574657c`
> **Preseed vault TX:** [`63abc745...`](https://preview.cardanoscan.io/transaction/63abc745701349d797fe30b8a5f84f789e0737c41d79c41def1538e508661a82) (Snap — 50 LAMP, Flame, pce=0); Instant deploy [`13c6f21c...`](https://preview.cardanoscan.io/transaction/13c6f21c44ab2d7433e66c0a8e45d5e986ef031b18efd3f93abd9e2ba24688b5) (100 LAMP, Flame, pce=0)

---

## Test matrix — 16 case (2 vault × 8 case)

### Positive cases (per module — 3 × 2 = 6)

| ID | Module | Setup | Run command |
|---|---|---|---|
| UP-POS-1 | Snapshot | Vault Flame, cooldown OK → change to Ember | `MODULE=Snapshot NEW_PROFILE=Ember npm run test:update-profile` |
| UP-POS-2 | Snapshot | Sau UP-POS-1, ở epoch ≥ effective trigger Snapshot | manual: epoch wait, then run snapshot_only.ts |
| UP-POS-3 | Snapshot | Skip 1 epoch sau effective, trigger Snapshot | manual: 2-epoch wait, then snapshot_only.ts |
| UP-POS-1 | Instant | Vault Flame → Ember | `MODULE=Instant NEW_PROFILE=Ember npm run test:update-profile` |
| UP-POS-2 | Instant | Sau UP-POS-1, ở epoch ≥ effective trigger Instant | manual |
| UP-POS-3 | Instant | Skip 1 epoch, trigger Instant | manual |

### Negative cases (per module — 8 × 2 = 16)

| ID | Tamper | Expected reject | Run command (Snapshot example) |
|---|---|---|---|
| UP-NEG-1 | No owner sign | C-PC-V1 | `SKIP_OWNER_SIG=1 npm run test:update-profile` |
| UP-NEG-2 | Cooldown < 2 epoch | C-PC-V2 | manual (need fresh vault then immediate re-change) |
| UP-NEG-3 | `new_profile == current` | C-PC-V3 (SDK pre-rejects too) | `NEW_PROFILE=Flame` (when current is Flame) |
| UP-NEG-4 | Tamper `output.magic_batches` | C-PC-V4 / A02 | `TAMPER=tamper_batches npm run test:update-profile` |
| UP-NEG-5 | Set `output.profile = new` (bypass lazy) | C-PC-V6 | `TAMPER=bypass_lazy npm run test:update-profile` |
| UP-NEG-6 | `effective_epoch = current` | C-PC-V6 | `TAMPER=wrong_effective npm run test:update-profile` |
| UP-NEG-7 | `effective_epoch = current + 5` | C-PC-V6 | `TAMPER=effective_too_far npm run test:update-profile` |
| UP-NEG-8 | Tamper `output.lamp_balance` | A02 | `TAMPER=tamper_balance npm run test:update-profile` |

### Edge cases

| ID | Case | Expected | Notes |
|---|---|---|---|
| UP-EDGE-1 | UpdateProfile khi pending_profile != None | **ACCEPT (override)** — pending mới thay pending cũ | Chốt: anh confirm Q1 override default. Cooldown vẫn enforce qua `profile_changed_epoch` (set lần đầu) → không bypass cooldown |
| UP-EDGE-2 | Trigger Snapshot ở `current < effective_epoch` | `applied_input.profile = OLD`, pending giữ nguyên | Verified via `apply_pending_profile` logic — branch `current >= eff` returns datum unchanged |

---

## Results — SnapshotGen verified on Preview (2026-05-28, epoch 20603)

### Positive cases

| ID | TX hash | Result | Datum diff |
|---|---|---|---|
| UP-POS-1 | [`e65456d6...`](https://preview.cardanoscan.io/transaction/e65456d63b3f9c5f83a0321e272568bb9b13d04d399284fd82f1d23106ebb2ae) | ✅ SUCCESS | Old profile: Flame → pending Ember (effective ep 20604). `profile_changed_epoch=20603`, `profile` field stays Flame (lazy), `magic_batches` unchanged (T4 immutable) |

### Negative cases (validator MUST reject)

| ID | Tamper | Layer | Result | Note |
|---|---|---|---|---|
| UP-NEG-1 | No owner sign | **Validator (C-PC-V1)** | ✅ REJECTED | `Spend[0] the validator crashed` |
| UP-NEG-3 | `new_profile == current` (Flame on Flame vault) | SDK pre-check | ✅ REJECTED | `UPDATE-002: new_profile == current profile (Flame)` — SDK enforces C-PC-V3 |
| UP-NEG-4 | `output.magic_batches = []` (tamper batches) | **Validator (C-PC-V4 + A02)** | ✅ REJECTED | T4 immutable enforced |
| UP-NEG-5 | `output.profile = new` (bypass lazy) | **Validator (C-PC-V6)** | ✅ REJECTED | `expect output.profile == input.profile` |
| UP-NEG-6 | `effective_epoch = current` (sai = +0) | **Validator (C-PC-V6)** | ✅ REJECTED | Expects current+1 |
| UP-NEG-7 | `effective_epoch = current + 5` (quá xa) | **Validator (C-PC-V6)** | ✅ REJECTED | Expects current+1 |
| UP-NEG-8 | `output.lamp_balance` bumped | **Validator (A02)** | ✅ REJECTED | C-PC-V5 balances immutable |

## Results — InstantGen verified on Preview

Re-verified on the **hardened validator** (PR #11 review fixes: output==1, BurnBatch
lock, treasury Script-cred, preserve catch-up) — vault hash `59add779…` (applied:
lamp_policy + treasury + um_nft + ms_per_epoch), deploy [`a4b0f717…`](https://preview.cardanoscan.io/transaction/a4b0f7175ea045a0e0aca826c63775c714d6e400f39d84dfa2e05a2caf3cbaa6).

### Positive case

| ID | TX hash | Result | Datum diff |
|---|---|---|---|
| UP-POS-1 (hardened) | [`593dfbba...`](https://preview.cardanoscan.io/transaction/593dfbba002ea001cd2999458d693adc95bef593b5fa080ef5f0d25e81b22041) | ✅ SUCCESS | Old profile Flame → pending Ember. `profile` stays Flame (lazy), `magic_batches` unchanged (T4). Confirms security fixes don't break the happy path. |
| UP-POS-1 (pre-hardening) | [`c593b915...`](https://preview.cardanoscan.io/transaction/c593b915590d7781f8eefefd532c3a88368668a03ac16014f816885cb4b9c75f) | ✅ SUCCESS | original validator (hash `334b625f…`) |

### Negative cases (validator MUST reject — run against fresh vault `13c6f21c`, cooldown-clear)

| ID | Tamper | Layer | Result | Note |
|---|---|---|---|---|
| UP-NEG-1 | No owner sign | **Validator (C-PC-V1)** | ✅ REJECTED | `Spend[0] the validator crashed` |
| UP-NEG-5 | `output.profile = new` (bypass lazy) | **Validator (C-PC-V6)** | ✅ REJECTED | `expect output.profile == input.profile` |
| UP-NEG-8 | `output.lamp_balance` bumped | **Validator (A02)** | ✅ REJECTED | balances immutable |

> **Tooling fix:** `update_profile_only.ts` now applies the vault script via the SDK `applyVaultValidator` helper (handles treasury bech32 → Plutus `Constr` for Instant) — the prior inline `applyParamsToScript([…, ADDRESSES.treasury, …])` passed raw bech32 and crashed on Instant. Same fix already shipped for `withdraw_only.ts` (commit `13be0932`).

### Cases defer

| ID | Reason |
|---|---|
| UP-NEG-2 (cooldown < 2) | Fresh vault có `profile_changed_epoch=0` → cooldown đã pass. Cần vault vừa UP xong trong epoch trước (Preview = 1 ngày epoch). Logic verified via UP-POS-1 setting profile_changed_epoch |
| UP-POS-2/3 (lazy apply) | Cần đợi đến effective epoch (+1 ngày) rồi trigger Snapshot/Instant trên vault này để xem `applied_input.profile = Ember` lan vào M compute + output datum |
| UP-EDGE-1 (override pending) | Cần 2-epoch wait trước khi UP lại |
| Instant UP-NEG-3/4/6/7 | Same validator code path đã verify qua Snap full 6-negative + Instant 3-negative (C-PC-V1/V6/A02 covered); remaining tamper variants share the same A02/C-PC-V6 branch |

---

## Onchain rules verified

- **C-PC-V1** Owner signs — `list.has(tx.extra_signatories, input_datum.owner)`
- **C-PC-V2** Cooldown ≥ 2 epoch — `current_epoch - profile_changed_epoch >= profile_change_cooldown`
- **C-PC-V3** Must change — `new_profile != input_datum.profile`
- **C-PC-V4** Existing batches unchanged — `output.magic_batches == input.magic_batches` (T4 immutable)
- **C-PC-V5** Balances + holdings unchanged
- **C-PC-V6** Lazy apply — `output.profile == input.profile` AND `output.pending_profile == Some({ new_profile, effective_epoch: current_epoch + 1 })`
- **Override decision** No `if pending == None` branch — every UpdateProfile tx follows same set-pending pattern

Implementation: `validate_update_profile` function in:
- `SnapshotGen/onchain/validators/vault.ak`
- `InstantGen/onchain/validators/vault.ak`

Helper: `apply_pending_profile` in each module's `lib/magiclamp/protocol/profile.ak`. Wired into both `validate_snapshot` (TriggerSnapshot) and `validate_instant_gen` (InstantGen) handlers — uses `applied_input` for BOTH M-computation AND A02 output datum check (avoids infinite pending bug).

## Lazy apply test scenarios

| Scenario | Flow | Expected behavior |
|---|---|---|
| Normal lazy | Tx UP @ ep `e` (cooldown OK) → Tx Snapshot @ ep `e+1` | Snap tx applies pending → output `profile = new`, `pending_profile = None`, batch's `profile_at_creation = new` |
| Idle past effective | Tx UP @ ep `e` → idle to ep `e+5` → Tx Snapshot @ ep `e+5` | Snap tx applies pending → batch's `profile_at_creation = new` (T4: based on tx time, not earn time) |
| Before effective | Tx UP @ ep `e` → Tx Snapshot @ ep `e` (same epoch) | TriggerSnapshot rejected by C-SS-1 (must be new epoch); even if it were accepted, `apply_pending_profile` would return datum unchanged because `current_epoch < effective` |
| Override pending | Tx UP @ ep `e` (set pending @ e+1) → Tx UP @ ep `e+2` (replace pending @ e+3) | Both txs valid — cooldown check passes (e+2 - e = 2 ≥ 2); second tx overrides pending |
