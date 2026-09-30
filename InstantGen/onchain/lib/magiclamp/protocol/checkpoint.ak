// lib/magiclamp/protocol/checkpoint.ak — "checkpoint" của két InstantGen Gen v2.0
// (gói b1): năm ô `wakeme_link` (6), `cap_epoch` (12), `cap_nanogic` (14),
// `usage_window` (18), `usage_window_epoch` (19).
//
// Mọi nhánh spend GHI năm ô này qua đúng một đường: `expected_checkpoint` tính trạng
// thái mong đợi từ (datum vào, reference input, epoch hiện tại), rồi
// `checkpoint_written` so với datum ra. Không nhánh nào nhận giá trị các ô này từ
// redeemer.
//
// ═══ LUẬT (kế hoạch v2 §2 "Luật cho wakeme_link / cap_*", 1–6) ═══════════════
// 1. `link` SUY RA: đúng một két Wakeme thoả (a)(b)(c)(e) của `wakeme_lent` trong
//    reference input ⟹ link := `owner_commit` của két đó. Chỉ nhánh CHỦ KÝ đổi được
//    link (`FollowVault`, `FollowVaultOrUnlink`); nhánh không chữ ký (`KeepLink`,
//    PruneExpired) không đổi được.
// 2. Link đã đặt mà lượt này làm mới cap ⟹ BẮT BUỘC có két trong reference input.
//    Chặn đòn "bỏ reference input để L_lent = 0, hạ cap". Ngoại lệ duy nhất là
//    RefreshCheckpoint (`FollowVaultOrUnlink`): thiếu két ⟹ link := "".
// 3. Làm mới khi `cap_epoch < e` (hoặc RefreshCheckpoint luôn làm mới):
//    `cap_epoch := e`, `cap_nanogic := amount_by_lamp(L_owned, L_lent, cửa sổ đã
//    dịch, ρ(e), horizon)`, dịch cửa sổ sang `e`. `cap_epoch == e` và không ép ⟹
//    năm ô GHIM nguyên, không đọc gì bên ngoài.
// 4. WithdrawLamp KHÔNG gọi `expected_checkpoint`: ghim nguyên (`current_checkpoint`),
//    không đọc reference input (SPEC §6.1.5: rút LAMP không phụ thuộc beacon).
// ρ đọc từ beacon `RateParam` qua reference input, hai lớp neo: địa chỉ
// `Script(rate_script_hash)` + NFT `(rate_nft_policy, "RHO")`. Thiếu / hai cái /
// datum sai hình / ρ ngoài `[0, rho_max_q]` ⟹ FAIL, không có ρ mặc định.

use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Input}
use magiclamp/protocol/constants.{
  instant_scale_horizon, rho_max_q, usage_window_len,
}
use magiclamp/protocol/gen_formula.{amount_by_lamp, shift_window}
use magiclamp/protocol/lamp.{l_avail}
use magiclamp/protocol/types.{EpochUsage, RateParam, VaultDatum}
use magiclamp/protocol/wakeme_lent.{wakeme_read}

/// Tên NFT beacon ρ ("RHO"). CHÉP CÓ NHÃN từ `GenBeacons/onchain/lib/genbeacons/
/// constants.ak` ▸ `rate_nft_name` (MAGIC@1e9a72d9, 2026-09-30).
pub const rate_nft_name: ByteArray = #"52484f"

/// Apply-param của validator vault, gom thành một bản ghi để truyền vào các nhánh.
/// Thứ tự apply-param thật nằm ở chữ ký `validator vault(...)`, KHÔNG ở đây.
pub type VaultParams {
  lamp_policy_id: PolicyId,
  lamp_asset_name: AssetName,
  gb_beacon_nft_policy: PolicyId,
  gb_beacon_script_hash: ScriptHash,
  gb_shard_policy_id: PolicyId,
  rate_nft_policy: PolicyId,
  rate_script_hash: ScriptHash,
  wakeme_vault_hash: ScriptHash,
  ms_per_epoch: Int,
}

/// Nhánh đang ghi có quyền gì với `wakeme_link`.
pub type LinkMode {
  /// Nhánh chủ ký (BurnBatch, UpdateProfile, SetDelegate): link theo két trong
  /// reference input; link đã đặt mà thiếu két ⟹ fail (luật 2).
  FollowVault
  /// RefreshCheckpoint: như `FollowVault`, nhưng thiếu két ⟹ link := "" (luật 5).
  FollowVaultOrUnlink
  /// Nhánh không chữ ký (PruneExpired): link KHÔNG đổi. Link đặt ⟹ bắt buộc có
  /// đúng két đó; link rỗng ⟹ không được đưa két nào vào.
  KeepLink
}

pub type Checkpoint {
  wakeme_link: ByteArray,
  cap_epoch: Int,
  cap_nanogic: Int,
  usage_window: List<EpochUsage>,
  usage_window_epoch: Int,
}

/// Năm ô như đang nằm trong datum — dùng cho ghim nguyên.
pub fn current_checkpoint(d: VaultDatum) -> Checkpoint {
  Checkpoint {
    wakeme_link: d.wakeme_link,
    cap_epoch: d.cap_epoch,
    cap_nanogic: d.cap_nanogic,
    usage_window: d.usage_window,
    usage_window_epoch: d.usage_window_epoch,
  }
}

/// ρ hiệu lực ở epoch `e` từ ĐÚNG MỘT beacon `RateParam` trong reference input.
/// Gương `genbeacons/rate.rho_at`: `rho_q` nếu `e >= effective_epoch`, ngược lại
/// `prev_rho_q`.
pub fn read_rho(
  reference_inputs: List<Input>,
  rate_nft_policy: PolicyId,
  rate_script_hash: ScriptHash,
  e: Int,
) -> Int {
  // Hai lớp: NFT chứng minh ai ĐÃ ĐÚC, địa chỉ script quản trị chứng minh datum
  // HIỆN TẠI đi qua validator ghi beacon. Thiếu lớp địa chỉ thì người cầm NFT
  // chuyển nó sang ví thường kèm datum tuỳ ý.
  let beacons =
    list.filter(
      reference_inputs,
      fn(i) {
        i.output.address.payment_credential == Script(rate_script_hash) && assets.quantity_of(
          i.output.value,
          rate_nft_policy,
          rate_nft_name,
        ) == 1
      },
    )
  expect [beacon] = beacons
  expect InlineDatum(raw) = beacon.output.datum
  expect rp: RateParam = raw
  let rho =
    if e >= rp.effective_epoch {
      rp.rho_q
    } else {
      rp.prev_rho_q
    }
  // Phòng thủ chiều sâu: validator beacon đã ép khoảng này lúc ghi.
  expect rho >= 0 && rho <= rho_max_q
  rho
}

/// Trạng thái checkpoint mà datum ra PHẢI mang (trước phần cộng dồn riêng của
/// nhánh, ví dụ BurnBatch cộng `consumed` vào ô 0 SAU bước này).
///
/// `force = True` chỉ dành cho RefreshCheckpoint (luôn làm mới, kể cả cùng epoch).
/// `d` là datum vào (đã áp profile chờ nếu nhánh có áp — các ô LAMP không đổi).
pub fn expected_checkpoint(
  d: VaultDatum,
  reference_inputs: List<Input>,
  e: Int,
  mode: LinkMode,
  force: Bool,
  own_script_hash: ScriptHash,
  own_vault_name: AssetName,
  params: VaultParams,
) -> Checkpoint {
  // Thời gian không lùi so với lượt làm mới gần nhất.
  expect e >= d.cap_epoch
  if !force && d.cap_epoch == e {
    current_checkpoint(d)
  } else {
    let window = shift_window(d.usage_window, d.usage_window_epoch, e)
    let read =
      wakeme_read(
        reference_inputs,
        params.wakeme_vault_hash,
        own_script_hash,
        own_vault_name,
        e,
        params.lamp_policy_id,
        params.lamp_asset_name,
      )
    let (link, lent) =
      when read is {
        Some((owner_commit, lent)) ->
          when mode is {
            KeepLink -> {
              // Nhánh không chữ ký: két đưa vào phải là két ĐÃ ghim.
              expect owner_commit == d.wakeme_link
              (owner_commit, lent)
            }
            _ -> (owner_commit, lent)
          }
        None ->
          when mode is {
            FollowVaultOrUnlink -> (#"", 0)
            _ -> {
              // Luật 2: đã ghim thì bắt buộc đọc.
              expect d.wakeme_link == #""
              (#"", 0)
            }
          }
      }
    let rho =
      read_rho(reference_inputs, params.rate_nft_policy, params.rate_script_hash, e)
    let cap =
      amount_by_lamp(
        l_avail(d.lamp_balance, d.lamp_locked),
        lent,
        window,
        rho,
        instant_scale_horizon,
      )
    Checkpoint {
      wakeme_link: link,
      cap_epoch: e,
      cap_nanogic: cap,
      usage_window: window,
      usage_window_epoch: e,
    }
  }
}

/// Datum ra mang ĐÚNG năm ô của `cp`.
pub fn checkpoint_written(out: VaultDatum, cp: Checkpoint) -> Bool {
  and {
    out.wakeme_link == cp.wakeme_link,
    out.cap_epoch == cp.cap_epoch,
    out.cap_nanogic == cp.cap_nanogic,
    out.usage_window == cp.usage_window,
    out.usage_window_epoch == cp.usage_window_epoch,
  }
}

/// Cửa sổ 7 ô toàn 0 — trạng thái genesis.
pub fn empty_window() -> List<EpochUsage> {
  list.repeat(EpochUsage { generated: 0, consumed: 0 }, usage_window_len)
}
