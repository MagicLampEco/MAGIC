# Deploy Scripts — MagicLamp Preview Testnet

## Chuẩn bị trước khi chạy

```bash
cd scripts
npm install

cp .env.example .env
# Mở .env và điền BLOCKFROST_KEY + PRIVATE_KEY
```

---

## Thứ tự deploy bắt buộc

```
01_mint_lamp.ts         → Mint LAMP token
02_deploy_um.ts         → Deploy UM datum (cần trước InstantGen)
03_deploy_shards.ts     → Deploy 16 shards (cần trước ScheduleGen)
04_create_vault.ts      → Tạo vault đầu tiên
```

> ⚠️ Mỗi bước phải chờ ~20 giây để tx được confirm trước khi chạy bước tiếp.

---

## Chạy từng bước

```bash
npm run deploy:lamp
# → Copy LAMP_POLICY_ID vào .env

npm run deploy:um
# → Copy UM_NFT_POLICY_ID vào .env

npm run deploy:shards
# → Copy SHARD_NFT_POLICY_ID vào .env

npm run deploy:vault
# → Copy VAULT_OWNER_PKH vào .env
```

---

## Test sau khi deploy

```bash
# Start UMKeeper (terminal riêng)
cd ../UMKeeper/offchain
BLOCKFROST_KEY=xxx PRIVATE_KEY=xxx npx tsx src/keeper.ts

# Chạy e2e test
cd ../scripts
npm run test:e2e
```

---

## 3 tầng test — chọn đúng tầng cho mục đích

| Tầng | Lệnh | Cover | Thời gian | Khi nào dùng |
|---|---|---|---|---|
| 1 | `npm run demo:lamp` | Feature UX local: LAMP→MAGIC, decay, profile | < 1 giây | Biz/QA xem nhanh tính năng (không cần testnet) |
| 1 | `npm run test:emulator` | Math + state machine across epoch | < 1 giây | Dev iterate logic, mỗi commit |
| 2 | `npm run test:profile-magic` ⭐ | **Tx thật trên Preview** — SnapshotGen + InstantGen với verbose output theo profile | ~30 giây/lần | Tuân test feature trên mạng thật, theo dõi decay |
| 2 | `npm run test:show-vault` | Query datum on Preview, in batches + expected decay | giây | Check trạng thái vault giữa các epoch |
| 2 | `npm run test:e2e` | Tx thật: Snapshot + Instant + VacuumCommit | phút | Smoke test toàn bộ flow |
| 3 | `aiken check` (per module) | Validator types & properties | giây | Mỗi thay đổi onchain |

Ba tầng bổ sung lẫn nhau — không cái nào thay thế cái nào. Để merge nhanh chỉ cần
**tầng 1 + tầng 3** xanh; trước khi deploy mainnet phải có **tầng 2** trên Preview.

### `demo:lamp` — feature walkthrough cho biz/QA

```bash
npm run demo:lamp
```

In ra 5 section dễ đọc:

- **A.** Cùng 1000 LAMP, mỗi profile (Ember/Flame/Lantern) sinh bao nhiêu MAGIC/epoch.
- **B.** Tuổi holding (LF) & độ active (OAC) tác động thế nào — bảng + bar chart ASCII.
- **C.** Decay curve cụ thể từ k=0 đến k=N cho mỗi profile (snapshot batch).
- **D.** InstantGen: halving ở k=1, cliff ở k=2; ảnh hưởng của UM stale (0.5×) vs hot (1.5×).
- **E.** User journey 10 epoch: nắm 1000 LAMP, làm 3 Snapshot + 1 Instant, track tổng MAGIC sống.

Mọi con số dùng đúng SDK pure functions (`computeSnapshotMagic`, `computeInstantMagic`,
`snapshotBatchBalance`, …) — cùng codebase với validator onchain, khớp spec §3/§6/§8/§9.

### `test:profile-magic` ⭐ — TEST TRÊN PREVIEW + theo dõi decay

Đây là cách Tuân (hoặc QA) **test thật trên mạng** SnapshotGen + InstantGen cho 1 profile cụ thể, với output dễ đọc:

```bash
# 1. Tạo vault với profile mong muốn (chỉ làm 1 lần):
VAULT_PROFILE=Flame npm run deploy:vault

# 2. Chạy test — submit Snapshot + Instant tx thật:
npm run test:profile-magic
```

Output sẽ in:

- **Trước tx:** profile (B/PM/r/N), LAMP balance, holdings + LF của từng holding, batches hiện có (initial/current/age/decay%)
- **SnapshotGen step:** công thức `L × R_snap × LF × OAC × PM × B = expected MAGIC`, submit tx thật, verify expected khớp SDK
- **InstantGen step:** công thức `L_paid × R_inst × UM × PM`, hiển thị UM staleness + fallback, submit tx, verify
- **Sau tx:** đọc lại datum mới, in batches mới — confirm tx thực sự thay đổi state onchain
- **Link cardanoscan** cho mỗi tx — Tuân click vào để thấy raw tx, datum, fee, slot

**Workflow theo dõi decay:**

| Ngày | Lệnh | Quan sát |
|---|---|---|
| Day 1 | `test:profile-magic` | Sinh batch Snapshot k=0, batch Instant k=0 |
| Day 2 | `test:show-vault` | Snapshot batch k=1 → current = init × (10-r)/10; Instant batch k=1 → halved (÷2) |
| Day 3 | `test:show-vault` | Snapshot k=2 → init × (10-r)²/10²; Instant k=2 → **0** (cliff) |
| ... | ... | Snapshot tiếp tục đến k=N thì về 0 |

**So sánh 3 profile:** mỗi profile cần 1 wallet riêng (vì 1 wallet chỉ tạo được 1 vault). Cách:
- Tạo 3 ví Preview khác nhau, mỗi ví `VAULT_PROFILE=Ember/Flame/Lantern npm run deploy:vault`.
- Switch `.env PRIVATE_KEY` giữa các ví khi chạy `test:profile-magic`.
- Hoặc dùng module **ProfileChange** để chuyển profile của vault hiện tại (sau 1 epoch buffer).

### `test:show-vault` — query state any time (read-only)

```bash
npm run test:show-vault
```

In nguyên trạng vault hiện tại trên Preview (không submit tx): batches với cột `current` (onchain) vs `expected` (SDK math) — nếu lệch, có bug giữa onchain validator và offchain SDK.

### `test:emulator` — protocol correctness checks

In-memory simulator chạy 4 kịch bản kiểm chứng spec invariants:

1. SnapshotGen across 4 epochs (catch-up C-SS-6, batch pruning by profile N)
2. InstantGen với fresh vs stale UM (C-UM-6 fallback)
3. VacuumGen **commit → +2 epoch → fire** (kịch bản tốn 2 ngày trên Preview)
4. Stale-UM regression cho Vacuum (C-UM-7: luôn dùng smoothed)

Run time: < 1 giây. Tương đương ~17 ngày real-time trên Preview.

---

## Định nghĩa thành công cho mỗi bước

| Script | Thành công là |
|---|---|
| 01_mint_lamp | TX hash xuất hiện + thấy LAMP trên cardanoscan |
| 02_deploy_um | UTxO tại um_script_address có datum với smoothed_q=1B |
| 03_deploy_shards | 16 UTxOs tại shard_script_address, mỗi cái có shard_id 0-15 |
| 04_create_vault | UTxO tại vault_script_address có VaultDatum với đúng owner |
| e2e_flow | "All basic flows working! ✅" in ra cuối script |

---

## Kiểm tra trên Cardano Explorer

```
https://preview.cardanoscan.io/transaction/{TX_HASH}
https://preview.cardanoscan.io/address/{SCRIPT_ADDRESS}
```

---

## Nếu bị stuck

| Lỗi | Xử lý |
|---|---|
| `BLOCKFROST_KEY missing` | Điền key vào .env |
| `Need at least 5 tADA` | Lấy tADA từ faucet |
| `FILL_AFTER_AIKEN_BUILD` | Chạy `aiken build` trước |
| `Vault UTxO not found` | Chạy 04_create_vault.ts trước |
| Tx timeout | Tăng fee hoặc thử lại — Preview testnet đôi khi chậm |
