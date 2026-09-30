//// Beacon GreenBack và shard GB — phần KÉT InstantGen phải tự ép (Gen v2.0 gói b2).
////
//// SPEC §6.1.3. Chia vai với `GenBeacons/onchain/validators/gb_shard.ak` (đầu tệp,
//// mục "Két PHẢI ép"): shard ép đặt lại lười, đồng tiêu với đúng một két thật, và
//// `remaining_out = remaining_eff − Draw.amount ≥ 0`. Shard KHÔNG ép — và tệp này ép:
////   (1) shard đó là shard CỦA KÉT này (`vault_shard_id`);
////   (2) lượng rút == lượng két cấp (`shard_draw` trả trạng thái để két so);
////   (3) độ tươi beacon + `depeg` (`greenback_open`);
////   (4) trần mỗi-két-mỗi-epoch (két dùng `gen_formula.gb_vault_share`).

use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/primitive/bytearray
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, Output}
use magiclamp/protocol/constants.{gb_shard_count, greenback_beacon_max_age_epochs}
use magiclamp/protocol/types.{GbShard, GreenBackBeacon}

/// Tên NFT beacon GreenBack ("GBB"). CHÉP CÓ NHÃN từ
/// `GenBeacons/onchain/lib/genbeacons/constants.ak` ▸ `greenback_nft_name`
/// (MAGIC@9c4a282b, 2026-09-30).
pub const greenback_nft_name: ByteArray = #"474242"

/// Tiền tố tên NFT shard ("GBS"). CHÉP CÓ NHÃN từ cùng tệp ▸ `shard_nft_prefix`.
pub const shard_nft_prefix: ByteArray = #"474253"

/// "GBS" ‖ một byte `id` — gương `genbeacons/constants.shard_nft_name`.
pub fn shard_nft_name(id: Int) -> ByteArray {
  bytearray.concat(shard_nft_prefix, bytearray.push(#"", id))
}

/// Ánh xạ két → shard GB: byte ĐẦU của `blake2b_256(hash trong owner)`, mod 16.
///
/// CHÉP CÓ NHÃN từ `ScheduleGen/onchain/lib/magiclamp/protocol/math.ak` ▸
/// `compute_shard_id` (MAGIC@9c4a282b, 2026-09-30) — CÙNG ánh xạ với két ScheduleGen, để
/// bộ dựng off-chain tính shard của một chủ két bằng một công thức cho cả hai cửa.
///
/// Ép được on-chain vì `owner` nằm trong datum, được ghim ở genesis (chủ ký) và GHIM ở
/// mọi nhánh spend (nhánh sinh so nguyên bản ghi), nên người dựng giao dịch không chọn
/// được shard ở lượt sinh. Chủ két thì chọn được shard lúc tạo két (chọn khoá) — giống hệt
/// ánh xạ theo tên NFT (chọn seed); không ánh xạ nào chặn được việc đó, và thứ chặn cá
/// voi hút cạn một shard là trần `gb_vault_share` mỗi két, không phải ánh xạ.
pub fn vault_shard_id(owner: Credential) -> Int {
  let inner =
    when owner is {
      VerificationKey(pkh) -> pkh
      Script(h) -> h
    }
  let hash = crypto.blake2b_256(inner)
  bytearray.at(hash, 0) % gb_shard_count
}

/// Beacon GreenBack THẬT trong reference input và ĐANG MỞ, fail-closed (SPEC §6.1.3):
///   - đúng MỘT reference input mang NFT `(nft_policy, "GBB")` — đếm mọi UTxO mang
///     token đó (số lượng > 0), nên hai beacon ⟹ từ chối;
///   - nằm tại `Script(beacon_script_hash)` (NFT chứng minh ai ĐÃ ĐÚC, địa chỉ chứng
///     minh datum HIỆN TẠI đi qua validator beacon), đúng 1 đơn vị NFT;
///   - `depeg == False`;
///   - tươi: `0 ≤ e − epoch ≤ greenback_beacon_max_age_epochs`.
/// Không có giá trị mặc định: mọi vế sai ⟹ FAIL hoặc `False`.
///
/// Trả `Bool` và bên gọi PHẢI `expect` nó. Bản đầu trả bản ghi beacon và bên gọi viết
/// `let _beacon = read_greenback(..)`: trình biên dịch BỎ binding không dùng, nên cả
/// khối `expect` bên trong không chạy — 7 bài âm beacon (depeg, cũ, tương lai, thiếu,
/// hai cái, sai script, sai NFT) cùng XANH trên két. Đo 2026-09-30, aiken v1.1.21.
pub fn greenback_open(
  reference_inputs: List<Input>,
  nft_policy: PolicyId,
  beacon_script_hash: ScriptHash,
  e: Int,
) -> Bool {
  expect [beacon] =
    list.filter(
      reference_inputs,
      fn(i) {
        assets.quantity_of(i.output.value, nft_policy, greenback_nft_name) > 0
      },
    )
  expect beacon.output.address.payment_credential == Script(beacon_script_hash)
  expect assets.quantity_of(beacon.output.value, nft_policy, greenback_nft_name) == 1
  expect InlineDatum(raw) = beacon.output.datum
  expect g: GreenBackBeacon = raw
  and {
    // MUT-GB-DEPEG
    !g.depeg,
    // MUT-GB-AGE — không đến từ tương lai, không cũ quá ngưỡng.
    g.epoch <= e,
    e - g.epoch <= greenback_beacon_max_age_epochs,
  }
}

/// Shard `id` bị tiêu trong giao dịch: trả `(GB_available, reset_amount, remaining_out)`.
///
///   - đúng MỘT input tại `Script(shard_hash)`, và nó mang NFT `"GBS" ‖ id` (sai shard ⟹
///     fail); đúng MỘT output tại `Script(shard_hash)` mang cùng NFT;
///   - `GB_available` = số còn lại HIỆU LỰC trước lượt rút. Shard đặt lại lười khi beacon
///     có `seq` mới hơn; `gb_shard.spend` ép `s_out == { ..eff, remaining: eff.remaining −
///     amount }`, nên `s_out.seq > s_in.seq` ⟺ lượt này đặt lại, và khi đó
///     `eff.remaining = s_out.reset_amount`; ngược lại `eff = s_in`.
///
/// Suy luận trên đứng trên việc validator shard CHẠY — nó chạy vì input nằm tại
/// `Script(shard_hash)` và `shard_hash` là apply-param của két, không do người gọi chọn.
pub fn shard_draw(
  inputs: List<Input>,
  outputs: List<Output>,
  shard_hash: ScriptHash,
  id: Int,
) -> (Int, Int, Int) {
  let name = shard_nft_name(id)
  expect [shard_in] =
    list.filter(
      inputs,
      fn(i) { i.output.address.payment_credential == Script(shard_hash) },
    )
  expect assets.quantity_of(shard_in.output.value, shard_hash, name) == 1
  expect [shard_out] =
    list.filter(
      outputs,
      fn(o) { o.address.payment_credential == Script(shard_hash) },
    )
  expect assets.quantity_of(shard_out.value, shard_hash, name) == 1
  expect InlineDatum(raw_in) = shard_in.output.datum
  expect s_in: GbShard = raw_in
  expect InlineDatum(raw_out) = shard_out.datum
  expect s_out: GbShard = raw_out
  let available =
    if s_out.seq > s_in.seq {
      s_out.reset_amount
    } else {
      s_in.remaining
    }
  (available, s_out.reset_amount, s_out.remaining)
}

// ═══ Bài kiểm ═════════════════════════════════════════════════════════════════

test shard_name_matches_genbeacons_encoding() {
  // "GBS" ‖ 0x0e — cùng byte với `genbeacons/constants.shard_nft_name(14)`.
  shard_nft_name(14) == #"4742530e"
}

// Ánh xạ chỉ đọc HASH bên trong credential (khoá hay script như nhau), kết quả trong
// [0, 16), và hai chủ khác nhau rơi được vào hai shard khác nhau.
test vault_shard_id_reads_inner_hash() {
  let a = #"00000000000000000000000000000000000000000000000000000000"
  let b = #"01000000000000000000000000000000000000000000000000000000"
  let sa = vault_shard_id(VerificationKey(a))
  and {
    sa == vault_shard_id(Script(a)),
    sa == bytearray.at(crypto.blake2b_256(a), 0) % 16,
    sa >= 0,
    sa < 16,
    sa != vault_shard_id(VerificationKey(b)),
  }
}
