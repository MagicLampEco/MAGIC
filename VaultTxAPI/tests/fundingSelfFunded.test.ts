// VaultTxAPI/tests/fundingSelfFunded.test.ts — `/tx/create-vault` với `funding.fee_source =
// "did_payment"`: ví Phoenix trả LAMP + min-ADA + phí, seed NFT két là một UTxO did_payment bị
// chi, ví khoá của người dùng CHỈ đứng thế chấp.
//
// Mẫu y như `funding.test.ts`: bộ dựng là `RecordedTxBuilder` (CBOR ghi sẵn, dựng bằng CML tại
// chỗ). Mỗi ca dương có ca đối xứng đổi ĐÚNG một biến — một trường của thân bài, hoặc một vế
// của CBOR — để màu xanh của ca dương không đến từ một lý do rỗng.
import { describe, expect, it } from "vitest";
import {
  credentialToAddress, scriptHashToCredential, unixTimeToSlot, validatorToScriptHash, type UTxO,
} from "@lucid-evolution/lucid";
import type { OwnerRef } from "@magiclamp/protocol-utils";
import { vaultIdAssetName } from "@magiclamp/sdk";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { ChainDidPaymentAnchorReader, parseFunding } from "../src/funding.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder, enterpriseAddressOf, walletUtxoOfFunding } from "../src/txBuilder.js";
import {
  LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH, SHARD_ADDRESS, VAULT_ADDRESS,
  VAULT_ID_UNIT, VAULT_SCRIPT_HASH, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor, type TxOutputSpec } from "./fixtures/tx.js";

const TTL = 180_000;
const NOW = 1_789_100_703_000;
const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };
const FEE = 190_000n;
const DEPOSIT = 1_001_000_000n;
const CTRL = "c1".repeat(28);
const DEV = "d1".repeat(28);
const SPEND = "d87980";

const DP_SCRIPT = "4746010000222220";
const DP_ADDRESS = credentialToAddress("Preview",
  scriptHashToCredential(validatorToScriptHash({ type: "PlutusV3", script: DP_SCRIPT })));
const COLL_ADDRESS = enterpriseAddressOf("Preview", "cc".repeat(28));
const OTHER_KEY_ADDRESS = enterpriseAddressOf("Preview", "ce".repeat(28));
const FEE_ADDRESS = enterpriseAddressOf("Preview", "fe".repeat(28));
const ANCHOR_POLICY = "a0".repeat(28);

const utxo = (txHash: string, outputIndex: number, address: string, assets: Record<string, bigint>): UTxO =>
  ({ txHash, outputIndex, address, assets, datum: null, datumHash: null, scriptRef: null }) as UTxO;
const ANCHOR = utxo("ab".repeat(32), 0, DP_ADDRESS, { lovelace: 2_000_000n, [`${ANCHOR_POLICY}${"01".repeat(32)}`]: 1n });
const COLL_UTXO = utxo("cc".repeat(32), 0, COLL_ADDRESS, { lovelace: 5_000_000n });
const COLL_TOKEN_UTXO = utxo("cd".repeat(32), 0, COLL_ADDRESS, { lovelace: 5_000_000n, [LAMP_UNIT]: 1n });
const FEE_UTXO = utxo("fa".repeat(32), 0, FEE_ADDRESS, { lovelace: 10_000_000n });
// Địa chỉ khoá đúng hình, SAI MẠNG; UTxO nằm đúng ở đó ⟹ chỉ phép kiểm mạng bắt được.
const MAINNET_COLL_ADDRESS = enterpriseAddressOf("Mainnet", "cc".repeat(28));
const MAINNET_COLL_UTXO = utxo("cf".repeat(32), 0, MAINNET_COLL_ADDRESS, { lovelace: 5_000_000n });
const DP1 = utxo("d1".repeat(32), 0, DP_ADDRESS, { lovelace: 3_000_000n, [LAMP_UNIT]: 600_000_000n });
const DP2 = utxo("d2".repeat(32), 1, DP_ADDRESS, { lovelace: 4_000_000n, [LAMP_UNIT]: 500_000_000n });
const DP3 = utxo("d3".repeat(32), 0, DP_ADDRESS, { lovelace: 2_000_000n, [LAMP_UNIT]: 1n });
const ref = (u: UTxO) => ({ txHash: u.txHash, outputIndex: u.outputIndex });
const refS = (u: UTxO) => `${u.txHash}#${u.outputIndex}`;

/** NFT két băm từ seed = DP1 (một UTxO did_payment bị chi). */
const NFT_FROM_DP1 = VAULT_SCRIPT_HASH + vaultIdAssetName(ref(DP1));
/** Cùng policy, băm từ UTxO thế chấp — KHÔNG phải input bị chi. */
const NFT_FROM_COLL = VAULT_SCRIPT_HASH + vaultIdAssetName(ref(COLL_UTXO));

const DEPLOYMENT: Deployment = parseDeployment(JSON.stringify({
  source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
  lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
  vaults: [{ vault_type: "Schedule", address: VAULT_ADDRESS }],
  shard_address: SHARD_ADDRESS,
  ref_script_utxos: {
    vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
  },
  consume: {
    engage_address: VAULT_ADDRESS,
    price_beacon_address: VAULT_ADDRESS,
    price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
  },
}), "Preview");

const KEY_OWNER: OwnerRef = { type: "key", hash: OWNER_PKH };

interface SelfFundedOpts {
  nft?: string;
  extraInput?: UTxO;
  extraOutput?: TxOutputSpec;
  dpChangeLovelace?: bigint;
  collateralInput?: UTxO;
  collateralReturnTo?: string;
  signers?: string[];
  redeemers?: { index: number; dataHex: string }[];
}

/** Tx tạo vault tự trả phí: chi DP1 + DP2 (7 ADA + 1 100 LAMP); vault nhận 5 ADA + 1 001 LAMP +
 *  NFT; thối về ví Phoenix 2 ADA − phí + 99 LAMP. Thế chấp = COLL_UTXO (5 ADA), return 2 ADA ⟹
 *  có thể mất 3 ADA = trần mặc định. Ví thế chấp không có input tiêu, không có output. */
function selfFundedTx(o: SelfFundedOpts = {}): string {
  const nft = o.nft ?? NFT_FROM_DP1;
  const outputs: TxOutputSpec[] = [
    {
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_000_000n, [LAMP_UNIT]: DEPOSIT, [nft]: 1n },
      inlineDatumHex: datumHex({ owner: KEY_OWNER, lampBalanceOildrop: DEPOSIT, lampLockedOildrop: 0n }),
    },
    { address: DP_ADDRESS, assets: { lovelace: o.dpChangeLovelace ?? 2_000_000n - FEE, [LAMP_UNIT]: 99_000_000n } },
  ];
  if (o.extraOutput) outputs.push(o.extraOutput);
  const inputs = [ref(DP1), ref(DP2), ...(o.extraInput ? [ref(o.extraInput)] : [])];
  return buildTxCbor({
    inputs,
    feeLovelace: FEE,
    mint: { [nft]: 1n },
    requiredSigners: o.signers ?? [OWNER_PKH, CTRL, DEV],
    outputs,
    collateralInputs: [ref(o.collateralInput ?? COLL_UTXO)],
    collateralReturn: { address: o.collateralReturnTo ?? COLL_ADDRESS, assets: { lovelace: 2_000_000n } },
    // Thứ tự đã sắp của ledger: d1… < d2… ⟹ DP1 = 0, DP2 = 1 (input thêm "cc…" nếu có đứng trước).
    spendRedeemers: o.redeemers ?? [{ index: 0, dataHex: SPEND }, { index: 1, dataHex: SPEND }],
    ttlSlot: BigInt(unixTimeToSlot("Preview", NOW + 1_800_000)),
  });
}

/** Tx của chế độ MẶC ĐỊNH (ví trả phí FEE_UTXO: phí + thế chấp + seed) — y hình `funding.test.ts`. */
function feePayerTx(): string {
  return buildTxCbor({
    inputs: [ref(FEE_UTXO), ref(DP1), ref(DP2)],
    feeLovelace: FEE,
    mint: { [VAULT_ID_UNIT]: 1n },
    requiredSigners: [OWNER_PKH, CTRL, DEV],
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_000_000n, [LAMP_UNIT]: DEPOSIT, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({ owner: KEY_OWNER, lampBalanceOildrop: DEPOSIT, lampLockedOildrop: 0n }),
      },
      // Chế độ ví trả phí: ví trả phí ỨNG 5 ADA min-ADA vault; did_payment nhận lại trọn 7 ADA đã chi.
      { address: DP_ADDRESS, assets: { lovelace: 7_000_000n, [LAMP_UNIT]: 99_000_000n } },
      { address: FEE_ADDRESS, assets: { lovelace: 10_000_000n - FEE - 5_000_000n } },
    ],
    collateralInputs: [ref(FEE_UTXO)],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: 7_000_000n } },
    spendRedeemers: [{ index: 0, dataHex: SPEND }, { index: 1, dataHex: SPEND }],
    ttlSlot: BigInt(unixTimeToSlot("Preview", NOW + 1_800_000)),
  });
}

function harness(opts: { cbor?: string; nft?: string } = {}) {
  const chain = new RecordedChainReader({ [DP_ADDRESS]: [DP1, DP2, DP3] }, TIP,
    [ANCHOR, FEE_UTXO, COLL_UTXO, COLL_TOKEN_UTXO, MAINNET_COLL_UTXO]);
  const builder = new RecordedTxBuilder({ create_vault: opts.cbor ?? selfFundedTx() }, opts.nft ?? NFT_FROM_DP1);
  const locks = new OwnerLockTable(TTL);
  const service = new VaultTxService({
    network: "Preview", deployment: DEPLOYMENT, chain, builder, locks,
    issued: new IssuedTxRegistry(TTL * 4), lockTtlMs: TTL, now: () => NOW,
    didPaymentAnchor: new ChainDidPaymentAnchorReader({ chain, anchorNftPolicy: ANCHOR_POLICY }),
  });
  const router: RouterDeps = {
    service, deploymentSource: DEPLOYMENT.source, vaultScopes: DEPLOYMENT.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "",
    logInternal: () => {},
  };
  return { builder, router };
}

const BASE_FUNDING = {
  type: "did_payment",
  did_payment_script_cbor: DP_SCRIPT,
  address: DP_ADDRESS,
  anchor_ref: `${ANCHOR.txHash}#0`,
  controller_pkh: CTRL,
  device_key_hash: DEV,
};
const SELF_FUNDED = { ...BASE_FUNDING, fee_source: "did_payment", collateral: { utxo: refS(COLL_UTXO), address: COLL_ADDRESS } };
const FEE_PAYER_MODE = { ...BASE_FUNDING, fee_payer: { utxo: refS(FEE_UTXO), address: FEE_ADDRESS } };
const post = (body: unknown) => ({ method: "POST", url: "/tx/create-vault", headers: {}, body });
const body = (funding: Record<string, unknown>) => ({
  kind: "schedule", owner: KEY_OWNER, lamp_amount: DEPOSIT.toString(), funding,
});
const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const detailsOf = (r: { body: unknown }) => (r.body as { error: { details: Record<string, unknown> } }).error.details;

describe("fee_source did_payment — dương, và CẶP với chế độ mặc định", () => {
  it("200: seed là UTxO did_payment, thế chấp là ví seed, ví seed không có input tiêu; summary đọc TỪ CBOR", async () => {
    const h = harness();
    const r = await handle(post(body(SELF_FUNDED)), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as { required_signers: string[]; witness_notes: string[]; summary: { funding: Record<string, unknown> } };
    expect(b.required_signers).toEqual([OWNER_PKH, CTRL, DEV]);
    expect(b.summary.funding).toEqual({
      type: "did_payment",
      address: DP_ADDRESS,
      did_payment_inputs: [refS(DP1), refS(DP2)],
      spent: { lovelace: "7000000", lamp_oildrop: "1100000000", other_assets: [] },
      returned: { lovelace: String(2_000_000n - FEE), lamp_oildrop: "99000000", other_assets: [] },
      withdrawal_lovelace: "0",
      self_funded: {
        fee_source: "did_payment",
        seed_utxo: refS(DP1),
        fee_lovelace: String(FEE),
        collateral: {
          address: COLL_ADDRESS, utxo: refS(COLL_UTXO),
          collateral_at_risk_lovelace: "3000000", collateral_return_lovelace: "2000000",
        },
      },
      valid_to_posix_ms: String(NOW + 1_800_000),
    });
    expect("fee_payer" in b.summary.funding).toBe(false);
    // Ví của lucid = ví thế chấp, mang ĐÚNG UTxO thế chấp; SDK nhận chế độ + cùng UTxO đó.
    const call = h.builder.lastCall!;
    expect(call.changeAddress).toBe(COLL_ADDRESS);
    expect(call.funding?.collateralUtxo).toBe(COLL_UTXO);
    expect(call.funding?.feePayerUtxo).toBeUndefined();
    expect(call.funding?.input.feeSource).toBe("did_payment");
    expect(call.funding?.input.collateralUtxo).toBe(COLL_UTXO);
    expect(call.collateralLovelace).toBe(3_000_000n);
    expect(b.witness_notes.some(n => n.startsWith("Thế chấp:"))).toBe(true);
  });

  it("CẶP (đổi mỗi fee_source + trường ví): chế độ mặc định ⟹ 200 với khối fee_payer, SDK KHÔNG nhận feeSource", async () => {
    const h = harness({ cbor: feePayerTx(), nft: VAULT_ID_UNIT });
    const r = await handle(post(body(FEE_PAYER_MODE)), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const f = (r.body as { summary: { funding: Record<string, unknown> } }).summary.funding;
    expect(f.fee_payer).toBeDefined();
    expect(f.self_funded).toBeUndefined();
    const call = h.builder.lastCall!;
    expect(call.changeAddress).toBe(FEE_ADDRESS);
    expect(call.funding?.feePayerUtxo).toBe(FEE_UTXO);
    expect(call.funding?.collateralUtxo).toBeUndefined();
    expect(call.funding?.input.feeSource).toBeUndefined();
    expect(call.funding?.input.collateralUtxo).toBeUndefined();
  });

  it("CẶP chéo: CBOR tự trả phí gửi dưới chế độ mặc định ⟹ 422; CBOR mặc định gửi dưới chế độ tự trả phí ⟹ 422", async () => {
    const a = await handle(post(body(FEE_PAYER_MODE)), harness().router);
    expect(a.status, JSON.stringify(a.body)).toBe(422);
    expect(codeOf(a)).toBe("FUNDING_TX_MISMATCH");
    const b = await handle(post(body(SELF_FUNDED)), harness({ cbor: feePayerTx(), nft: VAULT_ID_UNIT }).router);
    expect(b.status, JSON.stringify(b.body)).toBe(422);
    expect(codeOf(b)).toBe("FUNDING_TX_MISMATCH");
  });
});

describe("fee_source did_payment — âm ở cổng tĩnh (bộ dựng KHÔNG bị gọi)", () => {
  it("fee_source lạ ⟹ 400 FUNDING_SHAPE; CẶP: fee_source \"fee_payer\" tường minh ⟹ 200", async () => {
    const h = harness();
    const r = await handle(post(body({ ...SELF_FUNDED, fee_source: "wallet" })), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FUNDING_SHAPE");
    expect(detailsOf(r).field).toBe("funding.fee_source");
    expect(h.builder.lastCall).toBeNull();
    const ok = await handle(post(body({ ...FEE_PAYER_MODE, fee_source: "fee_payer" })),
      harness({ cbor: feePayerTx(), nft: VAULT_ID_UNIT }).router);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("thiếu collateral ⟹ 400 FUNDING_SHAPE (field funding.collateral)", async () => {
    const h = harness();
    const r = await handle(post(body({ ...SELF_FUNDED, collateral: undefined })), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FUNDING_SHAPE");
    expect(JSON.stringify(detailsOf(r))).toContain("funding.collateral");
    expect(h.builder.lastCall).toBeNull();
  });

  it("collateral mang token · khai sai địa chỉ · địa chỉ script ⟹ 400 FUNDING_COLLATERAL_INVALID (từng vế)", async () => {
    for (const collateral of [
      { utxo: refS(COLL_TOKEN_UTXO), address: COLL_ADDRESS },
      { utxo: refS(COLL_UTXO), address: OTHER_KEY_ADDRESS },
      { utxo: refS(COLL_UTXO), address: DP_ADDRESS },
      { utxo: refS(MAINNET_COLL_UTXO), address: MAINNET_COLL_ADDRESS },
    ]) {
      const h = harness();
      const r = await handle(post(body({ ...SELF_FUNDED, collateral })), h.router);
      expect(r.status, JSON.stringify(collateral)).toBe(400);
      expect(codeOf(r), JSON.stringify(collateral)).toBe("FUNDING_COLLATERAL_INVALID");
      expect(h.builder.lastCall).toBeNull();
    }
  });

  it("trộn chế độ: tự trả phí kèm fee_payer · mặc định kèm collateral ⟹ 400 FUNDING_SHAPE, nêu đúng trường thừa", async () => {
    const a = await handle(post(body({ ...SELF_FUNDED, fee_payer: FEE_PAYER_MODE.fee_payer })), harness().router);
    expect(codeOf(a)).toBe("FUNDING_SHAPE");
    expect(detailsOf(a).field).toBe("funding.fee_payer");
    const b = await handle(post(body({ ...FEE_PAYER_MODE, collateral: SELF_FUNDED.collateral })), harness().router);
    expect(codeOf(b)).toBe("FUNDING_SHAPE");
    expect(detailsOf(b).field).toBe("funding.collateral");
  });

  it("parseFunding: fee_source vắng ⟹ \"fee_payer\", không có collateral; did_payment ⟹ không có feePayer", () => {
    const d = parseFunding({ funding: FEE_PAYER_MODE })!;
    expect(d.feeSource).toBe("fee_payer");
    expect(d.feePayer?.address).toBe(FEE_ADDRESS);
    expect("collateral" in d).toBe(false);
    const s = parseFunding({ funding: SELF_FUNDED })!;
    expect(s.feeSource).toBe("did_payment");
    expect(s.collateral?.address).toBe(COLL_ADDRESS);
    expect("feePayer" in s).toBe(false);
  });
});

describe("fee_source did_payment — đọc lại CBOR (cực đối của ca dương, 422 FUNDING_TX_MISMATCH)", () => {
  const cases: [string, string, string][] = [
    // NFT băm từ UTxO thế chấp (không phải input bị chi) — mọi vế khác y ca dương.
    ["seed không phải UTxO did_payment bị chi", selfFundedTx({ nft: NFT_FROM_COLL }), NFT_FROM_COLL],
    // UTxO thế chấp bị chi như input thường; 5 ADA của nó thối về ví Phoenix nên bảo toàn phía
    // did_payment vẫn lệch đúng vì có input ngoài tập — chỉ vế (1) nói ra lý do.
    ["input lạ: UTxO của ví seed bị chi", selfFundedTx({ extraInput: COLL_UTXO }), NFT_FROM_DP1],
    // Cùng input lạ nhưng MỌI input đều có redeemer Spend ⟹ phép kiểm redeemer không bắt; chỉ vế
    // (1) — input ngoài tập did_payment — nói ra (đột biến api_csf_foreign_inputs đo điều đó).
    ["input lạ có kèm redeemer Spend", selfFundedTx({
      extraInput: COLL_UTXO,
      redeemers: [{ index: 0, dataHex: SPEND }, { index: 1, dataHex: SPEND }, { index: 2, dataHex: SPEND }],
    }), NFT_FROM_DP1],
    ["thiếu một redeemer Spend", selfFundedTx({ redeemers: [{ index: 0, dataHex: SPEND }] }), NFT_FROM_DP1],
    ["redeemer Spend khác Constr 0 []", selfFundedTx({ redeemers: [{ index: 0, dataHex: SPEND }, { index: 1, dataHex: "d87a80" }] }), NFT_FROM_DP1],
    ["collateral_return về ví Phoenix thay vì ví seed", selfFundedTx({ collateralReturnTo: DP_ADDRESS }), NFT_FROM_DP1],
    ["thế chấp là UTxO khác UTxO đã khai", selfFundedTx({ collateralInput: COLL_TOKEN_UTXO }), NFT_FROM_DP1],
    // 1 ADA từ tiền thối của ví Phoenix chuyển sang ví seed ⟹ bảo toàn vẫn khớp; chỉ vế output bắt.
    ["output về ví seed (bảo toàn vẫn đúng)", selfFundedTx({
      dpChangeLovelace: 2_000_000n - FEE - 1_000_000n,
      extraOutput: { address: COLL_ADDRESS, assets: { lovelace: 1_000_000n } },
    }), NFT_FROM_DP1],
    ["phí không trả đủ từ did_payment (thối dư 1 lovelace)", selfFundedTx({ dpChangeLovelace: 2_000_000n - FEE + 1n }), NFT_FROM_DP1],
    ["thiếu chữ ký thiết bị", selfFundedTx({ signers: [OWNER_PKH, CTRL] }), NFT_FROM_DP1],
  ];
  for (const [name, cbor, nft] of cases) {
    it(name, async () => {
      const r = await handle(post(body(SELF_FUNDED)), harness({ cbor, nft }).router);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(codeOf(r)).toBe("FUNDING_TX_MISMATCH");
    });
  }
});

describe("walletUtxoOfFunding — UTxO duy nhất ví lucid mang khi tạo vault có funding", () => {
  const input = {
    didPaymentScriptCbor: DP_SCRIPT, address: DP_ADDRESS, utxos: [DP1], anchorRefUtxo: ANCHOR,
    controllerPkh: CTRL, deviceKeyHash: DEV,
  };
  it("tự trả phí ⟹ UTxO thế chấp; CẶP mặc định ⟹ UTxO trả phí", () => {
    expect(walletUtxoOfFunding({ input: { ...input, feeSource: "did_payment", collateralUtxo: COLL_UTXO }, collateralUtxo: COLL_UTXO }))
      .toBe(COLL_UTXO);
    expect(walletUtxoOfFunding({ input, feePayerUtxo: FEE_UTXO })).toBe(FEE_UTXO);
  });
  it("tự trả phí mà thiếu/lệch collateralUtxo, hoặc kèm feePayerUtxo ⟹ NÉM; mặc định thiếu feePayerUtxo ⟹ NÉM", () => {
    const sf = { ...input, feeSource: "did_payment" as const, collateralUtxo: COLL_UTXO };
    expect(() => walletUtxoOfFunding({ input: sf })).toThrow(/bất biến nội bộ/);
    expect(() => walletUtxoOfFunding({ input: sf, collateralUtxo: COLL_TOKEN_UTXO })).toThrow(/bất biến nội bộ/);
    expect(() => walletUtxoOfFunding({ input: sf, collateralUtxo: COLL_UTXO, feePayerUtxo: FEE_UTXO })).toThrow(/bất biến nội bộ/);
    expect(() => walletUtxoOfFunding({ input, collateralUtxo: COLL_UTXO })).toThrow(/bất biến nội bộ/);
  });
});
