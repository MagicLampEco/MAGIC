//// Sổ két được phép (`VaultRegistry`) — kiểm hình dạng lúc genesis, đọc lúc tiêu shard.

use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/primitive/bytearray
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input}
use genbeacons/constants
use genbeacons/types.{VaultRegistry}
use genbeacons/util

/// Hình dạng hợp lệ của danh sách két: không rỗng, mỗi phần tử đúng 28 byte, không trùng.
/// Trùng lặp vô hại cho `list.has` nhưng là dấu hiệu dựng sai; rỗng ⟹ không shard nào rút
/// được (sổ chết, không sửa được vì spend luôn từ chối). O(n²) — n là số LOẠI két (2–3).
pub fn vault_list_ok(hashes: List<ScriptHash>) -> Bool {
  when hashes is {
    [] -> False
    _ -> no_dup_28(hashes)
  }
}

fn no_dup_28(hashes: List<ScriptHash>) -> Bool {
  when hashes is {
    [] -> True
    [h, ..rest] -> and {
        bytearray.length(h) == constants.script_hash_length,
        !list.has(rest, h),
        no_dup_28(rest),
      }
  }
}

/// Sổ két THẬT trong `ref_inputs`, fail-closed:
///   - đúng MỘT reference input mang NFT `(registry_policy, "VRG")` (0 hoặc ≥2 ⟹ từ chối);
///   - nó nằm tại `Script(registry_policy)` — policy = hash script sổ vì mint gộp vào cùng
///     validator. Genesis đã ép NFT vào địa chỉ đó và spend luôn từ chối, nên trên chuỗi
///     vế này là lớp thứ hai; giữ vì NFT chỉ chứng minh AI ĐÃ ĐÚC, địa chỉ mới chứng minh
///     datum chưa bị ai ngoài validator sổ đặt (cùng lý do với `read_greenback`);
///   - đúng 1 đơn vị NFT, datum inline giải mã được.
/// Trả danh sách hash két. KHÔNG kiểm lại hình dạng danh sách — genesis đã kiểm.
pub fn read_vault_registry(
  ref_inputs: List<Input>,
  registry_policy: PolicyId,
) -> List<ScriptHash> {
  expect [reg] =
    list.filter(
      ref_inputs,
      fn(i) {
        assets.quantity_of(
          i.output.value,
          registry_policy,
          constants.vault_registry_nft_name,
        ) > 0
      },
    )
  expect util.is_at_script(reg.output.address, registry_policy)
  expect
    assets.quantity_of(
      reg.output.value,
      registry_policy,
      constants.vault_registry_nft_name,
    ) == 1
  expect InlineDatum(d) = reg.output.datum
  expect r: VaultRegistry = d
  r.vault_script_hashes
}
