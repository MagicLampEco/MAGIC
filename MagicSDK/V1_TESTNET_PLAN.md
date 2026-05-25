# MAGIC v1.0 — Testnet Plan

Plan test em chạy sau khi implement xong `WithdrawLamp` + `UpdateProfile` full theo `SPEC_V1.md`. Cùng pattern với 37 case v0 mà em đã làm (xem `MASTER_TESTNET_REPORT.md`).

**Phạm vi:** 4 vault module × 2 redeemer mới + multi-vault scenarios + lazy apply scenarios + regression cho 37 case cũ.

---

## §1. Acceptance criteria

v1.0 testnet pass khi:

| # | Tiêu chí |
|---|---|
| 1 | Tất cả 37 case v0 cũ vẫn pass sau khi merge v1.0 code (regression) |
| 2 | 32+ case mới (chi tiết §3-§5) pass |
| 3 | `aiken check` 0 error 0 warning cho 4 module có v1.0 changes |
| 4 | `aiken build` thành công, plutus.json sinh ra cho 4 module |
| 5 | SDK unit test 28/28 pass với `vaultPlutusJson` mới (do redeemer index resolve runtime — index thay đổi không break SDK) |
| 6 | Hash report per-network bằng `scripts/verify_per_network.ts` chạy được, ghi nhận hash mới cho 4 module |

---

## §2. Smoke test script template

Theo pattern `scripts/test/snapshot_only.ts` hiện tại — mỗi case là 1 file riêng để dễ tách isolated rerun.

```ts
// scripts/test/withdraw_only.ts (NEW)
import { withdrawLamp } from "@magiclamp/sdk";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";

const lucid = await Lucid(new Blockfrost(URL, KEY), "Preview");
lucid.selectWallet.fromPrivateKey(process.env.PRIVATE_KEY!);

const plutus = JSON.parse(await readFile("../SnapshotGen/onchain/plutus.json", "utf8"));
const vaultScript = applyVaultValidator("Snapshot", { vaultUnappliedCbor: ... }, { network: "Preview" }).vaultScript;
const vaultUtxo = (await listVaultsForOwner({...}))[0].utxo;

const result = await withdrawLamp({
  lucid, vaultUtxo, amountOil: 500_000_000n,
  vaultScript, vaultType: "Snapshot",
  vaultPlutusJson: plutus, network: "Preview",
});
const signed = await result.tx.sign.withWallet().complete();
const txHash = await signed.submit();
console.log("✓ WITHDRAW OK:", txHash);
```

Pattern negative test: build tx, tamper field (e.g. set `output.lamp_balance` sai), expect `signed.submit()` throw error chứa trace label tương ứng.

---

## §3. Withdraw test matrix — 4 vault × 5 case = 20 case

Mỗi vault module (SnapshotGen / InstantGen / VacuumGen / ScheduleGen) cần test 5 case:

### 3.1. Positive cases

| ID | Case | Setup | Expected |
|---|---|---|---|
| W-POS-1 | Withdraw partial unlocked | Vault có 1000 LAMP unlocked, withdraw 500 | TX pass, vault còn 500 LAMP, holdings newest-first |
| W-POS-2 | Withdraw all unlocked (locked > 0) | Vault 1000 LAMP, 300 locked. Withdraw 700 | TX pass, vault còn 300 LAMP (chỉ locked), L_avail = 0 |
| W-POS-3 | Withdraw all (locked = 0) | Vault 1000 LAMP unlocked, withdraw 1000 | TX pass, vault còn 0 LAMP, holdings rỗng |

### 3.2. Negative cases — validator MUST reject

| ID | Tamper | Expected reject rule |
|---|---|---|
| W-NEG-1 | Set `amount = 0` | W-1 (`amount > 0`) |
| W-NEG-2 | Set `amount > L_avail` (vd amount = balance khi locked > 0) | W-3 |
| W-NEG-3 | Tx không có owner sign | W-2 |
| W-NEG-4 | Build tx có 2 vault input cùng address | W-4 |
| W-NEG-5 | Tamper `output.lamp_balance` (set không trừ amount) | W-5 |
| W-NEG-6 | Tamper `output.loyalty_holdings` (rút từ oldest thay vì newest) | W-5 (`holdings ==` check) |
| W-NEG-7 | Tamper `output.magic_batches` (modify field bất kỳ) | W-5 |
| W-NEG-8 | Tamper output vault value LAMP qty ≠ `lamp_balance` new | W-6 |

→ Mỗi module 3 positive + 8 negative = 11 case. 4 module × ~3 case quan trọng = **chốt 20 case minimum** (Snapshot full 11 + 3 module khác lặp lại 3 positive cốt lõi).

### 3.3. Cross-vault edge case

| ID | Case | Expected |
|---|---|---|
| W-CROSS-1 | User có Snapshot vault + Instant vault (2 address). Withdraw từ Snap | Chỉ Snap vault bị consume, Instant vault không bị động vào (W-4 chặn cross-vault input) |
| W-CROSS-2 | User có 2 Snapshot vault (cùng address). Withdraw từ 1 | TX chỉ consume 1 vault — W-4 không cho phép 2 vault cùng tx |

---

## §4. UpdateProfile test matrix — 2 vault × 8 case = 16 case

Chỉ SnapshotGen + InstantGen support UpdateProfile (Vacuum/Schedule không dùng profile).

### 4.1. Positive cases

| ID | Case | Setup | Expected |
|---|---|---|---|
| UP-POS-1 | Đổi Flame → Ember | Vault Flame, profile_changed_epoch = 0, current_epoch = 5 | TX pass, `pending_profile = Some({ Ember, effective: 6 })`, `profile` field vẫn Flame |
| UP-POS-2 | Lazy apply ở tx kế tiếp | Sau UP-POS-1, ở epoch 6 trigger Snapshot | `applied_input.profile = Ember`, M computed với Ember params, output datum `profile = Ember`, `pending_profile = None` |
| UP-POS-3 | Lazy apply ở epoch > effective | Sau UP-POS-1, skip epoch 6 không trigger, epoch 7 trigger | Cùng UP-POS-2 (apply OK) |

### 4.2. Negative cases — validator MUST reject

| ID | Tamper | Expected reject |
|---|---|---|
| UP-NEG-1 | Không có owner sign | C-PC-V1 |
| UP-NEG-2 | Đổi lúc `current - profile_changed_epoch < 2` (vd =1) | C-PC-V2 |
| UP-NEG-3 | `new_profile == current.profile` (đổi sang chính mình) | C-PC-V3 |
| UP-NEG-4 | Tamper `output.magic_batches` (đổi `profile_at_creation` của batch cũ) | C-PC-V4 + A02 |
| UP-NEG-5 | Set `output.profile` trực tiếp = new (bypass lazy) | "profile == input.profile" check |
| UP-NEG-6 | `pending_profile.effective_epoch = current_epoch` (sai = +0 thay vì +1) | C-PC-V6 |
| UP-NEG-7 | `pending_profile.effective_epoch = current_epoch + 5` (sai = quá xa) | C-PC-V6 |
| UP-NEG-8 | Tamper `output.lamp_balance` | A02 |

→ Mỗi module 3 positive + 8 negative = 11. 2 module × ~6 case = **16 case minimum**.

### 4.3. Edge cases UpdateProfile

| ID | Case | Expected |
|---|---|---|
| UP-EDGE-1 | UpdateProfile khi `pending_profile != None` (đã có pending chưa apply) | Tuỳ design: chấp nhận override hay reject — chọn 1, document rõ |
| UP-EDGE-2 | Trigger Snapshot ở `current < effective_epoch` (chưa tới hạn) | `applied_input.profile = OLD`, M computed với OLD, output `pending_profile` giữ nguyên |

> **UP-EDGE-1 design call:** Đề xuất **chấp nhận override** — user đổi lại trước khi pending fire = thay pending bằng pending mới. Đỡ phải đợi 2 epoch cooldown tiếp. Implement: nếu `pending_profile == Some(_)`, vẫn check C-PC-V2 (cooldown từ `profile_changed_epoch`), không phải từ `pending`. Nếu em chọn hướng reject → document rõ trong SPEC_V1.

---

## §5. Multi-vault scenarios — 4 case

| ID | Case | Expected |
|---|---|---|
| MV-1 | Owner pkh A tạo 2 vault Snapshot cùng address. Trigger snap vault 1 | Chỉ vault 1 datum thay đổi, vault 2 không động vào (UTxO độc lập) |
| MV-2 | Owner pkh A: vault Snap profile Flame + vault Snap profile Ember. Trigger cả 2 epoch tiếp | M sinh ra khác nhau (1.10 × bonus vs 1.30 × bonus), không cross-influence |
| MV-3 | Owner pkh A: vault Snap + vault Instant. Withdraw từ Snap | Instant vault không bị consume. L_avail của Instant không đổi |
| MV-4 | Owner pkh A: 3 vault Snapshot. UpdateProfile vault 1 → Ember | Pending set chỉ ở vault 1. Vault 2, 3 vẫn Flame, không ảnh hưởng |

---

## §6. Regression — 37 case v0 vẫn pass

Sau khi merge v1.0 changes, chạy lại tất cả script:

```bash
npm run test:snapshot        # SnapshotGen smoke
npm run test:instant         # InstantGen smoke
npm run test:vacuum-commit   # VacuumGen commit
npm run test:vacuum-fire     # VacuumGen fire
npm run test:schedule-commit # ScheduleGen commit
npm run test:schedule-fire   # ScheduleGen fire
```

Cộng các script anh em đã thêm khi test 37 case (xem từng `*_TESTNET_REPORT.md` để biết list đầy đủ).

**Đặc biệt cần re-verify sau khi thêm `apply_pending_profile` vào mọi handler:**
- TriggerSnapshot M compute không đổi khi `pending_profile = None` (mặc định)
- InstantGen M compute không đổi khi `pending_profile = None`
- BurnBatch không bị ảnh hưởng (batch đã có `profile_at_creation` riêng)
- ApplyHalving không bị ảnh hưởng

Nếu 1 trong 37 case cũ fail → quay lại check handler usage pattern (xem `SPEC_V1.md` §2 "Lazy apply cơ chế — handler usage pattern").

---

## §7. Test tooling

### Per-case build/expect pattern

```ts
// helpers/expectReject.ts
export async function expectReject(
  txBuilder: TxSignBuilder,
  expectedTraceLabel: string,
): Promise<void> {
  try {
    const signed = await txBuilder.sign.withWallet().complete();
    await signed.submit();
    throw new Error(`Expected reject with "${expectedTraceLabel}", but tx submitted successfully`);
  } catch (e: any) {
    const msg = e.message || String(e);
    if (!msg.includes(expectedTraceLabel)) {
      throw new Error(`Expected trace "${expectedTraceLabel}", got: ${msg}`);
    }
    console.log(`✓ Rejected as expected: ${expectedTraceLabel}`);
  }
}
```

Tuỳ Aiken trace setup, label có thể là số hex (CBOR-encoded) hoặc string — kiểm tra qua `aiken build --trace-level verbose` 1 lần để xem format.

### Tamper helper (build tx invalid để negative test)

```ts
// Pattern: build positive tx → modify output datum → re-build → submit
function tamperOutputDatum(tx: TxSignBuilder, mutator: (datum: VaultDatum) => VaultDatum) {
  // Extract output, decode, mutate, re-encode, replace
  // (Tuỳ Lucid API — có thể cần dùng `lucid.fromTx(serialized)` rồi modify)
}
```

---

## §8. Deliverables

Sau khi test xong, em update:

| File | Nội dung |
|---|---|
| `MASTER_TESTNET_REPORT.md` | Thêm section "v1.0 changes — 36+ new cases" với link tới các report sau |
| `WITHDRAW_TESTNET_REPORT.md` (NEW) | 20 case withdraw đầy đủ, tx hash, datum snapshots |
| `UPDATE_PROFILE_TESTNET_REPORT.md` (NEW) | 16 case UpdateProfile + lazy apply scenarios |
| `MULTI_VAULT_TESTNET_REPORT.md` (NEW) | 4 case multi-vault |
| Per-module `*_TESTNET_REPORT.md` | Append v1.0 specific case của module đó |

Format report cùng như 4 report v0 cũ — anh đã quen pattern: header (TX hash, datum before/after, value diff) + body (rule trace + expected).

---

## §9. Khi test xong

- [ ] All 32+ new case pass
- [ ] All 37 regression case pass
- [ ] 4 module có v1.0 hash mới + log vào `scripts/verify_per_network.ts` output (3 network)
- [ ] PR gửi anh review → merge main
- [ ] Update `MagicSDK/SPEC_V1.md` flip checklist § §7 từ `[ ]` → `[x]` cho mọi item em làm
- [ ] Update `MagicSDK/README.md` table v0 vs v1.0 — flip cột v1.0 từ "target" sang "current"

Sau merge, anh chạy E2E thật trên Preview với SDK + Blockfrost để confirm flow user thấy. Đó là gate cuối cùng trước khi audit + mainnet.

---

## §10. Câu hỏi mở — em có thể quyết hoặc bàn

| # | Câu hỏi | Default đề xuất |
|---|---|---|
| 1 | UpdateProfile khi đang có pending — override hay reject? | Override (xem §4.3 UP-EDGE-1) |
| 2 | Withdraw có log `withdraw_event` vào datum không (audit trail)? | Không (giữ datum gọn) — event đủ qua tx history |
| 3 | Trace label format (string vs hex)? | Cùng pattern hiện tại trên 37 case |
| 4 | Test trên Preview hay Preprod? | Preview (đã có infra) |

Em chọn xong → ghi vào commit message hoặc PR body.
