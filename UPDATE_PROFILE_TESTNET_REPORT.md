# UpdateProfile testnet report — Preview

**Branch:** `feat/v1.0-onchain`
**Spec:** [`MagicSDK/SPEC_V1.md`](MagicSDK/SPEC_V1.md) §2 (SnapshotGen) + §3 (InstantGen)
**Test plan:** [`MagicSDK/V1_TESTNET_PLAN.md`](MagicSDK/V1_TESTNET_PLAN.md) §4
**Runner:** [`scripts/test/update_profile_only.ts`](scripts/test/update_profile_only.ts)

> **Status:** runner ready, **testnet execution pending** — section "Results" fill sau khi run trên Preview với vault SnapshotGen + InstantGen deployed.

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

## Results — FILL AFTER PREVIEW EXEC

| ID | Module | TX hash | Result | Datum diff |
|---|---|---|---|---|
| UP-POS-1 | Snapshot | `pending` | — | `pending_profile = Some({ Ember, eff: <e+1> })` |
| UP-POS-1 | Instant | `pending` | — | — |
| ... | ... | ... | ... | ... |

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
