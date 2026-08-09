# Paymaster — FEAT (App Sponsor, MAGIC-as-gas)

## GenMAGIC v3.3 · Module Paymaster · v1.0 (MVP)

> ⚠ **Con trỏ `LAMP/docs/SPEC-Paymaster.md` đã CHẾT.** Bản trước ghi tệp đó là "nguồn bám" —
> nó không tồn tại (kiểm: `ls ../LAMP/docs/` báo không có thư mục). Đừng đi tìm, đừng dựng
> lại từ trí nhớ. Spec canonical duy nhất:
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).

Nguồn bám (đọc thẳng ở đó, mã là trọng tài): `Paymaster/onchain/validators/paymaster.ak`;
`Paymaster/onchain/lib/magiclamp/paymaster/{types,util,math}.ak`;
`InstantGen/onchain/validators/vault.ak` (`validate_burn_batch`, `validate_set_delegate`);
[`BOUNDARIES.md`](../BOUNDARIES.md) (ràng buộc vĩnh viễn — `CLAUDE.md` chỉ `@import` tệp đó).

**Trạng thái triển khai:** `validator paymaster(...)` nhận **11** apply-param
(`vault_script_hash, burn_batch_constr, lamp_policy_id, policy_nft_policy, meter_nft_policy,
protocol_nft_policy, max_policy_stale, max_did_entries, ms_per_epoch, treasury_addr,
lamp_asset_name`). Module **chưa có script deploy** trong `scripts/deploy/`. Trước khi ai đó
viết script đầu tiên: `cd scripts && npm run check:params`. Chi tiết + lý do: [`TECH.md`](./TECH.md),
[`EXEC.md §2`](./EXEC.md).

---

## 1. Mục đích

Paymaster cho phép **App** (đối tác/nền tảng) đứng ra trả **ADA (phí mạng) + LAMP (phí giao
thức) hộ user**, đổi lại user chỉ cần **tiêu MAGIC** (nhiên liệu nghiệp vụ họ đã có trong vault).
App đồng trigger `BurnBatch` của VAULT validator để giảm `current_amount` của user — App là
`personal_delegate` đã được user uỷ quyền (delegate-consume-right). Phí App chi ra được **hạch
toán** trong datum `SponsorMeter` (quota per-DID + global theo epoch), bù lại qua AppEconomics
reward epoch sau.

**MAGIC KHÔNG là token, KHÔNG MintingPolicy, KHÔNG `tx.mint`.** Tiêu MAGIC = handler `BurnBatch`
của vault giảm `current_amount` (nanogic). Paymaster ĐỌC lượng tiêu từ redeemer `BurnBatch{burns}`
của vault input co-spend (mirror `consume.ak read_vault_burns`), KHÔNG đọc `tx.mint`. Nguồn:
`paymaster.ak:4-9`, `types.ak:5-10`.

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| User (owner vault) | Sở hữu MAGIC trong vault. Đã đặt App làm `personal_delegate` (qua `SetDelegate` của vault, ngoài phạm vi Paymaster). KHÔNG cần ký tx sponsor. |
| App (`app_authority`) | VerificationKeyHash. PHẢI cosign tx (`paymaster.ak:94`). Trả ADA+LAMP hộ, trigger `BurnBatch`. Đồng thời là `personal_delegate` của MỌI vault sponsor (`paymaster.ak:97`). |
| SponsorPolicy beacon | Reference input mang SponsorPolicy NFT. DAO đặt tỷ giá + cap. `types.ak:23-32`. |
| SponsorMeter UTxO | Thread UTxO (1/app/epoch) mang Meter NFT. Ghi quota đã dùng. `types.ak:39-44`. |
| ProtocolFeeParams beacon | Reference input mang Protocol NFT. DAO đặt SÀN tỷ giá + cờ phí bật. `types.ak:51-55`. |
| Vault UTxO (module khác) | Generator vault. Spend bằng `BurnBatch` để giảm MAGIC. |

---

## 3. Flows

### 3.1 Happy path — App sponsor đầy đủ 1 user 1 nghiệp vụ

Điều kiện: user đã đặt App làm delegate; App có Meter UTxO epoch hiện tại; budget chưa cạn.

Các bước (theo thứ tự validator thực hiện, `paymaster.ak:63-165`):

1. Spend Meter UTxO bằng redeemer `Sponsor { vault_refs, policy_ref, protocol_ref, did_key, lamp_this, ada_this }` (`types.ak:65-74`).
2. `current_epoch = upper_bound_ms / ms_per_epoch` (`util.ak:18-24`) — cửa sổ validity ≤ 1 epoch.
3. PM-7: ép đúng 1 Meter input + 1 Meter output @paymaster, mỗi cái mang đúng 1 Meter NFT (`paymaster.ak:73-78`).
4. PM-10: đọc SponsorPolicy beacon, ép NFT auth + `current_epoch − policy.epoch ≤ max_policy_stale` + cùng `app_id` (`paymaster.ak:82-88`).
5. Đọc ProtocolFeeParams beacon (NFT auth) — SÀN tỷ giá (`paymaster.ak:91`).
6. PM-1: `app_authority ∈ extra_signatories` (`paymaster.ak:94`).
7. PM-1.5: MỌI vault trong `vault_refs` có `personal_delegate == Some(app_authority)` (field 15, `paymaster.ak:97,210-240`).
8. PM-2: `magic_consumed = Σ BurnBatch.burns` trên `vault_refs` PHÂN BIỆT, đọc từ redeemer thật (`paymaster.ak:101-105`, `util.ak:100-118`). Ép `> 0`.
9. PM-3.5: `policy.lamp_per_magic_q ≥ protocol.min_lamp_per_magic_q`; nếu `protocol_fee_active` ⇒ `lamp_this > 0` (`paymaster.ak:108-113`).
10. PM-3/4: `0 ≤ lamp_this ≤ lamp_cap(magic_consumed)`; `0 ≤ ada_this ≤ ada_cap(magic_consumed)` (`paymaster.ak:116-121`, `math.ak:16-23`).
11. PM-8: epoch lock — `meter_out.epoch == current_epoch`, `meter_in.epoch ≤ current_epoch`. Nếu `meter_in.epoch < current` → reset base (`[]`, 0) (`paymaster.ak:124-132`).
12. PM-5: `did_spent + lamp_this ≤ max_per_did_per_epoch` (`paymaster.ak:135-136`).
13. PM-6: `base_global + lamp_this ≤ max_global_per_epoch` (`paymaster.ak:139`).
14. Meter transition: `meter_out.did_lamp_map == add_did(base, did_key, lamp_this)`; `global == base_global + lamp_this` (`paymaster.ak:142-144`).
15. PM hard-cap: `|did_lamp_map| ≤ max_did_entries` (DoS guard, `paymaster.ak:147`).
16. PM-11: value Meter bảo toàn tuyệt đối `meter_out.value == meter_in.value` (`paymaster.ak:154`).
17. PM-12: aggregate cross-meter — `lamp_this ≤ lamp_cap(magic_total)` với `magic_total = Σ burns MỌI vault input toàn tx` (chống double-satisfaction, `paymaster.ak:161-163`).

Kết quả: vault user giảm MAGIC (qua BurnBatch); Meter cập quota; App đã trả ADA+LAMP hộ (settlement value nằm ở phần tx App tự dựng).

### 3.2 Luồng 3 vai trong 1 tx

App ký (cosign) + trả phí mạng. Vault user spend bằng BurnBatch (App là delegate → không cần user ký). Meter UTxO cập kế toán. Tất cả trong 1 tx atomic.

### 3.3 Epoch rollover (budget reset)

Khi App dùng lại Meter UTxO epoch cũ ở epoch mới: validator reset base về `([], 0)` TRƯỚC khi cộng op này (`paymaster.ak:126-132`) — chống replay budget cũ. Offchain builder mirror ở `paymaster.ts` (`epochRollover`).

### 3.4 Fallback — budget cạn

Nếu `did_spent + lamp_this > max_per_did` hoặc `base_global + lamp_this > max_global` → tx từ chối on-chain (PM-5/6). User tự trả (ngoài Paymaster) hoặc chờ epoch sau.

---

## 4. Invariants (bất biến giao thức)

| ID | Bất biến | Vị trí |
|---|---|---|
| PM-1 | App cosign | `paymaster.ak:94` |
| PM-1.5 | App = delegate MỌI vault | `paymaster.ak:97` |
| PM-2 | magic_consumed = Σ burns thật, dedup | `paymaster.ak:101-105` |
| PM-3/4 | lamp_this/ada_this ≤ cap tỷ giá | `paymaster.ak:116-121` |
| PM-3.5 | sàn DAO + chống sponsor=0 | `paymaster.ak:108-113` |
| PM-5/6 | per-DID + global cap | `paymaster.ak:135-139` |
| PM-7 | 1 Meter in + 1 out, NFT=1 | `paymaster.ak:73-78` |
| PM-8 | epoch lock + reset | `paymaster.ak:124-132` |
| PM-10 | policy NFT auth + freshness | `paymaster.ak:82-88` |
| PM-11 | value Meter bảo toàn | `paymaster.ak:154` |
| PM-12 | aggregate cross-meter (double-sat) | `paymaster.ak:161-163` |

---

## 5. Edge cases (MECE)

- **magic_consumed = 0** → fail PM-2 (`paymaster.ak:105`). App không sponsor khi user không tiêu MAGIC.
- **Khai thiếu vault_refs để hạ trần giả** → PM-12 đọc `all_burns_in_tx` (MỌI input), `lamp_this` vẫn bị cap theo `magic_total` thật (`paymaster.ak:161-163,246-275`).
- **2 vault_refs trùng OutRef** → dedup (`util.dedup_refs`, `util.ak:121-133`) — đếm 1 lần.
- **Policy/Meter epoch tương lai** → fail (`paymaster.ak:84,125`).
- **Drain ADA/NFT khỏi Meter** → fail PM-11 (`paymaster.ak:154`).
- **did_lamp_map phình** → fail hard-cap `max_did_entries` (`paymaster.ak:147`).

---

## 6. Out-of-scope (v1.x trở đi)

- Oracle giá LAMP/ADA (CIP-31) — MVP App tự định tỷ giá; field `oracle_nft_policy` đã có chỗ (`types.ak:30`).
- Settlement value-check LAMP on-chain (param `lamp_policy_id` giữ sẵn, `paymaster.ak:49`).
- AppEconomics reward payout (module riêng).
- DID per-user thật (MVP `did_key` = owner-key).
