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
import { withConsumeLeg } from "./fixtures/consume.js";
import { GEN_V2_REF_SCRIPTS, genV2Chain, genV2Json } from "./fixtures/genV2.js";

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

// Lô MAGIC sống của két: tx tiêu đốt `CONSUME_BURN` từ lô này (`consumed_credit` tăng đúng bấy
// nhiêu) — `/tx/consume` đọc lại Σburns == required từ CBOR (`fixtures/consume.ts`). Các route
// khác giữ nguyên lô ⟹ kế toán MAGIC của chúng không đổi.
const FEE_BATCH = { id: "fb".repeat(16), createdEpoch: 20_707n, amountNanogic: 5_000_000_000n };
const CONSUME_BURN = 1_000_000_000n;
const vaultOutMagic = (consume: boolean) => consume
  ? { batches: [{ ...FEE_BATCH, amountNanogic: FEE_BATCH.amountNanogic - CONSUME_BURN }], consumedCreditNanogic: CONSUME_BURN }
  : { batches: [FEE_BATCH] };
const VAULT_DATUM = datumHex({ lampLockedOildrop: 2_000_000n, batches: [FEE_BATCH] });
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
    ...GEN_V2_REF_SCRIPTS,
  },
  gen_v2: genV2Json("Preview"),
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
  /** Có ⟹ tx TIÊU MAGIC: két đốt `CONSUME_BURN`, ghép vế thread này (op 1 × 2). */
  consumeThread?: UTxO;
}

/** Tx đi qua vault, phí do FEE_UTXO (10 ADA) trả: phí 0,178 + thối 9,822; thế chấp mất ≤ 3 ADA. */
function feeTx(o: FeeTxOpts = {}): string {
  const outputs: TxOutputSpec[] = [
    {
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n - (o.stakedOutput ?? 0n), [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      inlineDatumHex: datumHex({ lampLockedOildrop: 23_000_000n, genScheduleCount: 1, ...vaultOutMagic(o.consumeThread !== undefined) }),
    },
    { address: o.changeTo ?? FEE_ADDRESS, assets: { lovelace: o.feeChange ?? 10_000_000n - FEE } },
  ];
  if (o.stakedOutput !== undefined) outputs.push({ address: FEE_ADDRESS_STAKED, assets: { lovelace: o.stakedOutput } });
  const spec = {
    inputs: [ref(VAULT_UTXO), ref(FEE_UTXO), ...(o.extraInput ? [o.extraInput] : [])],
    feeLovelace: FEE,
    outputs,
    requiredSigners: [OWNER_PKH],
    collateralInputs: [ref(FEE_UTXO)],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: o.collateralReturn ?? 7_000_000n } },
    ttlSlot: o.ttlMs === null ? undefined : BigInt(unixTimeToSlot("Preview", NOW + (o.ttlMs ?? 1_800_000))),
  };
  return buildTxCbor(o.consumeThread === undefined ? spec : withConsumeLeg(spec, {
    thread: o.consumeThread, vaultRef: ref(VAULT_UTXO), pairs: [{ opType: 1, opCount: 2n }], requiredNanogic: CONSUME_BURN,
  }));
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

function harness(opts: { threads?: UTxO[]; cbor?: string; openCbor?: string; declaredUnit?: string; consumeThread?: UTxO } = {}) {
  const chain = new RecordedChainReader(
    { [VAULT_ADDRESS]: [VAULT_UTXO], [ENGAGE_ADDRESS]: opts.threads ?? [threadUtxo(KEY_OWNER, "7e".repeat(32))], ...genV2Chain("Preview", { epoch: 20_707n }) },
    TIP,
    // Thread của lượt tiêu là INPUT của tx ⟹ phép đọc lại ví trả phí tra nó theo tham chiếu.
    [VAULT_UTXO, FEE_UTXO, FEE_UTXO_2, opts.consumeThread ?? threadUtxo(KEY_OWNER, "7e".repeat(32))],
  );
  const cbor = opts.cbor ?? feeTx();
  const builder = new RecordedTxBuilder(
    {
      schedule_commit: cbor, schedule_fire: cbor, open_thread: opts.openCbor ?? openTx(),
      // Thread mà lượt tiêu sẽ chọn — mặc định thread duy nhất của chủ ở chuỗi ghi sẵn.
      consume: feeTx({ consumeThread: opts.consumeThread ?? threadUtxo(KEY_OWNER, "7e".repeat(32)) }),
    },
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
// `schedule_id` không cần khớp một lịch thật trong datum: `RecordedTxBuilder` không đọc tham
// số, nó chỉ trả CBOR ghi sẵn — validate "lịch này có tồn tại" là việc của bộ dựng thật, không
// phải của `VaultTxService`.
const SCHEDULE_ID = "a0".repeat(32);
const scheduleFire = (over: Record<string, unknown> = {}) =>
  post("/tx/schedule-fire", { owner_pkh: OWNER_PKH, schedule_id: SCHEDULE_ID, ...over });

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
      // Két không đổi lovelace ⟹ không ứng gì; output két là output được chỉ định (#0).
      fronted_lovelace: "0", fronted_max_lovelace: "5000000", fronted_output_index: 0,
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

// ── /tx/schedule-fire — CÙNG cổng fee_payer với schedule-commit (chung `buildOne`) ──────

describe("fee_payer — schedule-fire", () => {
  it("schedule-fire: 200, summary.fee_payer đọc TỪ CBOR; bộ dựng nhận đúng UTxO trả phí + thế chấp 3 ADA", async () => {
    const h = harness();
    const r = await handle(scheduleFire({ fee_payer: FEE_PAYER }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as { summary: { fee_payer: Record<string, unknown> } };
    expect(b.summary.fee_payer).toEqual({
      address: FEE_ADDRESS, utxo: `${FEE_UTXO.txHash}#0`, input_lovelace: "10000000",
      fee_lovelace: String(FEE), change_lovelace: String(10_000_000n - FEE),
      // Két không đổi lovelace ⟹ không ứng gì; output két là output được chỉ định (#0).
      fronted_lovelace: "0", fronted_max_lovelace: "5000000", fronted_output_index: 0,
      collateral_at_risk_lovelace: "3000000", collateral_return_lovelace: "7000000",
      valid_to_posix_ms: String(NOW + 1_800_000),
    });
    expect(h.builder.lastCall?.feePayerUtxo).toBe(FEE_UTXO);
    expect(h.builder.lastCall?.collateralLovelace).toBe(3_000_000n);
  });

  it("CẶP: không có fee_payer ⟹ summary không có fee_payer, bộ dựng không nhận UTxO trả phí", async () => {
    const h = harness();
    const r = await handle(scheduleFire(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as { summary: Record<string, unknown> }).summary.fee_payer).toBeUndefined();
    expect(h.builder.lastCall?.feePayerUtxo).toBeUndefined();
  });

  it("fee_payer cùng change_address ⟹ 400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT", async () => {
    const h = harness();
    const r = await handle(scheduleFire({ fee_payer: FEE_PAYER, change_address: CHANGE_ADDRESS }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_PAYER_CHANGE_ADDRESS_CONFLICT");
    expect(h.builder.lastCall).toBeNull();
  });
});

// ── /tx/consume chọn thread theo chủ ─────────────────────────────────────────

const consume = (over: Record<string, unknown> = {}) =>
  post("/tx/consume", { owner_pkh: OWNER_PKH, op_type: 1, op_count: "2", ...over });
const GARBAGE = utxo("9a".repeat(32), 0, ENGAGE_ADDRESS, { lovelace: 2_000_000n, [ENGAGE_SCRIPT_HASH + "99"]: 1n }, "d87980");
const PLAIN_AT_ENGAGE = utxo("9b".repeat(32), 0, ENGAGE_ADDRESS, { lovelace: 3_000_000n });

describe("/tx/consume — thread Engage theo chủ", () => {
  it("hai thread của hai chủ (+ một UTxO rác mang NFT) ⟹ 200, chọn đúng thread của chủ yêu cầu", async () => {
    const mine = threadUtxo(KEY_OWNER, "a2".repeat(32), 0, "01");
    const h = harness({ threads: [threadUtxo(OTHER_OWNER, "a1".repeat(32), 0, "02"), GARBAGE, mine], consumeThread: mine });
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
    const h = harness({ threads: [t1, t2], consumeThread: t2 });
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

// ── /tx/consume — CÙNG cổng fee_payer với schedule-commit (chung `buildOne`) ────────────

describe("fee_payer — consume", () => {
  it("consume: 200, summary.fee_payer đọc TỪ CBOR; bộ dựng nhận đúng UTxO trả phí + thế chấp 3 ADA", async () => {
    const h = harness();
    const r = await handle(consume({ fee_payer: FEE_PAYER }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as { summary: { fee_payer: Record<string, unknown> } };
    expect(b.summary.fee_payer).toEqual({
      address: FEE_ADDRESS, utxo: `${FEE_UTXO.txHash}#0`, input_lovelace: "10000000",
      fee_lovelace: String(FEE), change_lovelace: String(10_000_000n - FEE),
      // Két không đổi lovelace ⟹ không ứng gì; output két là output được chỉ định (#0).
      fronted_lovelace: "0", fronted_max_lovelace: "5000000", fronted_output_index: 0,
      collateral_at_risk_lovelace: "3000000", collateral_return_lovelace: "7000000",
      valid_to_posix_ms: String(NOW + 1_800_000),
    });
    expect(h.builder.lastCall?.feePayerUtxo).toBe(FEE_UTXO);
    expect(h.builder.lastCall?.collateralLovelace).toBe(3_000_000n);
  });

  it("CẶP: không có fee_payer ⟹ summary không có fee_payer, bộ dựng không nhận UTxO trả phí", async () => {
    const h = harness();
    const r = await handle(consume(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as { summary: Record<string, unknown> }).summary.fee_payer).toBeUndefined();
    expect(h.builder.lastCall?.feePayerUtxo).toBeUndefined();
  });

  it("fee_payer cùng change_address ⟹ 400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT", async () => {
    const h = harness();
    const r = await handle(consume({ fee_payer: FEE_PAYER, change_address: CHANGE_ADDRESS }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_PAYER_CHANGE_ADDRESS_CONFLICT");
    expect(h.builder.lastCall).toBeNull();
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

// ── /tx/instant-gen — fee_payer, harness RIÊNG ───────────────────────────────────────────
//
// InstantGen Gen v2.0 đòi khối `gen_v2` + ref `gb_shard`, vault_type "Instant", và một mạng CÓ
// két Wakeme (Preprod — apply-param #8); `summarizeTx` còn ép datum ĐẦU RA phải Instant-shaped
// (20 trường) — khác hẳn `DEPLOYMENT`/`VAULT_UTXO` dùng ở trên (Schedule-shaped, 19 trường). Nên đường này cần
// một harness riêng, không tái dùng `harness()` phía trên; phần còn lại (`FEE_PAYER`,
// `FEE_UTXO`, `FEE_ADDRESS`, `CHANGE_ADDRESS`) vẫn dùng chung.


const INSTANT_DEPLOYMENT: Deployment = parseDeployment(JSON.stringify({
  source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
  lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
  vaults: [{ vault_type: "Instant", address: VAULT_ADDRESS }],
  shard_address: SHARD_ADDRESS,
  ref_script_utxos: {
    vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
    ...GEN_V2_REF_SCRIPTS,
  },
  gen_v2: genV2Json("Preprod"),
  consume: {
    engage_address: ENGAGE_ADDRESS,
    price_beacon_address: VAULT_ADDRESS,
    price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
  },
}), "Preprod");
// Epoch giao thức của NOW trên Preprod, tính TỪ GỐC cửa sổ (LAMP `Specs/Window/CONTRACT.md` v1.0):
// ⌊(1 789 100 703 000 − 1 654 041 600 000) / 432 000 000⌋ = 312. Bản trước ghi 4_141 (chia từ 0).
const INSTANT_EPOCH = 312n;

const INSTANT_VAULT_UTXO = utxo(INPUT_TX_HASH, 0, VAULT_ADDRESS,
  { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
  datumHex({ lampLockedOildrop: 0n, batches: [], instantUnlockMs: 0n, lastUpdatedEpoch: INSTANT_EPOCH - 1n }));

/** Tx đi qua vault Instant, phí do FEE_UTXO (10 ADA) trả — cùng số với `feeTx()` ở trên. */
function instantGenFeeTx(): string {
  return buildTxCbor({
    inputs: [ref(INSTANT_VAULT_UTXO), ref(FEE_UTXO)],
    feeLovelace: FEE,
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
        // `instantUnlockMs` BẮT BUỘC: chọn hình dạng datum 18 trường mà `summarizeTx` đòi
        // cho ý-định `instant_gen` (xem khối chú thích đầu mục này).
        inlineDatumHex: datumHex({
          lampLockedOildrop: 0n,
          batches: [{ id: "c0".repeat(16), createdEpoch: INSTANT_EPOCH, amountNanogic: 4_000_000n }],
          instantUnlockMs: 1_789_000_000_000n,
          lastUpdatedEpoch: INSTANT_EPOCH, capEpoch: INSTANT_EPOCH, capNanogic: 1_000_000_000n, usageWindowEpoch: INSTANT_EPOCH,
        }),
      },
      { address: FEE_ADDRESS, assets: { lovelace: 10_000_000n - FEE } },
    ],
    requiredSigners: [OWNER_PKH],
    collateralInputs: [ref(FEE_UTXO)],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: 7_000_000n } },
    ttlSlot: BigInt(unixTimeToSlot("Preprod", NOW + 1_800_000)),
  });
}

function instantHarness() {
  const chain = new RecordedChainReader(
    { [VAULT_ADDRESS]: [INSTANT_VAULT_UTXO], ...genV2Chain("Preprod", { epoch: INSTANT_EPOCH }) },
    TIP,
    [INSTANT_VAULT_UTXO, FEE_UTXO],
  );
  const builder = new RecordedTxBuilder({ instant_gen: instantGenFeeTx() });
  const issued = new IssuedTxRegistry(TTL * 4);
  const locks = new OwnerLockTable(TTL);
  const service = new VaultTxService({
    network: "Preprod", deployment: INSTANT_DEPLOYMENT, chain, builder, locks, issued, lockTtlMs: TTL, now: () => NOW,
  });
  const router: RouterDeps = {
    service, deploymentSource: INSTANT_DEPLOYMENT.source, vaultScopes: INSTANT_DEPLOYMENT.vaults, network: "Preprod",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { builder, router };
}

const instantGen = (over: Record<string, unknown> = {}) =>
  post("/tx/instant-gen", { owner_pkh: OWNER_PKH, m: "1", ...over });

describe("fee_payer — instant-gen", () => {
  it("instant-gen: 200, summary.fee_payer đọc TỪ CBOR; bộ dựng nhận đúng UTxO trả phí + thế chấp 3 ADA", async () => {
    const h = instantHarness();
    const r = await handle(instantGen({ fee_payer: FEE_PAYER }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as { summary: { fee_payer: Record<string, unknown> } };
    expect(b.summary.fee_payer).toEqual({
      address: FEE_ADDRESS, utxo: `${FEE_UTXO.txHash}#0`, input_lovelace: "10000000",
      fee_lovelace: String(FEE), change_lovelace: String(10_000_000n - FEE),
      // Két không đổi lovelace ⟹ không ứng gì; output két là output được chỉ định (#0).
      fronted_lovelace: "0", fronted_max_lovelace: "5000000", fronted_output_index: 0,
      collateral_at_risk_lovelace: "3000000", collateral_return_lovelace: "7000000",
      valid_to_posix_ms: String(NOW + 1_800_000),
    });
    expect(h.builder.lastCall?.feePayerUtxo).toBe(FEE_UTXO);
    expect(h.builder.lastCall?.collateralLovelace).toBe(3_000_000n);
  });

  it("CẶP: không có fee_payer ⟹ summary không có fee_payer, bộ dựng không nhận UTxO trả phí", async () => {
    const h = instantHarness();
    const r = await handle(instantGen(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as { summary: Record<string, unknown> }).summary.fee_payer).toBeUndefined();
    expect(h.builder.lastCall?.feePayerUtxo).toBeUndefined();
  });

  it("fee_payer cùng change_address ⟹ 400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT", async () => {
    const h = instantHarness();
    const r = await handle(instantGen({ fee_payer: FEE_PAYER, change_address: CHANGE_ADDRESS }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_PAYER_CHANGE_ADDRESS_CONFLICT");
    expect(h.builder.lastCall).toBeNull();
  });
});
