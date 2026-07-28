# MAGIC — ĐẶC TẢ KỸ THUẬT ON-CHAIN (HỢP NHẤT)

> Neo chuẩn tối thượng: `SPEC/Whitepaper-MagicLamp-Tokenomic-Vi.md §7` (Cơ chế Gen MAGIC + Firewall §10). Mô hình chi tiết InstantGen: `InstantGen/MATH.md` (16/7). Interface tiêu MAGIC: `ConsumeMAGIC/CONTRACT.md` v2. Ranh giới GreenBack/GlobalState: `SPEC/Carpet-Tech-Vi.md §T2`.
> Phiên bản: **v1-unified** · Ngày: **2026-07-17** · Mạng: Cardano PlutusV3 (Aiken) + off-chain TypeScript (Lucid Evolution).
> File này THẮNG mọi module TECH.md cũ khi mâu thuẫn. Mọi cơ chế trong danh mục "ĐÃ BỎ" (§0.4) KHÔNG xuất hiện ở đây; nếu nguồn cũ còn → coi là loại bỏ.

---

## 0. Phạm vi, neo nguồn, quy ước

### 0.1 MAGIC là gì (ràng buộc hiến pháp — không bao giờ vi phạm)
MAGIC = **vai CREDIT** của một instance Carpet (LAMP=BASE, CARP=UNIT). Là **prepaid service credit** — quyền-tiêu-dịch-vụ trả-trước.

- **KHÔNG policy-id, KHÔNG token, KHÔNG chuyển nhượng.** MAGIC = một **entitlement kế toán** nằm trong datum vault: `MagicBatch.current_amount` (đơn vị nanogic). Không có MintingPolicy MAGIC, không `tx.mint` MAGIC ở bất kỳ validator nào của module MAGIC.
- **Tiêu MAGIC = ĐỐT = giảm `current_amount`** qua redeemer **`BurnBatch`** của vault validator. Đây là **nơi DUY NHẤT** MAGIC giảm. (Nguồn: `ConsumeMAGIC/CONTRACT.md` §E; Whitepaper §4.)
- **Neo par `P* = 1`** theo sức-mua-dịch-vụ (1 nanogic = 1 byte·ngày lưu-lạnh, numéraire off-chain/beacon), **KHÔNG neo fiat, KHÔNG chuộc-ra-tiền** (Whitepaper §10 F1/F4/F5).

### 0.2 Sáu cơ chế (mô hình MỚI — chuẩn, thay bản cũ)
| # | Cơ chế | Vai | Nơi giảm/tăng MAGIC |
|---|---|---|---|
| 1 | **InstantGen** (gộp SnapshotGen cũ) | Nắm LAMP mở TƯ-CÁCH → gen quyền-tiêu-ngay; LAMP **ở-yên-ví** | +batch (source=Instant) |
| 2 | **ScheduleGen** | Khoá TƯ-CÁCH LAMP (ở-yên-ví) → dòng `pp` MAGIC/epoch × N | +batch/epoch (source=Schedule) |
| 3 | **ConsumeMAGIC** | Định giá + engagement-state; ép vault `BurnBatch` Σ==required | (đọc; đốt xảy ra ở vault) |
| 4 | **Consolidate** | Gộp `loyalty_holdings` phân mảnh | (không đổi MAGIC/LAMP) |
| 5 | **Paymaster** | Delegate đốt MAGIC THAY owner (fee abstraction) | (đốt ở vault, không chuyển) |
| 6 | **FlowRate** | Keeper cập nhật `demand_mult` (dual-EMA) cho pricing ConsumeMAGIC | (beacon off-chain-driven) |

### 0.3 Đơn vị + quy ước codec (P8 — bit-identical Aiken↔TypeScript)
- `Q = 1_000_000_000` (10⁹) — thang fixed-point. Mọi tỷ-lệ lưu `*_q`.
- `oildrop = LAMP × 10^6`; `nanogic = MAGIC × 10^9`.
- **BigInt mọi nơi** cho oildrop/nanogic/Q (C-OVERFLOW). Cấm `Number` cho arithmetic.
- **Q-format = floor tuần-tự** (sequential floor): `M = L×R×… / Q^k` áp từng bước `⌊×/Q⌋`, không multiply-then-divide một lần (§6.1 / L4).
- **Constructor index = thứ tự khai báo field/variant trong Aiken** = Plutus Data tag. Datum field-order + redeemer variant-order là **NORMATIVE** — đảo = decode-fail câm on-chain. Redeemer **append-only** (variant mới ở CUỐI).
- `ms_per_epoch`: Preview/Preprod = `86_400_000`; Mainnet = `432_000_000`. Epoch ≈ 5 ngày (Whitepaper §7.1).

### 0.4 ĐÃ BỎ (TUYỆT ĐỐI không đưa vào — nếu nguồn cũ có thì loại)
UM / UMKeeper / hệ-số-cầu-mạng · profile Ember/Flame/Lantern + PM (profile multiplier) · LF (loyalty factor theo tuổi-nắm-giữ) · VacuumGen / vacuum_orders · halving / ApplyHalving / `halved` · mô hình InstantGen-mua-trả-LAMP cũ (`M = L_paid×R×UM×PM/Q³`, chuyển LAMP sang Treasury) · ScheduleGen rate-lock (T8 / `rate_locked_q`) + hệ 16-shard.

### 0.5 Bất biến baked (đã qua phản biện đối kháng 16/7 — `InstantGen/MATH.md`)
- **R1 (value-reconciliation):** mọi lần đọc `lamp_balance` ÉP `assets.quantity_of(utxo, lamp_policy, lamp_name) == datum.lamp_balance` tại chỗ đọc → chống genesis-vault khai-khống để farm gen/VP. (MATH.md:42-46)
- **R2 (TWAB):** `L_i` = số-dư-trung-bình-thời-gian LAMP đủ-tư-cách trong epoch, **cắt-đuôi-khi-bán** → chống flash-hold + đuôi-hậu-thoát. (MATH.md:30-40)
- **R3 (per-DID):** tư-cách gen gắn **DID one-shot NFT**, **1 suất-gen/DID/epoch** → chống double-gen đa-vault. `owner` pkh tự-khai KHÔNG đủ. (MATH.md:105-108)
- **Firewall F1–F9** (Whitepaper §10) — xem §14.

---

## 1. Kiến trúc validator / policy

```
MAGIC module (client của Carpet GlobalState)
├─ vault validator ................ spend; giữ VaultDatum (per-user)
│   redeemer: InstantGen | BurnBatch | WithdrawLamp | SetDelegate
│            | ScheduleCommit | ScheduleFire   (append-only enum, §4)
├─ consume validator (ConsumeMAGIC) spend; giữ EngageDatum (per-app engagement)
├─ price_param validator (beacon) . spend; giữ PriceParam (M-of-N committee)
├─ price_nft policy ............... one-shot NFT xác thực PriceParam beacon
├─ paymaster validator ............ spend; giữ SponsorMeter (per-app quota)
│   + policy_nft / meter_nft / protocol_nft (beacon + thread NFT)
├─ did policy ..................... one-shot NFT per-DID (R3)
└─ flowrate beacon (off-chain keeper cập nhật; §10)
```

**Đọc-chung, KHÔNG-sở-hữu:** MAGIC-Gen là **CLIENT** đọc `br_q / gov_params(br_safe_q, f_max_q, eta_q) / S / pp_sched` từ **Carpet GlobalState** qua `reference_input` (§5). MAGIC **KHÔNG xây** GreenBack / GlobalState / PSM. `cap_surplus` pro-rata + `br` TWAP + đệm-trễ là việc **GreenBack** (Carpet-Tech §T2, §T6).

---

## 2. Datum schema

### 2.1 VaultDatum — 17 field (codec CHUNG cho InstantGen/Schedule/Consolidate/Paymaster)
Nguồn: `InstantGen/onchain/lib/magiclamp/protocol/types.ak:124-142`. Thứ tự field NORMATIVE:

| idx | field | type | Trạng thái mô-hình-mới |
|---|---|---|---|
| 0 | `owner` | ByteArray (VKH) | **LIVE** |
| 1 | `lamp_balance` | Natural (oildrop) | **LIVE** — ép R1 mỗi lần đọc |
| 2 | `lamp_locked` | Natural (oildrop) | **LIVE** — LAMP khoá tư-cách bởi ScheduleGen |
| 3 | `loyalty_holdings` | List\<LoyaltyHolding\> | **LIVE — REPURPOSED** làm nguồn TWAB (R2); KHÔNG còn là LF |
| 4 | `magic_batches` | List\<MagicBatch\> | **LIVE** — entitlement MAGIC |
| 5 | `next_batch_index` | Natural | **LIVE** — nguồn `batch_id` |
| 6 | `vacuum_orders` | List\<VacuumOrder\> | **CHẾT** — VacuumGen đã bỏ; giữ `[]` vì codec chung |
| 7 | `gen_schedules` | List\<GenSchedule\> | **LIVE** — ScheduleGen |
| 8 | `profile` | ActivityProfile | **CHẾT** — profile/PM đã bỏ; giữ `Ember` cố định |
| 9 | `profile_changed_epoch` | Natural | **CHẾT** — giữ `0` |
| 10 | `pending_profile` | Option\<PendingProfile\> | **CHẾT** — giữ `None` |
| 11 | `last_updated_epoch` | Natural | **LIVE** |
| 12 | `delegation_cert` | DelegationCertificate | **LIVE** — app allocation (attribution) |
| 13 | `activity_state` | ActivityState | **LIVE** — burn history |
| 14 | `streak_state` | StreakState | **LIVE** |
| 15 | `personal_delegate` | Option\<ByteArray\> | **LIVE** — Paymaster (SetDelegate) |
| 16 | `attribution` | VaultAttribution | **LIVE** — hash-chain sự kiện |

> Datum worst-case ~12KB; tx-limit 16KB (types.ak:123). Field CHẾT giữ nguyên **để không phá codec chung** đang dùng chéo 4 module. Kế-hoạch dọn: §15.

### 2.2 MagicBatch
Nguồn: `types.ak:28-38`. Thứ tự field NORMATIVE:

| idx | field | type | Trạng thái |
|---|---|---|---|
| 0 | `batch_id` | ByteArray | LIVE — `blake2b256(own_ref ∥ index)` |
| 1 | `source` | BatchSource | LIVE — chỉ `Instant`(1) / `Schedule`(3) dùng; `Snapshot`(0)/`Vacuum`(2) CHẾT |
| 2 | `created_epoch` | Natural | LIVE |
| 3 | `initial_amount` | Natural (nanogic) | LIVE — audit immutable |
| 4 | `current_amount` | Natural (nanogic) | LIVE — **mutable, chỉ GIẢM qua BurnBatch** |
| 5 | `decay_window` | Natural | **CHẾT** — decay = reset mỗi epoch (§7.1); giữ để codec chung |
| 6 | `profile_at_creation` | Option\<ActivityProfile\> | **CHẾT** — luôn `None` |
| 7 | `contract_id` | Option\<ByteArray\> | LIVE cho Schedule (`Some(schedule_id)`); `None` cho Instant |
| 8 | `halved` | Bool | **CHẾT** — halving đã bỏ; luôn `False` |

`BatchSource`: `Snapshot=0, Instant=1, Vacuum=2, Schedule=3` (types.ak:10-15).

### 2.3 LoyaltyHolding (REPURPOSED → nguồn TWAB cho R2)
Nguồn: `types.ak:41-45`.
```
LoyaltyHolding { amount: Natural, acquired_epoch: Natural, is_locked: Bool }   // Constr 0
```
- `Bool`: `False=Constr 0 []`, `True=Constr 1 []`.
- **Ngữ nghĩa mới:** `amount`+`acquired_epoch`+mốc thay đổi = dấu-vết-thời-gian để tính `L_i` TWAB (MATH.md:40). KHÔNG dùng `acquired_epoch` làm hệ-số-LF (LF đã bỏ). `acquired_epoch` immutable sau tạo (T21).
- Consolidate gộp các holding kề-epoch (§7.6) — xem cảnh báo TWAB [NEEDS-EVIDENCE] §16.

### 2.4 EngageDatum (ConsumeMAGIC — state per-app, tách khỏi VaultDatum)
Nguồn: `ConsumeMAGIC/CONTRACT.md` §B2 (v2). Thứ tự field NORMATIVE:
```
EngageDatum {
  owner          : ByteArray,   // idx 0
  consumed_count : Int,         // idx 1 — Σ nghiệp vụ đã attributed
  last_epoch     : Int,         // idx 2
  did_commit     : ByteArray,   // idx 3 — APPEND-ONLY (thêm ở v2), immutable sau genesis
}                               // Constr 0
```
- `did_commit` (MVP = `#""`): tương lai = `blake2b256` commit liên-kết engagement↔DID sinh-trắc (PROVIDER-AGNOSTIC — §6). Đặt 1 lần genesis, immutable.

### 2.5 PriceParam + OpPrice (beacon giá — reference input, CIP-31)
Nguồn: `ConsumeMAGIC/onchain/lib/magiclamp/consume/types.ak`; CONTRACT §B1.
```
OpPrice   { op_type: Int, base_price: Int }                              // Constr 0
PriceParam{ op_prices: List<OpPrice>, demand_mult: Int, m_min: Int,      // Constr 0
            m_max: Int, epoch: Int }
```
- `price(op_type) = base_price[op_type] × demand_mult / Q`, đơn vị nanogic. `q = 1e9` khớp `ProtocolUtils.Q`.
- op_type CHỐT: `1 = ảnh` (0.01 MAGIC = 10_000_000 nanogic), `2 = CID` (0.001 MAGIC = 1_000_000 nanogic). Fixture/beacon/redeemer PHẢI dùng đúng key này (CONTRACT §A).
- `demand_mult` do **FlowRate** keeper cập nhật (§10). Mặc định `m_min=0.5×, m_max=2.0×`.

### 2.6 Paymaster datums
Nguồn: `Paymaster/TECH.md §1`; `Paymaster/onchain/lib/magiclamp/paymaster/types.ak`.

**SponsorPolicy** (beacon, ref-input, `types.ak:23-32`):
| idx | field | type |
|---|---|---|
| 0 | `app_id` | ByteArray |
| 1 | `app_authority` | ByteArray (VKH) |
| 2 | `max_per_did_per_epoch` | Int (oildrop) |
| 3 | `max_global_per_epoch` | Int (oildrop) |
| 4 | `lamp_per_magic_q` | Int (Q) |
| 5 | `ada_per_magic_q` | Int (Q) |
| 6 | `oracle_nft_policy` | Option\<ByteArray\> |
| 7 | `epoch` | Int |

**SponsorMeter** (thread UTxO, `types.ak:39-44`): `app_id`(0), `epoch`(1), `did_lamp_map: List<(ByteArray,Int)>`(2), `global_lamp_epoch: Int`(3).

**ProtocolFeeParams** (beacon DAO sàn, `types.ak:51-55`): `min_lamp_per_magic_q`(0), `protocol_fee_active: Bool`(1), `epoch`(2).

### 2.7 FlowRateDatum (beacon dual-EMA)
Nguồn: `FlowRate/offchain/src/types.ts`. (Aiken beacon khi deploy phải mirror thứ tự này.)
```
FlowRateDatum {
  ema_fast_q, ema_slow_q, lamp_per_magic_q,      // Q-format
  total_lamp_epoch (oildrop), total_magic_epoch (nanogic),
  last_epoch (Int), div_q, cap_q
}
```

### 2.8 Struct CHẾT còn giữ (codec chung) + struct đã bỏ
- **`VacuumOrder`** (`types.ak:48-53`), **`AutoBurnConfig`** (`types.ak:56-60`), **`PendingProfile`** (`types.ak:98-101`), **`ActivityProfile`** (`types.ak:19-23`): CHẾT nhưng còn được VaultDatum/GenSchedule tham chiếu → giữ định-nghĩa để CBOR decode không vỡ. Off-chain builder luôn phát giá-trị-trơ (`vacuum_orders=[]`, `profile=Ember`, `pending_profile=None`).
- **`GenSchedule`** (`types.ak:63-75`): LIVE nhưng có field CHẾT — xem §7.5.
- **`ShardRedeemer` / `ScheduleAggregateShardDatum`** (ScheduleGen cũ): **BỎ HẲN** cùng hệ 16-shard. Không đưa vào build mới.
- **`UMDatum`** (`types.ak:145-149`): **BỎ HẲN** (UM đã bỏ).

---

## 3. VaultRedeemer (constr-index = thứ tự variant; append-only)
Nguồn: `types.ak:153-174`.

| constr | variant | Trạng thái mô-hình-mới |
|---|---|---|
| 0 | `InstantGen { … }` | **LIVE — NGỮ NGHĨA THAY** (không mua/không chuyển LAMP; §7.1). Field `lamp_paid` cũ **CHẾT** — xem [NEEDS-EVIDENCE] §16 về shape mới |
| 1 | `ApplyHalving` | **CHẾT** — halving bỏ. Handler → `fail` |
| 2 | `BurnBatch { burns: List<(ByteArray, Natural)> }` | **LIVE** — nơi DUY NHẤT giảm MAGIC (§7.2) |
| 3 | `UpdateProfile { new_profile }` | **CHẾT** — profile bỏ. Handler → `fail` |
| 4 | `WithdrawLamp { amount: Natural }` | **LIVE** (§7.3) |
| 5 | `SetDelegate { new_delegate: Option<ByteArray> }` | **LIVE** — Paymaster (§7.4) |
| 6 | `ScheduleCommit { schedule_length, lamp_per_epoch }` | **LIVE** — mô hình mới, cổng GreenBack (§7.5) |
| 7 | `ScheduleFire { schedule_id }` | **LIVE** (§7.5) |

> **Lưu ý hợp nhất:** repo cũ có 2 enum VaultRedeemer riêng (InstantGen vs ScheduleGen). Bản hợp nhất gộp thành MỘT enum append-only, ScheduleCommit/Fire nối ở constr 6/7 (SAU SetDelegate) để không đụng constr-index đã có. `BurnBatch` giữ constr 2 (cả hai module cũ đều đặt 2 — không đổi). Handler CHẾT (1,3) trả `fail`.

---

## 4. GlobalState reference_input contract (Carpet-Tech §T2)

MAGIC-Gen đọc GlobalState (singleton toàn-hệ của Carpet) làm **reference input**. KHÔNG spend, KHÔNG sở-hữu.

**Field đọc** (từ `GlobalDatum`, Carpet-Tech §T2):
- `br_q` — backing-ratio `B/S` (Q). Xác định chế-độ xanh/đỏ.
- `S` = `carp_circulating` / cung MAGIC lưu hành (nanogic) — cho `cap_surplus`.
- `pp_sched` — dòng MAGIC/epoch ScheduleGen toàn mạng — cho trần-kép.
- `gov_params`: `br_safe_q=1.5q`, `f_max_q=0.10q`, `eta_q=0.5q`, + `cap_surplus` budget do GreenBack quản.
- (depeg CARP/MAGIC < P* — cờ đọc từ GlobalState cho van-đỏ thứ hai.)

**Xác thực + freshness (chống ref-input cũ đọc `br` giả cao — adversary):**
- **Pin script hash:** GlobalState nhận diện bằng NFT `gs_nft` **VÀ** pin `Script(gs_script_hash)` (kế thừa mẫu `find_um_datum`: NFT-alone KHÔNG đủ — PHẢI pin script-address). (Carpet-Tech §T1.1)
- **Freshness:** `expect gs.epoch == e` (hoặc `e − gs.epoch ≤ MAX_GS_STALENESS` nếu GreenBack cập nhật trễ 1 epoch — chốt theo nhịp keeper CARP). (MATH.md:99-103)
- `cap_surplus` là **ngân-sách-mạng** phân bổ **pro-rata theo M-đủ-tư-cách** (KHÔNG FCFS) do GreenBack điều-phối (budget-UTxO/2-pha). InstantGen chỉ đọc phần còn khả-cấp + draw ≤ đó. (MATH.md:90-93)

---

## 5. DID one-shot NFT (R3)

- Tư-cách gen gắn **DID one-shot NFT** (khớp mô hình PhoenixKey C4), **KHÔNG** dùng `owner` pkh tự-khai. (MATH.md:106)
- **1 suất-gen / DID / epoch:** chặn double-gen cùng-LAMP qua nhiều vault/tx trong 1 epoch. Đọc "đã-gen-epoch-này" per-DID qua ref-input/beacon; `L_i` gộp **theo DID**, không theo UTxO rời. (MATH.md:107)
- **PROVIDER-AGNOSTIC:** resolve DID↔signer là việc PhoenixKey (ngoài scope MAGIC). MAGIC chỉ ràng qua NFT policy allow-list DAO + beacon resolver, KHÔNG hardcode PhoenixKey (hệ nhiều nhà cung cấp DID). Interface `did_commit` chưa chốt cứng → xem §16 blocker.

---

## 6. Validator logic — vault (từng redeemer)

Tham số validator (apply lúc build; thứ tự khớp `aiken.toml`):
`lamp_policy_id : PolicyId` · `treasury_addr : Address` (chỉ Schedule cần; phải Script credential) · `gs_nft_policy : PolicyId` + `gs_script_hash` (GlobalState) · `did_nft_policy : PolicyId` (R3) · `ms_per_epoch : Int`.

**Bất biến chung mọi redeemer** (kế thừa idiom Carpet §T0):
- **Epoch hai-bound:** `current_epoch` từ `tx.validity_range`; ÉP cả hai bound `Finite` và `e_lo == e_hi` (chống validity-range gaming — MAINNET-BLOCK). KHÔNG đọc lower-only.
- **Anti-double-spend:** `count(inputs at vault payment-script-hash) == 1`; `count(outputs at vault script) == 1` (đếm theo **payment script hash**, KHÔNG theo Address đầy đủ — chống double-satisfaction qua stake credential).
- **`output.reference_script == None`** trên output tiếp-diễn.
- **C-VAULT-10:** `Σ loyalty_holdings.amount == lamp_balance`. **C-VAULT-8:** `lamp_locked ≤ lamp_balance`. **C-VAULT-13:** `|loyalty_holdings| ≤ 64`. **C-VAULT-1:** `|magic_batches| ≤ 32`.
- **Value-leak guard (R1):** mọi output tiếp-diễn ÉP `assets.quantity_of(output, lamp_policy, lamp_name) == output_datum.lamp_balance`.

### 6.1 InstantGen (mô hình MỚI — nắm-LAMP-mở-tư-cách, LAMP ở-yên-ví)
> **KHÁC bản cũ:** KHÔNG mua, KHÔNG chuyển LAMP sang Treasury, KHÔNG UM/PM. LAMP **ở nguyên ví** (`lamp_balance` KHÔNG đổi). Chỉ **cấp một batch MAGIC** = trần-suất epoch này.

**Điều kiện cần (cả hai — Whitepaper §7.2):** (1) nắm LAMP đủ tư-cách; (2) **tiêu-thật MAGIC** trong epoch qua nền-tảng-đăng-ký (điều-kiện-(b), per-epoch).

**Bước tính `M_grant`** (nguồn duy nhất chuẩn: `InstantGen/MATH.md`):
1. **`L_i` (R2, TWAB)** cho `i = 0..6` (7 epoch): `L_i = ⌊ (Σ_j balance_j × dur_j) / len_epoch ⌋`, chỉ đếm LAMP CÒN đủ-tư-cách (unlocked); **cắt-đuôi-khi-bán** (bán ra → `balance_j` tụt NGAY). (MATH.md §2)
   - **R1 tại chỗ đọc:** `assets.quantity_of(vault_utxo, lamp_policy, lamp_name) == datum.lamp_balance`. (MATH.md:42-46)
2. **`M(L_i) = ⌊ L_i × R_gen_q / Q ⌋`** (oildrop→nanogic; 1 floor, tuyến-tính → chẻ ví không lợi). (MATH.md §3)
3. **`M_raw = ⌊ (Σ_{i=0..6} M(L_i)) / 7 ⌋`** — trung-bình phẳng `wᵢ=1/7` (sum-then-floor). (MATH.md §4)
4. **Cổng + trần-kép + van-đỏ** (đọc `br_q, S, pp_sched` từ GlobalState — §4):
   ```
   Van đỏ:  M_grant = 0                          nếu br_q ≤ br_safe_q (=1.5q)
   Depeg:   M_grant = 0                          nếu CARP/MAGIC < P*
   Xanh:    cap_surplus = ⌊ ⌊f_max_q × S / Q⌋ × (br_q − br_safe_q) / br_safe_q ⌋
            double_cap  = ⌊ pp_sched / 2 ⌋       (InstantGen ≤ 0.5× Schedule)
            M_grant     = min( M_raw, cap_surplus, double_cap )
   ```
   (MATH.md §5; Whitepaper §7.2)
5. **`R_gen_q`** = governance param, **GIẢ ĐỊNH** benchmark `= Q` (1000 LAMP → ~1 MAGIC/epoch trước cổng). KHÔNG hằng chốt — đọc từ gov_params/beacon. (MATH.md:26)

**R3 (per-DID):** đọc DID one-shot NFT; ÉP "chưa-gen-epoch-này" per-DID (§5). `L_i` gộp theo DID.

**Output datum (A02, field-by-field):**
- THAY: `magic_batches := old ++ [new_batch]` (new: `source=Instant`, `current_amount=initial_amount=M_grant`, `contract_id=None`, `profile_at_creation=None`, `halved=False`, `decay_window` bất-kỳ-trơ); `next_batch_index += 1`; `last_updated_epoch := e`; `attribution.total_events += 1`, `attribution.last_event_epoch := e`.
- **BẤT BIẾN (không đổi):** `owner`, **`lamp_balance` (KHÔNG trừ — LAMP ở-yên-ví)**, `lamp_locked`, `loyalty_holdings` (không remove), `vacuum_orders`, `gen_schedules`, `profile*`, `pending_profile`, `delegation_cert`, `activity_state`, `streak_state`, `personal_delegate`.
- **C-INST-batch:** active (non-đã-tiêu-hết) batches `< 32` trước khi thêm.

**Decay = RESET mỗi epoch (§7.1 pin-mặt-trời):** `M_grant` là **TRẦN-SUẤT epoch này**, KHÔNG cộng-dồn thành bể-quyền tiêu sau. Không tiêu hết → phần dư = 0 ở epoch e+1. (MATH.md §7; Whitepaper §7.2 use-it-or-lose-it)

### 6.2 BurnBatch — nơi DUY NHẤT giảm MAGIC
Redeemer: `BurnBatch { burns: List<(ByteArray, Natural)> }` — mỗi cặp `(batch_id, amount_nanogic)`.
- **Owner-or-delegate:** ÉP `owner ∈ tx.extra_signatories` HOẶC (`personal_delegate = Some(d)` và `d ∈ tx.extra_signatories`) — cho Paymaster đốt HỘ (§7.4/§9).
- Mỗi `batch_id` trong `burns`: tồn tại trong `magic_batches`; `output.current_amount = input.current_amount − amount`; `amount ≤ input.current_amount` (không âm).
- `initial_amount` immutable (audit). Batch về `current_amount = 0` có thể prune khỏi list.
- **KHÔNG `tx.mint`, KHÔNG chạm LAMP/ADA** — LAMP + ADA bảo toàn byte-perfect. MAGIC một-chiều (F1).
- **Co-spend anchor:** ConsumeMAGIC (§8) và Paymaster (§9) đọc redeemer `BurnBatch` này qua `tx.redeemers` để ép `Σburns == required`. `burn_batch_constr` (= constr index BurnBatch của vault) **= 2** trong enum hợp nhất.
- Output A02: mọi field khác PRESERVED; `last_updated_epoch := e`; attribution cập nhật.

### 6.3 WithdrawLamp
Redeemer: `WithdrawLamp { amount }`. Nguồn logic: ScheduleGen/TECH §2.5 (W-1..W-7).
- W-1 `amount > 0`; W-2 owner ký; W-3 `amount ≤ l_avail = lamp_balance − lamp_locked`.
- W-5 output field-by-field: mọi field khác PRESERVED; `last_updated_epoch` **PRESERVED** (KHÔNG advance).
- `output.lamp_balance = input − amount`; **R1** value-leak trên output; W-7 `Σholdings == lamp_balance` (holdings giảm tương ứng, youngest-first hoặc theo `remove_from_holdings`).

### 6.4 SetDelegate
Redeemer: `SetDelegate { new_delegate: Option<ByteArray> }` (types.ak:169-173).
- Owner-only (`owner ∈ extra_signatories`); **không cooldown**.
- THAY DUY NHẤT field 15 `personal_delegate := new_delegate`; **mọi field khác PRESERVED** (kể cả `last_updated_epoch`, `lamp_balance` — R1).
- `Some(d)` cho `d` kích `BurnBatch` HỘ owner (app paymaster) **KHÔNG chuyển MAGIC**; `None` khoá về owner-only.

### 6.5 ScheduleCommit / ScheduleFire (mô hình MỚI)
> **KHÁC bản cũ:** BỎ `rate_locked_q`/T8 (không khoá tỷ-giá), BỎ hệ 16-shard. Cổng đọc **GreenBack** (GlobalState). Rate lấy hiện-hành lúc fire (không đóng băng).

**GenSchedule (field CHẾT đánh dấu):**
| idx | field | trạng thái |
|---|---|---|
| 0 | `schedule_id` | LIVE — `blake2b256(own_ref ∥ sched_index)` |
| 1 | `commit_epoch` | LIVE |
| 2 | `start_fire_epoch` | LIVE — `= commit_epoch + buffer_ep (=2)` |
| 3 | `end_fire_epoch` | LIVE — `= commit_epoch + L + 1` |
| 4 | `schedule_length` | LIVE — `L` |
| 5 | `lamp_per_epoch` | LIVE — `λ` (khoá tư-cách LAMP) |
| 6 | `rate_locked_q` | **CHẾT** — không khoá tỷ giá; giữ trơ vì codec chung |
| 7 | `baseline_at_commit_q` | **CHẾT** (audit cũ) |
| 8 | `multiplier_at_commit_q` | **CHẾT** (audit cũ) |
| 9 | `fired_count` | LIVE — 0..L |
| 10 | `auto_burn_target` | LIVE (Option, cho auto-burn delegate) |

**ScheduleCommit { schedule_length L, lamp_per_epoch λ }** — khoá TƯ-CÁCH (LAMP ở-yên-ví):
- Owner ký. `L ∈ [10, 200]`; `λ ≥ 1_000_000 oildrop`; `L×λ ≤ l_avail = lamp_balance − lamp_locked`.
- **Cổng GreenBack (Whitepaper §7.3):** đọc GlobalState (§4) →
  ```
  Σ nghĩa-vụ-còn-lại (gồm hợp đồng mới) ≤ κ × Sức-tải-các-quỹ-cứu
  κ = 0.6 CỐ ĐỊNH (cấm đổi giữa vòng đời hợp đồng)
  ```
  Sức-tải = số-dư các quỹ cứu nội-bộ (RedBack + kho dự phòng nền tảng + Kho bạc), đọc từ GlobalState — **TUYỆT ĐỐI KHÔNG dùng giá LAMP/dữ-liệu-giá** (F6). `buffer_ep = 2` (luôn giữ đủ 2 epoch tới).
- `|gen_schedules| < 20` (MAX_GEN_SCHEDULES). `lamp_locked += L×λ` (khoá); `gen_schedules ++ [sched]` (`start = e+2`, `end = e+L+1`, `fired_count=0`). LAMP **KHÔNG chuyển đi** (ở-yên-ví, khoá logic bằng `lamp_locked`).
- Output A02 field-by-field; `Σholdings == lamp_balance` (R1); `select_lamp_for_lock` youngest-first (T5).

**ScheduleFire { schedule_id }** — trả dòng `pp` MAGIC/epoch:
- **Permissionless** (KHÔNG cần chữ ký owner — cho keeper/auto-burn). Chống double bằng `count(inputs at vault)==1` + `fired_count` đơn điệu.
- Chỉ fire epoch `∈ [start_fire_epoch, end_fire_epoch]` và mỗi epoch tối đa 1 suất (`fired_count += N`); catch-up `N ≤ MAX_FIRES_PER_TX = 8`.
- **Trần cứng `pp`/epoch:** mỗi fire cấp `≤ λ`-tương-ứng-`pp` MAGIC; KHÔNG rút-dồn nhiều epoch một lần (Whitepaper §7.3 bước 4).
- Thêm `N` batch MAGIC (`source=Schedule`, `contract_id=Some(schedule_id)`); khi `fired_count == L` → remove schedule + `lamp_locked -= L×λ` (unlock, LAMP trả về khả-dụng trong ví). `|magic_batches| ≤ 32`.
- Output A02; R1 value-leak.
- **No commit-cancel** (C-VAC-12/T10): đã commit → fire hoặc hết-hạn, không refund giữa-chừng.

### 6.6 Consolidate (§6.9 — sort-partition-merge)
Validator riêng `vault_consolidate.ak`; redeemer `Consolidate` (Constr 0, 0 field). Nguồn: `Consolidate/TECH.md §2`.
- **Full-datum decode 17 field** rồi so field-by-field (audit Bug 1 — validator rút-gọn cũ bị DRAIN).
- W-1 owner ký; W-2/W-3 đúng 1 input + 1 output tại **script hash** (double-sat qua stake cred — đếm theo payment credential).
- **W-4..W-19:** 16 field CỐ ĐỊNH (mọi field TRỪ `loyalty_holdings`) = input; `output == input`.
- **W-20** `|out.loyalty_holdings| < |in.loyalty_holdings|` (giảm mảnh); **W-21** `Σ out.amount == Σ in.amount`; **W-22** `Σ locked out == Σ locked in`; **W-23** `Σholdings == lamp_balance`; **W-24** `lamp_locked ≤ lamp_balance`.
- Off-chain: `mergeGroup` sort + merge cặp kề `epoch_diff ≤ 1`. BigInt cho `amount`/`acquired_epoch`.

---

## 7. ConsumeMAGIC — engagement-state validator (2-validator co-spend)
Nguồn AUTHORITATIVE: `ConsumeMAGIC/CONTRACT.md` v2. (TECH.md ConsumeMAGIC = v1 token-burn **ĐÃ THAY** — KHÔNG dùng `tx.mint`/`magic_policy`/`check_only_magic_burn`.)

**Mô hình:** tiêu MAGIC = 1 tx co-spend 2 validator:
- **Vault input** spend `BurnBatch { burns }` → giảm `current_amount` (§6.2). Nơi DUY NHẤT giảm MAGIC.
- **Engage UTxO** (`consume.ak`) spend `Consume { op_type, op_count, price_ref, vault_ref }` → ghi state per-app, ép `Σburns == required`.

`consume.ak` đọc redeemer BurnBatch của `vault_ref` qua `tx.redeemers` (purpose Spend), giải mã `burns` bằng `un_constr_data`, param `burn_batch_constr = 2`. Hai validator đọc **CÙNG** PriceParam beacon + **CÙNG** `op_type/op_count`.

**Bất biến (Aiken):**
- **C-CM-1 (value preservation @engage):** Engage UTxO chỉ giữ ADA + thread NFT (KHÔNG MAGIC/LAMP); `Σvalue(out@engage) == Σvalue(in@engage)` tuyệt đối; KHÔNG `tx.mint`.
- **C-CM-2 (Σburns == Σrequired — AGGREGATE):** đọc PriceParam qua `price_ref` ref-input (xác thực NFT). `total_required = Σ trên MỌI Engage input [price(op_type_i) × op_count_i]` (ép `pr_i == price_ref` — không trộn nhiều bảng giá); `total_burned = Σ burns trên MỌI vault_ref PHÂN BIỆT`. ÉP `total_burned == total_required` (**`==`, KHÔNG `≥`** — over-burn = giảm MAGIC vô cớ, CẤM). Chống pay-once-consume-N (N Engage cùng trỏ 1 vault burn → aggregate bắt lệch → REJECT).
- **C-CM-3 (double-satisfaction @engage):** đếm theo payment script hash; `#out@engage == #in@engage`; `Σ engageNFT(out) == Σ engageNFT(in)`; `Σ consumed_count(out) == Σ(in) + Σ op_count`.
- **C-CM-4 (replay/state):** mỗi out@engage đúng 1 thread NFT one-shot, `owner` bảo toàn, `last_epoch == current_epoch`, `did_commit` **immutable** (`out == in`).
- **C-CM-5 (stale price):** `0 ≤ current_epoch − PriceParam.epoch ≤ MAX_PRICE_STALE`.
- **INV-CASHBACK-BOUND** (lớp tiêu/hoàn): hoàn/thưởng mỗi DID ≤ phí-thật-đã-ĐỐT của DID đó. (MATH.md:88; Whitepaper §7.2)

**Beacon `price_param` (spend, M-of-N committee):** `tx.mint = zero`; đúng 1 in + 1 out @script; `count_sigs ≥ threshold`; `out.epoch > in.epoch` (đơn điệu tăng); `valid_param(out)`; NFT bảo toàn (1 in/1 out).
**`price_nft` (mint one-shot):** `genesis_ref` bị tiêu; đúng 1 asset-name; qty `= +1`; `else → fail` (chặn burn NFT).

**burn-ID phát:** `consumer_did / provider_did / service_id / resource_type` (cho Governance C1/attribution). `did_commit` PROVIDER-AGNOSTIC (§5).

---

## 8. Paymaster — delegate đốt MAGIC HỘ owner (fee abstraction)
Nguồn: `Paymaster/TECH.md`. KHÔNG chuyển MAGIC — chỉ trả phí tx thay + ký BurnBatch HỘ.

**Redeemer `Sponsor`** (spend Meter; `types.ak:65-74`, Constr 0, 6 field): `vault_refs: List<OutputReference>`(0), `policy_ref`(1), `protocol_ref`(2), `did_key: ByteArray`(3), `lamp_this: Int`(4), `ada_this: Int`(5).
- Off-chain dùng `Data.Object` (KHÔNG `Data.Enum` 1-phần-tử — Lucid 0.4.x cast lỗi khi variant >1 field).

**Param (9):** `vault_script_hash`, `burn_batch_constr` (**= 2** trong enum hợp nhất), `lamp_policy_id`, `policy_nft_policy`, `meter_nft_policy`, `protocol_nft_policy`, `max_policy_stale`, `max_did_entries`, `ms_per_epoch`.

**Bất biến cốt lõi (PM-1..PM-12):**
- Đếm theo **payment script hash** (chống double-sat qua stake cred).
- **`magic_consumed` đọc redeemer THẬT** của vault (`find_spend_redeemer` quét MỌI input — PM-12), KHÔNG tin redeemer Sponsor.
- **PM-1.5:** đọc `personal_delegate` **field-agnostic** qua `un_constr_data` field index **15** (KHÔNG import VaultDatum — tránh coupling); ÉP `app_authority == personal_delegate` (delegate hợp lệ).
- **Cap:** `lamp_this ≤ max_per_did_per_epoch` (per-DID) và `global_lamp_epoch + lamp_this ≤ max_global_per_epoch`; epoch-reset khi `meter.epoch < current_epoch`.
- **Sàn DAO:** `lamp_per_magic_q ≥ min_lamp_per_magic_q` (nếu `protocol_fee_active`).
- Beacon NFT auth: `quantity_of(.., nft_policy, nft_name) == 1` cho policy + protocol.
- Meter value bảo toàn (1 Meter NFT giữ nguyên); validity ≤ 1 epoch, epoch-ref = upper bound. `else → fail`.

**eUTXO:** INPUTS = Meter@paymaster (Sponsor) + Vault(s)@vault (BurnBatch, giảm current_amount); REF = SponsorPolicy + ProtocolFeeParams beacon; OUTPUTS = Meter' (datum mới, value bảo toàn) + App settlement (App tự dựng). Signer = `app_authority` (= delegate).

---

## 9. FlowRate — keeper dual-EMA cập nhật `demand_mult`
Nguồn: `FlowRate/offchain/src/math.ts`. Keeper off-chain (long-lived) đọc Σ flow toàn mạng (từ mọi SponsorMeter), tính rate, post vào beacon (feed `PriceParam.demand_mult` cho ConsumeMAGIC pricing).

**Hằng số:** `ALPHA_FAST_Q = Q/3` (α≈0.333) · `ALPHA_SLOW_Q = Q/12` (α≈0.083, cửa-sổ 12 epoch) · `BASE_CAP_Q=0.25` · `MIN_CAP_Q=0.05` · `DIV_BLEND_PIVOT=0.10` · `BLEND_FAST_MAX=0.70` · `HARD_FLOOR_Q=0.01` · `HARD_CEIL_Q=10.0` (LAMP/MAGIC) · `MIN_MAGIC_EPOCH=1000 MAGIC`.

**`updateFlowRate(datum, flow)`:**
1. Guard hoạt-động: `total_magic_ng < MIN_MAGIC_EPOCH` hoặc `total_lamp==0` → chỉ advance `last_epoch`.
2. Guard epoch tiến: `flow.epoch ≤ last_epoch` → no-op.
3. `raw = total_lamp_oildrop × Q / total_magic_ng`. **Overflow guard:** `raw > HARD_CEIL_Q` → giữ EMA, chỉ advance epoch, bound output bằng `cap_q` đã lưu.
4. `ema_fast' = (α_f·raw + (Q−α_f)·ema_fast)/Q`; `ema_slow'` tương tự.
5. `div_q = |fast−slow|/slow × Q`. **Adaptive cap:** `cap_q = BASE_CAP_Q × Q/(Q + 3·div_q)` ∈ [5%,25%].
6. **Blend:** `w_fast = (PIVOT−div)·0.70/PIVOT` (0 khi div≥10%); `rate = (w_fast·fast + w_slow·slow)/Q` → tin fast khi calm, tin slow khi bị thao-túng.
7. **Rate-of-change cap** vs `lamp_per_magic_q` trước: clamp `[prev·(Q−cap), prev·(Q+cap)]`; rồi clamp cứng `[HARD_FLOOR, HARD_CEIL]`.

> **Lưu ý mapping:** FlowRate xuất `lamp_per_magic_q` (tỷ giá). Quan hệ chính xác `lamp_per_magic_q → PriceParam.demand_mult` chưa neo trong nguồn → [NEEDS-EVIDENCE] §16. Pure BigInt, KHÔNG float, KHÔNG PI/windup.

---

## 10. ID computation (P8 — bit-identical on/off chain)
```
batch_id    = blake2b_256( tx_hash(32B) ∥ u64BE(output_index) ∥ u64BE(batch_index) )
schedule_id = blake2b_256( tx_hash(32B) ∥ u64BE(output_index) ∥ u64BE(sched_index) )
```
- Index encode: `bytearray.from_int_big_endian(n, 8)`. On-chain `math.ak`; off-chain phải dùng cùng encoding.
- **DID NFT** one-shot: policy param `genesis_ref` (mẫu `beacon_nft`); asset-name allow-list DAO (§5). (Hệ 16-shard cũ `shard_id = blake2b(pkh)[0] % 16` **ĐÃ BỎ**.)

---

## 11. Hard limits (đồng bộ `constants.ak` ↔ `constants.ts` mỗi module)
| Hằng | Giá trị | Nơi ép |
|---|---|---|
| `MAX_BATCHES_PER_VAULT` | 32 | vault (C-VAULT-1) |
| `MAX_LOYALTY_HOLDINGS` | 64 | vault (C-VAULT-13) |
| `MAX_GEN_SCHEDULES` | 20 | ScheduleCommit |
| `MAX_FIRES_PER_TX` (catch-up) | 8 | ScheduleFire |
| `SCHEDULE_LENGTH` L | [10, 200] | ScheduleCommit |
| `λ` min | 1_000_000 oildrop | ScheduleCommit |
| `buffer_ep` | 2 | ScheduleGen |
| `κ` (cổng Schedule) | 0.6 (cố định) | ScheduleCommit |
| `br_safe_q` | 1.5q | van-đỏ (GlobalState gov_params) |
| `f_max_q` | 0.10q | cap_surplus |
| `W` (cửa-sổ TWAB) | 7 epoch | InstantGen |
| `MAX_PRICE_STALE` | (param, MVP=5) | ConsumeMAGIC C-CM-5 |
| `MAX_GS_STALENESS` | (chốt theo keeper CARP) | GlobalState freshness |
| `max_did_entries` | (param) | Paymaster PM-17 |
| **BỎ:** `MAX_VACUUM_ORDERS`, `SHARD_COUNT=16`, `SHARD_CAP` | — | (Vacuum + shard đã bỏ) |

---

## 12. Firewall F1–F9 (bất biến hiến pháp — Whitepaper §10) → điểm cưỡng-chế
| Mã | Nội dung | Cưỡng-chế trong MAGIC |
|---|---|---|
| **F1** | MAGIC một chiều (không → CARP/LAMP/tiền) | BurnBatch chỉ GIẢM `current_amount`; không `tx.mint`; MAGIC không token |
| **F2** | Ma sát CARP→MAGIC (cam kết tiêu, gắn DID) | thuộc Carpet PSM/PrepaidGen — MAGIC chỉ nhận entitlement |
| **F3** | Không lợi-tức-thụ-động | InstantGen điều-kiện-(b) tiêu-thật; §6.1 use-it-or-lose-it |
| **F4** | MAGIC closed-loop (không-chuyển + decay-reset + không-chuộc) | §0.1, §7.1 |
| **F5** | CARP fiat-neutral | boundary — MAGIC không neo fiat (P*=1 dịch-vụ) |
| **F6** | Không yếu-tố-bên-ngoài (cổng đọc số-dư-nội-bộ) | cổng Schedule/gen đọc GlobalState nội-bộ, KHÔNG giá LAMP spot |
| **F7** | Bộ-đệm vùng-xám | app-layer (ngoài MAGIC core) |
| **F8** | Công-dân-hạng-nhất = tiêu-MAGIC (INV-MAGIC-CITIZEN) | reward/VP keyed **MAGIC-TIÊU-THỰC** (burn-ID cross-DID), KHÔNG LAMP-nắm-giữ; burn-ID `consumer_did≠provider_did` |
| **F9** | Không đỡ-peg bằng LAMP + điều-phối-2-trục | MAGIC không có code-path bán LAMP đỡ-peg; 2-trục thuộc GreenBack |

---

## 13. Off-chain SDK (TypeScript) + test
- Mỗi module `offchain/` = npm package độc lập (ES modules, `@lucid-evolution/lucid`, `vitest`). Test ở `../tests/**`.
- `math.ts`/`types.ts`/`constants.ts` mirror `.ak` (P8 bit-identical). Deploy scripts dùng `tsx`.
- **Test vectors NORMATIVE** (App B) — InstantGen `InstantGen/MATH.md §9`: TV-GEN-FLAT-01, TV-GEN-RED-02, TV-GEN-DOUBLECAP-03, TV-GEN-SURPLUS-04, TV-GEN-TAIL-05 (R2 cắt-đuôi), TV-GEN-VALUE-RECON-06 (R1 chặn khai-khống), TV-OVERFLOW-07 (BigInt bắt buộc). ConsumeMAGIC/Paymaster/Consolidate: giữ suite hiện có, LOẠI test dính cơ-chế đã bỏ (UM/profile/shard/vacuum/halving/purchase).

---

## 14. Lỗi rounding (L4)
InstantGen: `M(L_i)` (≤1 nanogic × 7) → `M_raw` sum-then-floor (≤1) → `cap_surplus` (≤2). Tổng lỗi ≤ vài nanogic, luôn `≤ M_true` (bảo thủ, thuận protocol). (MATH.md §8)

---

## 15. Kế hoạch codec-cleanup (field/struct CHẾT)
Nothing deployed to testnet (README status) → cleanup **an toàn trước genesis**, làm một lần:
1. **VaultDatum:** cân nhắc bỏ idx 6 (`vacuum_orders`), 8/9/10 (`profile`/`profile_changed_epoch`/`pending_profile`) — nhưng đổi thứ-tự = phá codec 4 module đồng thời → chỉ làm khi **đồng bộ cả 4** (InstantGen/Schedule/Consolidate/Paymaster `types.ak` + `types.ts`) trong 1 PR, chạy full test 4 module. Nếu giữ: ép giá-trị-trơ cố định + assert trong validator.
2. **MagicBatch:** bỏ idx 5 (`decay_window`), 6 (`profile_at_creation`), 8 (`halved`) — cùng ràng buộc đồng-bộ như trên.
3. **VaultRedeemer:** giữ append-only; handler CHẾT (constr 1 `ApplyHalving`, 3 `UpdateProfile`) → `fail @"deprecated"`. KHÔNG tái-dùng constr-index. Field `lamp_paid` của InstantGen(0) redeemer: chốt shape mới (§16) rồi thay trong 1 PR.
4. **GenSchedule:** idx 6/7/8 (`rate_locked_q`/`baseline`/`multiplier`) CHẾT → cân nhắc bỏ khi đồng-bộ.
5. **Xoá hẳn khỏi build:** `ShardRedeemer`, `ScheduleAggregateShardDatum`, `UMDatum`, `ActivityProfile`-as-PM, mọi ref UMKeeper/VacuumGen.
> Nguyên tắc: **một PR đồng-bộ Aiken↔TS↔test cho cả cụm codec-chung**; grep TOÀN BỘ callers + tests trước khi đổi thứ-tự field (CLAUDE.md §Verify).

---

## 16. Mục [NEEDS-EVIDENCE] (chưa neo nguồn — KHÔNG bịa)
1. **[NEEDS-EVIDENCE] Shape redeemer InstantGen mô-hình-mới.** `types.ak:155` còn `InstantGen { lamp_paid: Natural }` (mô hình mua cũ). Mô hình mới không mua → cần field gì? (đề xuất: `InstantGen { did_ref: OutputReference, gs_ref: OutputReference }` để trỏ DID NFT + GlobalState) — `InstantGen/MATH.md` KHÔNG pin redeemer. Chốt trước khi build validator mới.
2. **[NEEDS-EVIDENCE] `R_gen_q`.** MATH.md:26 ghi rõ là **GIẢ ĐỊNH** benchmark `= Q`, chưa phải hằng chốt. Cần benchmark + chốt governance param.
3. **[NEEDS-EVIDENCE] Mapping FlowRate `lamp_per_magic_q` → `PriceParam.demand_mult`.** FlowRate xuất tỷ-giá LAMP/MAGIC; PriceParam.demand_mult là hệ-số co-giãn [m_min,m_max]. Quan hệ chuyển-đổi chưa neo trong nguồn nào.
4. **[NEEDS-EVIDENCE] `did_commit` schema + R3 per-DID enforcement on-chain.** Interface DID chưa chốt (Carpet-Tech §T9 blocker cứng, chờ PhoenixKey/Long). Cơ chế "1 gen/DID/epoch" đọc "đã-gen" per-DID qua beacon/ref-input — cấu-trúc beacon chưa đặc-tả. Build STUB (`did_hash` opaque, kiểm ≠-nhau), KHÔNG khoá genesis trước blocker.
5. **[NEEDS-EVIDENCE] GlobalState field-mapping chính xác cho `pp_sched` + cờ depeg CARP/MAGIC<P*.** Carpet-Tech §T2 `GlobalDatum` có `magic_burned_epoch`, `d_deviation_q`... nhưng KHÔNG có field tên `pp_sched` tường minh; InstantGen đọc "dòng MAGIC/epoch ScheduleGen" — cần chốt field GlobalState tương ứng (đã gửi CARP: `CARP/_Agents/inbox/magic-globalstate-brq-2026-07-16.md`, MATH.md:93).
6. **[NEEDS-EVIDENCE] Consolidate ↔ TWAB tương thích.** Consolidate gộp holding kề-epoch (`epoch_diff ≤ 1`), nhưng `loyalty_holdings` giờ là nguồn TWAB (R2) cần mốc-thời-gian chính xác. Cần xác nhận merge KHÔNG phá ngữ nghĩa cắt-đuôi/TWAB (có thể phải khoá Consolidate với holding trong cửa-sổ 7 epoch đang tính gen).
7. **[NEEDS-EVIDENCE] Aiken validators chưa compile CI.** README: tất cả TS test pass, Aiken viết-nhưng-chưa-build-CI, chưa deploy testnet. Mọi cite `.ak:line` là từ nguồn cũ (mô hình cũ) — validator mô-hình-mới (InstantGen no-purchase, Schedule no-shard) CHƯA có code; §6 là đặc-tả-để-build, không phải mô-tả-code-hiện-hữu.
