// lib/getmagic/utils.ak — GetMAGIC utility functions
// Shared helpers for oracle message construction and epoch voucher logic.
//
// ── FRAMING RULE (read this before touching any builder below) ────────────
// Every byte string that is HASHED into an identifier or SIGNED by the oracle
// is built with the SAME shape:
//
//   LP(s)  = u32be(len(s)) ++ s                       (length-prefixed field)
//   msg    = <domain-tag> ++ 0x00 ++ LP(f1) ++ LP(f2) ++ … ++ u64be(i1) ++ …
//
// Why (nợ #26): plain concatenation of variable-length fields is NOT injective.
// `order_id ++ user_pkh` for (#"41", #"4243") and (#"4142", #"43") is the same
// byte string, so one hash / one oracle signature covers BOTH field splittings.
// With LP, decoding is a total function (read 4 bytes → read that many bytes →
// repeat), so encoding is injective. Fixed-width ints (u64be) are already
// self-delimiting and go LAST, un-prefixed.
//
// Rules for anyone extending these:
//   1. Any NEW variable-length field MUST be wrapped in `length_prefixed`.
//      A raw `bytearray.concat` of an unframed field re-opens nợ #26.
//   2. New fixed-width fields go AFTER all LP fields, or get LP'd too.
//   3. A new message kind gets a NEW domain tag; never reuse one.
//      Tags are ASCII (no 0x00 byte), so `tag ++ 0x00` is unambiguous and the
//      images of the three builders below are pairwise disjoint.

use aiken/collection/list
use aiken/crypto
use aiken/primitive/bytearray

// ── Domain tags ───────────────────────────────────────────────
// ASCII, no 0x00 byte inside — see rule 3 above.

/// "MAGIC_ALLOC_ID:v1" (17 bytes)
pub const domain_alloc_id: ByteArray = #"4d414749435f414c4c4f435f49443a7631"

/// "MAGIC_ORACLE_SETTLE:v1" (22 bytes)
pub const domain_oracle_settle: ByteArray =
  #"4d414749435f4f5241434c455f534554544c453a7631"

/// "MAGIC_VOUCHER:v1" (16 bytes)
pub const domain_voucher: ByteArray = #"4d414749435f564f55434845523a7631"

/// Length of an alloc_id — blake2b_256 output. Enforced, not assumed.
pub const alloc_id_length: Int = 32

// ── Số trường của từng khuôn ─────────────────────────────────
// Đưa số trường vào chính tiền ảnh: thêm một trường ⇒ hằng đổi ⇒ tiền ảnh đổi ⇒
// hash đổi, KỂ CẢ khi người sửa quên tăng `:v1`. Va chạm liên-phiên-bản thành
// bất khả theo cấu tạo, không còn phải phòng bằng trí nhớ người sửa.
//
// Khai ở ĐÂY, cạnh khuôn — không viết tay ở từng hàm. Viết tay thì nó lại là
// một thứ nữa phải nhớ đồng bộ, đúng cái đang tránh.
//
// Giới hạn, nói rõ để không ai nhận một nửa: hằng này KHÔNG bắt được ca ĐỔI CHỖ
// hai trường cùng độ dài (số trường không đổi). Ca đó do vector vàng ở
// `tests/vectors.ts` bắt — vector đã ghim thì chỉ được THÊM, không được SỬA.
// Và `:v1` vẫn giữ trong tiền tố: hai thứ bù nhau chứ không thay nhau.

/// alloc_id: order_id, user_pkh
pub const fields_alloc_id: Int = 2

/// oracle settle: order_id, user_pkh, nonce, timestamp_ms
pub const fields_oracle_settle: Int = 4

/// voucher: alloc_id, epoch, nanogic, expiry_posix
pub const fields_voucher: Int = 4

// ── Mốc đóng băng của khuôn — PHÉP PHÂN LOẠI, không phải cổng cho phép ──
// Hai mệnh đề dưới đây KHÔNG dùng để xin phép đổi khuôn. Dùng để phân loại xem
// đổi khuôn ở đây phải đi đường nào. Vế nào sai thì chính vế đó chỉ ra đường
// chuyển bắt buộc:
//
//   (1) KHÔNG script hash nào nướng khuôn này đã deploy lên BẤT KỲ mạng nào.
//       Testnet nằm TRONG, không nằm ngoài.
//   (2) KHÔNG chữ ký nào ký dưới khuôn này tồn tại ngoài kho mã.
//
//   cả hai ĐÚNG        ⟹ đổi thẳng `:vN` tại chỗ, không cần đường chuyển.
//   (1) sai            ⟹ khuôn đóng băng, thay đổi đi bằng `:vN+1`.
//   (2) sai            ⟹ phải đi BA NHỊP: bên kiểm nhận CẢ HAI khuôn trước, rồi
//                        bên ký chuyển sang khuôn mới, rồi mới tắt khuôn cũ.
//
// Mốc đóng băng là LẦN DEPLOY ĐẦU TIÊN lên bất kỳ mạng nào — KHÔNG phải mainnet.
// Đặt mốc ở mainnet là đặt sai chỗ, và nhà này đã trả giá cho đúng chuyện đó ở
// ScheduleGen: hai commit vá lỗi validator sau lần deploy 2026-08-13 làm script
// hash đổi, vault testnet đang giữ tLAMP nằm ở địa chỉ mà bản build hiện tại
// không suy ra được, và lỗi hiện ra chỉ dưới dạng "Vault not found". Cả hai
// commit đó là vá ĐÚNG VÀ CẦN — mốc đóng băng không tha cho thay đổi có lý do
// chính đáng, và đó mới là chỗ nó dạy được.
//
// 🔴 HAI VẾ KHÔNG NGANG HÀNG. Đọc chúng như hai lớp bảo vệ chồng nhau là đọc sai
// theo hướng nguy hiểm:
//
//   Vế (1) là một PHÉP KIỂM — chạy được bằng một lệnh, chạy lại trước mỗi lần
//   dựa vào nó.
//
//   Vế (2) là một GIẢ ĐỊNH, không phải phép kiểm. Theo đúng định nghĩa nó nói về
//   thứ nằm NGOÀI kho, nên không kiểm được từ trong kho. Nó chỉ trở thành phép
//   kiểm khi có một SỔ ĐĂNG KÝ KHOÁ KÝ tách rời để đối chiếu. Kho này KHÔNG có
//   sổ đó. Chừng nào chưa có, vế (2) là HỆ QUẢ của vế (1) — khoá oracle chưa
//   từng có bản chạy thật để mà ký cho ai — và nó mất hiệu lực CÙNG LÚC với vế
//   (1), không đỡ được cho vế (1).
//
//   Nhà Phoenix đã đo đúng vế này ở `PHOENIXKEY_RP_AUTH` và kết quả nặng hơn:
//   ở đó vế (2) không phải "tựa vào vế (1)" mà SAI HẲN — chữ ký dưới khuôn cũ
//   đang được app bên tích hợp sinh ra mỗi lượt đăng nhập. Đó là vì sao nhà đó
//   phải đi ba nhịp còn nhà này đổi thẳng được. Cùng một khuôn phân loại, hai
//   kết quả khác nhau, hai đường làm khác nhau.
//
// PHÉP KIỂM ĐÃ CHẠY — lệnh + ngày + kết quả. Đây là khẳng định về thế giới và nó
// CŨ ĐI. Chạy lại trước khi dựa vào.
//
//   2026-08-21  grep -niE "getmagic|otc|alloc|voucher|settle" scripts/DEPLOYED.md
//               → EXIT=1, không một dòng. Bản ghi triển khai chỉ có: LAMP policy,
//                 UM, shard, backing beacon, vault ScheduleGen, vault InstantGen.
//               ⟹ vế (1) ĐÚNG. Kèm một chi tiết đừng bỏ:
//                 `scripts/deploy/08_deploy_getmagic.ts` ĐÃ CÓ SẴN, chỉ là chưa
//                 chạy lần nào. Khoảng cách tới lần deploy đầu là MỘT lệnh, không
//                 phải "còn xa".
//
//   2026-08-21  Vế (2): mọi chỗ ký ed25519 đều nằm trong `GetMAGIC/`,
//               `scripts/test/`, `MagicSDK/examples/` — toàn bộ là vector thử.
//               Nhưng đây là đo BÊN TRONG kho, nên nó không kết luận được vế (2);
//               nó chỉ nói vế (2) chưa bị bác từ bên trong.

// ── Encoding ─────────────────────────────────────────────────

/// Encode Int to big-endian 8-byte ByteArray for oracle message building.
/// Uses stdlib bytearray.from_int_big_endian (matches off-chain DataView.setBigUint64 BE).
pub fn encode_int_8bytes(n: Int) -> ByteArray {
  bytearray.from_int_big_endian(n, 8)
}

/// LP(s) = u32be(len(s)) ++ s — makes a variable-length field self-delimiting.
/// Fails (fail-closed) if len(s) does not fit in 4 bytes; unreachable on Cardano
/// where a whole tx is capped well under 2^32 bytes.
pub fn length_prefixed(s: ByteArray) -> ByteArray {
  bytearray.concat(bytearray.from_int_big_endian(bytearray.length(s), 4), s)
}

/// `tag ++ 0x00 ++ u8(field_count)` — tiền tố phân miền.
fn domain_prefix(tag: ByteArray, field_count: Int) -> ByteArray {
  bytearray.concat(tag, #"00")
    |> bytearray.concat(bytearray.from_int_big_endian(field_count, 1))
}

// ── Identifier derivation ─────────────────────────────────────

/// Derive the canonical allocation identifier.
///
///   alloc_id = blake2b_256(
///     "MAGIC_ALLOC_ID:v1" ++ 0x00 ++ u8(2) ++ LP(order_id) ++ LP(user_pkh)
///   )
///
/// P8: mirrored bit-for-bit by `deriveAllocId` in offchain/src/oracle.ts.
///
/// alloc_id is a LOOKUP KEY (accounting, double-claim tracking, vouchers). Two
/// different (order_id, user_pkh) pairs colliding here corrupts all three, and
/// it fails SILENTLY — no signature check trips. Hence the framing.
pub fn build_alloc_id(order_id: ByteArray, user_pkh: ByteArray) -> ByteArray {
  crypto.blake2b_256(
    domain_prefix(domain_alloc_id, fields_alloc_id)
      |> bytearray.concat(length_prefixed(order_id))
      |> bytearray.concat(length_prefixed(user_pkh)),
  )
}

// ── Oracle message builders ───────────────────────────────────

/// Build oracle settlement message:
///
///   msg = "MAGIC_ORACLE_SETTLE:v1" ++ 0x00 ++ u8(4)
///      ++ LP(order_id) ++ LP(user_pkh) ++ LP(nonce)
///      ++ u64be(timestamp_ms)
///
/// G-OTC-1: Oracle sig covers exactly this payload.
/// P8: mirrored bit-for-bit by `buildOracleSettleMsg` in offchain/src/oracle.ts.
pub fn build_oracle_settle_msg(
  order_id: ByteArray,
  user_pkh: ByteArray,
  nonce: ByteArray,
  timestamp_ms: Int,
) -> ByteArray {
  domain_prefix(domain_oracle_settle, fields_oracle_settle)
    |> bytearray.concat(length_prefixed(order_id))
    |> bytearray.concat(length_prefixed(user_pkh))
    |> bytearray.concat(length_prefixed(nonce))
    |> bytearray.concat(encode_int_8bytes(timestamp_ms))
}

/// Build epoch voucher message:
///
///   msg = "MAGIC_VOUCHER:v1" ++ 0x00 ++ u8(4)
///      ++ LP(alloc_id)
///      ++ u64be(epoch) ++ u64be(nanogic) ++ u64be(expiry_posix)
///
/// G-ALLOC-1: Each voucher is an Ed25519 sig over this per-epoch payload.
/// P8: mirrored bit-for-bit by `buildVoucherMsg` in offchain/src/oracle.ts.
///
/// The `expect` turns "alloc_id is always 32 bytes" from a convention held by
/// off-chain code into an invariant enforced by the validator: `alloc_id` is
/// declared as a free `ByteArray` in types.ak, and nothing else pins its width.
pub fn build_voucher_msg(
  alloc_id: ByteArray,
  epoch: Int,
  nanogic: Int,
  expiry_posix: Int,
) -> ByteArray {
  expect bytearray.length(alloc_id) == alloc_id_length
  domain_prefix(domain_voucher, fields_voucher)
    |> bytearray.concat(length_prefixed(alloc_id))
    |> bytearray.concat(encode_int_8bytes(epoch))
    |> bytearray.concat(encode_int_8bytes(nanogic))
    |> bytearray.concat(encode_int_8bytes(expiry_posix))
}

// ── Epoch helpers ─────────────────────────────────────────────

/// Returns True if the given epoch is already in the claimed list.
pub fn epoch_already_claimed(claimed: List<Int>, epoch: Int) -> Bool {
  list.has(claimed, epoch)
}

/// Return the voucher at index (epoch - start_epoch), 0-based.
/// Returns None if the index is out of range.
pub fn get_voucher_for_epoch(
  vouchers: List<ByteArray>,
  epoch: Int,
  start_epoch: Int,
) -> Option<ByteArray> {
  let idx = epoch - start_epoch
  list.at(vouchers, idx)
}

// ══════════════════════════════════════════════════════════════
// TEST — P8 (Aiken ↔ TypeScript trùng BIT)
//
// Trọng tài là `GetMAGIC/tests/vectors.ts`. Các test dưới ghim ĐÚNG chuỗi byte mà
// `GetMAGIC/offchain/src/oracle.ts` sinh ra cho cùng đầu vào (chạy lại bằng Node
// `crypto` thuần để lấy hex). Lệch một byte ở đây = mọi chữ ký oracle do off-chain
// sinh sẽ bị on-chain từ chối, và ngược lại.
// ══════════════════════════════════════════════════════════════

// TV_ORACLE_01_CLEAN.timestampHex — 1_700_000_000_000 → 8 byte big-endian.
test p8_encode_int_8bytes_matches_ts() {
  encode_int_8bytes(1_700_000_000_000) == #"0000018bcfe56800"
}

// encode_int_8bytes phải là big-endian ĐỘ DÀI CỐ ĐỊNH 8, kể cả số nhỏ.
test p8_encode_int_8bytes_pads_to_8() {
  encode_int_8bytes(100) == #"0000000000000064" && bytearray.length(
    encode_int_8bytes(0),
  ) == 8
}

// TV_ORACLE_02: nanogic 10_000_000_000 và expiry 51_840_000_000.
test p8_encode_int_8bytes_nanogic_and_expiry() {
  encode_int_8bytes(10_000_000_000) == #"00000002540be400" && encode_int_8bytes(
    51_840_000_000,
  ) == #"0000000c11e7a000"
}

// TV_ORACLE_01_CLEAN — settle msg = order_id(8) ++ user_pkh(28) ++ nonce(32) ++ ts(8)
// = 76 byte. Hex dưới đây khớp buildOracleSettleMsg của offchain/src/oracle.ts.
test p8_settle_msg_matches_tv_oracle_01_clean() {
  let msg =
    build_oracle_settle_msg(
      #"4142434431323334",
      #"00000000000000000000000000000000000000000000000000000000",
      #"0000000000000000000000000000000000000000000000000000000000000000",
      1_700_000_000_000,
    )
  bytearray.length(msg) == 76 && msg == #"41424344313233340000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000018bcfe56800"
}

// TV_ORACLE_02 — voucher msg = alloc_id(32) ++ epoch(8) ++ nanogic(8) ++ expiry(8)
// = 56 byte.
test p8_voucher_msg_matches_tv_oracle_02() {
  let msg =
    build_voucher_msg(
      #"0000000000000000000000000000000000000000000000000000000000000000",
      100,
      10_000_000_000,
      51_840_000_000,
    )
  bytearray.length(msg) == 56 && msg == #"0000000000000000000000000000000000000000000000000000000000000000000000000000006400000002540be4000000000c11e7a000"
}

// ── Ca GIÁ TRỊ: số âm và tràn 64-bit ─────────────────────────
//
// Off-chain `encodeInt8Bytes` NÉM lỗi khi n < 0 (oracle.ts:15). On-chain builtin
// `integer_to_bytearray` cũng lỗi. Hai test dưới chốt rằng hành vi hai bên khớp:
// không bên nào âm thầm bọc vòng (wrap) thành số dương khổng lồ.

test p8_encode_int_8bytes_negative_fails() fail {
  encode_int_8bytes(-1) == #""
}

// 2^64 không lọt 8 byte → builtin lỗi, KHÔNG cắt bớt bit cao.
test p8_encode_int_8bytes_overflow_fails() fail {
  encode_int_8bytes(18_446_744_073_709_551_616) == #""
}

// 2^64 - 1 là giá trị lớn nhất còn lọt.
test p8_encode_int_8bytes_max_u64_ok() {
  encode_int_8bytes(18_446_744_073_709_551_615) == #"ffffffffffffffff"
}

// ══════════════════════════════════════════════════════════════
// TEST — chỉ mục voucher (G-ALLOC-5) và sổ epoch đã claim (G-ALLOC-2)
// ══════════════════════════════════════════════════════════════

test voucher_index_is_epoch_minus_start() {
  let vs = [#"aa", #"bb", #"cc"]
  get_voucher_for_epoch(vs, 100, 100) == Some(#"aa") && get_voucher_for_epoch(
    vs,
    102,
    100,
  ) == Some(#"cc")
}

// epoch < start_epoch → index âm. `list.at` phải trả None, KHÔNG được đếm ngược
// từ cuối danh sách (kiểu Python) — nếu đếm ngược, epoch 99 sẽ mượn được voucher
// của epoch 102.
test voucher_index_negative_is_none() {
  get_voucher_for_epoch([#"aa", #"bb", #"cc"], 99, 100) == None
}

test voucher_index_past_end_is_none() {
  get_voucher_for_epoch([#"aa", #"bb", #"cc"], 103, 100) == None
}

test voucher_index_empty_list_is_none() {
  get_voucher_for_epoch([], 100, 100) == None
}

test epoch_already_claimed_true_and_false() {
  epoch_already_claimed([100, 102], 102) && !epoch_already_claimed(
    [100, 102],
    101,
  ) && !epoch_already_claimed([], 100)
}
