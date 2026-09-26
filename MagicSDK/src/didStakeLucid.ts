// MagicSDK/src/didStakeLucid.ts — nối cổng Lucid cho nhân chứng chủ `did_stake`.
//
// Chính sách (so hash, tra số dư, hình dạng mục rút) nằm ở `@magiclamp/protocol-utils` ▸
// `didStakeOwnerAuth`. Tệp này chỉ cấp hai phép tính cần Lucid — băm script PlutusV3 và
// dựng địa chỉ thưởng — cộng với hàm tra tài khoản thưởng do NGƯỜI GỌI đưa vào.
//
// Vì sao không tự tra số dư qua `lucid.config().provider.getDelegation`: hàm đó trả
// `{ poolId, rewards }` và KHÔNG nói tài khoản đã đăng ký hay chưa — một tài khoản chưa đăng
// ký và một tài khoản đã đăng ký số dư 0 ra cùng một hình dạng. Đoán "đăng ký rồi" ở đó là
// dựng giao dịch cho đúng ca ledger từ chối. Người gọi phải đưa một nguồn phân biệt được hai
// ca (Blockfrost `/accounts/{stake}`: 404 hoặc `active: false` ⟹ chưa đăng ký).

import {
  validatorToScriptHash, credentialToRewardAddress, scriptHashToCredential,
  type TxBuilder, type UTxO,
} from "@lucid-evolution/lucid";
import {
  didStakeOwnerAuth,
  type DidStakePorts, type DidStakeOwnerAuth, type DidStakeWitnessInput, type RewardAccountState,
} from "@magiclamp/protocol-utils";

export function didStakeLucidPorts(
  rewardAccount: (rewardAddress: string) => Promise<RewardAccountState>,
): DidStakePorts {
  return {
    scriptHashOf: (cbor) => validatorToScriptHash({ type: "PlutusV3", script: cbor }),
    rewardAddressOf: (network, hash) =>
      credentialToRewardAddress(network, scriptHashToCredential(hash)),
    rewardAccount,
  };
}

/**
 * `OwnerAuth` nhánh script cho chủ `did_stake`, sẵn để truyền vào `ownerAuth` của mọi bộ
 * dựng (withdrawLamp, updateProfile, createVault, buildInstantGenTx, buildScheduleCommitTx,
 * buildConsumeTx…).
 *
 * Dựng một lần cho MỘT giao dịch: số dư thưởng chụp lúc gọi (xem khối ⚠ ở
 * `ProtocolUtils/src/didStakeOwnerAuth.ts`).
 */
export function didStakeOwnerAuthLucid(
  input: DidStakeWitnessInput<UTxO>,
  rewardAccount: (rewardAddress: string) => Promise<RewardAccountState>,
): Promise<DidStakeOwnerAuth<TxBuilder>> {
  return didStakeOwnerAuth<TxBuilder, UTxO>(input, didStakeLucidPorts(rewardAccount));
}
