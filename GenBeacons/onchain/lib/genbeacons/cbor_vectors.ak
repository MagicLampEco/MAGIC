//// Vector CBOR của datum/redeemer/apply-param GenBeacons — ghim hình dạng nhị phân HAI bên.
////
//// Mỗi hằng `*_cbor` là `cbor.serialise` của một giá trị cố định. Test Aiken dưới đây ghim
//// hằng đó với bộ mã hoá của Aiken; `GenBeacons/offchain/tests/cborVectors.test.ts` đọc
//// THẲNG các hằng này từ tệp này (không chép số) và ghim chúng với `Data.to` của Lucid. Hai
//// bên cùng khớp một hằng ⟹ lược đồ TS trùng thứ tự trường + chỉ số constructor với .ak.
////
//// Đổi một kiểu ở `types.ak` ⟹ test ở đây đỏ ⟹ sửa hằng ⟹ bài TS đỏ cho tới khi lược đồ
//// `offchain/src/types.ts` theo kịp. Tên hằng là hợp đồng với bài TS: `<tên>_cbor`.
////
//// Giá trị chọn để phân biệt được lỗi: `gb_nanogic` > 2⁶⁴ (bignum, thẻ CBOR 2); `depeg`
//// có cả True (Constr 1) lẫn False (Constr 0); `rho_q ≠ prev_rho_q` để đảo trường là đỏ.

use aiken/cbor
use cardano/transaction.{OutputReference}
use genbeacons/types.{
  Draw, GbShard, GbShardRedeemer, GreenBackBeacon, RateParam, VaultRegistry,
}

pub const rate_param_cbor: ByteArray = #"d8799f1a499602d21a3ade68b1194e21ff"

pub const greenback_depeg_cbor: ByteArray =
  #"d8799fc24901f399b1438a10000007194e20d87a80ff"

pub const greenback_genesis_cbor: ByteArray = #"d8799f0000194e20d87980ff"

pub const gb_shard_cbor: ByteArray =
  #"d8799f0f071b00066517289880001b0006651728987e70ff"

pub const vault_registry_cbor: ByteArray =
  #"d8799f9f581c7a000000000000000000000000000000000000000000000000000001581c7a000000000000000000000000000000000000000000000000000002ffff"

pub const gb_shard_redeemer_cbor: ByteArray = #"d8799f190190ff"

pub const output_reference_cbor: ByteArray =
  #"d8799f58205eed0000000000000000000000000000000000000000000000000000000000ab03ff"

test rate_param_vector() {
  let d: Data =
    RateParam {
      rho_q: 1_234_567_890,
      prev_rho_q: 987_654_321,
      effective_epoch: 20_001,
    }
  cbor.serialise(d) == rate_param_cbor
}

test greenback_depeg_vector() {
  let d: Data =
    GreenBackBeacon {
      gb_nanogic: 36_000_000_000_000_000_000,
      seq: 7,
      epoch: 20_000,
      depeg: True,
    }
  cbor.serialise(d) == greenback_depeg_cbor
}

test greenback_genesis_vector() {
  let d: Data =
    GreenBackBeacon { gb_nanogic: 0, seq: 0, epoch: 20_000, depeg: False }
  cbor.serialise(d) == greenback_genesis_cbor
}

test gb_shard_vector() {
  let d: Data =
    GbShard {
      shard_id: 15,
      seq: 7,
      reset_amount: 1_800_000_000_000_000,
      remaining: 1_799_999_999_999_600,
    }
  cbor.serialise(d) == gb_shard_cbor
}

test vault_registry_vector() {
  let d: Data =
    VaultRegistry {
      vault_script_hashes: [
        #"7a000000000000000000000000000000000000000000000000000001",
        #"7a000000000000000000000000000000000000000000000000000002",
      ],
    }
  cbor.serialise(d) == vault_registry_cbor
}

test gb_shard_redeemer_vector() {
  let r: GbShardRedeemer = Draw { amount: 400 }
  let d: Data = r
  cbor.serialise(d) == gb_shard_redeemer_cbor
}

test output_reference_vector() {
  let d: Data =
    OutputReference {
      transaction_id: #"5eed0000000000000000000000000000000000000000000000000000000000ab",
      output_index: 3,
    }
  cbor.serialise(d) == output_reference_cbor
}
