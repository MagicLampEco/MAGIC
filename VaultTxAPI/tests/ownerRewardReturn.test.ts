// VaultTxAPI/tests/ownerRewardReturn.test.ts — thưởng `did_stake` qua ví trả phí về ví Phoenix của chủ.
//
// Ba tầng, mỗi tầng một CẶP ca:
//   (1) suy địa chỉ ví Phoenix (`didOwner.ts` ▸ `didPaymentAddressFor`) khớp vector DID #1 của PhoenixKey-Core
//       (`rust_core/src/phoenix_address.rs` ▸ `VECTORS`, tính độc lập bằng aiken CLI); anchor của DID KHÁC
//       hoặc cấu hình thiếu ⟹ `missing`, không đoán;
//   (2) chốt trước khi dựng (`planOwnerRewardReturn`): biên min-ADA đúng một lovelace;
//   (3) đọc lại CBOR (`checkFeePayerTx`): output R tới ví Phoenix + tiền thối ví trả phí KHÔNG chứa R;
//       mọi biến thể lệch (R vào thối, R tới chỗ lạ, R−1, datum, hai output, mục rút lệch) ⟹ 422.

import { credentialToRewardAddress, unixTimeToSlot, validatorToScriptHash, type UTxO } from "@lucid-evolution/lucid";
import { didAnchorNftName } from "@magiclamp/sdk";
import { describe, expect, it } from "vitest";

import type { DidStakeDeployment } from "../src/config.js";
import { didPaymentAddressFor } from "../src/didOwner.js";
import { CodedApiError } from "../src/errors.js";
import {
  checkFeePayerTx, planOwnerRewardReturn, pureAdaMinCoin, type FeePayerCheckContext, type OwnerRewardReturn,
} from "../src/feePayer.js";
import { enterpriseAddressOf } from "../src/txBuilder.js";
import { DID_PAYMENT_UNAPPLIED_CBOR, DID_STAKE_UNAPPLIED_CBOR } from "./fixtures/phoenixScripts.js";
import { buildTxCbor, type TxOutputSpec } from "./fixtures/tx.js";

// ── vector PhoenixKey-Core `phoenix_address.rs` ▸ `VECTORS` (DID #1 Preprod + alice) ───────────────
/** `taad` sau apply trên Preprod — cũng ở `scripts/DEPLOYED.md` (anchor DID). */
const POLICY = "e97ace3451c5ce54063fdc3f379112c335c39f0379ad6a2766ed6a4c";
const DID_1 = "did:phoenix:aaaadiif2k7sa:c7bc9220a245a5bc1813868592b4a2ca4fdb85b14314fb594a4e9b40a083a77e";
const ANCHOR_1 = "9e64482f072657d504b5ef8400372c22b017c18b736303f591ffc1f5dc5f2a4c";
const PAY_1 = "fae088434d538b98683a897a551205360f30b6f6444b028ac29ceec6";
/** Hash `did_stake` đã apply của DID #1 — hash ĐÃ ĐĂNG KÝ trên Preprod. */
const STAKE_1 = "fbbc90f11088dc8e5ae09df7d5c6563d1828c67c1bf395a47743131b";
const ADDR_1 = "addr_test1xrawpzzrf4fchxrg82yh54gjq5mq7v9k7ezykq52c2wwa3hmhjg0zyygmj894cya7l2uv43arq5vvlqm7w26ga6rzvdscfzeuc";
/** Anchor của `did:phoenix:person:alice` — một DID KHÁC. */
const ANCHOR_ALICE = "1643c0c9f776c4b173c475019e8d83b59e0269fa5d21f7fbe8e15af14c9ac470";
const DID_PAYMENT_UNAPPLIED_HASH = "cc9e5c10d2c79000f69aca547f3ecf26be14b4ec11931f9281c5e646";

const script = (cbor: string) => ({ cbor, hash: validatorToScriptHash({ type: "PlutusV3", script: cbor }) });
const DID_STAKE: DidStakeDeployment = {
  anchorNftPolicy: POLICY,
  unappliedScript: script(DID_STAKE_UNAPPLIED_CBOR),
  didPaymentUnappliedScript: script(DID_PAYMENT_UNAPPLIED_CBOR),
};
const REWARD_1 = credentialToRewardAddress("Preprod", { type: "Script", hash: STAKE_1 });
/** coinsPerUtxoByte của Preprod/Mainnet hiện hành. */
const COINS_PER_BYTE = 4_310n;

describe("didPaymentAddressFor — vector DID #1 của PhoenixKey-Core", () => {
  it("fixture đúng bản đã ghim: hash did_payment chưa apply cc9e5c10…, did_stake chưa apply 97e86a21…; anchor = blake2b_256(did)", () => {
    expect(DID_STAKE.didPaymentUnappliedScript!.hash).toBe(DID_PAYMENT_UNAPPLIED_HASH);
    expect(DID_STAKE.unappliedScript!.hash.startsWith("97e86a21")).toBe(true);
    expect(didAnchorNftName(DID_1)).toBe(ANCHOR_1);
  });

  it("dương: DID #1 ⟹ đúng địa chỉ BASE Preprod của vector + đúng hash did_payment đã apply", () => {
    expect(didPaymentAddressFor({ didStake: DID_STAKE, anchorNftName: ANCHOR_1, ownerHash: STAKE_1, network: "Preprod" }))
      .toEqual({ address: ADDR_1, didPaymentHash: PAY_1 });
  });

  it("CỰC ĐỐI: anchor của DID KHÁC với chủ DID #1 ⟹ missing owner_witness.anchor_ref, không ra địa chỉ nào", () => {
    const r = didPaymentAddressFor({ didStake: DID_STAKE, anchorNftName: ANCHOR_ALICE, ownerHash: STAKE_1, network: "Preprod" });
    expect(r).toMatchObject({ missing: "owner_witness.anchor_ref" });
    expect("address" in r).toBe(false);
  });

  it.each<[string, DidStakeDeployment | undefined, string | undefined, string]>([
    ["không có khối did_stake", undefined, ANCHOR_1, "deployment.did_stake"],
    ["thiếu did_payment chưa apply", { anchorNftPolicy: POLICY, unappliedScript: DID_STAKE.unappliedScript! },
      ANCHOR_1, "deployment.did_stake.did_payment_unapplied_script"],
    ["thiếu did_stake chưa apply", { anchorNftPolicy: POLICY, didPaymentUnappliedScript: DID_STAKE.didPaymentUnappliedScript! },
      ANCHOR_1, "deployment.did_stake.unapplied_script"],
    ["UTxO anchor không mang NFT anchor", DID_STAKE, undefined, "owner_witness.anchor_ref"],
  ])("CỰC ĐỐI cấu hình/nhân chứng: %s ⟹ missing %s", (_n, didStake, anchorNftName, missing) => {
    expect(didPaymentAddressFor({ didStake, anchorNftName, ownerHash: STAKE_1, network: "Preprod" }))
      .toMatchObject({ missing });
  });
});

describe("planOwnerRewardReturn — biên min-ADA", () => {
  const minAda = pureAdaMinCoin(ADDR_1, COINS_PER_BYTE);
  const found = () => ({ address: ADDR_1, didPaymentHash: PAY_1 });
  const plan = (r: bigint) =>
    planOwnerRewardReturn({ rewardAddress: REWARD_1, withdrawLovelace: r }, found, async () => COINS_PER_BYTE);

  it("R = min-ADA ⟹ output R về ví Phoenix; CẶP: R = min-ADA − 1 ⟹ 422 FEE_PAYER_OWNER_REWARD_BELOW_MIN_ADA", async () => {
    expect(minAda > 0n).toBe(true);
    await expect(plan(minAda)).resolves.toEqual({ rewardAddress: REWARD_1, lovelace: minAda, didPaymentAddress: ADDR_1 });
    let caught: unknown;
    try { await plan(minAda - 1n); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CodedApiError);
    expect((caught as CodedApiError).httpStatus).toBe(422);
    expect((caught as CodedApiError).code).toBe("FEE_PAYER_OWNER_REWARD_BELOW_MIN_ADA");
    expect((caught as CodedApiError).details).toMatchObject({ min_lovelace: minAda.toString(), did_payment_address: ADDR_1 });
  });
});

// ── đọc lại CBOR ─────────────────────────────────────────────────────────────

const NOW = 1_789_100_703_000;
const TTL_SLOT = BigInt(unixTimeToSlot("Preprod", NOW + 1_800_000));
const FEE_ADDRESS = enterpriseAddressOf("Preprod", "fe".repeat(28));
const STRANGER = enterpriseAddressOf("Preprod", "5a".repeat(28));
const FEE_IN = 10_000_000n;
const FEE = 200_000n;
const R = 3_141_592n;
const FEE_UTXO: UTxO = { txHash: "fa".repeat(32), outputIndex: 0, address: FEE_ADDRESS, assets: { lovelace: FEE_IN } };
const RET: OwnerRewardReturn = { rewardAddress: REWARD_1, lovelace: R, didPaymentAddress: ADDR_1 };

function ctxOf(ret: OwnerRewardReturn | undefined): FeePayerCheckContext {
  return {
    network: "Preprod", tipPosixMs: BigInt(NOW), feePayer: { utxoRef: { txHash: FEE_UTXO.txHash, outputIndex: 0 }, address: FEE_ADDRESS },
    feePayerUtxo: FEE_UTXO, maxCollateralLovelace: 3_000_000n, otherInputs: [], otherInputAddresses: [],
    ...(ret === undefined ? {} : { ownerRewardReturn: ret }),
  };
}

/** Tx tối giản đi ví trả phí: chỉ UTxO trả phí là input; `withdraw` lovelace rút ở địa chỉ thưởng DID #1. */
function rewardTx(o: { withdraw: bigint; outputs: TxOutputSpec[]; change: bigint }): string {
  return buildTxCbor({
    inputs: [{ txHash: FEE_UTXO.txHash, outputIndex: 0 }],
    collateralInputs: [{ txHash: FEE_UTXO.txHash, outputIndex: 0 }],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: 7_000_000n } },
    ttlSlot: TTL_SLOT,
    feeLovelace: FEE,
    ...(o.withdraw === 0n ? {} : { withdrawals: [{ rewardAddress: REWARD_1, lovelace: o.withdraw }] }),
    outputs: [...o.outputs, { address: FEE_ADDRESS, assets: { lovelace: o.change } }],
  });
}
const mismatch = (f: () => unknown, re: RegExp) => {
  let caught: unknown;
  try { f(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(CodedApiError);
  expect((caught as CodedApiError).code).toBe("FEE_PAYER_TX_MISMATCH");
  expect((caught as CodedApiError).message).toMatch(re);
};

describe("checkFeePayerTx — vế thưởng did_stake", () => {
  const good = () => rewardTx({ withdraw: R, outputs: [{ address: ADDR_1, assets: { lovelace: R } }], change: FEE_IN - FEE });

  it("dương: output R tới ví Phoenix; thối ví trả phí = vào − phí (KHÔNG chứa R); summary.owner_reward đọc từ CBOR", () => {
    const s = checkFeePayerTx(good(), ctxOf(RET));
    expect(s.change_lovelace).toBe((FEE_IN - FEE).toString());
    expect(BigInt(s.input_lovelace) - BigInt(s.fee_lovelace) - BigInt(s.change_lovelace)).toBe(0n);
    expect(s.fronted_lovelace).toBe("0");
    expect(s.owner_reward).toEqual({ reward_address: REWARD_1, withdraw_lovelace: R.toString(), did_payment_address: ADDR_1, output_index: 0 });
  });

  it("CẶP R = 0: không mục rút, không output thưởng ⟹ hợp lệ, không có owner_reward", () => {
    const s = checkFeePayerTx(rewardTx({ withdraw: 0n, outputs: [], change: FEE_IN - FEE }), ctxOf(undefined));
    expect(s.owner_reward).toBeUndefined();
  });

  it("ĐỘT BIẾN bỏ output R (R rơi vào thối ví trả phí) ⟹ 422, có hay không có thưởng đã chốt", () => {
    const leaked = rewardTx({ withdraw: R, outputs: [], change: FEE_IN - FEE + R });
    mismatch(() => checkFeePayerTx(leaked, ctxOf(RET)), /0 output về ví Phoenix/);
    mismatch(() => checkFeePayerTx(leaked, ctxOf(undefined)), /mục rút 3141592 lovelace của chủ đang chảy về ví trả phí/);
  });

  it("CỰC ĐỐI: R tới địa chỉ lạ (ví trả phí vẫn cân) ⟹ 422 — chỉ vế thưởng bắt được ca này", () => {
    mismatch(() => checkFeePayerTx(
      rewardTx({ withdraw: R, outputs: [{ address: STRANGER, assets: { lovelace: R } }], change: FEE_IN - FEE }), ctxOf(RET)),
    /0 output về ví Phoenix/);
  });

  it.each<[string, () => string, RegExp]>([
    ["output R − 1, thối +1", () => rewardTx({ withdraw: R, outputs: [{ address: ADDR_1, assets: { lovelace: R - 1n } }], change: FEE_IN - FEE + 1n }),
      /phải thuần ADA, đúng 3141592/],
    ["output mang datum", () => rewardTx({ withdraw: R, outputs: [{ address: ADDR_1, assets: { lovelace: R }, inlineDatumHex: "d87980" }], change: FEE_IN - FEE }),
      /không datum/],
    ["hai output về ví Phoenix", () => rewardTx({
      withdraw: R, outputs: [{ address: ADDR_1, assets: { lovelace: R - 1_500_000n } }, { address: ADDR_1, assets: { lovelace: 1_500_000n } }],
      change: FEE_IN - FEE,
    }), /2 output về ví Phoenix/],
    ["mục rút R + 1 (thối ví trả phí +1)", () => rewardTx({ withdraw: R + 1n, outputs: [{ address: ADDR_1, assets: { lovelace: R } }], change: FEE_IN - FEE + 1n }),
      /mục rút ở .* là 3141593/],
  ])("CỰC ĐỐI: %s ⟹ 422 FEE_PAYER_TX_MISMATCH", (_n, tx, re) => {
    mismatch(() => checkFeePayerTx(tx(), ctxOf(RET)), re);
  });
});
