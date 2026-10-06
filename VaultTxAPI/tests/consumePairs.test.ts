// VaultTxAPI/tests/consumePairs.test.ts — `POST /tx/consume` dạng `pairs` (ConsumeMany, constr 3)
// và phép đọc lại `consumeLine.ts` ▸ `checkConsumeTx`.
//
// ══ HAI KHỐI ══════════════════════════════════════════════════════════════════
// (1) Hình dạng `pairs` ở tầng HTTP: mỗi luật một mã 400, bộ dựng KHÔNG được gọi. Mỗi ca âm có
//     một ca dương sát biên (8 cặp được, 9 cặp không; op_count "1" được, "0" không…), để ca âm đỏ
//     vì đúng luật đang canh chứ không vì thân bài hỏng chỗ khác.
// (2) `checkConsumeTx`: một ca dương + một ca âm cho TỪNG vế (1)–(4) của nó. Mỗi ca âm dựng từ
//     ĐÚNG tx của ca dương rồi đổi một chỗ — đầu vào phân biệt được hai bên đột biến.
// Bộ dựng ở đây là bản GHI SẴN; validator chạy thật ở `consumeManyEmulator.test.ts`.
// ══════════════════════════════════════════════════════════════════════════════

import { Constr, Data, type UTxO } from "@lucid-evolution/lucid";
import { posixMsToEpoch } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment } from "../src/config.js";
import { checkConsumeTx, consumeLineOf, type ConsumeLine } from "../src/consumeLine.js";
import type { EngageThread } from "../src/engage.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder } from "../src/txBuilder.js";
import { PRICE_REF, threadDatumAfter, withConsumeLeg, type ConsumeLegSpec } from "./fixtures/consume.js";
import { ENGAGE_ADDRESS, ENGAGE_SCRIPT_HASH, engageDatumHex, threadUtxo } from "./fixtures/engage.js";
import { GB_SHARD_REF, genV2Chain, genV2Json } from "./fixtures/genV2.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OTHER_OWNER_PKH, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor, type TxSpec, prerecordedTtlSlot } from "./fixtures/tx.js";

const NET = "Preprod" as const;
const TTL = 180_000;
const NOW = 1_789_100_703_000;
const FIXTURE_TTL_SLOT = prerecordedTtlSlot(NOW, undefined, "Preprod");
const TIP: ChainTip = {
  blockHeight: 4_651_976,
  blockHash: "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f",
  blockTimePosixMs: BigInt(NOW),
};
const EPOCH = posixMsToEpoch(BigInt(NOW), NET);

const DEPLOYMENT_JSON = JSON.stringify({
  source: "bản dựng thử của phép kiểm — không phải một lần deploy thật",
  lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
  vaults: [{ vault_type: "Instant", address: VAULT_ADDRESS }],
  shard_address: SHARD_ADDRESS,
  ref_script_utxos: {
    vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
    gb_shard: GB_SHARD_REF,
  },
  consume: {
    engage_address: ENGAGE_ADDRESS,
    price_beacon_address: VAULT_ADDRESS,
    price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
  },
  gen_v2: genV2Json(NET),
});

const LIVE_BATCH = { id: "b0".repeat(16), createdEpoch: EPOCH, amountNanogic: 5_000_000_000n };
const VAULT_REF = { txHash: INPUT_TX_HASH, outputIndex: 0 };
const KEY_OWNER = { type: "key" as const, hash: OWNER_PKH };
const THREAD = threadUtxo(KEY_OWNER, "7e".repeat(32));
const VAULT_ASSETS = { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n };

const VAULT_UTXO: UTxO = {
  ...VAULT_REF, address: VAULT_ADDRESS, assets: VAULT_ASSETS,
  datum: datumHex({
    lampLockedOildrop: 0n, batches: [LIVE_BATCH], instantUnlockMs: 0n,
    lastUpdatedEpoch: EPOCH - 1n, capEpoch: EPOCH, wakemeLink: "",
  }),
};

type Pair = { opType: number; opCount: bigint };

/** Vế KÉT: đốt `burned` khỏi lô sống, `consumed_credit` tăng đúng bấy nhiêu. */
function vaultSide(burned: bigint): TxSpec {
  return { ttlSlot: FIXTURE_TTL_SLOT,
    inputs: [VAULT_REF],
    feeLovelace: 178_000n,
    outputs: [{
      address: VAULT_ADDRESS, assets: VAULT_ASSETS,
      inlineDatumHex: datumHex({
        lampLockedOildrop: 0n, batches: [{ ...LIVE_BATCH, amountNanogic: LIVE_BATCH.amountNanogic - burned }],
        instantUnlockMs: 0n, lastUpdatedEpoch: EPOCH, capEpoch: EPOCH, usageWindowEpoch: EPOCH,
        consumedCreditNanogic: burned,
      }),
    }],
  };
}

/** Tx tiêu đầy đủ (két + thread) — `required` = lượng két đốt. */
function consumeSpec(pairs: Pair[], required: bigint, over: Partial<ConsumeLegSpec> = {}): TxSpec {
  return withConsumeLeg(vaultSide(required), { thread: THREAD, vaultRef: VAULT_REF, pairs, requiredNanogic: required, ...over });
}

function harness(cbor: string) {
  const deployment = parseDeployment(DEPLOYMENT_JSON, NET);
  const chain = new RecordedChainReader(
    { [VAULT_ADDRESS]: [VAULT_UTXO], [ENGAGE_ADDRESS]: [THREAD], ...genV2Chain(NET, { epoch: EPOCH }) },
    TIP, [THREAD]);
  const builder = new RecordedTxBuilder({ consume: cbor });
  const service = new VaultTxService({
    network: NET, deployment, chain, builder,
    locks: new OwnerLockTable(TTL), issued: new IssuedTxRegistry(),
    lockTtlMs: TTL, now: () => NOW,
  });
  const router: RouterDeps = {
    service, deploymentSource: deployment.source, vaultScopes: deployment.vaults, network: NET,
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { builder, router };
}

const post = (body: Record<string, unknown>) => ({
  method: "POST", url: "/tx/consume", headers: {}, body: { owner_pkh: OWNER_PKH, ...body },
});
const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
type ConsumeView = { redeemer: string; pairs: { op_type: number; op_count: string }[]; required_nanogic: string; engage_input_ref: string };
const consumeOf = (r: { body: unknown }) => (r.body as { summary: { consume: ConsumeView } }).summary.consume;
const wire = (pairs: Pair[]) => pairs.map(p => ({ op_type: p.opType, op_count: p.opCount.toString() }));

// Bốn mã nghiệp vụ OriLife (1–4), mỗi mã một lần.
const ORILIFE_4: Pair[] = [1, 2, 3, 4].map(t => ({ opType: t, opCount: BigInt(t) }));
const TWO: Pair[] = [{ opType: 1, opCount: 2n }, { opType: 3, opCount: 1n }];

// ── (1) tầng HTTP ────────────────────────────────────────────────────────────

describe("POST /tx/consume — `pairs` hợp lệ", () => {
  it("2 cặp ⟹ 200, bộ dựng nhận `pairs`, summary.consume = ConsumeMany đọc TỪ CBOR", async () => {
    const h = harness(buildTxCbor(consumeSpec(TWO, 7_000_000n)));
    const r = await handle(post({ pairs: wire(TWO) }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((h.builder.lastCall!.buildParams as { pairs?: Pair[] }).pairs).toEqual(TWO);
    const c = consumeOf(r);
    expect(c.redeemer).toBe("ConsumeMany");
    expect(c.pairs).toEqual(wire(TWO));
    expect(c.required_nanogic).toBe("7000000");
    expect(c.engage_input_ref).toBe(`${THREAD.txHash}#0`);
  });

  it("4 cặp OriLife (mã 1–4) ⟹ 200, ConsumeMany 4 cặp", async () => {
    const h = harness(buildTxCbor(consumeSpec(ORILIFE_4, 9_000_000n)));
    const r = await handle(post({ pairs: wire(ORILIFE_4) }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(consumeOf(r).pairs).toEqual(wire(ORILIFE_4));
  });

  it("biên trên: 8 cặp ⟹ 200", async () => {
    const eight: Pair[] = [1, 2, 3, 4, 5, 6, 7, 8].map(t => ({ opType: t, opCount: 1n }));
    const h = harness(buildTxCbor(consumeSpec(eight, 8_000_000n)));
    const r = await handle(post({ pairs: wire(eight) }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("`pairs` MỘT phần tử ⟹ bộ dựng nhận dạng đơn (Consume constr 0), summary in danh sách một phần tử", async () => {
    const one: Pair[] = [{ opType: 2, opCount: 3n }];
    const h = harness(buildTxCbor(consumeSpec(one, 3_000_000n)));
    const r = await handle(post({ pairs: wire(one) }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = h.builder.lastCall!.buildParams as { opType?: number; opCount?: bigint; pairs?: unknown };
    expect([p.opType, p.opCount, p.pairs]).toEqual([2, 3n, undefined]);
    expect(consumeOf(r).redeemer).toBe("Consume");
    expect(consumeOf(r).pairs).toEqual(wire(one));
  });

  it("dạng một cặp cũ ⟹ 200, summary.consume = Consume", async () => {
    const h = harness(buildTxCbor(consumeSpec([{ opType: 1, opCount: 2n }], 2_000_000n)));
    const r = await handle(post({ op_type: 1, op_count: "2" }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(consumeOf(r)).toMatchObject({ redeemer: "Consume", pairs: [{ op_type: 1, op_count: "2" }], required_nanogic: "2000000" });
  });
});

describe("POST /tx/consume — `pairs` sai ⟹ 400 có mã, bộ dựng KHÔNG được gọi", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["cả hai dạng (pairs + op_type + op_count)", { pairs: wire(TWO), op_type: 1, op_count: "2" }, "CONSUME_PAIRS_CONFLICT"],
    ["cả hai dạng (pairs + chỉ op_type)", { pairs: wire(TWO), op_type: 1 }, "CONSUME_PAIRS_CONFLICT"],
    ["cả hai dạng (pairs + chỉ op_count)", { pairs: wire(TWO), op_count: "2" }, "CONSUME_PAIRS_CONFLICT"],
    ["pairs rỗng", { pairs: [] }, "CONSUME_PAIRS_EMPTY"],
    ["9 cặp", { pairs: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(t => ({ op_type: t, op_count: "1" })) }, "CONSUME_PAIRS_TOO_MANY"],
    ["không tăng ngặt (3 rồi 1)", { pairs: [{ op_type: 3, op_count: "1" }, { op_type: 1, op_count: "1" }] }, "CONSUME_PAIRS_NOT_INCREASING"],
    ["trùng op_type", { pairs: [{ op_type: 2, op_count: "1" }, { op_type: 2, op_count: "1" }] }, "CONSUME_PAIRS_NOT_INCREASING"],
    ["op_count \"0\"", { pairs: [{ op_type: 1, op_count: "1" }, { op_type: 2, op_count: "0" }] }, "CONSUME_PAIR_COUNT_INVALID"],
    ["op_count âm", { pairs: [{ op_type: 1, op_count: "-1" }] }, "CONSUME_PAIR_COUNT_INVALID"],
    ["op_count là số JSON", { pairs: [{ op_type: 1, op_count: 2 }] }, "CONSUME_PAIR_COUNT_INVALID"],
    ["op_count dài 21 chữ số", { pairs: [{ op_type: 1, op_count: "1".repeat(21) }] }, "CONSUME_PAIR_COUNT_INVALID"],
    ["op_count vắng", { pairs: [{ op_type: 1 }] }, "CONSUME_PAIR_COUNT_INVALID"],
    ["op_type là chuỗi", { pairs: [{ op_type: "1", op_count: "1" }] }, "CONSUME_PAIR_TYPE_INVALID"],
    ["op_type thập phân", { pairs: [{ op_type: 1.5, op_count: "1" }] }, "CONSUME_PAIR_TYPE_INVALID"],
    ["op_type âm", { pairs: [{ op_type: -1, op_count: "1" }] }, "CONSUME_PAIR_TYPE_INVALID"],
    ["op_type quá 1000000", { pairs: [{ op_type: 1_000_001, op_count: "1" }] }, "CONSUME_PAIR_TYPE_INVALID"],
    ["pairs không phải mảng", { pairs: { op_type: 1, op_count: "1" } }, "CONSUME_PAIRS_SHAPE"],
    ["phần tử null", { pairs: [null] }, "CONSUME_PAIRS_SHAPE"],
    ["phần tử là mảng", { pairs: [[1, "1"]] }, "CONSUME_PAIRS_SHAPE"],
    ["phần tử có khoá lạ", { pairs: [{ op_type: 1, op_count: "1", price: "0" }] }, "CONSUME_PAIRS_SHAPE"],
  ];
  for (const [name, body, code] of cases) {
    it(name, async () => {
      const h = harness(buildTxCbor(consumeSpec(TWO, 7_000_000n)));
      const r = await handle(post(body), h.router);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(codeOf(r)).toBe(code);
      expect(h.builder.lastCall).toBeNull();
    });
  }

  it("CỰC ĐỐI biên: op_count \"1\" + op_type 1000000 ⟹ 200 (không phải 400)", async () => {
    const p: Pair[] = [{ opType: 1_000_000, opCount: 1n }];
    const h = harness(buildTxCbor(consumeSpec(p, 1_000_000n)));
    const r = await handle(post({ pairs: wire(p) }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe("consumeLineOf — tầng DỊCH VỤ kiểm lại, không chỉ tin bộ đọc HTTP", () => {
  it("pairs + opType ⟹ CONSUME_PAIRS_CONFLICT; không có cả hai ⟹ BAD_REQUEST; 1 phần tử ⟹ single", () => {
    expect(thrown(() => consumeLineOf({ pairs: TWO, opType: 1 })).code).toBe("CONSUME_PAIRS_CONFLICT");
    expect(thrown(() => consumeLineOf({ pairs: TWO, opCount: 1n })).code).toBe("CONSUME_PAIRS_CONFLICT");
    expect(thrown(() => consumeLineOf({})).code).toBe("BAD_REQUEST");
    expect(consumeLineOf({ pairs: [{ opType: 4, opCount: 1n }] })).toEqual({ kind: "single", opType: 4, opCount: 1n });
    expect(consumeLineOf({ pairs: TWO })).toEqual({ kind: "many", pairs: TWO });
    expect(thrown(() => consumeLineOf({ pairs: [{ opType: 2, opCount: 1n }, { opType: 1, opCount: 1n }] })).code)
      .toBe("CONSUME_PAIRS_NOT_INCREASING");
  });
});

// ── (2) checkConsumeTx ───────────────────────────────────────────────────────

const ENGAGE_THREAD: EngageThread = { utxo: THREAD, nftUnit: `${ENGAGE_SCRIPT_HASH}01`, owner: KEY_OWNER };
const LINE: ConsumeLine = { kind: "many", pairs: TWO };
const REQ = 7_000_000n;

function check(spec: TxSpec, o: { line?: ConsumeLine; burned?: bigint } = {}) {
  return checkConsumeTx(buildTxCbor(spec), {
    engageAddress: ENGAGE_ADDRESS, thread: ENGAGE_THREAD, vaultInputRef: VAULT_REF,
    line: o.line ?? LINE, burnedNanogic: o.burned ?? REQ,
  });
}
const base = () => consumeSpec(TWO, REQ);
const threadOutIx = (s: TxSpec) => s.outputs.length - 1;
/** Lỗi ném ra — `{httpStatus, code, message}` — để mỗi ca âm khẳng định ĐÚNG vế đã chặn nó. */
function thrown(fn: () => unknown): { httpStatus: number; code: string; message: string } {
  try { fn(); } catch (e) { return e as { httpStatus: number; code: string; message: string }; }
  throw new Error("không ném");
}

describe("checkConsumeTx — đọc lại tx tiêu TỪ CBOR", () => {
  it("dương: ConsumeMany 2 cặp khớp ⟹ trả tóm tắt", () => {
    expect(check(base())).toEqual({
      redeemer: "ConsumeMany", pairs: wire(TWO), required_nanogic: "7000000", required_magic: "0.007000000",
      engage_input_ref: `${THREAD.txHash}#0`,
    });
  });

  // [tên, tx, đoạn thông điệp của ĐÚNG vế phải chặn, ngữ cảnh]
  const neg: [string, () => TxSpec, string, { line?: ConsumeLine; burned?: bigint }?][] = [
    ["(1) thread không phải input", () => vaultSide(REQ), "không phải input của giao dịch"],
    ["(1) thread không có redeemer Spend", () => ({ ...base(), spendRedeemers: [] }), "cần đúng MỘT redeemer Spend"],
    ["(2) redeemer không phải Consume/ConsumeMany (constr 1)", () => {
      const s = base();
      return { ...s, spendRedeemers: s.spendRedeemers!.map(r => ({ ...r, dataHex: Data.to(new Constr(1, [])) })) };
    }, "không phải Consume/ConsumeMany"],
    ["(2) redeemer đúng cặp nhưng SAI dạng (Consume đơn cho lượt many)", () => consumeSpec(TWO.slice(0, 1), REQ),
      "không mang đúng lượt tiêu", { line: LINE }],
    ["(2) redeemer ConsumeMany một cặp cho lượt single", () => consumeSpec([TWO[0]!], REQ, { redeemer: "ConsumeMany" }),
      "không mang đúng lượt tiêu", { line: { kind: "single", opType: 1, opCount: 2n } }],
    ["(2) op_count trong redeemer lệch yêu cầu", () => consumeSpec([{ opType: 1, opCount: 2n }, { opType: 3, opCount: 2n }], REQ), "không mang đúng lượt tiêu"],
    ["(2) vault_ref trỏ két khác", () => consumeSpec(TWO, REQ, { vaultRef: { txHash: INPUT_TX_HASH, outputIndex: 1 } }), "redeemer trỏ két"],
    ["(2) price_ref không nằm trong reference_inputs", () => ({ ...base(), referenceInputs: [] }), "không nằm trong reference_inputs"],
    ["(3) không có output ở địa chỉ engage", () => { const s = base(); return { ...s, outputs: s.outputs.slice(0, -1) }; }, "có 0 output ở địa chỉ engage"],
    ["(3) hai output ở địa chỉ engage", () => { const s = base(); return { ...s, outputs: [...s.outputs, s.outputs[threadOutIx(s)]!] }; }, "có 2 output ở địa chỉ engage"],
    ["(3) output thread mất NFT", () => {
      const s = base(); const o = s.outputs[threadOutIx(s)]!;
      return { ...s, outputs: [...s.outputs.slice(0, -1), { ...o, assets: { lovelace: 2_000_000n } }] };
    }, "không mang NFT thread"],
    ["(3) value thread đổi 1 lovelace", () => {
      const s = base(); const o = s.outputs[threadOutIx(s)]!;
      return { ...s, outputs: [...s.outputs.slice(0, -1), { ...o, assets: { ...o.assets, lovelace: 2_000_001n } }] };
    }, "value của output thread khác"],
    ["(4) output thread không datum", () => {
      const s = base(); const o = s.outputs[threadOutIx(s)]!;
      return { ...s, outputs: [...s.outputs.slice(0, -1), { address: o.address, assets: o.assets }] };
    }, "không mang datum inline"],
    ["(4) chủ thread đổi", () => {
      const s = base(); const o = s.outputs[threadOutIx(s)]!;
      const other = { ...THREAD, datum: engageDatumHex({ type: "key", hash: OTHER_OWNER_PKH }) };
      return { ...s, outputs: [...s.outputs.slice(0, -1), { ...o, inlineDatumHex: threadDatumAfter(other, 3n, REQ) }] };
    }, "đổi chủ"],
    ["(4) consumed_count tăng sai (2 thay vì 3)", () => {
      const s = base(); const o = s.outputs[threadOutIx(s)]!;
      return { ...s, outputs: [...s.outputs.slice(0, -1), { ...o, inlineDatumHex: threadDatumAfter(THREAD, 2n, REQ) }] };
    }, "consumed_count tăng 2"],
    ["(4) required ≠ lượng két đốt (lệch 1 nanogic)", () => base(), "két đốt 7000001", { burned: REQ + 1n }],
    ["(4) required = 0 (két cũng đốt 0)", () => consumeSpec(TWO, 0n), "consumed_nanogic của thread tăng 0", { burned: 0n }],
  ];
  for (const [name, mk, frag, o] of neg) {
    it(`âm ${name} ⟹ 422 CONSUME_TX_MISMATCH`, () => {
      const e = thrown(() => check(mk(), o ?? {}));
      expect([e.httpStatus, e.code]).toEqual([422, "CONSUME_TX_MISMATCH"]);
      expect(e.message).toContain(frag);
    });
  }

  it("âm: CBOR không giải mã được ⟹ 422 CONSUME_TX_MISMATCH", () => {
    const e = thrown(() => checkConsumeTx("00ff", {
      engageAddress: ENGAGE_ADDRESS, thread: ENGAGE_THREAD, vaultInputRef: VAULT_REF, line: LINE, burnedNanogic: REQ,
    }));
    expect([e.httpStatus, e.code]).toEqual([422, "CONSUME_TX_MISMATCH"]);
    expect(e.message).toContain("CBOR không giải mã được");
  });

  it("CẶP của ca price_ref: price_ref khác mặc định nhưng có trong reference_inputs ⟹ qua", () => {
    const pr = { ...PRICE_REF, outputIndex: 5 };
    expect(check(consumeSpec(TWO, REQ, { priceRef: pr })).redeemer).toBe("ConsumeMany");
  });
});
