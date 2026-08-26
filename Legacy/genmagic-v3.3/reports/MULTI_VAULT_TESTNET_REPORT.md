# Multi-vault testnet report — Preview

**Branch:** `feat/v1.0-onchain`
**Spec:** [`MagicSDK/SPEC_V1.md`](MagicSDK/SPEC_V1.md) §4
**Test plan:** [`MagicSDK/V1_TESTNET_PLAN.md`](MagicSDK/V1_TESTNET_PLAN.md) §5
**Runner:** [`scripts/test/multi_vault_only.ts`](scripts/test/multi_vault_only.ts)

> **Status:** runner ready, **testnet execution pending** — fill section "Results" sau khi deploy ≥3 Snap vault + 1 Instant vault trên Preview.
>
> **Onchain change:** ZERO — multi-vault per owner đã được Cardano hỗ trợ sẵn. Mỗi vault là 1 UTxO riêng tại cùng vault address. Validator chỉ check 1 vault input per tx (C-VAULT-DS-1) — không giới hạn N vault per owner.
>
> SDK support: `MagicSDK/src/listVaults.ts:listVaultsForOwner` discover N vault → trả VaultRecord kèm vaultId/oldestEpoch/profile/lampBalanceOil để app layer label.

---

## Test matrix — 4 case

| ID | Case | Run command | Pre-req |
|---|---|---|---|
| MV-1 | 2 Snapshot vaults same address — trigger vault 1 only | `CASE=mv1 npm run test:multi-vault` | ≥2 SnapshotGen vault deployed |
| MV-2 | 2 vaults different profiles (Flame vs Ember) — M differs | `CASE=mv2 npm run test:multi-vault` | ≥2 Snap vault, profiles khác nhau |
| MV-3 | Snap + Instant vaults — withdraw từ Snap only | `CASE=mv3 npm run test:multi-vault` | ≥1 Snap + ≥1 Instant vault |
| MV-4 | 3 Snap vaults — UpdateProfile vault 1 → pending chỉ set trên vault 1 | `CASE=mv4 npm run test:multi-vault` | ≥3 Snap vault |

---

## Results — FILL AFTER PREVIEW EXEC

| ID | TX hash | Result | Verification |
|---|---|---|---|
| MV-1 | `pending` | — | Vault 2 datum unchanged on-chain post-tx |
| MV-2 | `discovery only` | — | Profile diversity confirmed via `listVaultsForOwner` |
| MV-3 | `pending` | — | Instant vault `lamp_balance` unchanged |
| MV-4 | `pending` | — | Vault 2, 3 `pending_profile = None` post-tx |

---

## Onchain rules verified

- **C-VAULT-DS-1** Exactly 1 vault input per tx — `list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1`. Blocks "double-satisfaction" across vault UTxOs.
- **No "1 vault per owner" check** — by design (§4). User has N independent vaults each with its own datum, holdings, LF.
- **W-4 cross-vault block** — if user tries to spend 2 vaults at same address in 1 tx, validator rejects (C-VAULT-DS-1).

## Key invariants

| Invariant | Why it holds |
|---|---|
| LF independence per vault | LF computed from `input_datum.loyalty_holdings` only — no cross-vault read |
| Profile independence per vault | `profile` is per-datum field; UpdateProfile only mutates the spent vault's datum |
| MAGIC batch isolation | Each batch lives in its parent vault's `magic_batches[]` — no cross-vault batch sharing |
| Withdraw isolation | Spent vault's `lamp_balance` decreases; other vaults untouched |

## Use case context

Per [`MagicSDK/SPEC_V1.md`](MagicSDK/SPEC_V1.md) §4:
- User has 3 LAMP allocations (short / mid / long term)
- Each allocation = 1 Snapshot vault
- Tiêu LAMP của vault ngắn hạn (qua Withdraw + Instant) KHÔNG ảnh hưởng tới LF của vault dài hạn
- App layer labels vaults off-chain (`userDID → [vaultId₁, vaultId₂, ...]`)
