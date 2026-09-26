// src/didStakeOwnerAuth.ts — nhân chứng chủ `Script(h)` khi h là validator `did_stake` của
// PhoenixKey.
//
// Nhánh `script` của `OwnerAuth` chỉ nói "gọi `attachWithdraw(tx)` đúng một lần". Tệp này
// dựng hàm đó cho ĐÚNG MỘT loại script chủ: `did_stake`. Dữ kiện về `did_stake` do nhà
// Phoenix cung cấp và đã xác nhận (2026-09-26); kho này KHÔNG giữ mã nguồn validator đó:
//
//   · h = blake2b_224(0x03 ‖ cbor) của `did_stake` đã apply
//     `(anchor_nft_policy, blake2b_256(utf8(did)))`. Tệp này KHÔNG apply tham số — nó nhận
//     CBOR đã apply rồi BĂM LẠI và so với `owner.hash`. Lệch ⟹ `OWNER_AUTH_MISMATCH`.
//   · Redeemer `Authorize` = `Constr 0 []` (CBOR `d87980`).
//   · Script đính INLINE (Preprod chưa có ref-script cho `did_stake`).
//   · UTxO anchor DID là REFERENCE input, và phải đang ở trạng thái Active. Trạng thái đó
//     KHÔNG kiểm ở đây: lược đồ datum anchor thuộc nhà Phoenix, kho này không giữ nó. Anchor
//     không Active ⟹ `did_stake` từ chối trên chuỗi.
//   · `required_signers` = khoá controller + MỘT khoá thiết bị.
//   · Lượng rút = ĐÚNG số dư thưởng hiện có của tài khoản `Script(h)` — ledger ép, không
//     phải validator. Tra qua cổng `rewardAccount`, KHÔNG gõ cứng 0. Tài khoản chưa đăng
//     ký ⟹ `OWNER_STAKE_NOT_REGISTERED`, không dựng giao dịch.
//
// Gói này cố ý không phụ thuộc Lucid (xem `ownerAuth.ts`), nên ba việc cần thư viện Cardano
// — băm script, dựng địa chỉ thưởng, đọc tài khoản thưởng — đi vào qua `DidStakePorts`. Mỗi
// gói có Lucid tự nối cổng (MagicSDK ▸ `didStakeLucidPorts`).
//
// ⚠ Số dư chụp LÚC GỌI hàm này. Giao dịch nộp sau một ranh giới epoch mà thưởng vừa được
//   cộng thì ledger từ chối (lượng rút ≠ số dư). Dựng xong thì nộp ngay; bị từ chối vì
//   lượng rút thì dựng lại, đừng sửa số tay.

import type { Network } from "./index.js";
import {
  OwnerAuthError, assertHash28, sameOwner, ownerRefToString,
  type OwnerAuth, type OwnerRef,
} from "./ownerAuth.js";

/** Redeemer `Authorize` của `did_stake` = `Constr 0 []`. */
export const DID_STAKE_AUTHORIZE_REDEEMER = "d87980";

/** Bề mặt giao dịch tệp này cần — trùng tên và thứ tự tham số với `TxBuilder` của Lucid
 *  Evolution 0.4.30, nên một `TxBuilder` thật thoả kiểu này mà không cần bọc. */
export interface DidStakeTxLike<Tx> {
  readFrom(utxos: any[]): Tx;
  withdraw(rewardAddress: string, amount: bigint, redeemer?: string): Tx;
  attach: { WithdrawalValidator(script: { type: "PlutusV3"; script: string }): Tx };
  addSignerKey(keyHash: string): Tx;
}

/** Tài khoản thưởng như nhà cung cấp chuỗi thấy. Hai trường đều BẮT BUỘC. */
export interface RewardAccountState {
  /** Đã đăng ký làm stake credential (đang hoạt động). */
  registered: boolean;
  /** Số lovelace rút được NGAY BÂY GIỜ. Ledger đòi mục rút bằng đúng số này. */
  withdrawableLovelace: bigint;
}

export interface DidStakePorts {
  /** blake2b_224(0x03 ‖ cbor) — hash của script PlutusV3. */
  scriptHashOf(scriptCbor: string): string;
  /** Địa chỉ thưởng (bech32 `stake…`) của credential `Script(h)` trên `network`. */
  rewardAddressOf(network: Network, scriptHash: string): string;
  /** Tra tài khoản thưởng. Không đọc được thì NÉM — đừng trả một trạng thái đoán. */
  rewardAccount(rewardAddress: string): Promise<RewardAccountState>;
}

export interface DidStakeWitnessInput<U> {
  /** Chủ trong datum. Phải là `{ type: "script" }`. */
  owner: OwnerRef;
  /** CBOR của `did_stake` ĐÃ apply `(anchor_nft_policy, blake2b_256(utf8(did)))`. */
  didStakeScriptCbor: string;
  /** UTxO anchor DID — thành reference input. */
  anchorRefUtxo: U;
  controllerPkh: string;
  deviceKeyHash: string;
  network: Network;
}

/** Chi tiết đã gắn — để tầng API nói cho app biết cần ký bằng khoá nào. */
export interface DidStakeWitnessDetails {
  scriptHash: string;
  rewardAddress: string;
  withdrawLovelace: bigint;
  requiredSigners: [controllerPkh: string, deviceKeyHash: string];
  redeemerCbor: string;
}

export type DidStakeOwnerAuth<Tx> = Extract<OwnerAuth<Tx>, { kind: "script" }> & {
  details: DidStakeWitnessDetails;
};

const CBOR_HEX = /^(?:[0-9a-f]{2})+$/;

/**
 * Dựng `OwnerAuth` nhánh script cho chủ `did_stake`.
 *
 * Thứ tự kiểm là thứ tự RẺ → ĐẮT, và mọi phép kiểm xong TRƯỚC khi chạm mạng:
 *   1. chủ phải là script, các hash phải đúng 28 byte, CBOR phải là hex chẵn;
 *   2. hash của CBOR phải BẰNG `owner.hash` — không thì `OWNER_AUTH_MISMATCH`;
 *   3. tra tài khoản thưởng: chưa đăng ký ⟹ `OWNER_STAKE_NOT_REGISTERED`; hình dạng lạ ⟹ ném.
 */
export async function didStakeOwnerAuth<Tx extends DidStakeTxLike<Tx>, U>(
  input: DidStakeWitnessInput<U>,
  ports: DidStakePorts,
): Promise<DidStakeOwnerAuth<Tx>> {
  const owner = input.owner;
  if (owner === null || typeof owner !== "object" || owner.type !== "script") {
    throw new OwnerAuthError(
      "OWNER_AUTH_MISMATCH",
      `nhân chứng did_stake chỉ dùng cho chủ script, chủ nhận được là ` +
        `${owner && typeof owner === "object" ? ownerRefToString(owner) : String(owner)}.`,
    );
  }
  const ownerHash = assertHash28(owner.hash, "script hash của chủ");
  const controllerPkh = assertHash28(input.controllerPkh, "controller_pkh");
  const deviceKeyHash = assertHash28(input.deviceKeyHash, "device_key_hash");

  const cbor = typeof input.didStakeScriptCbor === "string" ? input.didStakeScriptCbor.toLowerCase() : "";
  if (!CBOR_HEX.test(cbor)) {
    throw new OwnerAuthError(
      "OWNER_CREDENTIAL_SHAPE",
      `did_stake_script_cbor phải là hex số ký tự chẵn, khác rỗng.`,
    );
  }
  if (input.anchorRefUtxo === null || typeof input.anchorRefUtxo !== "object") {
    throw new OwnerAuthError(
      "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
      `thiếu UTxO anchor DID (reference input bắt buộc của did_stake).`,
    );
  }

  const got = assertHash28(ports.scriptHashOf(cbor), "hash của did_stake_script_cbor");
  if (!sameOwner({ type: "script", hash: got }, { type: "script", hash: ownerHash })) {
    throw new OwnerAuthError(
      "OWNER_AUTH_MISMATCH",
      `did_stake_script_cbor băm ra ${got} nhưng chủ trong datum là script:${ownerHash}. ` +
        `Script này không phải chủ của vault — thường do apply sai DID hoặc sai anchor_nft_policy.`,
    );
  }

  const rewardAddress = ports.rewardAddressOf(input.network, ownerHash);
  const acct = await ports.rewardAccount(rewardAddress);
  if (
    acct === null || typeof acct !== "object" ||
    typeof acct.registered !== "boolean" || typeof acct.withdrawableLovelace !== "bigint" ||
    acct.withdrawableLovelace < 0n
  ) {
    throw new OwnerAuthError(
      "OWNER_CREDENTIAL_SHAPE",
      `cổng rewardAccount trả hình dạng lạ cho ${rewardAddress} — cần ` +
        `{ registered: boolean, withdrawableLovelace: bigint ≥ 0 }.`,
    );
  }
  if (!acct.registered) {
    throw new OwnerAuthError(
      "OWNER_STAKE_NOT_REGISTERED",
      `tài khoản thưởng ${rewardAddress} (script:${ownerHash}) chưa đăng ký stake. Ledger ` +
        `không nhận mục rút nào cho nó, nên mọi nhánh cần quyền chủ đóng băng tới khi DID ` +
        `đăng ký stake credential.`,
    );
  }
  const amount = acct.withdrawableLovelace;
  const script = { type: "PlutusV3" as const, script: cbor };

  return {
    kind: "script",
    hash: ownerHash,
    attachWithdraw: (tx: Tx): Tx =>
      tx
        .readFrom([input.anchorRefUtxo])
        .withdraw(rewardAddress, amount, DID_STAKE_AUTHORIZE_REDEEMER)
        .attach.WithdrawalValidator(script)
        .addSignerKey(controllerPkh)
        .addSignerKey(deviceKeyHash),
    details: {
      scriptHash: ownerHash,
      rewardAddress,
      withdrawLovelace: amount,
      requiredSigners: [controllerPkh, deviceKeyHash],
      redeemerCbor: DID_STAKE_AUTHORIZE_REDEEMER,
    },
  };
}
