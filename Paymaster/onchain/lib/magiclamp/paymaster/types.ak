// Paymaster onchain types — interface contract (SPEC-Paymaster §6).
// Constr index = THỨ TỰ KHAI BÁO field → Plutus Data encoding. Phải khớp
// byte-perfect với offchain codec (P8). Field MỚI ở CUỐI (append-only).
//
// ── MÔ HÌNH (accounting, neo commit 6c617daf) ────────────────────────────────
// MAGIC KHÔNG là token, KHÔNG MintingPolicy, KHÔNG tx.mint. Tiêu MAGIC = handler
// BurnBatch của VAULT validator giảm current_amount. Paymaster KHÔNG mint MAGIC.
// Paymaster ĐỌC magic_consumed = Σ BurnBatch.burns từ redeemer của vault input
// co-spend (giống consume.ak read_vault_burns), KHÔNG đọc tx.mint.
// App = personal_delegate của vault user (đồng ký BurnBatch). Phí = kế toán datum.

use cardano/transaction.{OutputReference}

/// SponsorPolicy — beacon (reference input), mang SponsorPolicy NFT one-shot.
/// DAO approval đặt tham số. App tx-builder đọc qua reference input.
///   app_authority         : VerificationKeyHash bắt buộc cosign (= personal_delegate)
///   max_per_did_per_epoch : oil — cap mỗi DID (MVP: owner-key) mỗi epoch
///   max_global_per_epoch  : oil — cap toàn app mỗi epoch
///   lamp_per_magic_q      : Q-format (lamp_oil / nanogic). 1.0 = Q = 1 LAMP/MAGIC
///   ada_per_magic_q       : Q-format (lovelace / nanogic)
///   oracle_nft_policy     : None = MVP tự định; Some = CIP-31 oracle (v1.x)
///   epoch                 : epoch cập nhật (đơn điệu tăng)
pub type SponsorPolicy {
  app_id                : ByteArray,
  app_authority         : ByteArray,
  max_per_did_per_epoch : Int,
  max_global_per_epoch  : Int,
  lamp_per_magic_q      : Int,
  ada_per_magic_q       : Int,
  oracle_nft_policy     : Option<ByteArray>,
  epoch                 : Int,
}

/// SponsorMeter — thread UTxO (1 per app per epoch), mang SponsorMeter NFT.
/// Datum ghi quota đã dùng. Thread NFT chống double-meter (1 UTxO duy nhất).
///   did_lamp_map      : (did_key, lamp_sponsored_oil) per DID/owner-key. HARD-CAP
///                       list.length ≤ max_did_entries (fail-closed, DoS guard).
///   global_lamp_epoch : tổng oil đã sponsor trong epoch
pub type SponsorMeter {
  app_id            : ByteArray,
  epoch             : Int,
  did_lamp_map      : List<(ByteArray, Int)>,
  global_lamp_epoch : Int,
}

/// ProtocolFeeParams — beacon DAO (reference input), mang Protocol NFT.
/// Mang SÀN tỷ giá (PM-3.5). Multi-Tier Fee §A. Append-only field.
///   min_lamp_per_magic_q : Q-format sàn — lamp_per_magic_q của app PHẢI ≥ giá trị này
///   protocol_fee_active  : nếu True (phí giao thức > 0) thì ép lamp_sponsored > 0
///   epoch                : epoch cập nhật
pub type ProtocolFeeParams {
  min_lamp_per_magic_q : Int,
  protocol_fee_active  : Bool,
  epoch                : Int,
}

/// Redeemer Paymaster (spend SponsorMeter).
///   vault_refs  : các vault input co-spend bằng BurnBatch; paymaster đọc redeemer
///                 BurnBatch của từng ref để tính magic_consumed = Σ burns (dedup).
///   policy_ref  : reference input SponsorPolicy beacon
///   protocol_ref: reference input ProtocolFeeParams beacon (sàn)
///   did_key     : khoá per-user trong did_lamp_map (MVP = EngageDatum.owner)
///   lamp_this   : oil app khai sponsor op này (validator ép ≤ trần + cập quota)
///   ada_this    : lovelace app khai sponsor op này (validator ép ≤ trần)
pub type PaymasterRedeemer {
  Sponsor {
    vault_refs   : List<OutputReference>,
    policy_ref   : OutputReference,
    protocol_ref : OutputReference,
    did_key      : ByteArray,
    lamp_this    : Int,
    ada_this     : Int,
  }
}

/// Redeemer minting policy NFT one-shot (policy NFT + meter NFT dùng chung).
pub type NftRedeemer {
  MintGenesis
}
