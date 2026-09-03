// lib/types.ak — lược đồ Plutus Data. Chỉ số constructor + thứ tự trường là hợp
// đồng nhị phân: đổi là vỡ decode mọi UTxO đã tạo.
// Normative: §4.1 MagicBatch, §5 VaultDatum
// All field names and ordering must match on-chain encoding exactly.

// ── Primitive alias ──────────────────────────────────────────
pub type Natural = Int

// ── Batch source (constructor index = Plutus Data tag) ──────
// Snapshot=0, Instant=1, Vacuum=2, Schedule=3
pub type BatchSource {
  Snapshot   // constr 0
  Instant    // constr 1
  Vacuum     // constr 2
  Schedule   // constr 3
}

// ── Activity profile (constructor index) ────────────────────
// Ember=0, Flame=1, Lantern=2
pub type ActivityProfile {
  Ember    // constr 0
  Flame    // constr 1
  Lantern  // constr 2
}

// ── §4.1 MagicBatch ─────────────────────────────────────────
// decay_window = 1 for EVERY source (§4.2 per-epoch use-or-lose cliff).
// NORMATIVE: field order must not change (breaks on-chain encoding).
pub type MagicBatch {
  batch_id            : ByteArray,                   // blake2b256(utxo_ref ∥ index)
  source              : BatchSource,
  created_epoch       : Natural,                     // the ONLY epoch this batch is live
  initial_amount      : Natural,                     // immutable audit trail
  current_amount      : Natural,                     // mutable (BurnBatch only)
  decay_window        : Natural,                     // = 1 (§4.2)
  profile_at_creation : Option<ActivityProfile>,     // Some(P) Snapshot; None others (C-DECAY-4)
  contract_id         : Option<ByteArray>,           // Some for Schedule; None others
  halved              : Bool,                        // DEAD FIELD dưới mô hình cliff. Giữ để
                                                     // hình dạng Plutus Data (9 trường) còn
                                                     // byte-compatible với datum đã deploy và
                                                     // các module anh em.
                                                     // ĐÍNH CHÍNH (2026-08-12): bản cũ ghi
                                                     // "Any True value is rejected" — SAI.
                                                     // Không có `expect` nào từ chối
                                                     // `halved == True` trong vault.ak; nó chỉ
                                                     // được ĐẶT False lúc tạo batch
                                                     // (vault.ak:436) và so sánh cấu trúc ở
                                                     // các nhánh spend. Nghĩa là: validator
                                                     // này không bao giờ SINH ra True, nhưng
                                                     // cũng không CHẶN True do bên khác ghi.
                                                     // Đừng dựa vào nó như một bất biến.
}

// ── LoyaltyHolding ──────────────────────────────────────────
pub type LoyaltyHolding {
  amount         : Natural,
  acquired_epoch : Natural,   // immutable after creation (T21, C-HOLDING-2)
  is_locked      : Bool,
}

// ── VacuumOrder ─────────────────────────────────────────────
pub type VacuumOrder {
  order_id     : ByteArray,
  commit_epoch : Natural,
  fire_epoch   : Natural,     // = commit_epoch + 2
  lamp_amount  : Natural,
}

// ── AutoBurnConfig ──────────────────────────────────────────
pub type AutoBurnConfig {
  delegate          : ByteArray,          // VerificationKeyHash
  target_app_id     : Option<ByteArray>,
  max_burn_per_fire : Natural,
}

// ── GenSchedule ─────────────────────────────────────────────
pub type GenSchedule {
  schedule_id              : ByteArray,
  commit_epoch             : Natural,
  start_fire_epoch         : Natural,    // = commit_epoch + 2
  end_fire_epoch           : Natural,    // = commit_epoch + L + 1
  schedule_length          : Natural,    // L
  lamp_per_epoch           : Natural,    // λ
  rate_locked_q            : Natural,    // immutable (T8)
  baseline_at_commit_q     : Natural,    // R_snap_c (audit)
  multiplier_at_commit_q   : Natural,    // S_Q(L) (audit)
  fired_count              : Natural,
  auto_burn_target         : Option<AutoBurnConfig>,
}

// ── AppAllocation ───────────────────────────────────────────
pub type AppAllocation {
  app_id     : ByteArray,
  weight_bps : Natural,       // C-DC-2: ≥ 100; C-DC-3: Σ ≤ 10000
}

// ── PendingAllocations ──────────────────────────────────────
pub type PendingAllocations {
  allocations      : List<AppAllocation>,
  effective_epoch  : Natural,
}

// ── DelegationCertificate ───────────────────────────────────
pub type DelegationCertificate {
  current                  : List<AppAllocation>,    // C-DC-1: |current| ≤ 5
  pending                  : Option<PendingAllocations>,
  current_effective_epoch  : Natural,
  last_changed_epoch       : Natural,
}

// ── PendingProfile ──────────────────────────────────────────
pub type PendingProfile {
  new_profile      : ActivityProfile,
  effective_epoch  : Natural,
}

// ── VaultAttribution ────────────────────────────────────────
pub type VaultAttribution {
  attribution_root  : ByteArray,    // blake2b256 hash chain (§7.2)
  last_event_epoch  : Natural,
  total_events      : Natural,      // C-ATT-2: strictly increasing
}

// ── ActivityState ───────────────────────────────────────────
// `consumed_credit` — TỔNG LƯỢNG nanogic đã tiêu, KHÔNG phải số lượt.
//
// SEMANTICS (§6.3 keyed-consumed): running total of MAGIC (nanogic) the owner
// has ACTUALLY CONSUMED via BurnBatch and has NOT yet converted into an
// InstantGen reward. BurnBatch adds Σburns; InstantGen zeroes it when it pays
// the reward out. This is the on-chain `consumed` base for `reward(consumed)`.
//
// ── Nợ #39 ĐÃ ĐÓNG 2026-08-28 ────────────────────────────────────────────────
// Trường này từng mang hai nhãn trong cùng một kho: `total_burns_count` (nghe như ĐẾM)
// và `consumed_credit` (LƯỢNG). Cùng ô byte, cùng kiểu ⇒ decode không bao giờ báo lỗi,
// nên va chạm nhãn chỉ lộ ra bằng số tiền sai — và ở ĐÚNG ô này thì "số tiền sai" là
// NGÂN SÁCH THƯỞNG: `reward(consumed)` ngay dưới đây đọc nó.
//
// Nghĩa KHÔNG mơ hồ. Ba trọng tài, bản ghi cũ viết "spec im lặng nên không có trọng
// tài" là suy diễn SAI từ tiền đề đúng:
//   1) validator: nhánh BurnBatch cộng `sum_burns(burns)` = Σ LƯỢNG, không phải
//      `list.length(burns)`;
//   2) INV-CASHBACK-BOUND ở `math.ak:73-75` — `reward ≤ consumed` chỉ có nghĩa khi hai
//      vế cùng thứ nguyên nanogic;
//   3) SPEC §7.3 đã xử đúng câu hỏi này cho trường anh em phía engage.
// Cộng INV-MAGIC-CITIZEN (`BOUNDARIES.md §2`): thưởng gắn MAGIC ĐÃ TIÊU — một LƯỢNG.
//
// Nhãn cũ là nhãn của một trường CHẾT thời tiền-PHA-2 (`DESIGN-PHASE2.md §4.1`: chưa
// handler nào từng ghi vào nó). Đổi tên KHÔNG đụng chuỗi, nhưng ĐÃ vỡ API MagicSDK —
// breaking, cố ý.
// 🔴 KHÔNG "thêm một trường cho nghĩa kia" — thêm trường là hỏng decode mọi UTxO đang
// sống (Nợ #37).
pub type ActivityState {
  recent_burn_epochs : List<(ByteArray, Natural)>,   // (app_id, epoch)
  consumed_credit    : Natural,                      // nanogic consumed, not yet rewarded
}

// ── StreakState ──────────────────────────────────────────────
pub type StreakState {
  current_streak    : Natural,
  last_active_epoch : Natural,
}

// ── §5.1 VaultDatum (full) ───────────────────────────────────
// worst-case ~12KB; tx limit 16KB (§5.1 Datum size note)
pub type VaultDatum {
  owner                 : ByteArray,               // VerificationKeyHash
  lamp_balance          : Natural,
  lamp_locked           : Natural,
  loyalty_holdings      : List<LoyaltyHolding>,
  magic_batches         : List<MagicBatch>,
  next_batch_index      : Natural,
  vacuum_orders         : List<VacuumOrder>,
  gen_schedules         : List<GenSchedule>,
  profile               : ActivityProfile,
  profile_changed_epoch : Natural,
  pending_profile       : Option<PendingProfile>,
  last_updated_epoch    : Natural,
  delegation_cert       : DelegationCertificate,
  activity_state        : ActivityState,
  streak_state          : StreakState,
  personal_delegate     : Option<ByteArray>,
  attribution           : VaultAttribution,
}

// ── UM Datum ─────────────────────────────────────────────────
pub type UMDatum {
  smoothed_q         : Natural,      // clamp([UM_MIN_Q, UM_MAX_Q])
  last_updated_epoch : Natural,
  history            : List<Natural>,
}

// ── BackingBeacon datum (§6.3 cổng thặng dư) ─────────────────
//
// [CẦN XÁC NHẬN — schema do MAGIC đề xuất, chờ CARP xác nhận]
//
// `cap_surplus(br)` needs `br = B/S`, which is CARP-side information the MAGIC
// vault cannot derive from its own state. It is delivered by a beacon UTxO used
// as a REFERENCE INPUT (CIP-31), pinned by a one-shot NFT + its script address
// (same two-layer anti-forgery pattern as UMDatum).
//
// Fail-closed contract: if the beacon is missing, at the wrong address, without
// its NFT, stale, or flagged depeg → the InstantGen tx does NOT validate, i.e.
// cap = 0 and the Gen door is SHUT. There is no default `br`.
//
// NOTE the deployed CARP `GlobalState` (twap/spot/breaker/nsf/valid_until) is a
// CDP-pricing datum and does NOT carry `br_q`; it cannot be used here as-is.
pub type BackingBeaconDatum {
  br_q              : Natural,   // ⌊B/S × Q⌋ — authoritative backing ratio
  magic_supply      : Natural,   // S — effective MAGIC supply (nanogic)
  depeg             : Bool,      // True = CARP/MAGIC below peg → cap = 0 (phanh)
  last_updated_epoch: Natural,   // staleness guard (max_backing_stale)
}

// ── Vault redeemer ───────────────────────────────────────────
// NORMATIVE: append-only enum. New variants at END only.
pub type VaultRedeemer {
  // constr 0  InstantGen: convert accumulated `consumed_credit` into a MAGIC
  //           batch for the CURRENT epoch. NO LAMP moves (I-ACT-7).
  //           `claimed_amount` is the caller's assertion of the grant; the
  //           validator recomputes it and requires exact equality, so the
  //           granted amount is visible in the redeemer for auditing.
  InstantGen    { claimed_amount: Natural }

  // constr 1  PruneExpired (§7.4): permissionless garbage collection of DEAD
  //           batches (created_epoch < current_epoch). Only removes bytes that
  //           already carry zero live value; changes NO live amount.
  //           (Occupies the slot of the retired `ApplyHalving` — halving no
  //           longer exists under the §4.2 cliff. Nullary, so the Plutus Data
  //           encoding of constr 1 is unchanged.)
  PruneExpired

  // constr 2  BurnBatch: burn MAGIC from specified batches
  BurnBatch     { burns: List<(ByteArray, Natural)> }

  // constr 3  UpdateProfile: change activity profile (§12)
  UpdateProfile { new_profile: ActivityProfile }

  // constr 4  WithdrawLamp: withdraw unlocked LAMP back to wallet (SPEC_V1 §1)
  WithdrawLamp  { amount: Natural }

  // constr 5  SetDelegate: set/clear the consume-delegate (personal_delegate).
  // Owner-only, no cooldown. Reuses the existing personal_delegate field (15);
  // does NOT add a datum field. Some(d) lets d trigger BurnBatch on owner's
  // behalf (app paymaster) WITHOUT moving MAGIC; None restricts to owner.
  SetDelegate   { new_delegate: Option<ByteArray> }
}
