// lib/getmagic/testkit.ak — mock-Transaction builders + pinned Ed25519 fixtures
//
// Dùng CHUNG cho test của `validators/otc_order.ak` và `validators/magic_allocation.ak`.
// KHÔNG có validator nào import module này ở đường mã sản xuất ⇒ thêm/sửa file này
// KHÔNG đổi script hash (đã đối chiếu plutus.json trước/sau — xem báo cáo A3).
//
// ── Nguồn của các chữ ký dán cứng dưới đây ────────────────────────────────
// Sinh bằng Node 24 `node:crypto` Ed25519 thuần (không phụ thuộc npm), seed cố định:
//     oracle   seed = 0x01 × 32  → vkey 8a88e3dd…6f5c
//     attacker seed = 0x02 × 32  → vkey 81397 70e…b394
// `oracle seed = 0x01 × 32` chính là `TV_VOUCHER_01.privateKeyHex` trong
// `GetMAGIC/tests/vectors.ts` ⇒ khoá thử nghiệm của hai phía là MỘT (P8).
// Thông điệp được ký dựng đúng theo `getmagic/utils.ak`:
//     settle_msg  = order_id ++ user_pkh ++ nonce ++ ts(8 BE)
//     voucher_msg = alloc_id ++ epoch(8 BE) ++ nanogic(8 BE) ++ expiry_posix(8 BE)

use aiken/interval.{Interval}
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{
  Datum, InlineDatum, Input, NoDatum, Output, OutputReference,
}

// ── Địa chỉ / UTxO builders ───────────────────────────────────

pub fn script_address(hash: ByteArray) -> Address {
  Address { payment_credential: Script(hash), stake_credential: None }
}

/// Địa chỉ script GIỮ NGUYÊN payment credential nhưng gắn stake credential của
/// người khác. Dùng cho ca ĐỊA CHỈ: validator chỉ so payment_credential.
pub fn script_address_staked(hash: ByteArray, stake_pkh: ByteArray) -> Address {
  Address {
    payment_credential: Script(hash),
    stake_credential: Some(Inline(VerificationKey(stake_pkh))),
  }
}

pub fn vk_address(pkh: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(pkh), stake_credential: None }
}

pub fn mk_output(addr: Address, value: Value, datum: Data) -> Output {
  Output {
    address: addr,
    value: value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

pub fn mk_output_raw(addr: Address, value: Value, datum: Datum) -> Output {
  Output {
    address: addr,
    value: value,
    datum: datum,
    reference_script: None,
  }
}

pub fn mk_output_no_datum(addr: Address, value: Value) -> Output {
  Output {
    address: addr,
    value: value,
    datum: NoDatum,
    reference_script: None,
  }
}

pub fn mk_input(ref: OutputReference, out: Output) -> Input {
  Input { output_reference: ref, output: out }
}

pub fn mk_ref(id: ByteArray, ix: Int) -> OutputReference {
  OutputReference { transaction_id: id, output_index: ix }
}

/// Cửa sổ hợp lệ HẸP bắt đầu đúng tại `lo` (lower_bound = Finite(lo)).
pub fn window_from(lo: Int) -> Interval {
  interval.between(lo, lo + 1)
}

/// Cửa sổ KHÔNG chặn dưới → `lower_bound.bound_type = NegativeInfinity`.
/// Cả hai validator rơi về mặc định `tx_lower_ms = 0` trong ca này.
pub fn window_unbounded() -> Interval {
  interval.everything
}

// ── Danh tính ────────────────────────────────────────────────

/// vkey Ed25519 của oracle "thật" (seed 0x01 × 32).
pub const oracle_vkey: ByteArray =
  #"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"

/// vkey Ed25519 của kẻ tấn công (seed 0x02 × 32).
pub const attacker_vkey: ByteArray =
  #"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394"

pub const user_pkh: ByteArray = #"11111111111111111111111111111111111111111111111111111111"

pub const org_pkh: ByteArray = #"22222222222222222222222222222222222222222222222222222222"

pub const attacker_pkh: ByteArray = #"99999999999999999999999999999999999999999999999999999999"

/// Script hash của `magic_allocation` (giả lập tham số apply cho `otc_order`).
pub const alloc_sh: ByteArray = #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

/// Một script hash KHÁC — dùng cho ca "output đi nhầm script".
pub const other_sh: ByteArray = #"b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"

/// Script hash của chính `otc_order` (chỉ để dựng input, validator không đọc).
pub const otc_sh: ByteArray = #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"

pub const org_vault_nft_policy: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

// ── Hằng số đơn hàng OTC ──────────────────────────────────────

pub const order_id: ByteArray = #"4142434431323334"

pub const nonce: ByteArray =
  #"3333333333333333333333333333333333333333333333333333333333333333"

/// Unix ms — 1_700_000_000_000.
pub const otc_ts: Int = 1_700_000_000_000

/// created + 14_400_000 (4 giờ) theo G-OTC-5.
pub const otc_expiry: Int = 1_700_014_400_000

pub const fiat_vnd: Int = 200_000

pub const magic_per_epoch: Int = 10_000_000_000

pub const total_epochs: Int = 6

// ── Chữ ký settle (oracle ký order_id ++ user_pkh ++ nonce ++ ts) ─────

/// Hợp lệ: oracle ký đúng payload, ts = otc_ts.
pub const settle_sig_ok: ByteArray =
  #"cbad8b68642fed9348446ff15bd6df025ff4431b36d516082a15ba31a1060548ce122ce1a8034e3df7a0178058a649f8024c0f0db2aed44a6ca71b6c21e0e909"

/// Cùng payload nhưng ký bằng khoá KẺ TẤN CÔNG.
pub const settle_sig_attacker: ByteArray =
  #"c1ce1e9c833d6d056212d4e64de638c22f262b6b3f88c471c5bf8884b597192b86e21b707cd38fd4d30b254fbacaa3911a0754f7febf178d060fa28836df3406"

/// Oracle ký với ts = otc_expiry — cô lập ĐÚNG một biến cho ca biên hết hạn
/// (freshness vẫn đạt, chỉ `not_expired` đổi chiều).
pub const settle_sig_ts_at_expiry: ByteArray =
  #"85cc6dfe91736e4e853b475861b0b21e3497c9cc880dc3da5a706897e5675c3d578b68a71ef84e365bbe02cb23f3378150a9fa990bf78cf4db6383a96dba5901"

/// Oracle ký, nhưng cho user_pkh = 0x99×28 (payload lệch với datum).
pub const settle_sig_other_user: ByteArray =
  #"764e81d36303ea01389691b03b755b09b49e0ba5c4212f5fdaea4ab6e4c9787b21415fb032f46a2e966a76bf1a213a14bd114492d2cd3b9fe67b33935bc07109"

// ── Voucher (oracle ký alloc_id ++ epoch ++ nanogic ++ expiry_posix) ──

pub const alloc_id: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

pub const start_epoch: Int = 100

pub const expiry_epoch: Int = 106

/// expiry_epoch × 86_400_000 — công thức dán cứng trong magic_allocation.ak:76.
pub const expiry_posix: Int = 9_158_400_000

pub const voucher_e100: ByteArray =
  #"3a2539bd2822df21cd13cf20e6ff3bbe885218d45afb4f03533e1f3280110938f10973689039c1f45227f2a0ad02764a620043260e901a5ebc7f81bd62846c09"

pub const voucher_e101: ByteArray =
  #"b5933e74b2c1901532de8b6e39a10c1217d6749dbcf85395516595fb90dd312489ffbe939f15dc78a94df499871f8dca450d6554f9f6e29fb65be1e054a19c00"

pub const voucher_e102: ByteArray =
  #"69560d62ceb00810b1e7dee80f9fe74d122690b48169473068bbd6667e74f34b488b9e12f119907c956c6da9b7fb95baf2f8a6b52790d65602676ead8bc9460a"

pub const voucher_e103: ByteArray =
  #"241b7481281ec73d2a5babf4d5fd0a1e8862cdd67e551b96ce23e8197432b43b8b7d72d6fc1c7a2fd7cb52e41675e09c9bdb6e820bf6dd94e34db7d96c71380e"

pub const voucher_e104: ByteArray =
  #"6313da2365cc640e7cef9df38b48aaa602ad7443adc7127d69ad4b20cc90627cc77261af106384ab2e1139c8b396f80e84793e1f3fd25df7830aae1fec3f1002"

pub const voucher_e105: ByteArray =
  #"221a487ef34d0449dd68ab53bcae68ff108e86ebeeb37529fdb4b2f83a084d644e0d62c58fdfe82d3cbd9976f36603e87795e55cfad8700c3c69125ccf93bb0e"

/// Voucher epoch 100, cùng payload, nhưng ký bằng khoá KẺ TẤN CÔNG.
/// Dùng cho nợ #34 (trust-root): hợp lệ nếu datum.oracle_vkey = attacker_vkey.
pub const voucher_e100_attacker: ByteArray =
  #"57c83e4f757bf80c6620eaceeadba0fee574caff895400ea9a3eb8b0bddcf71f96f30e97373d062c557fc2049cb9cdfdc2ebf9d928bbf21d36f0fa305dd9740f"

pub fn vouchers_ok() -> List<ByteArray> {
  [voucher_e100, voucher_e101, voucher_e102, voucher_e103, voucher_e104, voucher_e105]
}

/// Danh sách voucher bị XOAY một ô: index 0 giữ voucher của epoch 101.
/// Chứng minh voucher gắn ĐÚNG epoch, không phải "voucher nào cũng được".
pub fn vouchers_rotated() -> List<ByteArray> {
  [voucher_e101, voucher_e100, voucher_e102, voucher_e103, voucher_e104, voucher_e105]
}

/// Index 0 là voucher do kẻ tấn công ký (datum.oracle_vkey vẫn là oracle thật).
pub fn vouchers_forged_first() -> List<ByteArray> {
  [
    voucher_e100_attacker, voucher_e101, voucher_e102, voucher_e103,
    voucher_e104, voucher_e105,
  ]
}

pub fn vouchers_attacker_first() -> List<ByteArray> {
  [voucher_e100_attacker]
}

// ── Giá trị ──────────────────────────────────────────────────

/// UTxO "có tiền": 100 ADA + 1 token đại diện quyền đã cấp.
pub fn rich_value() -> Value {
  assets.add(
    assets.from_lovelace(100_000_000),
    org_vault_nft_policy,
    #"4d41474943",
    1,
  )
}

/// UTxO đã bị vét: chỉ còn min-ADA, không token.
pub fn drained_value() -> Value {
  assets.from_lovelace(1_000_000)
}

pub fn none_cred() -> Option<Credential> {
  None
}
