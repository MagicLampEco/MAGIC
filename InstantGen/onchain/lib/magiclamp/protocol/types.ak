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
// Nhãn cũ là nhãn của một trường CHẾT thời trước DESIGN-2 (`DESIGN-PHASE2.md §4.1`: chưa
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
  // 🪦 BIA MỘ trường 15 — quyền chết 2026-09-16 (Nợ #14), trường ở lại. Lý do
  // KHÔNG phải "gỡ ra thì vỡ decode mọi UTxO đã tạo": hash đã đổi nên UTxO đời
  // trước nằm ở địa chỉ khác, ngoài tầm với của validator này dù có gỡ hay không.
  // Lý do thật: gỡ trường 15 đẩy mọi trường sau nó lên một chỉ số, và có bên đọc
  // theo VỊ TRÍ — `Paymaster` ▸ `vault_delegate_is` gọi thẳng `list.at(fields, 15)`.
  // Bên đó lấy nhầm trường và KHÔNG kêu; các bên đọc qua lược đồ thì hỏng ồn ào.
  personal_delegate     : Option<ByteArray>,
  attribution           : VaultAttribution,
  // ── Trường 17: khoá LAMP sau một lượt sinh (`CC-GEN-L-TIMING`) ───────────────
  //
  // Mốc THỜI GIAN (POSIX mili-giây, cùng đơn vị với `tx.validity_range`) mà từ đó
  // LAMP được rời khỏi két trở lại. `0` = chưa từng sinh, không khoá gì.
  //
  // VÌ SAO KHOÁ NÀY CẦN. Cận an toàn của mô hình sinh (`Specs §6.1.5`) là
  // `Σ sinh ≤ Σ LAMP-trên-chuỗi × trần ρ`, và cận đó chỉ đúng nếu **một đồng LAMP
  // không nuôi hai lượt sinh trong cùng một cửa sổ**. Bộ đếm suy ra ở
  // `decay.ak ▸ instant_gen_in_epoch` giữ cận đó TRONG MỘT KÉT; trường này giữ nó
  // khi LAMP nhảy két. Lập luận đứng sau nó là BẢO TOÀN, không phải kinh tế — một
  // lập luận kinh tế ("thuê LAMP đắt") bác được bằng số đo của chính kho này, vì
  // từ 84 LAMP trở lên `cap_surplus` cắn trước `cap_pp` nên thuê thêm LAMP không
  // nâng được một nanogic nào.
  //
  // VÌ SAO ĐO BẰNG THỜI GIAN CHỨ KHÔNG BẰNG CHỈ SỐ EPOCH. Khoá neo theo chỉ số
  // epoch để người gọi tự chọn thời lượng qua thời điểm sinh: sinh phút cuối epoch
  // thì giữ gần 0, sinh đầu epoch thì giữ trọn một epoch. Kẻ tấn công cần MAGIC cho
  // một lượt đốt tức thì nên luôn chọn phút cuối; người dùng thật phải tiêu rải nên
  // chọn đầu epoch. Tức cơ chế thu của người ngay nhiều hơn kẻ gian, và chính kẻ
  // gian chọn mức thu của mình. Neo theo thời gian trôi thu đúng một epoch của mọi
  // người, và bỏ luôn động cơ dồn giao dịch vào cuối epoch (thứ gây tranh chấp
  // beacon).
  //
  // 🔴 NEO VÀO CẬN TRÊN CỦA `validity_range`, KHÔNG vào cận dưới. Người gọi muốn
  // khoá ngắn: cận dưới họ đẩy lùi được về đầu epoch (`get_current_epoch` chỉ đòi
  // nó cùng epoch), nên neo vào đó là để họ tự bấm nút rút ngắn. Cận trên thì họ
  // chỉ đẩy được về phía SAU — đẩy lùi quá slot thật là giao dịch không vào khối
  // — nên mức ngắn nhất họ đạt được đúng bằng "một epoch kể từ bây giờ". Cùng một
  // dòng mã, một cận gác được và một cận thì không.
  //
  // 🔴 PHẠM VI — ĐỌC TRƯỚC KHI DỰA VÀO TRƯỜNG NÀY. Nó được đọc làm CỔNG ở đúng
  // MỘT nhánh: `validate_withdraw_lamp` (`get_validity_lower_ms(tx) >=
  // instant_unlock_ms`). Nhánh SINH ghi nó, và KHÔNG đọc nó làm cổng — không
  // mệnh đề nào trong `validate_instant_gen` so mốc này với thời điểm hiện tại.
  // Bốn nhánh SPEND còn lại chỉ GHIM nó đứng yên. Ngoài sáu nhánh spend còn một
  // loại THỨ BA, đừng bỏ khi đếm: nhánh MINT `MintVaultId` ghim nó VỀ 0
  // (`validate_mint_vault_id`) — chỗ duy nhất ép được giá trị KHỞI ĐẦU, vì
  // Cardano không chạy validator lúc tạo UTxO. Sót một chỗ ghim-đứng-yên là một
  // đường rửa khoá; sót chỗ ghim-về-0 là một két sinh ra đã mang mốc bịa.
  //
  // Ép được:     một đồng LAMP không nuôi hai lượt sinh ở hai két INSTANTGEN
  //              trong cùng một cửa sổ khoá — vì nó không rời được két thứ nhất.
  //              Chữ "InstantGen" là phần gánh nghĩa của câu; xem gạch kế.
  // KHÔNG ép:    biên giữa các MODULE. Trường này chỉ tồn tại ở đây —
  //              `grep -rn "instant_unlock_ms" ScheduleGen --include="*.ak"` trả
  //              0 dòng — và `validate_withdraw_lamp` bên đó chỉ gác `amount > 0`,
  //              chữ ký chủ, `amount <= avail`; không mệnh đề thời gian nào.
  //              `ScheduleFire` lại nhả `lamp_locked` NGAY trong epoch nó trả
  //              MAGIC, và không đòi chữ ký. Nên cùng số LAMP đó đứng sau một
  //              lượt fire ScheduleGen VÀ một trần InstantGen trong cùng một chỉ
  //              số epoch, theo thứ tự tuần tự. Hướng ngược lại thì bị chặn.
  //              Bịt chỗ này là đổi mô hình sinh ScheduleGen, không phải sửa ở
  //              đây; ràng buộc tạm fail-closed CHỈ CHẠY TESTNET bao ca này.
  // KHÔNG ép:    MỘT két sinh ở giây cuối epoch `e` rồi sinh lại ở giây đầu
  //              `e+1` lấy HAI trần cách nhau vài giây, trên cùng số LAMP, không
  //              cần chuyển đi đâu. Trần trong epoch do bộ đếm suy ra ở
  //              `decay.ak ▸ instant_gen_in_epoch` giữ, mà bộ đếm ấy khoá theo
  //              CHỈ SỐ epoch nên nó về 0 ở ranh giới; trường này thì chỉ canh
  //              đường RA.
  //
  // Mức phát biểu đúng của cặp cơ chế, đừng viết rộng hơn: **≤1 trần mỗi CHỈ SỐ
  // epoch cho mỗi két, cộng ≤1 lượt chuyển két mỗi CỬA SỔ KHOÁ**. Viết thành
  // "≤1 trần mỗi epoch trên mỗi đồng LAMP" là khai một bảo đảm không có.
  //
  // Chủ dự án chốt 2026-09-21: GIỮ cơ chế, sửa lời khai cho đúng phạm vi. Cửa sổ
  // này tốn 2× trần ở ĐỈNH (dồn suất hai chỉ số epoch vào vài giây; nhịp dài
  // hạn không đổi, vẫn 1 trần mỗi epoch mỗi lô LAMP); lỗ `apply_burns` vá cùng
  // ngày thì nâng chính NHỊP, tới 120×. Khác đơn vị. Bịt nó là đổi mô
  // hình (trần theo cửa sổ TRÔI thay vì theo chỉ số epoch), và mô hình đó đòi
  // một ô datum ghi được để nhớ mốc — đánh đổi đúng thứ đắt nhất lấy thứ rẻ
  // nhất. Ràng buộc TẠM đang có hiệu lực, fail-closed: CHỈ CHẠY TESTNET.
  //
  // ĐẶT Ở CUỐI vì có bên đọc theo VỊ TRÍ — xem bia mộ trường 15 ngay trên. Thêm ở
  // cuối giữ nguyên chỉ số 0..16, nên `Paymaster` ▸ `vault_delegate_is`
  // (`list.at(fields, 15)`) và `ConsumeMAGIC` ▸ `consume.ak` (đọc trường 0) không
  // phải đụng gì.
  //
  // KHÔNG có ở `ScheduleGen`: két bên đó không có nhánh sinh Instant, nên trường
  // này ở đó sẽ là một ô KHÔNG CÓ NGƯỜI GHI — phải trả bằng một cổng đông-cứng ở
  // mỗi nhánh spend, hai trong số đó không cần chữ ký. Hai lược đồ khác nhau là
  // cái giá rẻ hơn, và nó hỏng ỒN ÀO (decode sai số trường) thay vì im.
  instant_unlock_ms     : Natural,
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

  // constr 5  SetDelegate: 🪦 nay CHỈ XOÁ ĐƯỢC (`new_delegate == None`).
  // Owner-only, no cooldown. Reuses the existing personal_delegate field (15).
  // Bản cũ của dòng này viết "Some(d) lets d trigger BurnBatch on owner's behalf
  // (app paymaster)" — đường đó CHẾT 2026-09-16 (Nợ #14). Variant ở lại nguyên
  // chỗ làm bia mộ nhị phân; xem `validate_set_delegate`.
  SetDelegate   { new_delegate: Option<ByteArray> }
}
