// VaultTxAPI/tests/funding.test.ts — `/tx/create-vault` với `funding` did_payment.
//
// Bộ dựng là `RecordedTxBuilder`: CBOR ghi sẵn, dựng bằng CML tại chỗ. Thứ được kiểm là
// (a) cổng tĩnh trước khi giữ khoá — hash script, địa chỉ ví trả phí, xung đột
// `change_address`, bộ anchor/controller/thiết bị — và (b) phép ĐỌC LẠI CBOR
// (`checkFundingTx`): mỗi ca dương có ca cực đối khác ĐÚNG một vế trong CBOR.
import { describe, expect, it } from "vitest";
import {
  credentialToAddress, scriptHashToCredential, unixTimeToSlot, validatorToScriptHash,
  type TxBuilder, type UTxO,
} from "@lucid-evolution/lucid";
import { FundingError, planDidPaymentFunding, type OwnerRef } from "@magiclamp/protocol-utils";
import { didPaymentLucidPorts } from "@magiclamp/sdk";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { ChainDidPaymentAnchorReader } from "../src/funding.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import type { OwnerWitnessProvider, ScriptOwnerWitness } from "../src/owner.js";
import { VaultTxService } from "../src/service.js";
import {
  RecordedTxBuilder, enterpriseAddressOf, type BuiltCreateVault, type CreateVaultContext,
} from "../src/txBuilder.js";
import {
  LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OTHER_OWNER_PKH, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
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
const OTHER_DP_SCRIPT = "49480100002221200101";
const DP_ADDRESS = credentialToAddress("Preview",
  scriptHashToCredential(validatorToScriptHash({ type: "PlutusV3", script: DP_SCRIPT })));
const FEE_ADDRESS = enterpriseAddressOf("Preview", "fe".repeat(28));
const ANCHOR_POLICY = "a0".repeat(28);

const utxo = (txHash: string, outputIndex: number, address: string, assets: Record<string, bigint>): UTxO =>
  ({ txHash, outputIndex, address, assets, datum: null, datumHash: null, scriptRef: null }) as UTxO;
const ANCHOR = utxo("ab".repeat(32), 0, DP_ADDRESS, { lovelace: 2_000_000n, [`${ANCHOR_POLICY}01`]: 1n });
const FEE_UTXO = utxo("fa".repeat(32), 0, FEE_ADDRESS, { lovelace: 10_000_000n });
const DP1 = utxo("d1".repeat(32), 0, DP_ADDRESS, { lovelace: 3_000_000n, [LAMP_UNIT]: 600_000_000n });
const DP2 = utxo("d2".repeat(32), 1, DP_ADDRESS, { lovelace: 4_000_000n, [LAMP_UNIT]: 500_000_000n });
const DP3 = utxo("d3".repeat(32), 0, DP_ADDRESS, { lovelace: 2_000_000n, [LAMP_UNIT]: 1n });
const ref = (u: UTxO) => ({ txHash: u.txHash, outputIndex: u.outputIndex });

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
const SCRIPT_OWNER: OwnerRef = { type: "script", hash: OWNER_PKH };

interface FundedOpts {
  owner?: OwnerRef;
  signers?: string[];
  returnTo?: string;
  extraOutput?: TxOutputSpec;
  extraInput?: { txHash: string; outputIndex: number };
  redeemers?: { index: number; dataHex: string }[];
  ttlMs?: number | null;
  feeChange?: bigint;
  collateralReturn?: bigint;
}

/** Tx tạo vault nạp từ DP1 + DP2: chi 7 ADA + 1 100 LAMP, vault nhận 5 ADA + 1 001 LAMP,
 *  thối 2 ADA + 99 LAMP về ví Phoenix; ví trả phí góp 10 ADA = phí 0,19 + thối 9,81. */
function fundedTx(o: FundedOpts = {}): string {
  const owner = o.owner ?? KEY_OWNER;
  const outputs: TxOutputSpec[] = [
    {
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_000_000n, [LAMP_UNIT]: DEPOSIT, [VAULT_ID_UNIT]: 1n },
      inlineDatumHex: datumHex({ owner, lampBalanceOildrop: DEPOSIT, lampLockedOildrop: 0n }),
    },
    { address: o.returnTo ?? DP_ADDRESS, assets: { lovelace: 2_000_000n, [LAMP_UNIT]: 99_000_000n } },
    { address: FEE_ADDRESS, assets: { lovelace: o.feeChange ?? 10_000_000n - FEE } },
  ];
  if (o.extraOutput) outputs.push(o.extraOutput);
  return buildTxCbor({
    inputs: [ref(FEE_UTXO), ref(DP1), ref(DP2), ...(o.extraInput ? [o.extraInput] : [])],
    feeLovelace: FEE,
    mint: { [VAULT_ID_UNIT]: 1n },
    requiredSigners: o.signers ?? (owner.type === "key" ? [OWNER_PKH, CTRL, DEV] : [CTRL, DEV]),
    outputs,
    collateralInputs: [ref(FEE_UTXO)],
    // Thế chấp có thể mất = 10 − 7 = 3 ADA, đúng trần mặc định `fee_payer_collateral_lovelace`.
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: o.collateralReturn ?? 7_000_000n } },
    // Thứ tự đã sắp của ledger: d1… < d2… < fa… ⟹ DP1 = 0, DP2 = 1.
    spendRedeemers: o.redeemers ?? [{ index: 0, dataHex: SPEND }, { index: 1, dataHex: SPEND }],
    ttlSlot: o.ttlMs === null ? undefined : BigInt(unixTimeToSlot("Preview", NOW + (o.ttlMs ?? 1_800_000))),
  });
}

class FakeWitness implements OwnerWitnessProvider {
  calls: { owner: OwnerRef; w: ScriptOwnerWitness }[] = [];
  async resolve(owner: OwnerRef, w: ScriptOwnerWitness) {
    this.calls.push({ owner, w });
    return {
      auth: { kind: "script" as const, hash: owner.hash, attachWithdraw: (tx: TxBuilder) => tx },
      requiredSigners: [w.controllerPkh, w.deviceKeyHash],
      notes: ["giả: rút did_stake"],
    };
  }
}

/** Bộ dựng chạy ĐÚNG bộ chọn UTxO của SDK trên UTxO dịch vụ đọc được, rồi trả CBOR ghi sẵn. */
class PlanningBuilder extends RecordedTxBuilder {
  override async createVault(ctx: CreateVaultContext, p: { lampAmount: bigint }): Promise<BuiltCreateVault> {
    planDidPaymentFunding({
      utxos: ctx.funding!.input.utxos,
      need: { lovelace: 5_000_000n, [LAMP_UNIT]: p.lampAmount },
      primaryUnit: LAMP_UNIT,
      returnAddress: ctx.funding!.input.address,
    }, didPaymentLucidPorts(4310n));
    return super.createVault(ctx, p);
  }
}

function harness(opts: { cbor?: string; anchorReader?: boolean; planning?: boolean } = {}) {
  const chain = new RecordedChainReader({ [DP_ADDRESS]: [DP1, DP2, DP3] }, TIP, [ANCHOR, FEE_UTXO]);
  const Builder = opts.planning ? PlanningBuilder : RecordedTxBuilder;
  const builder = new Builder({ create_vault: opts.cbor ?? fundedTx() }, VAULT_ID_UNIT);
  const locks = new OwnerLockTable(TTL);
  const witness = new FakeWitness();
  const service = new VaultTxService({
    network: "Preview", deployment: DEPLOYMENT, chain, builder, locks,
    issued: new IssuedTxRegistry(TTL * 4), lockTtlMs: TTL, now: () => NOW, ownerWitness: witness,
    didPaymentAnchor: opts.anchorReader === false ? undefined
      : new ChainDidPaymentAnchorReader({ chain, anchorNftPolicy: ANCHOR_POLICY }),
  });
  const router: RouterDeps = {
    service, deploymentSource: DEPLOYMENT.source, vaultScopes: DEPLOYMENT.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "",
    logInternal: () => {},
  };
  return { builder, router, witness };
}

const FUNDING = {
  type: "did_payment",
  did_payment_script_cbor: DP_SCRIPT,
  address: DP_ADDRESS,
  fee_payer: { utxo: `${FEE_UTXO.txHash}#0`, address: FEE_ADDRESS },
  anchor_ref: `${ANCHOR.txHash}#0`,
  controller_pkh: CTRL,
  device_key_hash: DEV,
};
const WITNESS_BODY = {
  did_stake_script_cbor: "4e4d01000033222220051200120011",
  anchor_ref: `${ANCHOR.txHash}#0`,
  controller_pkh: CTRL,
  device_key_hash: DEV,
};
const post = (body: unknown) => ({ method: "POST", url: "/tx/create-vault", headers: {}, body });
const body = (over: Record<string, unknown> = {}, funding: Record<string, unknown> = {}) => ({
  kind: "schedule", owner: KEY_OWNER, lamp_amount: DEPOSIT.toString(), funding: { ...FUNDING, ...funding }, ...over,
});
const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;

describe("POST /tx/create-vault + funding did_payment — dương", () => {
  it("chủ khoá: 200, summary.funding đọc TỪ CBOR, bộ dựng nhận ví trả phí + UTxO did_payment", async () => {
    const h = harness();
    const r = await handle(post(body()), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as { required_signers: string[]; witness_notes: string[]; summary: { funding: Record<string, unknown> } };
    expect(b.required_signers).toEqual([OWNER_PKH, CTRL, DEV]);
    expect(b.summary.funding).toEqual({
      type: "did_payment",
      address: DP_ADDRESS,
      did_payment_inputs: [`${DP1.txHash}#0`, `${DP2.txHash}#1`],
      spent: { lovelace: "7000000", lamp_oildrop: "1100000000", other_assets: [] },
      returned: { lovelace: "2000000", lamp_oildrop: "99000000", other_assets: [] },
      withdrawal_lovelace: "0",
      fee_payer: {
        address: FEE_ADDRESS, utxo: `${FEE_UTXO.txHash}#0`, input_lovelace: "10000000",
        fee_lovelace: "190000", change_lovelace: "9810000", collateral_return_lovelace: "7000000",
        collateral_at_risk_lovelace: "3000000",
      },
      valid_to_posix_ms: String(NOW + 1_800_000),
    });
    expect(h.builder.lastCall?.changeAddress).toBe(FEE_ADDRESS);
    // Thế chấp tường minh = trần cấu hình (mặc định 3 ADA), không để lucid tự đặt 5 ADA.
    expect(h.builder.lastCall?.collateralLovelace).toBe(3_000_000n);
    expect(h.builder.lastCall?.funding?.feePayerUtxo).toBe(FEE_UTXO);
    expect(h.builder.lastCall?.funding?.input.utxos).toEqual([DP1, DP2, DP3]);
    expect(h.builder.lastCall?.funding?.input.anchorRefUtxo).toBe(ANCHOR);
    expect(b.witness_notes.some(n => n.includes("Thứ tự"))).toBe(true);
  });

  it("chủ script + owner_witness: funding KHÔNG khai lại anchor/controller/thiết bị ⟹ dùng chung, 200", async () => {
    const h = harness({ cbor: fundedTx({ owner: SCRIPT_OWNER }) });
    const r = await handle(post(body({ owner: SCRIPT_OWNER, owner_witness: WITNESS_BODY },
      { anchor_ref: undefined, controller_pkh: undefined, device_key_hash: undefined })), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as { required_signers: string[] }).required_signers).toEqual([CTRL, DEV]);
    expect(h.witness.calls).toHaveLength(1);
    expect(h.builder.lastCall?.ownerAuthKind).toBe("script");
    expect(h.builder.lastCall?.funding?.input.controllerPkh).toBe(CTRL);
  });
});

describe("POST /tx/create-vault + funding — âm ở cổng tĩnh (bộ dựng KHÔNG bị gọi)", () => {
  it("did_payment_script_cbor không băm ra credential của funding.address ⟹ 400 FUNDING_SCRIPT_MISMATCH", async () => {
    const h = harness();
    const r = await handle(post(body({}, { did_payment_script_cbor: OTHER_DP_SCRIPT })), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FUNDING_SCRIPT_MISMATCH");
    expect(h.builder.lastCall).toBeNull();
  });

  it("funding.address là địa chỉ KHOÁ ⟹ 400 FUNDING_SCRIPT_MISMATCH (không phải ví Phoenix)", async () => {
    const h = harness();
    const r = await handle(post(body({}, { address: FEE_ADDRESS })), h.router);
    expect(codeOf(r)).toBe("FUNDING_SCRIPT_MISMATCH");
  });

  it("fee_payer.address là địa chỉ SCRIPT ⟹ 400 FUNDING_FEE_PAYER_INVALID", async () => {
    const h = harness();
    const r = await handle(post(body({}, { fee_payer: { utxo: `${FEE_UTXO.txHash}#0`, address: DP_ADDRESS } })), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FUNDING_FEE_PAYER_INVALID");
    expect(h.builder.lastCall).toBeNull();
  });

  it("UTxO trả phí không nằm ở fee_payer.address, hoặc mang token ⟹ 400 FUNDING_FEE_PAYER_INVALID", async () => {
    const h = harness();
    const r = await handle(post(body({}, { fee_payer: { utxo: `${DP1.txHash}#0`, address: FEE_ADDRESS } })), h.router);
    // DP1 không có trong bản ghi refUtxos ⟹ chuỗi báo không thấy; ANCHOR thì có nhưng ở địa chỉ khác.
    expect(r.status).toBeGreaterThanOrEqual(400);
    const r2 = await handle(post(body({}, { fee_payer: { utxo: `${ANCHOR.txHash}#0`, address: FEE_ADDRESS } })), harness().router);
    expect(codeOf(r2)).toBe("FUNDING_FEE_PAYER_INVALID");
  });

  it("funding cùng change_address ⟹ 400 FUNDING_CHANGE_ADDRESS_CONFLICT", async () => {
    const h = harness();
    const r = await handle(post(body({ change_address: FEE_ADDRESS })), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FUNDING_CHANGE_ADDRESS_CONFLICT");
    expect(h.builder.lastCall).toBeNull();
  });

  it("bộ anchor/controller/thiết bị lệch owner_witness ⟹ 400 FUNDING_WITNESS_MISMATCH (từng vế)", async () => {
    for (const lech of [
      { controller_pkh: "c2".repeat(28) },
      { device_key_hash: "d2".repeat(28) },
      { anchor_ref: `${"ac".repeat(32)}#0` },
    ]) {
      const h = harness({ cbor: fundedTx({ owner: SCRIPT_OWNER }) });
      const r = await handle(post(body({ owner: SCRIPT_OWNER, owner_witness: WITNESS_BODY }, lech)), h.router);
      expect(r.status, JSON.stringify(lech)).toBe(400);
      expect(codeOf(r), JSON.stringify(lech)).toBe("FUNDING_WITNESS_MISMATCH");
      expect(h.builder.lastCall).toBeNull();
    }
  });

  it("chủ khoá, funding thiếu anchor/controller/thiết bị ⟹ 400 FUNDING_SHAPE; trường lạ ⟹ 400 FUNDING_SHAPE", async () => {
    const h = harness();
    expect(codeOf(await handle(post(body({}, { anchor_ref: undefined })), h.router))).toBe("FUNDING_SHAPE");
    expect(codeOf(await handle(post(body({}, { change: "x" })), h.router))).toBe("FUNDING_SHAPE");
    expect(codeOf(await handle(post(body({}, { type: "key" })), h.router))).toBe("FUNDING_SHAPE");
    expect(h.builder.lastCall).toBeNull();
  });

  it("dịch vụ không cấu hình đọc anchor ⟹ 501 FUNDING_UNAVAILABLE", async () => {
    const h = harness({ anchorReader: false });
    const r = await handle(post(body()), h.router);
    expect(r.status).toBe(501);
    expect(codeOf(r)).toBe("FUNDING_UNAVAILABLE");
  });

  it("CẶP: không có funding, không có change_address ⟹ vẫn 400 CHANGE_ADDRESS_REQUIRED (đường cũ giữ nguyên)", async () => {
    const h = harness();
    const r = await handle(post({ kind: "schedule", owner: KEY_OWNER, lamp_amount: DEPOSIT.toString() }), h.router);
    expect(codeOf(r)).toBe("CHANGE_ADDRESS_REQUIRED");
  });
});

describe("POST /tx/create-vault + funding — ví did_payment không đủ", () => {
  it("LAMP yêu cầu vượt tổng ở did_payment ⟹ 422 FUNDING_INSUFFICIENT (không 500), khoá được nhả", async () => {
    const h = harness({ planning: true });
    const r = await handle(post(body({ lamp_amount: "2000000000" })), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codeOf(r)).toBe("FUNDING_INSUFFICIENT");
    // Khoá mềm đã nhả: lượt sau của cùng chủ không bị 409.
    const again = await handle(post(body()), h.router);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });

  it("CẶP: cùng bộ dựng, lượng vừa đủ ⟹ 200 (bộ chọn thật chạy, không phải ca rỗng)", async () => {
    const h = harness({ planning: true });
    expect((await handle(post(body()), h.router)).status).toBe(200);
    expect(() => planDidPaymentFunding({
      utxos: [DP1], need: { lovelace: 5_000_000n, [LAMP_UNIT]: DEPOSIT }, primaryUnit: LAMP_UNIT, returnAddress: DP_ADDRESS,
    }, didPaymentLucidPorts(4310n))).toThrow(FundingError);
  });
});

describe("POST /tx/create-vault + funding — đọc lại CBOR (cực đối, 422 FUNDING_TX_MISMATCH)", () => {
  const cases: [string, string][] = [
    // Tiền output lạ lấy từ tiền thối của ví trả phí ⟹ MỌI phép bảo toàn vẫn khớp; chỉ phép
    // kiểm địa chỉ output bắt được ca này (đột biến MUTANT-OUTPUT đo đúng điều đó).
    ["output tới địa chỉ lạ (bảo toàn vẫn đúng)", fundedTx({
      extraOutput: { address: enterpriseAddressOf("Preview", OTHER_OWNER_PKH), assets: { lovelace: 1_500_000n } },
      feeChange: 10_000_000n - FEE - 1_500_000n,
    })],
    ["phần thối LAMP về ví trả phí thay vì ví Phoenix", fundedTx({ returnTo: FEE_ADDRESS })],
    ["input lạ ngoài ví trả phí + did_payment", fundedTx({ extraInput: { txHash: "99".repeat(32), outputIndex: 3 } })],
    ["thiếu một redeemer Spend", fundedTx({ redeemers: [{ index: 0, dataHex: SPEND }] })],
    ["redeemer Spend khác Constr 0 []", fundedTx({ redeemers: [{ index: 0, dataHex: SPEND }, { index: 1, dataHex: "d87a80" }] })],
    ["ví trả phí góp thêm vào vault (thối ít hơn phí cho phép)", fundedTx({ feeChange: 10_000_000n - FEE - 1n })],
    ["thiếu chữ ký thiết bị", fundedTx({ signers: [OWNER_PKH, CTRL] })],
    ["không có hạn dùng", fundedTx({ ttlMs: null })],
    ["hạn dùng quá 1 giờ", fundedTx({ ttlMs: 3_700_000 })],
    // Trần mặc định 3 ADA: return 6,999999 ADA ⟹ có thể mất 3 000 001 lovelace, vượt trần 1.
    ["thế chấp có thể mất vượt trần 3 ADA (1 lovelace)", fundedTx({ collateralReturn: 6_999_999n })],
  ];
  for (const [name, cbor] of cases) {
    it(name, async () => {
      const r = await handle(post(body()), harness({ cbor }).router);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(codeOf(r)).toBe("FUNDING_TX_MISMATCH");
    });
  }
});
