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
  applyParamsToScript, validatorToScriptHash, credentialToRewardAddress, scriptHashToCredential,
  type TxBuilder, type UTxO,
} from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
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

// ── suy script did_stake từ DID ───────────────────────────────────────────────
//
// `did_stake(anchor_nft_policy, anchor_nft_name)` (PhoenixKey-Validator ▸ validators/did_stake.ak)
// apply HAI tham số theo đúng thứ tự đó: policy anchor (hằng theo mạng) và tên NFT anchor =
// blake2b_256(did). Nên từ chuỗi DID cộng script CHƯA apply là suy ra được script + hash của chủ
// `Script(h)`, app không phải gửi CBOR. Script chưa apply đổi theo đời validator bên PhoenixKey
// ⟹ người gọi đưa nó qua cấu hình theo mạng, KHÔNG đúc hằng ở đây.

const POLICY_HEX = /^[0-9a-f]{56}$/;
const CBOR_HEX = /^(?:[0-9a-f]{2})+$/;

/** Tên NFT anchor của một DID: hex của blake2b_256(utf8(did)) — 64 ký tự. */
export function didAnchorNftName(did: string): string {
  if (typeof did !== "string" || did.length === 0) {
    throw new Error("didAnchorNftName: did phải là chuỗi khác rỗng.");
  }
  return bytesToHex(blake2b(utf8ToBytes(did), { dkLen: 32 }));
}

export interface DidStakeScriptForDidInput {
  /** CBOR `did_stake` CHƯA apply tham số (hex). */
  unappliedCbor: string;
  /** `anchor_nft_policy` của mạng (56 hex). */
  anchorNftPolicy: string;
  did: string;
}

/** Script `did_stake` đã apply `(anchorNftPolicy, didAnchorNftName(did))` cùng hash của nó. */
export function didStakeScriptForDid(input: DidStakeScriptForDidInput): { cbor: string; hash: string } {
  if (!CBOR_HEX.test(input.unappliedCbor)) {
    throw new Error("didStakeScriptForDid: unappliedCbor phải là hex thường, số ký tự chẵn, khác rỗng.");
  }
  if (!POLICY_HEX.test(input.anchorNftPolicy)) {
    throw new Error("didStakeScriptForDid: anchorNftPolicy phải là 56 hex thường.");
  }
  const cbor = applyParamsToScript(input.unappliedCbor, [input.anchorNftPolicy, didAnchorNftName(input.did)]);
  return { cbor, hash: validatorToScriptHash({ type: "PlutusV3", script: cbor }) };
}
