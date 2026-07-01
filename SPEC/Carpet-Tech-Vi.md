# Carpet (CARP) — ĐẶC TẢ KỸ THUẬT ON-CHAIN

> Trạng thái: **ĐỀ XUẤT** (draft **v0.1-tech**, đi kèm `Carpet-CARP-DacTa-Vi.md` v0.3). Cập nhật 2026-07-01.
> Nguồn chân lý kinh tế: `Carpet-CARP-DacTa-Vi.md` v0.3. File này **KHÔNG** định nghĩa lại chính sách — chỉ đặc-tả **cách cài on-chain** cho eUTXO/Cardano (PlutusV3 / Aiken).
> Tuyến-phụ CDP: đặc-tả-toán ở `CARP-Math-Vi.md`; file này chỉ nêu **interface** (datum/redeemer/blocker) đủ để build, không lặp toán.
> Quy ước ngôn ngữ: giữ tiếng Anh cho tên hàm/tham số/thuật-ngữ; phần diễn giải bằng tiếng Việt thuần. **KHÔNG đề cập MagicChange.**

**Bảng-ánh-xạ từ-vựng** (theo Đặc-tả §6b): `GreenBack=GreenPeg`, `RedBack=RedPeg`, `Backstop=Insurance Pool`, `br=H/backing-ratio`, `d=d_internal/CARP_premium`, `utility-floor=PrepaidGen 1:1 + PSM-par`.

---

## §T0. Nguyên tắc cài đặt (từ khung đã chốt → on-chain)

Năm neo thiết kế bắt buộc, ánh xạ thẳng ra ràng buộc validator:

| Neo (Đặc-tả) | Hệ quả on-chain |
|---|---|
| CARP utility-floored, **KHÔNG chuộc-ra-rổ** | Không validator nào đọc "giá rổ tài sản" để định giá chuộc. `PSM-par` chuộc `P_redeem ≡ 1` oracle-free. |
| **INV-PEG-ENDO** (P*=1 nội sinh) | Chuộc-par đọc `base_price` on-chain (beacon `PriceParam`), KHÔNG oracle USD/giá-tài-sản. |
| **INV-NO-EXTERNAL-INPUT** | Cổng solvency/ngưỡng chỉ căn **số-dư-nội-bộ** trong datum global; giá-thị-trường KHÔNG điều-khiển mint/burn. |
| **INV-VACUUM-ISOLATION (F1)** | Token-Vacuum ở **policy riêng**; validator-core **từ-chối** mọi input mang token-Vacuum vào `backing_core` (cưỡng-chế, không khai-báo). |
| **INV-NO-LAMP-PEG-DEFENSE** | Không code-path nào cho phép bán/chi LAMP để hút CARP đỡ-peg. LAMP chỉ ở tuyến-phụ CDP + Backstop. |
| **INV-MAGIC-CITIZEN** | Mọi reward/VP đọc **burn-ID** (MAGIC-tiêu-thực), không đọc số-dư-nắm-giữ. |

**Đơn vị fixed-point:** theo codebase hiện có — `q = 1_000_000_000` (10⁹). Mọi tỷ-lệ (`br`, `κ_eff`, `ρ`, `d`) lưu dạng `*_q` (nhân q). `1 CARP = q base-unit` (giống oildrop LAMP). Tỷ giá kinh tế (`1 CARP = 1 TB·ngày`, §2.1 Đặc-tả) là **định-nghĩa numéraire off-chain/beacon**, KHÔNG hard-code oracle USD on-chain.

**Mẫu chung mọi validator** (kế thừa idiom VacuumGen):
- Epoch = `get_current_epoch(tx, ms_per_epoch)` — BẮT BUỘC ràng **cả hai bound** `Finite` và `e_lo == e_hi` (chống validity-range gaming, MAINNET-BLOCK). Không đọc lower-only.
- Value-leak guard: mọi output tiếp-diễn phải `assets.quantity_of(output.value, policy, name) == datum.balance_field`.
- Anti-tamper: `count(inputs at addr)==1`, `count(outputs at addr)==1`, `output.reference_script == None`.
- Redeemer **append-only** (biến-thể mới ở CUỐI enum) — không đổi constr-index cũ.
- Datum field-order **NORMATIVE** (đổi thứ-tự = vỡ mã-hoá on-chain).

---

## §T1. KIẾN TRÚC VALIDATOR / POLICY (tổng thể)

Bốn cụm script, ranh giới rõ để build song song. Mỗi cụm là một `aiken.toml` riêng (giống layout `/MAGIC/*/onchain`).

```
┌─ CARP minting policy ─────────────────────────────┐   policy: carp_policy
│  mint/burn CARP; chỉ-cho-mint qua Core (PSM/CDP)  │
├─ Core cụm (SOLVENCY + PEG-core) ──────────────────┤
│  • GlobalState validator  (spend + ref beacon)    │   datum: GlobalDatum
│  • PSM validator          (chuộc-par oracle-free) │   datum: PsmDatum
│  • PrepaidGen validator   (khoá CARP → quỹ Paid)  │   datum: PaidVaultDatum (F2 escrow)
│  • GreenBack validator    (đệm κ_eff, backing)    │   datum: GreenBackDatum
├─ Vacuum cụm (CÁCH-LY-CỨNG F1) ────────────────────┤
│  • VacuumCommit policy    (token-Vacuum RIÊNG)    │   policy: vacuum_policy  ← KHÁC core
│  • VacuumVault validator  (commit-khoá + stagger) │   datum: VacuumDatum
├─ Đỡ-peg cụm (PEG, vệ-tinh tách biệt) ─────────────┤
│  • RedBack validator      (đọc P_CARP, F5)        │   datum: RedBackDatum
│  • Backstop validator     (bad_debt)              │   datum: BackstopDatum
│  • (Quỹ độc lập: Rice/Phoenix — mandate riêng)    │   (đọc ρ_LAMP / TWAP-dài, F5)
└───────────────────────────────────────────────────┘
Tuyến-phụ: CDP-LAMP validator (g_min≤33%, thanh-lý) — CARP-Math-Vi.md
```

**Ranh trục** (INV-2-AXIS): Core-cụm giữ **SOLVENCY** (`br`); Đỡ-peg-cụm giữ **PEG** (`d`). Hai cụm KHÔNG chia-sẻ một biến quyết-định. GlobalState là **nguồn-đọc chung** nhưng mỗi cụm đọc **field khác nhau** (§T7 lệch-biến).

### §T1.1 Beacon & singleton
- **GlobalState** là **singleton toàn-hệ**: 1 NFT `gs_nft` (policy one-shot từ genesis UTxO). Mọi validator khác đọc GlobalState qua **reference_input** + pin `Script(gs_script_hash)` (kế thừa mẫu UM `find_um_datum`: NFT-alone không đủ, PHẢI pin script-address).
- **PriceParam beacon** (`base_price`, `P*=1`): 1 UTxO gắn NFT `price_nft`, chỉ DAO-governance spend (đổi ≤10%/lần, ≥1 quý/lần — §2 Đặc-tả). Validator chuộc/mint đọc qua reference_input.

---

## §T2. GlobalDatum — sổ-cái trạng-thái toàn-hệ

Nguồn-thật cho `br`, `d`, throughput, và **hai-trục-điều-phối** (§4.7 Đặc-tả). Mọi số là **số-dư-nội-bộ** (INV-NO-EXTERNAL-INPUT) — KHÔNG có field nào là "giá thị trường push từ oracle".

```aiken
pub type GlobalDatum {
  // ── Cung & backing (trục SOLVENCY) ──
  carp_circulating      : Natural,        // C_circ (base-unit)
  carp_in_treasury      : Natural,        // F-TÀI-SẢN': KHÔNG đếm backing
  backing_core          : BackingCore,    // §T2.1 — CẤM token-Vacuum (F1)
  br_q                  : Natural,        // backing-ratio *q (tuyến-phụ CDP tổng hợp)
  bad_debt              : Natural,        // shortfall chờ Backstop

  // ── Tín-hiệu stress MỘT-NGUỒN (§6.1 Đặc-tả) ──
  sigma_hat_q           : Natural,        // σ̂ EWMA-có-trễ; feed CẢ NSF LẪN κ_eff
  kappa_eff_q           : Natural,        // κ_eff hiện hành ∈ [0.43q, 0.60q]

  // ── Trục PEG (đọc bởi đỡ-peg-cụm) ──
  p_carp_twap_q         : Natural,        // TWAP P_CARP *q (RedBack đọc — F5 lệch-biến)
  rho_lamp_twap_q       : Natural,        // ρ_LAMP TWAP *q (tuyến-phụ CDP + Rice đọc)
  d_deviation_q         : Natural,        // |P_CARP − P*|/P* *q (dẫn xuất, TWAP)

  // ── Throughput (biến sống-còn utility-floor, §6c Đặc-tả) ──
  magic_burned_epoch    : Natural,        // Σ MAGIC_burned_thật epoch hiện tại (burn-ID)
  epoch_of_counter      : Natural,        // epoch của counter trên (reset mỗi epoch)

  // ── Vacuum stagger ledger (F3) ──
  vacuum_committed      : Natural,        // Σ LAMP-commit-Vacuum hiện hành (≤20%C)
  vacuum_maturity       : List<(Natural, Natural)>,  // (fire_epoch, Σcommit) — chống cliff

  // ── Housekeeping ──
  last_updated_epoch    : Natural,
  gov_params            : GovParams,      // a,b (κ), d_soft/d_red/d_vacuum, br_safe... [DAO]
}
```

### §T2.1 BackingCore — cấu-trúc backing (F1 cưỡng-chế)
```aiken
pub type BackingCore {
  magic_unissued        : Natural,   // MAGIC/CARP-chưa-phát (GreenBack tầng-2)
  carp_reserve          : Natural,   // CARP đệm (KHÔNG tính carp_in_treasury)
  lamp_floor            : Natural,   // LAMP-đáy tuyến-phụ (lamp_frac ≤ 33%, INV-LAMP-CORE-CAP)
  // KHÔNG có field vacuum_* ở đây — token-Vacuum bị CẤM vào BackingCore (F1).
}
```

`GovParams` gom mọi tham-số [DAO] để đổi qua governance-spend (không hard-code), gồm: `a_q, b_q` (κ_eff), `br_safe_q=1.5q, br_healthy_q=1.8q`, `d_soft_q=0.02q, d_red_q=0.04q, d_vacuum_q=0.06q, d_emergency_q`, `overlap_lo_q=1.5q, overlap_hi_q=1.6q` (vùng chồng-lấn F4), `redback_nav_floor_bps=800` (8%NAV), `commit_vacuum_cap_bps=2000` (20%C), `f_max_q=0.10q, eta_q=0.5q` (InstantGen), `lamp_frac_cap_bps=3300` (33%).

**Bất biến GlobalDatum (mọi spend phải giữ):**
- `INV-GS-VACUUM-FREE`: value của UTxO GlobalState + mọi output BackingCore **KHÔNG chứa token thuộc `vacuum_policy`** (§T4).
- `INV-GS-TREASURY-NOBACK`: `carp_in_treasury` KHÔNG cộng vào `br_q` (F-TÀI-SẢN').
- `INV-GS-EPOCH-RESET`: khi `current_epoch > epoch_of_counter` → `magic_burned_epoch` reset về giá-trị-epoch-mới; nếu cùng epoch → chỉ được cộng dồn.

---

## §T3. INV-VACUUM-ISOLATION (F1) — cách-ly-cứng, CƯỠNG-CHẾ on-chain

**Vấn đề (Sev5):** LAMP-commit-Vacuum rò vào backing_core → khi Vacuum đáo-hạn rút đồng-loạt, backing tụt phi-tuyến (cliff). Đặc-tả yêu cầu leak≡0 **cưỡng-chế**, không chỉ khai-báo.

### §T3.1 Cơ chế: policy-riêng + token-marker
1. **Token-Vacuum ở policy RIÊNG** `vacuum_policy` (KHÁC `carp_policy`, KHÁC `lamp_policy`). Khi holder commit, VacuumCommit mint 1 **token-marker** `VAC` (amount = số LAMP commit, hoặc NFT-order + datum ghi lượng) đại-diện commit-khoá.
2. **Validator-core TỪ CHỐI token-Vacuum:** GlobalState-spend, GreenBack-spend, PSM-spend, PrepaidGen-spend đều chạy guard:

```aiken
// Guard cưỡng-chế F1 — chạy trong MỌI validator thuộc Core-cụm.
// Từ chối bất kỳ input/continuing-output nào mang token thuộc vacuum_policy.
fn assert_no_vacuum_token(tx: Transaction, vacuum_policy: PolicyId) -> Bool {
  let clean = fn(o: Output) -> Bool {
    // không có asset nào dưới vacuum_policy trong value này
    list.is_empty(assets.tokens(o.value, vacuum_policy) |> dict.to_pairs)
  }
  expect list.all(tx.inputs, fn(i) { clean(i.output) })
  expect list.all(tx.outputs, clean)
  True
}
```

3. **Hệ quả:** LAMP-Vacuum **vật-lý không thể** nằm cùng-tx với backing_core-core. Leak≡0 là **bất-khả-thi-về-cấu-trúc**, không phải "hứa". Token-Vacuum chỉ lưu-thông được ở VacuumVault + đỡ-peg-tạm + cổng `hard_cap-cứu` Schedule (validator riêng, KHÔNG chạm BackingCore).

### §T3.2 Cửa-rò còn lại (sim: L_max = 0.373%C) → cap
- Sim cho cửa-rò cực-mỏng khi core khởi-tạo sát trần `lamp_frac0 = 0.325`. Chặn bằng **`commit-Vacuum ≤ 20% C_circ`** (`commit_vacuum_cap_bps`), kiểm ở VacuumCommit (§T4).
- LAMP-Vacuum chỉ vào `hard_cap-cứu` (cổng Schedule) + đỡ-peg-tạm — **KHÔNG vào BackingCore** (đã cưỡng-chế §T3.1).

---

## §T4. VacuumVault + VacuumCommit policy (F1 + F3)

Tách hẳn khỏi Core (chạy được song song, ranh giới cứng qua `vacuum_policy`).

### §T4.1 VacuumDatum
Tái-dụng mẫu `VacuumOrder` của VacuumGen (đã build) + thêm stagger:
```aiken
pub type VacuumCommitOrder {
  order_id       : ByteArray,     // blake2b256(own_ref ∥ commit_epoch ∥ amount)
  committer      : ByteArray,     // owner VKH
  commit_epoch   : Natural,
  fire_epoch     : Natural,       // = commit_epoch + vacuum_delay (2)
  maturity_epoch : Natural,       // đáo-hạn commit-khoá (2 epoch kỳ-hạn)
  locked_amount  : Natural,       // LAMP hoặc CARP khoá
  asset_kind     : VacuumAsset,   // Lamp | Carp (CHỈ hai loại — §4.2 Đặc-tả)
  fee_credit_q   : Natural,       // ưu-đãi-phí non-transferable (keyed-MAGIC, KHÔNG lãi)
}
pub type VacuumAsset { Lamp  Carp }
```

### §T4.2 Redeemer + ràng buộc
```aiken
pub type VacuumRedeemer {
  VacCommit  { amount: Natural, kind: VacuumAsset }   // constr 0
  VacMature  { order_id: ByteArray }                  // constr 1 (đáo-hạn, hoàn asset + fee_credit)
  VacExpire  { order_id: ByteArray }                  // constr 2 (grace quá hạn, owner thu hồi)
}
```

**VacCommit:**
- `C-VAC-ISO`: mint đúng `amount` token `vacuum_policy` (marker) trong CÙNG tx; token-marker chỉ tới VacuumVault-addr (KHÔNG tới bất kỳ Core-addr).
- `C-VAC-CAP` (F1 cửa-rò): đọc GlobalState ref → `global.vacuum_committed + amount ≤ carp_circulating * commit_vacuum_cap_bps / 10000` (≤20%C).
- `C-VAC-STAGGER` (F3): cấm `>X%` commit **cùng maturity_epoch**. Ràng buộc:
  `Σ commit tại maturity_epoch (từ global.vacuum_maturity) + amount ≤ carp_circulating * stagger_cap_bps / 10000`.
  Đồng thời `|Δcap|/epoch ≤ cap_surplus` — cưỡng-chế bằng: mỗi VacCommit chỉ tăng `vacuum_committed` một-bước-≤-cap_surplus (đọc `gov_params.cap_surplus_bps`).
- `C-VAC-FEE-NOYIELD`: `fee_credit_q` là **quyền-tiêu-thêm non-transferable** (MAGIC Generation Rate, §1b Đặc-tả) — KHÔNG phải token trả-holder. Kiểm: không có output nào chuyển giá-trị-tài-sản cho committer ngoài hoàn-gốc + credit-tiêu.
- Value-leak guard trên asset khoá (LAMP/CARP) như VacuumGen.

**VacMature:** hoàn `locked_amount` cho committer + burn token-marker + cấp `fee_credit_q` (ghi vào MAGIC-rate, không mint tài sản). Chỉ hợp-lệ khi `current_epoch ≥ maturity_epoch`. Cập-nhật `global.vacuum_committed -= amount` và gỡ khỏi `vacuum_maturity`.

**VacExpire:** như VacuumGen `VacuumExpire` — owner thu-hồi sau grace, chống khoá-vĩnh-viễn do keeper miss.

> **Cách-ly kép:** dù VacuumVault xử-lý LAMP, guard `assert_no_vacuum_token` ở Core-cụm bảo-đảm token-marker KHÔNG lọt vào BackingCore. F3-stagger + F1-cách-ly chạy **cùng nhau** (Đặc-tả §4.2: "KÈM cách-ly-cứng F1").

---

## §T5. PrepaidGen — escrow-theo-delivery (F2)

Sàn-cứng peg (§3.1 Đặc-tả) + chống Prepaid-default (Sev4). Khoá X CARP → gen X MAGIC; CARP vào **quỹ Paid của platform**.

### §T5.1 PaidVaultDatum (quỹ Paid mỗi platform)
```aiken
pub type PaidVaultDatum {
  platform_id        : ByteArray,
  service_id         : ByteArray,        // MAGIC gắn 1 dịch-vụ cụ-thể (§5 Đặc-tả)
  carp_escrowed      : Natural,          // CARP đang khoá (chưa nhả cho provider)
  magic_gen_total    : Natural,          // Σ MAGIC đã gen từ quỹ này
  magic_burned_par   : Natural,          // Σ MAGIC_burned_par (burn-ID, đối-chiếu)
  provider_claimed   : Natural,          // Σ đã nhả cho provider (escrow-theo-delivery)
  buffer_min_bps     : Natural,          // ≥ 1500 (buffer-Paid ≥15%C, F2)
}
```

### §T5.2 Ràng buộc F2 (cưỡng-chế)
- **`vesting_v = 0`** — escrow-theo-delivery: provider chỉ nhả khi có **bằng-chứng dịch-vụ-đã-giao** (burn-ID tương ứng). On-chain: `PaidClaim` yêu cầu co-spend với ConsumeMAGIC-proof (burn-ID) trong CÙNG tx.
- **`claim_provider ≤ Σ MAGIC_burned_par`**: `output.provider_claimed ≤ magic_burned_par`. Provider KHÔNG đòi được nhiều hơn phần MAGIC đã-thực-đốt.
- **`buffer-Paid ≥ 15%`**: sau mỗi claim, `carp_escrowed − provider_claimed ≥ carp_escrowed_initial * buffer_min_bps / 10000`. Đây là **panic-thiết-kế** (đệm-thiết-kế, không phải lỗi).
- **`shortfall → Backstop, KHÔNG đụng LAMP`**: nếu quỹ Paid thiếu → route bad_debt sang Backstop-cụm; guard `assert_no_lamp_peg_defense` cấm mọi input LAMP-backing vào tx-đền-Paid.
- **PrepaidGen-mint tự-back:** vì CARP khoá tự-back MAGIC → KHÔNG rút GreenBack → **không giới-hạn số-lượng** (§5.1 Đặc-tả). Kiểm: `magic_gen_total == carp_escrowed_at_gen` (1:1).

### §T5.3 PSM-par (chuộc-par oracle-free)
- `PsmRedeem`: đổi CARP↔MAGIC/đóng-CDP tại `P_redeem ≡ 1`, đọc `base_price` từ PriceParam beacon (ref-input), KHÔNG oracle giá-tài-sản (INV-PEG-ENDO).
- Arbitrage tự-thưởng qua đóng CDP-phụ (§3.0). Lõi Carpet + GreenBack **KHÔNG tự trade DEX** — không có code-path trade ở Core-cụm.

---

## §T6. GreenBack — đệm κ_eff (SOLVENCY) + hàm-điều-phối-2-trục

### §T6.1 κ_eff (một-nguồn-tín-hiệu-stress)
```aiken
// κ_eff = clamp(0.6 − a·σ̂ − b·max(0, br_safe − br), 0.43, 0.6)   (§4.1 Đặc-tả)
// σ̂ = sigma_hat_q đọc TỪ GlobalState (EWMA-có-trễ) — MỘT nguồn, feed CẢ κ_eff LẪN NSF.
fn compute_kappa_eff_q(g: GlobalDatum, gp: GovParams) -> Int {
  let stress_solv = max(0, gp.br_safe_q - g.br_q)         // thiếu backing
  let raw = 600_000_000
    - gp.a_q * g.sigma_hat_q / q
    - gp.b_q * stress_solv / q
  clamp(raw, 430_000_000, 600_000_000)   // [0.43q, 0.60q]
}
```
- **Đệm-yêu-cầu = Σ nghĩa-vụ-Schedule / κ_eff.** GreenBack-spend kiểm `backing_core ≥ obligations / κ_eff`.
- Waterfall khi thiếu (§4.1): GreenBack-điều-chỉnh-tỷ-giá → bán-LAMP-thặng-dư → RedBack → tín-dụng-platform → Treasury. Mỗi bước là redeemer riêng, **KHÔNG** bước nào là "bán LAMP để hút CARP đỡ-peg" (đó là INV-NO-LAMP-PEG-DEFENSE — LAMP-thặng-dư ở đây phục-vụ solvency-nghĩa-vụ, KHÔNG phải peg).
- `INV-SCHEDULE-NEUTRAL-VS-RED`: GreenBack (bơm-cung + ôm-LAMP) và RedBack (trung-lập-cung + không-LAMP) ở **hai cụm validator tách biệt**, không chia-sẻ datum-quyết-định.

### §T6.2 HÀM-ĐIỀU-PHỐI-2-TRỤC (§4.7 Đặc-tả — gốc gỡ deadzone F4)
Đây là **hàm thiếu quan-trọng nhất**. Cài như một **pure function** đọc HAI trục độc-lập, trả **tầng-được-phép-kích**. Mọi validator đỡ-peg gọi hàm này để tự-kiểm "mình có được phép hành-động không".

```aiken
pub type Tier {
  T0_Arb          // Tuyến-0 arbitrage nội sinh
  T1_UtilityFloor // sàn-cứng (PrepaidGen + PSM)
  T3_RedBack      // hút-CARP-rẻ (CHỈ khi br lành)
  T4_Vacuum       // commit-khoá
  T5_Backstop     // bad_debt
  TE_Emergency    // chuỗi-khẩn-cấp DAO
}

// dispatch(d, br) — KHÔNG trộn hai trục vào một biến (INV-2-AXIS).
// d = độ-lệch-giá (PEG); br = backing-ratio (SOLVENCY).
fn dispatch(d_q: Int, br_q: Int, gp: GovParams) -> List<Tier> {
  let br_ok = br_q >= gp.br_safe_q
  if d_q >= gp.d_emergency_q {
    if br_ok { [TE_Emergency] } else { [T5_Backstop, TE_Emergency] }
  } else if d_q >= gp.d_vacuum_q {
    if br_ok { [T4_Vacuum, T3_RedBack] } else { [T4_Vacuum, T5_Backstop] }
  } else if d_q >= gp.d_red_q {
    // F4: RedBack CHỈ hút-CARP khi br lành; br-đỏ → utility-floor + chuẩn-bị Backstop
    if br_ok { [T3_RedBack, T1_UtilityFloor] } else { [T1_UtilityFloor, T5_Backstop] }
  } else if d_q >= gp.d_soft_q {
    if br_ok { [T0_Arb, T1_UtilityFloor] } else { [T1_UtilityFloor] }
  } else {
    [T0_Arb]
  }
}
```

- **RedBack-spend BẮT BUỘC** kiểm `list.has(dispatch(...), T3_RedBack)` trước khi hút-CARP. Khi `br < br_safe`, `T3_RedBack` KHÔNG có trong list → RedBack **không-thể** hút-CARP (hút khi br-đỏ = hại solvency → cấm cấu-trúc).
- **Vùng chồng-lấn `[1.5q, 1.6q]`** (F4): GreenBack↔RedBack overlap-có-chủ-đích — không có khe `br` nào cả-hai đều "chờ". Cài bằng: GreenBack-active khi `br ≤ overlap_hi_q`; RedBack-eligible khi `br ≥ overlap_lo_q` → dải `[1.5,1.6]` cả-hai cùng-sẵn-sàng.
- **Thang-ngưỡng-peg-có-thứ-tự** `d_soft(2%) < d_red(4%) < d_vacuum(6%) < d_emergency` cài thẳng là chuỗi `else-if` giảm-dần → thứ-tự cưỡng-chế bởi cấu-trúc điều-kiện.

---

## §T7. RedBack + Backstop + quỹ độc lập (PEG) — cài lệch-biến F5

### §T7.1 RedBackDatum
```aiken
pub type RedBackDatum {
  basket          : List<BasketAsset>,   // rổ đa-token ρ≤0.3, KHÔNG LAMP/BTC/ETH/fiat
  nav_q           : Natural,             // NAV rổ *q (dẫn-xuất, KHÔNG đẩy-oracle điều-khiển)
  carp_absorbed   : Natural,             // CARP đã hút (giảm C_circ tạm)
  signal_source   : SignalSource,        // F5: RedBack = PCarp
  threshold_q     : Natural,             // ngưỡng-kích riêng (F5 lệch-ngưỡng gap≥5%)
}
pub type BasketAsset { asset_policy: PolicyId, asset_name: ByteArray, qty: Natural, rho_q: Natural }
pub type SignalSource { PCarp  RhoLamp  TwapLong }   // F5 lệch-biến
```

### §T7.2 F5 — chống coordinated-ART (cưỡng-chế lệch-biến + lệch-ngưỡng)
- **LỆCH-BIẾN:** mỗi quỹ đọc **field KHÁC** trong GlobalState:
  - RedBack đọc `p_carp_twap_q` (`SignalSource=PCarp`).
  - Rice (quỹ độc-lập) đọc `rho_lamp_twap_q` (`RhoLamp`).
  - Phoenix đọc TWAP-dài (`TwapLong`).
  Guard: validator RedBack **fail nếu** hàm-kích của nó tham-chiếu bất-kỳ field-tín-hiệu nào ≠ `signal_source` khai-báo. → không đồng-pha thành issuer-mechanism-tập-trung.
- **LỆCH-NGƯỠNG:** `gap ≥ 5%` giữa `threshold_q` của từng quỹ. Cưỡng-chế: `GovParams` giữ 3 ngưỡng, invariant `|thr_i − thr_j| ≥ 0.05q` kiểm ở governance-spend khi đặt tham-số.
- **CẤM oracle-chung:** mỗi quỹ có beacon-tín-hiệu riêng (policy-NFT khác nhau); validator hard-code chỉ-đọc-beacon-của-mình. Không có một PriceFeed-NFT dùng-chung cho cả ba.
- **INV-FUNDS-INDEPENDENT:** không tồn-tại code-path nào để một tx đồng-thời spend hai-quỹ-đỡ-peg khác nhau (chống phối-hợp-điều-khiển). Kiểm: mỗi quỹ = own-addr riêng, redeemer riêng, không cross-spend.

### §T7.3 RedBack hút-CARP (sàn-cứng theo C_circ, F4)
- Điều-kiện: `d ≥ d_red` (TWAP) **VÀ** `br ≥ br_safe` **VÀ** `bad_debt == 0` **VÀ** `T3_RedBack ∈ dispatch(...)`.
- **Sàn-cứng ~8% NAV độc-lập-cap_res** (`redback_nav_floor_bps=800`): RedBack được bán tài-sản-rổ hút CARP tới ≥8%NAV — **theo C_circ, KHÔNG theo cap_res co-về-0**. Đây là điểm sửa F4 (biến-kích `d` TÁCH khỏi biến-năng-lực `C_circ`/`NAV`; KHÔNG dùng chung một biến).
- Quy-mô ~15%C; khi phình → trích CARP về Treasury (`carp_in_treasury`, KHÔNG đếm backing).
- **TUYỆT ĐỐI không rót tài-sản RedBack vào GreenBack** — không có redeemer cross-cụm.

### §T7.4 BackstopDatum (đổi tên Insurance)
```aiken
pub type BackstopDatum {
  reserve_q       : Natural,     // đệm bad_debt nội-bộ (LAMP + ít cứng)
  bad_debt_queue  : List<(ByteArray, Natural)>,   // (cdp_id, shortfall)
}
```
- Kích khi `br < br_safe` (backing-đỏ) hoặc bad_debt từ thanh-lý CDP/Prepaid-shortfall.
- = **đệm-nội-bộ-không-bán-bảo-hiểm** (F-LANG): KHÔNG phát-hành hợp-đồng-bảo-hiểm ra ngoài. Không mint token đại-diện-claim ra thị-trường.

---

## §T8. RCR reward-CARP + INV-MAGIC-CITIZEN (on-chain)

- **RCR = 3.0×** (`INV-5`, sửa "2.5×"→"3.0×" của bản cũ): mọi reward-CARP mint phải có `backing_core ≥ 3.0 × reward_carp` tại thời-điểm mint. Cưỡng-chế ở CARP-minting-policy nhánh reward: `expect backing_core_q * q >= 3_000_000_000 * reward_amount`.
- **INV-MAGIC-CITIZEN:** hàm `reward` và `VP` **PHẢI** đọc `magic_burned` (burn-ID cross-DID), CẤM đọc số-dư-nắm-giữ:
  - `mint_reward = f_lõm(phí-thực-đốt)` per-DID, **cap-per-DID**; trần `Σreward ≤ Σ MAGIC_burned` (đọc burn-ledger). Hàm-lõm → giảm-dần-biên (chống cá-lớn); cap-per-DID → chống Sybil-gom.
  - `VP = bão-hoà-ngưỡng`, KHÔNG-nhân-LAMP; `C1 = MAGIC tiêu cross-DID` (chống self-deal/tự-burn-vòng). Validator VP đọc burn-ID có `consumer_did ≠ provider_did`.
- Guard `assert_reward_keyed_magic`: tx-mint-reward BẮT BUỘC co-spend với burn-proof (burn-ID) trong cùng tx; không có burn-proof → fail. → không-thể reward theo holding.

---

## §T9. Blocker — did_commit (phụ-thuộc ngoài, PHẢI giải trước genesis)

**Blocker cứng:** nhiều bất-biến neo vào **DID** (PhoenixKey sinh-trắc), nhưng interface `did_commit` chưa chốt:
- **VP cross-DID** (§T8): cần đọc `consumer_did`/`provider_did` từ burn-ID để chặn self-deal. Chưa có schema `did_commit` on-chain → **VP validator không build-được-đúng** cho tới khi chốt.
- **cap-per-DID** (mint reward): cần một cách cưỡng-chế "một DID một hạn-mức" — hoặc DID-NFT-singleton, hoặc Merkle-commit did→cap ở GlobalState. Phải chốt cơ-chế trước khi khoá reward-policy.
- **Registry-MỞ** (§5b): did:tiger/did:elephant đăng-ký → cần format `did_commit` thống-nhất để mọi platform/app tham-chiếu cùng-một-DID.

**Yêu cầu interface (đề-xuất, chờ PhoenixKey chốt):**
```aiken
pub type DidCommit {
  did_hash     : ByteArray,     // blake2b256 commit của DID sinh-trắc (KHÔNG lộ PII)
  did_nft      : Option<ByteArray>,  // policy DID-NFT nếu dùng NFT-singleton
}
```
Cho tới khi PhoenixKey chốt `did_commit`: **VP + cap-per-DID để STUB** (nhận `did_hash` opaque, kiểm ≠-nhau nhưng chưa liên-kết sinh-trắc-thật). KHÔNG khoá genesis reward/VP trước blocker này. (PhoenixKey backend thuộc ranh-giới KHÔNG-sửa → tạo Issue giao Long, không tự cài schema DID.)

---

## §T10. Ma trận bất-biến → điểm cưỡng-chế on-chain

| Bất biến (Đặc-tả §7) | Cưỡng-chế ở |
|---|---|
| `INV-VACUUM-ISOLATION` (F1) | `assert_no_vacuum_token` trong MỌI Core-validator (§T3.1) + `vacuum_policy` riêng |
| `INV-LAMP-CORE-CAP` (g_min-tuyến-phụ) | CDP-validator: `lamp_frac ≤ 33%` (CARP-Math); `BackingCore.lamp_floor` cap |
| `INV-NO-LAMP-PEG-DEFENSE` | Không code-path bán-LAMP-hút-CARP; `assert_no_lamp_peg_defense` ở đỡ-peg-cụm |
| `INV-PEG-ENDO` | PSM đọc `base_price` beacon, KHÔNG oracle USD/tài-sản (§T5.3) |
| `INV-NO-EXTERNAL-INPUT` | Cổng/ngưỡng đọc GlobalDatum-nội-bộ; không field oracle-push điều-khiển |
| `INV-2-AXIS` | `dispatch(d, br)` hai-trục tách-biệt (§T6.2); F4 overlap `[1.5,1.6]` |
| `INV-FUNDS-INDEPENDENT` (F5) | lệch-biến `SignalSource` + lệch-ngưỡng gap≥5% + beacon-riêng (§T7.2) |
| `INV-MAGIC-CITIZEN` | reward/VP co-spend burn-proof (burn-ID); cấm keyed-holding (§T8) |
| `INV-NO-PASSIVE-YIELD` | không redeemer nào chi-holder-theo-số-dư; `fee_credit` non-transferable |
| `F-TÀI-SẢN'` | `carp_in_treasury` KHÔNG cộng `br_q` (`INV-GS-TREASURY-NOBACK`) |
| F2 (Prepaid-default) | `vesting_v=0` + `claim ≤ Σburned_par` + buffer≥15% + shortfall→Backstop (§T5.2) |
| F3 (Vacuum-cliff) | stagger `vacuum_maturity` cap-per-epoch + `|Δcap|≤cap_surplus` (§T4.2) |
| `RCR=3.0×` (INV-5) | reward-mint policy: `backing_core ≥ 3.0 × reward` (§T8) |

---

## §T11. Thứ-tự build (song song, ranh giới cứng)

1. **Core-cụm** (spec → onchain → test): GlobalState + PriceParam beacon → PSM → PrepaidGen(F2) → GreenBack(κ_eff + dispatch). Interface-contract: `GlobalDatum` field-order + `assert_no_vacuum_token`.
2. **Vacuum-cụm** (song song): `vacuum_policy` + VacuumVault(F1 marker + F3 stagger). Chỉ phụ-thuộc GlobalDatum ref-read.
3. **Đỡ-peg-cụm** (song song sau khi `dispatch` chốt): RedBack(F5 lệch-biến) + Backstop + quỹ độc-lập.
4. **Reward/VP**: CHỜ blocker `did_commit` (§T9) — build STUB trước, khoá sau.
5. **Tuyến-phụ CDP**: theo `CARP-Math-Vi.md` (validator riêng, g_min-chỉ-đây).

**Interface-contract giữ bởi orchestrator** (không để agent đổi): `GlobalDatum`/`BackingCore` schema; `q=10⁹` fixed-point; `dispatch(d,br)` signature; `assert_no_vacuum_token`; burn-ID format cho throughput + reward.

**Test-gate mỗi cụm:** `aiken check` FULL pass + test cưỡng-chế F1 (input-mang-token-Vacuum → reject), F2 (over-claim → reject), F3 (over-commit-cùng-epoch → reject), dispatch (br-đỏ + d≥d_red → KHÔNG có T3_RedBack), value-leak (mọi output).

---

## §T12. Điểm mở kỹ-thuật (đồng-bộ §9 Đặc-tả)

1. `did_commit` schema (§T9) — **blocker cứng**, chờ PhoenixKey/Long.
2. Datum-size GlobalState: nếu `vacuum_maturity`/`bad_debt_queue` phình → tách sang beacon phụ (giữ <16KB tx-limit, như VaultDatum ~12KB).
3. Benchmark throughput on-chain: `magic_burned_epoch` counter + reset-mỗi-epoch (INV-GS-EPOCH-RESET) — đo thực-địa trước genesis (§6c Đặc-tả).
4. Cơ-chế TWAP nội-sinh cho `p_carp_twap_q`/`rho_lamp_twap_q`: nguồn cập-nhật (keeper-permissionless? governance?) phải giữ INV-NO-EXTERNAL-INPUT (không để oracle-ngoài điều-khiển mint/burn — chỉ dùng cho ngưỡng-kích đỡ-peg, không cho định-giá-chuộc-par).
5. Governance-spend cho `GovParams` + PriceParam: ràng ≤10%/lần, ≥1 quý/lần; multi-sig/DAO-vote gate.

---

> **Ghi chú nhất quán:** khi mâu-thuẫn về chính-sách/kinh-tế → theo `Carpet-CARP-DacTa-Vi.md` v0.3. File này chỉ đặc-tả **cách cài**. Mọi tên hàm/tham-số ở đây là **đề-xuất on-chain**, chốt cuối khi build từng cụm. KHÔNG commit/push khi chưa duyệt.
