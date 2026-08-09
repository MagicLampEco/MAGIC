# MAGIC — Luật validator cho `WithdrawLamp` và `UpdateProfile`

**Vai của tệp này:** viết ra luật mà hai handler `WithdrawLamp` và `UpdateProfile` phải cưỡng
chế, và đặt tên cho từng luật (`W-1..W-7`, `C-PC-V1..V6`) để mã và báo lỗi trỏ về được. Các
nhánh trong `InstantGen/onchain/validators/vault.ak` và
`ScheduleGen/onchain/validators/vault.ak` chú thích thẳng "SPEC_V1 §1", "SPEC_V1 §2/§3" —
đổi tên mục ở đây là làm treo những con trỏ đó.

**Đối tượng:** dev on-chain (Aiken). Dev off-chain xem
[`INTEGRATOR_GUIDE_V1.md`](./INTEGRATOR_GUIDE_V1.md). Mô hình chuẩn của cả hệ:
[`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
Module nào đang sống: [`DEVSTATUS.md`](../DEVSTATUS.md).

**Phạm vi:** hai vault còn sống. `SnapshotGen` và `VacuumGen` đã dời sang
`Legacy/genmagic-v3.3/`; mọi câu trong tài liệu này chỉ nói về hai module dưới đây.

| Handler | InstantGen | ScheduleGen | Hiện thực |
|---|---|---|---|
| `WithdrawLamp { amount }` (§1) | ✅ | ✅ | `validate_withdraw_lamp` ở cả hai `vault.ak` |
| `UpdateProfile { new_profile }` (§2) | ✅ | — không có variant | `validate_update_profile` (InstantGen) |

ScheduleGen **cố ý không có** `UpdateProfile`: suất được khoá lúc commit nên profile không vào
công thức tính. SDK chặn trước bằng `UPDATE-001`.

---

## §1. `WithdrawLamp { amount }`

### Việc cần làm

Chủ vault rút phần LAMP **chưa khoá** về ví (hoặc một địa chỉ chỉ định). Đây là đường ra duy
nhất của LAMP: dưới `I-ACT-7` không handler nào khác chuyển LAMP ra khỏi vault. Không có
handler này thì LAMP nạp vào là kẹt vĩnh viễn.

### Luật

```aiken
WithdrawLamp { amount } -> {
  // W-1: amount > 0
  expect amount > 0

  // W-2: chủ ký
  expect list.has(tx.extra_signatories, input_datum.owner)

  // W-3: amount ≤ L_avail — chỉ rút phần chưa khoá
  let avail = l_avail(input_datum.lamp_balance, input_datum.lamp_locked)
  expect amount <= avail

  // W-4: đúng MỘT vault input (C-VAULT-DS-1)
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // W-5: soát output datum theo TỪNG TRƯỜNG (khuôn A02)
  let output_datum     = find_vault_output_datum(tx.outputs, vault_addr)
  let new_holdings     = remove_newest_first(input_datum.loyalty_holdings, amount)
  let new_lamp_balance = input_datum.lamp_balance - amount

  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == new_lamp_balance
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == new_holdings
  expect output_datum.magic_batches == input_datum.magic_batches
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.vacuum_orders == input_datum.vacuum_orders     // bia mộ, giữ nguyên
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.profile == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile == input_datum.pending_profile
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate
  expect output_datum.attribution == input_datum.attribution

  // last_updated_epoch GIỮ NGUYÊN — KHÔNG đẩy lên epoch hiện tại.
  expect output_datum.last_updated_epoch == input_datum.last_updated_epoch

  // W-6: LAMP trong output vault khớp lamp_balance mới
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  expect quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name) == new_lamp_balance

  // W-7: bất biến tổng holding
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance
  expect list.length(output_datum.loyalty_holdings) <= max_loyalty_holdings

  // GIÁ TRỊ: NFT danh tính còn nguyên, ADA không giảm, tập policy bị chặn trần
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

  True
}
```

### `last_updated_epoch` GIỮ NGUYÊN — điểm dễ dựng sai nhất

Rút LAMP **không** được đẩy `last_updated_epoch` lên epoch hiện tại. Đẩy lên là đặt lại cửa sổ
bắt-kịp và làm mất phần MAGIC đã tích qua các epoch đã trôi. Rút LAMP là việc của riêng LAMP,
trực giao với chuyện sinh MAGIC.

Đây là chỗ hiện thực off-chain đang lệch: `withdrawLamp` trong `src/withdrawLamp.ts` đặt
`last_updated_epoch: currentEpoch`, và output vault nó dựng **không mang NFT danh tính** —
`validate_vault_value` sẽ từ chối. Hai điểm này phải sửa ở phía off-chain (luật on-chain là
bên đúng), và phải kiểm bằng một tx thật trên testnet trước khi mở chức năng rút cho người
dùng.

### `remove_newest_first`

Chọn holding **mới nhất** (`acquired_epoch` cao nhất) trước, để giữ tuổi của các holding cũ —
tuổi là thứ nuôi tư cách sinh MAGIC. Holding đang khoá không bao giờ bị động vào.

Hiện thực: `remove_newest_first` trong `InstantGen/onchain/lib/magiclamp/protocol/lamp.ak` và
`ScheduleGen/onchain/lib/magiclamp/protocol/lock.ak`. Bản song sinh off-chain là
`removeNewestFirst` trong `MagicSDK/src/withdrawLamp.ts` — P8 buộc hai bên trùng bit, vector
trong `tests/` là trọng tài.

### Ca biên

| Tình huống | Kết quả mong đợi |
|---|---|
| `amount = 0` | W-1 từ chối |
| `amount > lamp_balance` | W-3 từ chối |
| `amount > L_avail` (do có phần khoá) | W-3 từ chối |
| `amount = L_avail` (vét sạch phần chưa khoá) | được; sau tx vault chỉ còn holding đang khoá |
| `amount = lamp_balance` khi `lamp_locked > 0` | W-3 từ chối |
| `amount = lamp_balance` khi `lamp_locked = 0` | được; vault còn 0 LAMP, holding rỗng, vault vẫn tồn tại |
| thiếu chữ ký chủ | W-2 từ chối |
| sửa bất kỳ trường nào của output datum | W-5 từ chối |
| output vault thiếu NFT danh tính | `validate_vault_value` từ chối |

### Ca phủ định cần có test

| Cách phá | Luật bắt |
|---|---|
| `output.lamp_balance` trừ sai | W-5 |
| `output.lamp_locked` bị đổi | W-5 |
| `output.loyalty_holdings` không theo mới-nhất-trước | W-5 (so với `remove_newest_first`) |
| `output.magic_batches` bị sửa | W-5 |
| rút vào holding đang khoá | W-5 (kết quả tính ra khác) |
| `output.last_updated_epoch` bị đẩy lên | W-5 |
| LAMP trong output vault ≠ số dư mới | W-6 |
| ví không ký | W-2 |
| hai vault input trong một tx | W-4 |
| output vault không mang NFT danh tính | `validate_vault_value` |
| nhồi thêm policy lạ vào output vault | `validate_vault_value` (trần số policy) |

---

## §2. `UpdateProfile { new_profile }` — InstantGen

### Vì sao áp dụng TRỄ

Batch sinh dưới một profile phải decay theo lịch của profile đó. Đổi profile không được hồi tố
lên batch cũ (T4, `TV-SAMENESS-01`). Nên tx `UpdateProfile` chỉ **đặt** `pending_profile`;
trường `profile` thật sự đổi ở tx kế tiếp chạm vào vault.

### Luật

```aiken
UpdateProfile { new_profile } -> {
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // C-PC-V1: chủ ký
  expect list.has(tx.extra_signatories, input_datum.owner)

  // C-PC-V2: thời gian nguội
  expect current_epoch - input_datum.profile_changed_epoch >= profile_change_cooldown

  // C-PC-V3: phải đổi thật
  expect new_profile != input_datum.profile

  // C-PC-V4..V6: áp dụng trễ — đặt pending, trường profile GIỮ NGUYÊN
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == input_datum.loyalty_holdings
  expect output_datum.magic_batches == input_datum.magic_batches      // C-PC-V4, T4
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.vacuum_orders == input_datum.vacuum_orders
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate
  expect output_datum.attribution == input_datum.attribution

  // MẤU CHỐT: profile chưa đổi
  expect output_datum.profile == input_datum.profile

  // MẤU CHỐT: pending được đặt, hiệu lực từ epoch kế tiếp (đè pending cũ nếu có)
  expect output_datum.pending_profile == Some(PendingProfile {
    new_profile,
    effective_epoch: current_epoch + 1,
  })
  expect output_datum.profile_changed_epoch == current_epoch
  expect output_datum.last_updated_epoch == current_epoch

  // GIÁ TRỊ: LAMP đúng bằng số dư cũ, NFT danh tính còn nguyên, ADA không giảm
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  expect quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name) == input_datum.lamp_balance
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

  True
}
```

Khác `WithdrawLamp` ở một điểm dễ nhầm: ở đây `last_updated_epoch` **đẩy lên** epoch hiện tại
(vault vừa đổi trạng thái điều hành), còn ở `WithdrawLamp` thì **giữ nguyên**.

### Cách áp dụng trễ

```aiken
fn apply_pending_profile(datum: VaultDatum, current_epoch: Int) -> VaultDatum {
  when datum.pending_profile is {
    Some(pp) ->
      if current_epoch >= pp.effective_epoch {
        VaultDatum { ..datum, profile: pp.new_profile, pending_profile: None }
      } else {
        datum
      }
    None -> datum
  }
}
```

**Khuôn dùng bắt buộc trong mọi handler khác:**

```aiken
let applied_input = apply_pending_profile(input_datum, current_epoch)

// 1. dùng applied_input để TÍNH
let m = compute_instant_grant(..., applied_input.profile, ...)

// 2. dùng applied_input cho cả phần soát output datum (A02)
expect output_datum.profile == applied_input.profile
expect output_datum.pending_profile == applied_input.pending_profile
```

Chỉ áp dụng cho phần tính mà không áp dụng cho phần soát datum ⇒ output vẫn mang pending cũ ⇒
tx kế tiếp lại áp dụng nữa ⇒ pending không bao giờ tiêu. Cả hai chỗ phải dùng `applied_input`.

Hiện thực: `apply_pending_profile` trong
`InstantGen/onchain/lib/magiclamp/protocol/profile.ak`.

### Ca phủ định cần có test

| Cách phá | Luật bắt |
|---|---|
| đổi thẳng `output.profile` (lách áp-dụng-trễ) | `output.profile == input.profile` |
| `pending_profile` sai `effective_epoch` | C-PC-V6 |
| đổi lại khi chưa hết thời gian nguội | C-PC-V2 |
| `new_profile == profile` hiện tại | C-PC-V3 |
| sửa `magic_batches` (ví dụ đổi `profile_at_creation` của batch cũ) | C-PC-V4 / T4 |
| sửa `lamp_balance` | A02 |
| rút LAMP ra trong chính tx này | ghim giá trị output |

### Quyết định: gọi lần hai khi pending chưa áp dụng

**Chấp nhận đè.** Pending mới thay pending cũ. Thời gian nguội vẫn tính từ
`profile_changed_epoch` đã đặt ở lần một nên không lách được. Lý do: người dùng đổi ý sớm là
trường hợp hợp lệ; bắt đợi pending tiêu xong là làm kẹt.

Hiện thực không có nhánh `if pending == None` — mọi tx `UpdateProfile` đi cùng một đường.

---

## §3. `UpdateProfile` và ScheduleGen

ScheduleGen **không** có variant này, và đó là quyết định, không phải việc còn nợ: suất được
khoá tại commit nên profile không tham gia công thức tính của module đó. Thêm variant vào
`VaultRedeemer` của ScheduleGen là đổi hợp đồng nhị phân Plutus Data mà không đổi được hành vi
— đừng làm.

Off-chain chặn trước: `updateProfile` ném `UPDATE-001` khi `vaultType === "Schedule"`, trước
mọi lệnh gọi mạng.

---

## §4. Nhiều vault một chủ — không cần đổi gì on-chain

```aiken
expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1
```

Đây là chống thoả-mãn-kép (C-VAULT-DS-1), **không** phải "một vault mỗi chủ". Một người có N
vault ở cùng địa chỉ, mỗi vault một UTxO, một datum, một NFT danh tính, một dãy holding riêng.
Tiêu LAMP của vault ngắn hạn không đụng tới tuổi tích luỹ của vault dài hạn, vì tư cách tính
theo `loyalty_holdings` của vault hiện tại, không cộng chéo.

Off-chain: `listVaultsForOwner` trong `MagicSDK/src/listVaults.ts` liệt kê N vault của một
chủ. Mọi hành động đều chỉ đích danh một vault qua tham số `vaultUtxo`, nên không cần thêm gì.

---

## §5. Các quyết định thiết kế

| Câu hỏi | Quyết định |
|---|---|
| Rút LAMP có thu phí giao thức không? | Không — chỉ trả phí mạng ADA như mọi tx Cardano |
| Khoá phiên nằm ở đâu? | Thuộc PhoenixKey. MAGIC không lo. `personal_delegate` nay có nghĩa rõ: uỷ quyền TIÊU (`BurnBatch`), đặt bằng redeemer `SetDelegate` |
| `UpdateProfile` làm validator riêng hay gộp? | Gộp vào vault InstantGen — nơi duy nhất profile vào công thức |
| Nhiều vault một chủ? | Có, sẵn có; SDK thêm `listVaultsForOwner` |
| Đặt `personal_delegate` lúc tạo vault? | Không — datum khởi sinh phải sạch (`personal_delegate == None`), đặt sau bằng `SetDelegate` |

---

## §6. Chỉ số constructor của redeemer

**Off-chain KHÔNG hardcode chỉ số.** SDK đọc thẳng từ `plutus.json` mà Aiken sinh ra:

```
plutus.json
├── validators[].title = "vault.vault.spend"
│   └── redeemer.schema.$ref → "#/definitions/…/VaultRedeemer"
└── definitions["…/VaultRedeemer"].anyOf[]
    └── { title: "WithdrawLamp", index: …, … }
```

Người gọi truyền `vaultPlutusJson` qua `ValidatorBundle`; helper `resolveConstrIndex` tra chỉ
số theo TÊN variant. Enum đổi thứ tự thì chỉ cần `aiken build` lại, SDK tự bắt kịp — không có
bảng đếm tay nào để lệch.

Thứ tự thật của từng module nằm ở `pub type VaultRedeemer` trong
`<Module>/onchain/lib/magiclamp/protocol/types.ak`. Đó là **hợp đồng nhị phân**: variant đã bỏ
khỏi mô hình và trường `vacuum_orders` vẫn phải nằm nguyên chỗ cũ làm bia mộ, vì đổi vị trí là
vỡ decode mọi vault đã lên chain.

---

## §7. Ghi chú lịch sử — kế hoạch chuyển đổi v0 → v1

Giữ lại vì lý do đằng sau vẫn còn giá trị khi nào phải đổi validator lần nữa.

Đổi mã validator ⇒ đổi hash ⇒ đổi địa chỉ ⇒ vault cũ nằm lại ở địa chỉ cũ. Validator cũ vẫn
chạy được (mã trên chain là bất biến), nên ai giữ khoá riêng và giữ CBOR cũ vẫn tiêu được UTxO
cũ.

Bốn hướng từng cân nhắc: (a) bỏ hẳn bản cũ; (b) rút-rồi-tạo-lại; (c) một tx nguyên tử vừa tiêu
vault cũ vừa tạo vault mới; (d) không chuyển đổi. **Đã chọn (d)** vì bản cũ chỉ sống trên
Preview và không bao giờ lên mainnet: bản lên mainnet phải là bản đã có đủ `WithdrawLamp` +
`UpdateProfile`, đã kiểm toán. Sau khi lên mainnet, mỗi lần đổi validator là một đợt chuyển
đổi có kế hoạch riêng — không có đường tắt.

Cần biết cái gì đã deploy ở đâu tại thời điểm này thì xem [`DEVSTATUS.md`](../DEVSTATUS.md),
không xem tài liệu này.

---

## §8. Còn nợ

Danh sách việc chưa làm sống ở [`DEVSTATUS.md`](../DEVSTATUS.md) — một nơi giữ, không chép
sang đây. Riêng phần dính trực tiếp tới hai handler trên:

- Ma trận test [`V1_TESTNET_PLAN.md`](./V1_TESTNET_PLAN.md) **chưa hội tụ** về mô hình hai
  vault: nó còn liệt kê ca cho Snapshot/Vacuum và còn tham số `treasuryAddress`. Cần viết lại
  hoặc dời đi.
- `withdrawLamp` off-chain lệch luật W-5 ở `last_updated_epoch` và thiếu NFT danh tính trong
  output vault (xem [§1](#1-withdrawlamp-amount)). Chưa có tx thật trên testnet chứng minh
  đường rút chạy đầu-cuối.
