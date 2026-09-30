// lib/magiclamp/protocol/gen_gate.ak — đầu vào Gen v2.0 của két ScheduleGen (gói c).
//
// Ba việc, đều chỉ nhánh KÝ (`ScheduleCommit`) gọi — fire KHÔNG đọc beacon
// (`CC-GEN-SCHEDULE-FIXED`, SPEC §6.1.4):
//   1. `read_rho`            — ρ hiệu lực ở epoch hiện tại từ beacon `RateParam`.
//   2. `read_greenback_fresh`— beacon GreenBack, fail-closed (thiếu · nhiều · sai NFT/
//                              script · cũ · `depeg`) — SPEC §6.1.3.
//   3. `gb_draw_checked`     — shard GB của két bị TRỪ đúng lượng ký (không chỉ đọc).
// Cộng hai hàm cửa sổ dùng ở MỌI nhánh: `window_add_at`, `drawn_in_epoch`.
//
// Neo beacon hai lớp (NFT + địa chỉ script): NFT chứng minh ai ĐÃ ĐÚC, còn datum HIỆN
// TẠI do người giữ UTxO quyết; chỉ địa chỉ script ép mọi lần đổi datum đi qua validator
// beacon. Khuôn chép từ `GenBeacons/onchain/lib/genbeacons/greenback.ak` ▸
// `read_greenback` và `InstantGen/onchain/lib/magiclamp/protocol/checkpoint.ak` ▸
// `read_rho` (MAGIC@9c4a282b) — hai project không import chéo.

use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, Spend, Transaction}
use magiclamp/protocol/constants.{
  buffer_ep, gb_shard_nft_prefix, greenback_beacon_max_age_epochs,
  greenback_nft_name, rate_nft_name, rho_max_q, shard_count, usage_window_len,
}
use magiclamp/protocol/math.{min2}
use magiclamp/protocol/types.{
  Draw, EpochUsage, GbShard, GbShardRedeemer, GenSchedule, GreenBackBeacon,
  RateParam,
}

/// Apply-param Gen v2.0 của két, gom lại để truyền vào nhánh ký. Thứ tự apply-param
/// thật nằm ở chữ ký `validator vault(...)`, KHÔNG ở đây.
pub type GenParams {
  gb_beacon_nft_policy: PolicyId,
  gb_beacon_script_hash: ByteArray,
  gb_shard_policy_id: PolicyId,
  rate_nft_policy: PolicyId,
  rate_script_hash: ByteArray,
}

/// ρ hiệu lực ở epoch `e` từ ĐÚNG MỘT beacon `RateParam` (NFT "RHO" tại
/// `Script(rate_script_hash)`). `rho_q` nếu `e >= effective_epoch`, ngược lại
/// `prev_rho_q`. Thiếu / hai cái / sai script / datum sai hình / ngoài `[0, rho_max_q]`
/// ⟹ FAIL, không có ρ mặc định.
pub fn read_rho(
  reference_inputs: List<Input>,
  rate_nft_policy: PolicyId,
  rate_script_hash: ByteArray,
  e: Int,
) -> Int {
  expect [beacon] =
    list.filter(
      reference_inputs,
      fn(i) { assets.quantity_of(i.output.value, rate_nft_policy, rate_nft_name) > 0 },
    )
  expect beacon.output.address.payment_credential == Script(rate_script_hash)
  expect assets.quantity_of(beacon.output.value, rate_nft_policy, rate_nft_name) == 1
  expect InlineDatum(raw) = beacon.output.datum
  expect rp: RateParam = raw
  let rho =
    if e >= rp.effective_epoch {
      rp.rho_q
    } else {
      rp.prev_rho_q
    }
  expect rho >= 0 && rho <= rho_max_q
  rho
}

/// Beacon GreenBack THẬT và DÙNG ĐƯỢC ở epoch `e`, fail-closed (SPEC §6.1.3):
/// đúng một reference input mang NFT "GBB" · tại `Script(beacon_script_hash)` · đúng 1
/// đơn vị · datum giải mã được · `depeg == False` · `gb_nanogic >= 0` ·
/// `0 <= e − epoch <= greenback_beacon_max_age_epochs`.
pub fn read_greenback_fresh(
  reference_inputs: List<Input>,
  nft_policy: PolicyId,
  beacon_script_hash: ByteArray,
  e: Int,
) -> GreenBackBeacon {
  expect [beacon] =
    list.filter(
      reference_inputs,
      fn(i) {
        assets.quantity_of(i.output.value, nft_policy, greenback_nft_name) > 0
      },
    )
  expect beacon.output.address.payment_credential == Script(beacon_script_hash)
  expect
    assets.quantity_of(beacon.output.value, nft_policy, greenback_nft_name) == 1
  expect InlineDatum(d) = beacon.output.datum
  expect g: GreenBackBeacon = d
  expect !g.depeg
  expect g.gb_nanogic >= 0
  expect g.epoch <= e && e - g.epoch <= greenback_beacon_max_age_epochs
  g
}

/// Tên NFT shard GB: "GBS" ‖ byte(shard_id) — gương `genbeacons/constants.shard_nft_name`.
pub fn gb_shard_nft_name(id: Int) -> ByteArray {
  bytearray.concat(gb_shard_nft_prefix, bytearray.push(#"", id))
}

/// Shard GB của két bị TRỪ đúng `draw` trong giao dịch ký. Trả `reset_amount` của
/// shard sau lượt này (cho trần mỗi-két-mỗi-epoch).
///
/// Két ép (shard KHÔNG ép được — `gb_shard.ak` đầu tệp):
///   - đúng MỘT input tại `Script(gb_shard_policy_id)`, và nó mang NFT của ĐÚNG shard
///     của két (`shard_id`);
///   - redeemer của input đó là `Draw { amount }` với `amount == draw`;
///   - đúng MỘT output mang NFT đó, cùng địa chỉ, datum `GbShard` cùng `shard_id`.
/// Két ép THÊM (phòng thủ chiều sâu, và để phép kiểm ở tầng két bắt được GB thiếu mà
/// không cần chạy validator shard): shard đi theo đúng `seq` của beacon đang đọc, và
/// `remaining_out == remaining_hiệu_lực − draw >= 0`. Nhánh đặt lại (beacon mới hơn)
/// chỉ ép CẬN TRÊN `reset_amount ≤ ⌊GB/16⌋` — giá trị đúng bằng `min(⌊GB/16⌋, cap)`
/// do validator shard ép, vì trần `cap` là apply-param của shard, két không biết.
pub fn gb_draw_checked(
  tx: Transaction,
  gb_shard_policy_id: PolicyId,
  shard_id: Int,
  draw: Int,
  beacon: GreenBackBeacon,
) -> Int {
  expect draw > 0
  let name = gb_shard_nft_name(shard_id)
  expect [s_in] =
    list.filter(
      tx.inputs,
      fn(i) { i.output.address.payment_credential == Script(gb_shard_policy_id) },
    )
  expect assets.quantity_of(s_in.output.value, gb_shard_policy_id, name) == 1
  expect Some(Pair(_, rd)) =
    list.find(
      tx.redeemers,
      fn(p) {
        let Pair(purpose, _) = p
        purpose == Spend(s_in.output_reference)
      },
    )
  expect rd_typed: GbShardRedeemer = rd
  let Draw { amount } = rd_typed
  expect amount == draw
  expect [s_out] =
    list.filter(
      tx.outputs,
      fn(o) { assets.quantity_of(o.value, gb_shard_policy_id, name) == 1 },
    )
  expect s_out.address == s_in.output.address
  expect InlineDatum(din) = s_in.output.datum
  expect g_in: GbShard = din
  expect InlineDatum(dout) = s_out.datum
  expect g_out: GbShard = dout
  expect g_in.shard_id == shard_id && g_out.shard_id == shard_id
  expect g_out.seq == beacon.seq
  let remaining_eff =
    if beacon.seq > g_in.seq {
      expect g_out.reset_amount <= beacon.gb_nanogic / shard_count
      g_out.reset_amount
    } else {
      expect beacon.seq == g_in.seq
      expect g_out.reset_amount == g_in.reset_amount
      g_in.remaining
    }
  expect g_out.remaining == remaining_eff - draw
  expect g_out.remaining >= 0
  g_out.reset_amount
}

/// Lượng GB két đã rút TRONG epoch `e`, SUY RA từ datum (không có ô nhớ riêng):
/// Σ `m_per_epoch × min(N, buffer_ep)` của hợp đồng có `commit_epoch == e`. Chính xác
/// vì hợp đồng ký ở `e` bắn lượt đầu ở `e + 2` nên không thể xong (bị gỡ) trong `e`.
pub fn drawn_in_epoch(schedules: List<GenSchedule>, e: Int) -> Int {
  list.foldl(
    schedules,
    0,
    fn(s, acc) {
      if s.commit_epoch == e {
        acc + s.m_per_epoch * min2(s.schedule_length, buffer_ep)
      } else {
        acc
      }
    },
  )
}

/// Cộng `generated` vào ô `idx` (0 = epoch đang mở). `idx >= usage_window_len` ⟹ epoch
/// đã ra khỏi cửa sổ, bỏ (SPEC §6.1.2 "bỏ nếu `e'` đã ra khỏi cửa sổ"). `idx < 0` hoặc
/// `generated < 0` ⟹ fail.
pub fn window_add_at(
  window: List<EpochUsage>,
  idx: Int,
  generated: Int,
) -> List<EpochUsage> {
  expect idx >= 0 && generated >= 0
  if idx >= usage_window_len {
    window
  } else {
    list.indexed_map(
      window,
      fn(i, u) {
        if i == idx {
          EpochUsage { generated: u.generated + generated, consumed: u.consumed }
        } else {
          u
        }
      },
    )
  }
}

test window_add_at_hits_cell() {
  let z = EpochUsage { generated: 0, consumed: 0 }
  let w = [z, z, z, z, z, z, z]
  list.at(window_add_at(w, 3, 5), 3) == Some(EpochUsage { generated: 5, consumed: 0 })
}

test window_add_at_out_of_window_dropped() {
  let z = EpochUsage { generated: 0, consumed: 0 }
  let w = [z, z, z, z, z, z, z]
  window_add_at(w, 7, 5) == w
}
