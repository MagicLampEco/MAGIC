// VaultTxAPI/tests/engageFeePayer.test.ts — ba cổng mới của lượt này, mỗi cổng một CẶP ca:
//
//   · `fee_payer` trên các đường dựng: dịch vụ ĐỌC LẠI CBOR theo luật ví trả phí
//     (`feePayer.ts` ▸ `checkFeePayerTx`), không tin bộ dựng;
//   · `/tx/consume` chọn thread Engage theo TỪNG chủ (`engage.ts` ▸ `pickEngageThread`);
//   · `/tx/open-thread` đọc lại NFT + output + datum genesis (`engage.ts` ▸ `checkOpenThreadTx`).
//
// Bộ dựng là `RecordedTxBuilder`: nó trả CBOR ghi sẵn, không ngó tham số — nên mọi ca âm dưới
// đây đỏ vì CỔNG ĐỌC LẠI, không vì bộ dựng từ chối.

import { credentialToAddress, unixTimeToSlot, type UTxO } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../src/txBuilder.js";
import { ENGAGE_ADDRESS, ENGAGE_SCRIPT_HASH, engageDatumHex, threadUtxo } from "./fixtures/engage.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OTHER_OWNER_PKH, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor, type TxOutputSpec } from "./fixtures/tx.js";

const TTL = 180_000;
const NOW = 1_789_100_703_000;
const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };
const FEE = 178_000n;
const KEY_OWNER = { type: "key" as const, hash: OWNER_PKH };
const OTHER_OWNER = { type: "key" as const, hash: OTHER_OWNER_PKH };
const CHANGE_ADDRESS = enterpriseAddressOf("Preview", OWNER_PKH);
const FEE_KEY = "fe".repeat(28);
const FEE_ADDRESS = enterpriseAddressOf("Preview", FEE_KEY);
const FEE_ADDRESS_STAKED = credentialToAddress("Preview", { type: "Key", hash: FEE_KEY }, { type: "Key", hash: "ab".repeat(28) });

const utxo = (txHash: string, outputIndex: number, address: string, assets: Record<string, bigint>, datum?: string): UTxO =>
  ({ txHash, outputIndex, address, assets, datum });
const ref = (u: { txHash: string; outputIndex: number }) => ({ txHash: u.txHash, outputIndex: u.outputIndex });

const VAULT_DATUM = datumHex({ lampLockedOildrop: 2_000_000n });
const VAULT_UTXO = utxo(INPUT_TX_HASH, 0, VAULT_ADDRESS,
  { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n }, VAULT_DATUM);
const FEE_UTXO = utxo("fa".repeat(32), 0, FEE_ADDRESS, { lovelace: 10_000_000n });
const FEE_UTXO_2 = utxo("fb".repeat(32), 0, FEE_ADDRESS, { lovelace: 4_000_000n });

const DEPLOYMENT: Deployment = parseDeployment(JSON.stringify({
  source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
  lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
  vaults: [{ vault_type: "Schedule", address: VAULT_ADDRESS }],
  shard_address: SHARD_ADDRESS,
  ref_script_utxos: {
    vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
  },
  consume: {
    engage_address: ENGAGE_ADDRESS,
    price_beacon_address: VAULT_ADDRESS,
    price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
  },
}), "Preview");

interface FeeTxOpts {
  feeChange?: bigint;
  collateralReturn?: bigint;
  ttlMs?: number | null;
  changeTo?: string;
  extraInput?: { txHash: string; outputIndex: number };
  /** Lấy lovelace từ VAULT trả sang một địa chỉ cùng khoá ví trả phí: phần ví trả phí vẫn cân. */
  stakedOutput?: bigint;
}

/** Tx đi qua vault, phí do FEE_UTXO (10 ADA) trả: phí 0,178 + thối 9,822; thế chấp mất ≤ 3 ADA. */
function feeTx(o: FeeTxOpts = {}): string {
  const outputs: TxOutputSpec[] = [
    {
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n - (o.stakedOutput ?? 0n), [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      inlineDatumHex: datumHex({ lampLockedOildrop: 23_000_000n, genScheduleCount: 1 }),
    },
    { address: o.changeTo ?? FEE_ADDRESS, assets: { lovelace: o.feeChange ?? 10_000_000n - FEE } },
  ];
  if (o.stakedOutput !== undefined) outputs.push({ address: FEE_ADDRESS_STAKED, assets: { lovelace: o.stakedOutput } });
  return buildTxCbor({
    inputs: [ref(VAULT_UTXO), ref(FEE_UTXO), ...(o.extraInput ? [o.extraInput] : [])],
    feeLovelace: FEE,
    outputs,
    requiredSigners: [OWNER_PKH],
    collateralInputs: [ref(FEE_UTXO)],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: o.collateralReturn ?? 7_000_000n } },
    ttlSlot: o.ttlMs === null ? undefined : BigInt(unixTimeToSlot("Preview", NOW + (o.ttlMs ?? 1_800_000))),
  });
}

const THREAD_UNIT = ENGAGE_SCRIPT_HASH + "c0ffee";

interface OpenTxOpts {
  owner?: { type: "key" | "script"; hash: string }; consumedCount?: bigint; mintUnit?: string; outAddress?: string; mintQty?: bigint;
}

function openTx(o: OpenTxOpts = {}): string {
  const unit = o.mintUnit ?? THREAD_UNIT;
  return buildTxCbor({
    inputs: [{ txHash: "c0".repeat(32), outputIndex: 0 }],
    feeLovelace: 200_000n,
    mint: { [unit]: o.mintQty ?? 1n },
    outputs: [
      {
        address: o.outAddress ?? ENGAGE_ADDRESS,
        assets: { lovelace: 2_000_000n, [unit]: 1n },
        inlineDatumHex: engageDatumHex(o.owner ?? KEY_OWNER, { consumedCount: o.consumedCount }),
      },
      { address: CHANGE_ADDRESS, assets: { lovelace: 7_800_000n } },
    ],
    requiredSigners: [OWNER_PKH],
  });
}

function harness(opts: { threads?: UTxO[]; cbor?: string; openCbor?: string; declaredUnit?: string } = {}) {
  const chain = new RecordedChainReader(
    { [VAULT_ADDRESS]: [VAULT_UTXO], [ENGAGE_ADDRESS]: opts.threads ?? [threadUtxo(KEY_OWNER, "7e".repeat(32))] },
    TIP,
    [VAULT_UTXO, FEE_UTXO, FEE_UTXO_2],
  );
  const cbor = opts.cbor ?? feeTx();
  const builder = new RecordedTxBuilder(
    { schedule_commit: cbor, consume: cbor, open_thread: opts.openCbor ?? openTx() },
    undefined,
    opts.declaredUnit ?? THREAD_UNIT,
  );
  const issued = new IssuedTxRegistry(TTL * 4);
  const locks = new OwnerLockTable(TTL);
  const service = new VaultTxService({
    network: "Preview", deployment: DEPLOYMENT, chain, builder, locks, issued, lockTtlMs: TTL, now: () => NOW,
  });
  const router: RouterDeps = {
    service, deploymentSource: DEPLOYMENT.source, vaultScopes: DEPLOYMENT.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { builder, router, issued, locks };
}

const post = (url: string, body: unknown) => ({ method: "POST", url, headers: {}, body });
const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const FEE_PAYER = { utxo: `${FEE_UTXO.txHash}#0`, address: FEE_ADDRESS };
const commit = (over: Record<string, unknown> = {}) =>
  post("/tx/schedule-commit", { owner_pkh: OWNER_PKH, schedule_length: "3", lamp_per_epoch: "7000000", ...over });

// ── fee_payer ────────────────────────────────────────────────────────────────

describe("fee_payer — dương", () => {
  it("schedule-commit: 200, summary.fee_payer đọc TỪ CBOR; bộ dựng nhận đúng UTxO trả phí + thế chấp 3 ADA", async () => {
    const h = harness();
    const r = await handle(commit({ fee_payer: FEE_PAYER }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as { summary: { fee_payer: Record<string, unknown> }; witness_notes: string[] };
    expect(b.summary.fee_payer).toEqual({
      address: FEE_ADDRESS, utxo: `${FEE_UTXO.txHash}#0`, input_lovelace: "10000000",
      fee_lovelace: String(FEE), change_lovelace: String(10_000_000n - FEE),
      collateral_at_risk_lovelace: "3000000", collateral_return_lovelace: "7000000",
      valid_to_posix_ms: String(NOW + 1_800_000),
    });
    expect(h.builder.lastCall?.feePayerUtxo).toBe(FEE_UTXO);
    expect(h.builder.lastCall?.collateralLovelace).toBe(3_000_000n);
    expect(b.witness_notes.join(" ")).toContain(FEE_ADDRESS);
  });

  it("CẶP: không có fee_payer ⟹ summary không có fee_payer, bộ dựng không nhận UTxO trả phí", async () => {
    const h = harness();
    const r = await handle(commit(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as { summary: Record<string, unknown> }).summary.fee_payer).toBeUndefined();
    expect(h.builder.lastCall?.feePayerUtxo).toBeUndefined();
  });
});

describe("fee_payer — âm ở cổng tĩnh (bộ dựng KHÔNG bị gọi)", () => {
  it("fee_payer cùng change_address ⟹ 400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT", async () => {
    const h = harness();
    const r = await handle(commit({ fee_payer: FEE_PAYER, change_address: CHANGE_ADDRESS }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_PAYER_CHANGE_ADDRESS_CONFLICT");
    expect(h.builder.lastCall).toBeNull();
  });

  it("fee_payer.utxo sai khuôn ⟹ 400 FEE_PAYER_SHAPE; địa chỉ script ⟹ 400 FEE_PAYER_INVALID", async () => {
    const h = harness();
    const a = await handle(commit({ fee_payer: { utxo: "zz#0", address: FEE_ADDRESS } }), h.router);
    expect(codeOf(a)).toBe("FEE_PAYER_SHAPE");
    const b = await handle(commit({ fee_payer: { utxo: FEE_PAYER.utxo, address: VAULT_ADDRESS } }), h.router);
    expect(codeOf(b)).toBe("FEE_PAYER_INVALID");
    expect(h.builder.lastCall).toBeNull();
  });

  it("chủ script thiếu cả fee_payer lẫn change_address ⟹ 400 CHANGE_ADDRESS_REQUIRED, thông điệp nêu fee_payer", async () => {
    const h = harness();
    const r = await handle(commit({ owner_pkh: undefined, owner: { type: "script", hash: OWNER_PKH } }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("CHANGE_ADDRESS_REQUIRED");
    expect(JSON.stringify(r.body)).toContain("fee_payer");
  });
});

describe("fee_payer — đọc lại CBOR (cực đối, 422 FEE_PAYER_TX_MISMATCH)", () => {
  const cases: [string, string][] = [
    ["thế chấp có thể mất vượt trần 3 ADA (1 lovelace)", feeTx({ collateralReturn: 6_999_999n })],
    ["input thứ hai của ví trả phí", feeTx({ extraInput: ref(FEE_UTXO_2) })],
    ["thối về địa chỉ khác cùng khoá ví trả phí", feeTx({ changeTo: FEE_ADDRESS_STAKED })],
    // Phần ví trả phí CÂN (thối đủ về fee_payer.address): chỉ cổng "cùng khoá, khác địa chỉ" bắt được.
    ["output tiền vault sang địa chỉ cùng khoá ví trả phí (phần phí vẫn cân)", feeTx({ stakedOutput: 1_000_000n })],
    ["hạn dùng quá 1 giờ", feeTx({ ttlMs: 3_700_000 })],
    ["không có hạn dùng", feeTx({ ttlMs: null })],
    ["ví trả phí mất ròng hơn phí 1 lovelace", feeTx({ feeChange: 10_000_000n - FEE - 1n })],
  ];
  for (const [name, cbor] of cases) {
    it(name, async () => {
      const h = harness({ cbor });
      const r = await handle(commit({ fee_payer: FEE_PAYER }), h.router);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(codeOf(r)).toBe("FEE_PAYER_TX_MISMATCH");
      // Khoá chủ được nhả: lượt thứ hai trên CÙNG bảng khoá lại đỏ ở cổng đọc lại, không ở 409.
      expect(codeOf(await handle(commit({ fee_payer: FEE_PAYER }), h.router))).toBe("FEE_PAYER_TX_MISMATCH");
    });
  }
});

// ── /tx/consume chọn thread theo chủ ─────────────────────────────────────────

const consume = (over: Record<string, unknown> = {}) =>
  post("/tx/consume", { owner_pkh: OWNER_PKH, op_type: 1, op_count: "2", ...over });
const GARBAGE = utxo("9a".repeat(32), 0, ENGAGE_ADDRESS, { lovelace: 2_000_000n, [ENGAGE_SCRIPT_HASH + "99"]: 1n }, "d87980");
const PLAIN_AT_ENGAGE = utxo("9b".repeat(32), 0, ENGAGE_ADDRESS, { lovelace: 3_000_000n });

describe("/tx/consume — thread Engage theo chủ", () => {
  it("hai thread của hai chủ (+ một UTxO rác mang NFT) ⟹ 200, chọn đúng thread của chủ yêu cầu", async () => {
    const mine = threadUtxo(KEY_OWNER, "a2".repeat(32), 0, "01");
    const h = harness({ threads: [threadUtxo(OTHER_OWNER, "a1".repeat(32), 0, "02"), GARBAGE, mine] });
    const r = await handle(consume(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.builder.lastCall?.engageUtxo).toBe(mine);
  });

  it("chủ không có thread (chỉ có thread người khác + rác) ⟹ 404 ENGAGE_THREAD_NOT_FOUND, chỉ tới /tx/open-thread", async () => {
    const h = harness({ threads: [threadUtxo(OTHER_OWNER, "a1".repeat(32)), GARBAGE] });
    const r = await handle(consume(), h.router);
    expect(r.status).toBe(404);
    expect(codeOf(r)).toBe("ENGAGE_THREAD_NOT_FOUND");
    expect(JSON.stringify(r.body)).toContain("/tx/open-thread");
    expect(h.builder.lastCall).toBeNull();
  });

  it("hai thread cùng chủ ⟹ 409 ENGAGE_THREAD_AMBIGUOUS; CẶP: kèm engage_ref ⟹ 200 đúng thread đó", async () => {
    const t1 = threadUtxo(KEY_OWNER, "b1".repeat(32), 0, "01");
    const t2 = threadUtxo(KEY_OWNER, "b2".repeat(32), 1, "02");
    const h = harness({ threads: [t1, t2] });
    const a = await handle(consume(), h.router);
    expect(a.status).toBe(409);
    expect(codeOf(a)).toBe("ENGAGE_THREAD_AMBIGUOUS");
    const b = await handle(consume({ engage_ref: `${t2.txHash}#1` }), h.router);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(h.builder.lastCall?.engageUtxo).toBe(t2);
  });

  it("engage_ref là thread của chủ khác ⟹ 400 ENGAGE_REF_MISMATCH; không ở địa chỉ engage ⟹ 400", async () => {
    const other = threadUtxo(OTHER_OWNER, "c1".repeat(32), 0, "03");
    const h = harness({ threads: [threadUtxo(KEY_OWNER, "c2".repeat(32)), other, PLAIN_AT_ENGAGE] });
    const a = await handle(consume({ engage_ref: `${other.txHash}#0` }), h.router);
    expect(a.status).toBe(400);
    expect(codeOf(a)).toBe("ENGAGE_REF_MISMATCH");
    const b = await handle(consume({ engage_ref: `${"dd".repeat(32)}#0` }), h.router);
    expect(codeOf(b)).toBe("ENGAGE_REF_MISMATCH");
    // UTxO CÓ ở địa chỉ engage nhưng không mang NFT thread: cổng NFT, không phải cổng địa chỉ.
    const c = await handle(consume({ engage_ref: `${PLAIN_AT_ENGAGE.txHash}#0` }), h.router);
    expect(c.status, JSON.stringify(c.body)).toBe(400);
    expect(codeOf(c)).toBe("ENGAGE_REF_MISMATCH");
    expect(h.builder.lastCall).toBeNull();
  });

  it("engage_ref mang NFT nhưng datum hỏng ⟹ 422 ENGAGE_THREAD_DATUM_UNDECODABLE; sai khuôn ⟹ 400 ENGAGE_REF_SHAPE", async () => {
    const h = harness({ threads: [threadUtxo(KEY_OWNER, "c2".repeat(32)), GARBAGE] });
    const a = await handle(consume({ engage_ref: `${GARBAGE.txHash}#0` }), h.router);
    expect(a.status).toBe(422);
    expect(codeOf(a)).toBe("ENGAGE_THREAD_DATUM_UNDECODABLE");
    const b = await handle(consume({ engage_ref: "abc#0" }), h.router);
    expect(codeOf(b)).toBe("ENGAGE_REF_SHAPE");
  });
});

// ── /tx/open-thread ──────────────────────────────────────────────────────────

const open = (over: Record<string, unknown> = {}) =>
  post("/tx/open-thread", { owner_pkh: OWNER_PKH, change_address: CHANGE_ADDRESS, ...over });

describe("/tx/open-thread", () => {
  it("dương: chủ chưa có thread, change_address ⟹ 200, NFT/datum đọc TỪ CBOR, tx vào sổ phát hành", async () => {
    const h = harness({ threads: [threadUtxo(OTHER_OWNER, "a1".repeat(32))] });
    const r = await handle(open(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as Record<string, unknown> & { summary: { engage: Record<string, unknown> }; tx_hash: string };
    expect(Object.keys(b).sort()).toEqual([
      "engage_address", "engage_nft", "expires_at", "owner", "required_signers", "summary", "tx_cbor", "tx_hash", "witness_notes",
    ]);
    expect(b.engage_nft).toBe(THREAD_UNIT);
    expect(b.engage_address).toBe(ENGAGE_ADDRESS);
    expect(b.summary.engage).toMatchObject({ owner: KEY_OWNER, consumed_count: "0", lovelace: "2000000" });
    expect(h.issued.wasIssued(b.tx_hash, NOW)).toBe(true);
    expect(h.builder.lastCall?.changeAddress).toBe(CHANGE_ADDRESS);
  });

  it("chủ đã có thread ⟹ 409 ENGAGE_THREAD_EXISTS, bộ dựng không bị gọi", async () => {
    const h = harness();
    const r = await handle(open(), h.router);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("ENGAGE_THREAD_EXISTS");
    expect(h.builder.lastCall).toBeNull();
  });

  it("chỉ fee_payer ⟹ 422 FEE_PAYER_DEPOSIT_UNSOURCED; funding ⟹ 501 OPEN_THREAD_FUNDING_UNSUPPORTED", async () => {
    const h = harness({ threads: [] });
    const a = await handle(open({ change_address: undefined, fee_payer: FEE_PAYER }), h.router);
    expect(a.status).toBe(422);
    expect(codeOf(a)).toBe("FEE_PAYER_DEPOSIT_UNSOURCED");
    const b = await handle(open({ funding: { type: "did_payment" } }), h.router);
    expect(b.status).toBe(501);
    expect(codeOf(b)).toBe("OPEN_THREAD_FUNDING_UNSUPPORTED");
    expect(h.builder.lastCall).toBeNull();
  });

  const bad: [string, { openCbor?: string; declaredUnit?: string }][] = [
    ["datum thread mang chủ khác", { openCbor: openTx({ owner: OTHER_OWNER }) }],
    ["datum thread không phải genesis (consumed_count 1)", { openCbor: openTx({ consumedCount: 1n }) }],
    ["NFT đúc khác NFT bộ dựng khai", { declaredUnit: ENGAGE_SCRIPT_HASH + "beef" }],
    ["NFT đúc KHÔNG dưới policy consume", { openCbor: openTx({ mintUnit: "d0".repeat(28) + "c0ffee" }) }],
    ["output thread không ở địa chỉ engage", { openCbor: openTx({ outAddress: VAULT_ADDRESS }) }],
    // NFT khai + output đều đúng, chỉ SỐ LƯỢNG đúc sai: chỉ cổng "đúng 1 dưới policy, qty 1" bắt được.
    ["đúc 2 đơn vị NFT thread (output vẫn mang 1)", { openCbor: openTx({ mintQty: 2n }) }],
  ];
  for (const [name, o] of bad) {
    it(`đọc lại CBOR: ${name} ⟹ 422 OPEN_THREAD_TX_MISMATCH`, async () => {
      const h = harness({ threads: [], ...o });
      const r = await handle(open(), h.router);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(codeOf(r)).toBe("OPEN_THREAD_TX_MISMATCH");
    });
  }
});
