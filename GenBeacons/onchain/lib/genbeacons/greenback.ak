//// Đọc beacon GreenBack từ reference input — dùng cho shard, và để két chép sang.

use aiken/collection/list
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input}
use genbeacons/constants
use genbeacons/types.{GreenBackBeacon}
use genbeacons/util

/// Beacon GreenBack THẬT trong `ref_inputs`, fail-closed:
///   - đúng MỘT reference input mang NFT `(nft_policy, "GBB")` (0 hoặc ≥2 ⟹ từ chối);
///   - nó nằm tại `Script(beacon_script_hash)` — NFT chỉ chứng minh AI ĐÃ ĐÚC, còn datum
///     HIỆN TẠI do người đang giữ UTxO quyết; chỉ địa chỉ script ép mọi lần đổi datum đi
///     qua validator beacon (bẫy đã gặp: beacon NFT chuyển ra ví thường, datum tuỳ ý);
///   - đúng 1 đơn vị NFT, datum inline giải mã được.
/// KHÔNG kiểm `depeg` và KHÔNG kiểm độ tươi — bên gọi tự kiểm (shard kiểm `depeg`; độ
/// tươi `CC-GEN-BEACON-AGE` là việc của két).
pub fn read_greenback(
  ref_inputs: List<Input>,
  nft_policy: PolicyId,
  beacon_script_hash: ByteArray,
) -> GreenBackBeacon {
  expect [beacon] =
    list.filter(
      ref_inputs,
      fn(i) {
        assets.quantity_of(i.output.value, nft_policy, constants.greenback_nft_name) > 0
      },
    )
  expect util.is_at_script(beacon.output.address, beacon_script_hash)
  expect
    assets.quantity_of(
      beacon.output.value,
      nft_policy,
      constants.greenback_nft_name,
    ) == 1
  expect InlineDatum(d) = beacon.output.datum
  expect g: GreenBackBeacon = d
  g
}
