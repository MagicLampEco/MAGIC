// VaultTxAPI/tests/feePayerNewcomer.test.ts — người dùng mới 0 ADA đi trọn đường bằng ví trả phí.
//
// Bộ soát ký của PhoenixKey từ chối mọi tx có input (kể cả thế chấp) từ ví khoá của người dùng hoặc
// địa chỉ did_payment. Nên mỗi route của người mới phải dựng được với `fee_payer`, chỉ tiêu UTxO
// trả phí + UTxO ở địa chỉ luồng, và ví trả phí chỉ được ỨNG min-ADA cho đúng output két/thread của
// chủ, có trần (`feePayer.ts` ▸ khối "KHOẢN ỨNG MIN-ADA").
//
// Mỗi ca âm có cực đối dựng Y HỆT, chỉ khác đúng vế đang kiểm. Bộ dựng là `RecordedTxBuilder`: nó
// trả CBOR ghi sẵn, nên mọi ca âm đỏ vì CỔNG ĐỌC LẠI của dịch vụ, không vì bộ dựng từ chối.

import { credentialToAddress, unixTimeToSlot, type TxBuilder, type UTxO } from "@lucid-evolution/lucid";
import { encodeBindDidRedeemer } from "@magiclamp/consumemagic";
import type { OwnerRef } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { FEE_PAYER_DEFAULT_FRONTING_MAX_LOVELACE, parseDeployment } from "../src/config.js";
import { CodedApiError } from "../src/errors.js";
import { assertNoOwnerRewardToFeePayer } from "../src/feePayer.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import type { OwnerWitnessProvider, ScriptOwnerWitness } from "../src/owner.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../src/txBuilder.js";
import { ENGAGE_ADDRESS, ENGAGE_SCRIPT_HASH, engageDatumHex, threadUtxo } from "./fixtures/engage.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OTHER_OWNER_PKH, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor, type TxOutputSpec } from "./fixtures/tx.js";
import { GB_SHARD_POLICY, GEN_V2_REF_SCRIPTS, addrOf, genV2Chain, genV2Json } from "./fixtures/genV2.js";

const TTL = 180_000;
const NOW = 1_789_100_703_000;
const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };
const TTL_SLOT = BigInt(unixTimeToSlot("Preview", NOW + 1_800_000));
const KEY_OWNER: OwnerRef = { type: "key", hash: OWNER_PKH };
const SCRIPT_OWNER: OwnerRef = { type: "script", hash: OWNER_PKH };
const OWNER_WALLET = enterpriseAddressOf("Preview", OWNER_PKH);
const STRANGER = enterpriseAddressOf("Preview", OTHER_OWNER_PKH);
const FEE_ADDRESS = enterpriseAddressOf("Preview", "fe".repeat(28));
const FEE_IN = 10_000_000n;
const COLLATERAL_RETURN = 7_000_000n;

const utxo = (txHash: string, outputIndex: number, address: string, assets: Record<string, bigint>, datum?: string): UTxO =>
  ({ txHash, outputIndex, address, assets, ...(datum === undefined ? {} : { datum }) });
const ref = (u: { txHash: string; outputIndex: number }) => ({ txHash: u.txHash, outputIndex: u.outputIndex });

const FEE_UTXO = utxo("fa".repeat(32), 0, FEE_ADDRESS, { lovelace: FEE_IN });
const FEE_PAYER = { utxo: `${FEE_UTXO.txHash}#0`, address: FEE_ADDRESS };
/** UTxO ở ví khoá của chủ — thứ bộ soát ký của PhoenixKey từ chối khi nó là input. */
const OWNER_UTXO = utxo("c0".repeat(32), 0, OWNER_WALLET, { lovelace: 3_000_000n });

const FEE_BATCH = { id: "fb".repeat(16), createdEpoch: 20_707n, amountNanogic: 5_000_000_000n };
const VAULT_LOVELACE = 5_659_030n;
const VAULT_UTXO = utxo(INPUT_TX_HASH, 0, VAULT_ADDRESS,
  { lovelace: VAULT_LOVELACE, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
  datumHex({ lampLockedOildrop: 2_000_000n, batches: [FEE_BATCH] }));
/** Đo trên Preprod 2026-10-04: lượt Sinh đầu đòi nâng min-ADA két thêm đúng chừng này. */
const RAISE = 672_360n;

const THREAD_UNIT = ENGAGE_SCRIPT_HASH + "c0ffee";
const THREAD_TX = "7e".repeat(32);
const UNBOUND = threadUtxo(KEY_OWNER, THREAD_TX, 0, "01");
/** Thread chưa gắn DID của chủ SCRIPT (did_stake) — tx hash khác để hai thread cùng phân giải được. */
const UNBOUND_SCRIPT = threadUtxo(SCRIPT_OWNER, "7f".repeat(32), 0, "01");
const DID = "d1".repeat(32);

function deploymentJson(vaultType: "Schedule" | "Instant", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    vaults: [{ vault_type: vaultType, address: VAULT_ADDRESS }],
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
    ...extra,
  });
}

/** Phần chung của mọi tx đi ví trả phí: thế chấp = UTxO trả phí, trả lại 7 ADA, hạn 30 phút. */
function feeLegs(inputs: { txHash: string; outputIndex: number }[]) {
  return {
    inputs,
    collateralInputs: [ref(FEE_UTXO)],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: COLLATERAL_RETURN } },
    ttlSlot: TTL_SLOT,
  };
}
const ownerLeg = (on: boolean): TxOutputSpec[] => on ? [{ address: OWNER_WALLET, assets: { lovelace: OWNER_UTXO.assets.lovelace! } }] : [];

/** schedule-commit qua ví trả phí; `raise` lovelace từ ví trả phí vào KÉT, `stray` vào một địa chỉ lạ. */
function commitTx(o: { raise?: bigint; stray?: bigint } = {}): string {
  const fee = 178_000n;
  const raise = o.raise ?? 0n;
  const stray = o.stray ?? 0n;
  return buildTxCbor({
    ...feeLegs([ref(VAULT_UTXO), ref(FEE_UTXO)]),
    feeLovelace: fee,
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: VAULT_LOVELACE + raise, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({ lampLockedOildrop: 23_000_000n, genScheduleCount: 1, batches: [FEE_BATCH] }),
      },
      { address: FEE_ADDRESS, assets: { lovelace: FEE_IN - fee - raise - stray } },
      ...(stray > 0n ? [{ address: STRANGER, assets: { lovelace: stray } }] : []),
    ],
    requiredSigners: [OWNER_PKH],
  });
}

/** Shard GreenBack id 3 của bản ghi Gen v2.0 — UTxO DÙNG CHUNG mà nhánh sinh tiêu rồi dựng lại. */
const GB_SHARD_ADDRESS = addrOf("Preview", GB_SHARD_POLICY);
const SHARD_3 = genV2Chain("Preview", { epoch: 20_707n })[GB_SHARD_ADDRESS]![3]!;
/** Đo trên Preprod 2026-10-04 (cụm Wakeme v5): lượt sinh đầu trên một shard mới nâng min-ADA shard đúng chừng này. */
const SHARD_RAISE = 73_270n;

/**
 * Tx có chân shard: két nâng `raise`, shard nâng `shardRaise`, ví trả phí ứng cả hai.
 * `shardSpent: false` ⟹ shard KHÔNG bị tiêu — output ở địa chỉ shard là output mới, không phải dựng lại.
 */
function shardTx(o: { raise?: bigint; shardRaise: bigint; shardSpent?: boolean }): string {
  const fee = 178_000n;
  const raise = o.raise ?? 0n;
  const spent = o.shardSpent ?? true;
  const shardUnit = Object.keys(SHARD_3.assets).find(k => k !== "lovelace")!;
  return buildTxCbor({
    ...feeLegs([ref(VAULT_UTXO), ref(FEE_UTXO), ...(spent ? [ref(SHARD_3)] : [])]),
    feeLovelace: fee,
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: VAULT_LOVELACE + raise, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({ lampLockedOildrop: 23_000_000n, genScheduleCount: 1, batches: [FEE_BATCH] }),
      },
      {
        address: GB_SHARD_ADDRESS,
        assets: { lovelace: (spent ? SHARD_3.assets.lovelace : 0n) + o.shardRaise, [shardUnit]: 1n },
        inlineDatumHex: SHARD_3.datum!,
      },
      { address: FEE_ADDRESS, assets: { lovelace: FEE_IN - fee - raise - o.shardRaise } },
    ],
    requiredSigners: [OWNER_PKH],
  });
}

/** open-thread qua ví trả phí: UTxO trả phí là seed + input duy nhất; ví ứng trọn 2 ADA của thread. */
function openTx(o: { ownerInput?: boolean; owner?: OwnerRef } = {}): string {
  const fee = 200_000n;
  return buildTxCbor({
    ...feeLegs([ref(FEE_UTXO), ...(o.ownerInput ? [ref(OWNER_UTXO)] : [])]),
    feeLovelace: fee,
    mint: { [THREAD_UNIT]: 1n },
    outputs: [
      { address: ENGAGE_ADDRESS, assets: { lovelace: 2_000_000n, [THREAD_UNIT]: 1n }, inlineDatumHex: engageDatumHex(o.owner ?? KEY_OWNER) },
      { address: FEE_ADDRESS, assets: { lovelace: FEE_IN - fee - 2_000_000n } },
      ...ownerLeg(o.ownerInput === true),
    ],
    requiredSigners: [OWNER_PKH],
  });
}

/** bind-did qua ví trả phí: thread giữ nguyên value, ví chỉ mất phí. */
function bindTx(o: { ownerInput?: boolean; owner?: OwnerRef } = {}): string {
  const fee = 190_000n;
  const thread = o.owner === undefined ? UNBOUND : UNBOUND_SCRIPT;
  return buildTxCbor({
    ...feeLegs([ref(thread), ref(FEE_UTXO), ...(o.ownerInput ? [ref(OWNER_UTXO)] : [])]),
    feeLovelace: fee,
    outputs: [
      { address: ENGAGE_ADDRESS, assets: { ...thread.assets }, inlineDatumHex: engageDatumHex(o.owner ?? KEY_OWNER, { didCommit: DID }) },
      { address: FEE_ADDRESS, assets: { lovelace: FEE_IN - fee } },
      ...ownerLeg(o.ownerInput === true),
    ],
    requiredSigners: [OWNER_PKH],
    // Thread (7e…) đứng đầu danh sách input đã sắp, trước c0… và fa….
    spendRedeemers: [{ index: 0, dataHex: encodeBindDidRedeemer() }],
  });
}

const NEW_VAULT_LOVELACE = 2_400_000n;
/** create-vault két instant 0 LAMP qua ví trả phí: ví ứng trọn lovelace output két mới. */
function createTx(o: { ownerInput?: boolean; owner?: OwnerRef } = {}): string {
  const fee = 190_000n;
  return buildTxCbor({
    ...feeLegs([ref(FEE_UTXO), ...(o.ownerInput ? [ref(OWNER_UTXO)] : [])]),
    feeLovelace: fee,
    mint: { [VAULT_ID_UNIT]: 1n },
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: NEW_VAULT_LOVELACE, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({
          owner: o.owner ?? KEY_OWNER, lampBalanceOildrop: 0n, lampLockedOildrop: 0n, instantUnlockMs: 0n, wakemeLink: DID,
        }),
      },
      { address: FEE_ADDRESS, assets: { lovelace: FEE_IN - fee - NEW_VAULT_LOVELACE } },
      ...ownerLeg(o.ownerInput === true),
    ],
    requiredSigners: [OWNER_PKH],
  });
}

/** Nhân chứng chủ script giả, mang số dư thưởng `reward` của tài khoản did_stake. */
class RewardWitness implements OwnerWitnessProvider {
  constructor(private readonly reward: bigint) {}
  async resolve(owner: OwnerRef, w: ScriptOwnerWitness) {
    return {
      auth: { kind: "script" as const, hash: owner.hash, attachWithdraw: (tx: TxBuilder) => tx },
      requiredSigners: [w.controllerPkh, w.deviceKeyHash],
      notes: ["giả: rút did_stake"],
      ownerReward: { rewardAddress: "stake_test17gia", withdrawLovelace: this.reward },
    };
  }
}
const WITNESS_BODY = {
  did_stake_script_cbor: "4e4d01000033222220051200120011",
  anchor_ref: `${"ab".repeat(32)}#0`,
  controller_pkh: "c1".repeat(28),
  device_key_hash: "d1".repeat(28),
};

function harness(o: {
  vaultType?: "Schedule" | "Instant"; extra?: Record<string, unknown>; cbor: Record<string, string>;
  threads?: UTxO[]; vaults?: UTxO[]; witness?: OwnerWitnessProvider;
}) {
  const deployment = parseDeployment(deploymentJson(o.vaultType ?? "Schedule", o.extra), "Preview");
  const chain = new RecordedChainReader(
    {
      ...genV2Chain("Preview", { epoch: 20_707n }),
      [VAULT_ADDRESS]: o.vaults ?? [VAULT_UTXO], [ENGAGE_ADDRESS]: o.threads ?? [],
      // Ví khoá của chủ: 0 UTxO — người dùng mới không có ADA.
      [OWNER_WALLET]: [],
    },
    TIP,
    [VAULT_UTXO, FEE_UTXO, OWNER_UTXO, UNBOUND, UNBOUND_SCRIPT, SHARD_3],
  );
  const builder = new RecordedTxBuilder(o.cbor, VAULT_ID_UNIT, THREAD_UNIT);
  const issued = new IssuedTxRegistry(TTL * 4);
  const locks = new OwnerLockTable(TTL);
  const service = new VaultTxService({
    network: "Preview", deployment, chain, builder, locks, issued, lockTtlMs: TTL, now: () => NOW,
    ...(o.witness === undefined ? {} : { ownerWitness: o.witness }),
  });
  const router: RouterDeps = {
    service, deploymentSource: deployment.source, vaultScopes: deployment.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { builder, router, issued, locks };
}

const post = (url: string, body: unknown) => ({ method: "POST", url, headers: {}, body });
const codeOf = (r: { body: unknown }) => (r.body as { error?: { code: string } }).error?.code;
const detailsOf = (r: { body: unknown }) => (r.body as { error: { details: Record<string, unknown> } }).error.details;
type FeePayerView = { fronted_lovelace: string; fronted_max_lovelace: string; fronted_output_index: number | null };
const feePayerOf = (r: { body: unknown }) => (r.body as { summary: { fee_payer: FeePayerView } }).summary.fee_payer;
const txHashOf = (r: { body: unknown }) => (r.body as { tx_hash: string }).tx_hash;

const commit = () => post("/tx/schedule-commit", {
  owner_pkh: OWNER_PKH, schedule_length: "3", lamp_per_epoch: "7000000", fee_payer: FEE_PAYER,
});

// ── khoản ứng min-ADA trên két đang sống ─────────────────────────────────────

describe("khoản ứng min-ADA — két đang sống (lượt làm datum dài ra)", () => {
  it(`ví trả phí nâng két ${RAISE} lovelace ⟹ 200, fronted_lovelace đọc TỪ CBOR`, async () => {
    const h = harness({ cbor: { schedule_commit: commitTx({ raise: RAISE }) } });
    const r = await handle(commit(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(feePayerOf(r)).toMatchObject({
      fronted_lovelace: RAISE.toString(), fronted_max_lovelace: "5000000", fronted_output_index: 0,
    });
  });

  it(`CỰC ĐỐI: cùng ${RAISE} lovelace đi tới một địa chỉ lạ (két không đổi) ⟹ 422 FEE_PAYER_TX_MISMATCH`, async () => {
    const h = harness({ cbor: { schedule_commit: commitTx({ stray: RAISE }) } });
    const r = await handle(commit(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codeOf(r)).toBe("FEE_PAYER_TX_MISMATCH");
  });

  it(`trần 600000 ⟹ 422 FEE_PAYER_FRONTING_ABOVE_MAX; CẶP: trần ${RAISE} ⟹ 200`, async () => {
    const low = harness({ extra: { fee_payer_fronting_max_lovelace: "600000" }, cbor: { schedule_commit: commitTx({ raise: RAISE }) } });
    const a = await handle(commit(), low.router);
    expect(a.status, JSON.stringify(a.body)).toBe(422);
    expect(codeOf(a)).toBe("FEE_PAYER_FRONTING_ABOVE_MAX");
    expect(detailsOf(a)).toMatchObject({ fronted_lovelace: RAISE.toString(), fronted_max_lovelace: "600000", output_index: 0 });
    const exact = harness({ extra: { fee_payer_fronting_max_lovelace: RAISE.toString() }, cbor: { schedule_commit: commitTx({ raise: RAISE }) } });
    const b = await handle(commit(), exact.router);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(feePayerOf(b).fronted_max_lovelace).toBe(RAISE.toString());
  });
});

describe("khoản ứng min-ADA — shard GreenBack dùng chung (nhánh sinh dựng lại shard với datum dài hơn)", () => {
  it(`két nâng ${RAISE} + shard nâng ${SHARD_RAISE} ⟹ 200; ví ứng cả hai, phần shard tách riêng trong summary`, async () => {
    const h = harness({ cbor: { schedule_commit: shardTx({ raise: RAISE, shardRaise: SHARD_RAISE }) } });
    const r = await handle(commit(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(feePayerOf(r)).toMatchObject({
      fronted_lovelace: (RAISE + SHARD_RAISE).toString(), fronted_output_index: 0,
      shared_fronted_lovelace: SHARD_RAISE.toString(), shared_fronted_outputs: [{ output_index: 1, lovelace: SHARD_RAISE.toString() }],
    });
  });

  it(`CỰC ĐỐI: cùng ${SHARD_RAISE} vào địa chỉ shard nhưng shard KHÔNG bị tiêu ⟹ 422 FEE_PAYER_TX_MISMATCH`, async () => {
    const h = harness({ cbor: { schedule_commit: shardTx({ shardRaise: SHARD_RAISE, shardSpent: false }) } });
    const r = await handle(commit(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codeOf(r)).toBe("FEE_PAYER_TX_MISMATCH");
  });

  it(`trần 60000 ⟹ 422 FEE_PAYER_FRONTING_ABOVE_MAX ở output shard; CẶP: trần ${SHARD_RAISE} ⟹ 200`, async () => {
    const low = harness({ extra: { fee_payer_fronting_max_lovelace: "60000" }, cbor: { schedule_commit: shardTx({ shardRaise: SHARD_RAISE }) } });
    const a = await handle(commit(), low.router);
    expect(a.status, JSON.stringify(a.body)).toBe(422);
    expect(codeOf(a)).toBe("FEE_PAYER_FRONTING_ABOVE_MAX");
    expect(detailsOf(a)).toMatchObject({ fronted_lovelace: SHARD_RAISE.toString(), output_index: 1 });
    const exact = harness({ extra: { fee_payer_fronting_max_lovelace: SHARD_RAISE.toString() }, cbor: { schedule_commit: shardTx({ shardRaise: SHARD_RAISE }) } });
    const b = await handle(commit(), exact.router);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
  });
});

describe("cấu hình fee_payer_fronting_max_lovelace", () => {
  it("vắng ⟹ mặc định 5 tADA; chuỗi chữ số ⟹ đúng số đó; \"0\" ⟹ 0 (tắt ứng)", () => {
    expect(parseDeployment(deploymentJson("Schedule"), "Preview").feePayerFrontingMaxLovelace)
      .toBe(FEE_PAYER_DEFAULT_FRONTING_MAX_LOVELACE);
    expect(FEE_PAYER_DEFAULT_FRONTING_MAX_LOVELACE).toBe(5_000_000n);
    expect(parseDeployment(deploymentJson("Schedule", { fee_payer_fronting_max_lovelace: "672360" }), "Preview")
      .feePayerFrontingMaxLovelace).toBe(672_360n);
    expect(parseDeployment(deploymentJson("Schedule", { fee_payer_fronting_max_lovelace: "0" }), "Preview")
      .feePayerFrontingMaxLovelace).toBe(0n);
  });
  it("CỰC ĐỐI: số JSON, số âm, chữ ⟹ NÉM lúc nạp cấu hình", () => {
    for (const v of [672360, "-1", "5 ADA", "05"]) {
      expect(() => parseDeployment(deploymentJson("Schedule", { fee_payer_fronting_max_lovelace: v }), "Preview"))
        .toThrow(/fee_payer_fronting_max_lovelace/);
    }
  });
});

// ── mục rút did_stake ────────────────────────────────────────────────────────

describe("mục rút did_stake qua ví trả phí", () => {
  it("số dư thưởng > 0 ⟹ 422 FEE_PAYER_OWNER_REWARD_NONZERO; CẶP: 0 hoặc chủ khoá ⟹ không ném", () => {
    let caught: unknown;
    try { assertNoOwnerRewardToFeePayer({ rewardAddress: "stake_test17gia", withdrawLovelace: 1n }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CodedApiError);
    expect((caught as CodedApiError).code).toBe("FEE_PAYER_OWNER_REWARD_NONZERO");
    expect(() => assertNoOwnerRewardToFeePayer({ rewardAddress: "stake_test17gia", withdrawLovelace: 0n })).not.toThrow();
    expect(() => assertNoOwnerRewardToFeePayer(undefined)).not.toThrow();
  });

  const openScript = () => post("/tx/open-thread", { owner: SCRIPT_OWNER, owner_witness: WITNESS_BODY, fee_payer: FEE_PAYER });
  it("open-thread chủ script, rút 1 lovelace ⟹ 422 trước khi dựng; CẶP: rút 0 ⟹ 200", async () => {
    const one = harness({ cbor: { open_thread: openTx({ owner: SCRIPT_OWNER }) }, witness: new RewardWitness(1n) });
    const a = await handle(openScript(), one.router);
    expect(a.status, JSON.stringify(a.body)).toBe(422);
    expect(codeOf(a)).toBe("FEE_PAYER_OWNER_REWARD_NONZERO");
    expect(one.builder.lastCall).toBeNull();
    expect(one.locks.size()).toBe(0);
    const zero = harness({ cbor: { open_thread: openTx({ owner: SCRIPT_OWNER }) }, witness: new RewardWitness(0n) });
    const b = await handle(openScript(), zero.router);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
  });

  const bindScript = () => post("/tx/bind-did", {
    owner: SCRIPT_OWNER, owner_witness: WITNESS_BODY, did_commit: DID, fee_payer: FEE_PAYER,
  });
  it("bind-did chủ script, rút 1 lovelace ⟹ 422 trước khi dựng; CẶP: rút 0 ⟹ 200", async () => {
    const one = harness({ cbor: { bind_did: bindTx({ owner: SCRIPT_OWNER }) }, threads: [UNBOUND_SCRIPT], witness: new RewardWitness(1n) });
    const a = await handle(bindScript(), one.router);
    expect(a.status, JSON.stringify(a.body)).toBe(422);
    expect(codeOf(a)).toBe("FEE_PAYER_OWNER_REWARD_NONZERO");
    expect(one.builder.lastCall).toBeNull();
    expect(one.locks.size()).toBe(0);
    const zero = harness({ cbor: { bind_did: bindTx({ owner: SCRIPT_OWNER }) }, threads: [UNBOUND_SCRIPT], witness: new RewardWitness(0n) });
    const b = await handle(bindScript(), zero.router);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
  });

  const createScript = () => post("/tx/create-vault", {
    kind: "instant", owner: SCRIPT_OWNER, owner_witness: WITNESS_BODY, lamp_amount: "0", did_commit: DID, fee_payer: FEE_PAYER,
  });
  it("create-vault chủ script, rút 1 lovelace ⟹ 422 trước khi dựng; CẶP: rút 0 ⟹ 200", async () => {
    const one = harness({ vaultType: "Instant", vaults: [], cbor: { create_vault: createTx({ owner: SCRIPT_OWNER }) }, witness: new RewardWitness(1n) });
    const a = await handle(createScript(), one.router);
    expect(a.status, JSON.stringify(a.body)).toBe(422);
    expect(codeOf(a)).toBe("FEE_PAYER_OWNER_REWARD_NONZERO");
    expect(one.builder.lastCall).toBeNull();
    expect(one.locks.size()).toBe(0);
    const zero = harness({ vaultType: "Instant", vaults: [], cbor: { create_vault: createTx({ owner: SCRIPT_OWNER }) }, witness: new RewardWitness(0n) });
    const b = await handle(createScript(), zero.router);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
  });
});

// ── open-thread ──────────────────────────────────────────────────────────────

const open = () => post("/tx/open-thread", { owner_pkh: OWNER_PKH, fee_payer: FEE_PAYER });

describe("/tx/open-thread qua ví trả phí — chủ có 0 UTxO", () => {
  it("dương: 200; seed + thế chấp + hạn dùng đều từ ví trả phí; ứng trọn 2 ADA của thread; vào sổ phát hành kèm UTxO trả phí", async () => {
    const h = harness({ cbor: { open_thread: openTx() } });
    const r = await handle(open(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(feePayerOf(r)).toMatchObject({ fronted_lovelace: "2000000", fronted_output_index: 0 });
    expect(h.builder.lastCall).toMatchObject({
      feePayerUtxo: FEE_UTXO, collateralLovelace: 3_000_000n, validToMs: BigInt(NOW) + 3_600_000n, changeAddress: FEE_ADDRESS,
    });
    expect(h.issued.lookup(txHashOf(r), NOW)?.feePayerUtxo).toBe(FEE_PAYER.utxo);
  });

  it("CỰC ĐỐI: thêm một input từ ví khoá của chủ ⟹ 422 FEE_PAYER_TX_MISMATCH", async () => {
    const h = harness({ cbor: { open_thread: openTx({ ownerInput: true }) } });
    const r = await handle(open(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codeOf(r)).toBe("FEE_PAYER_TX_MISMATCH");
    expect(h.locks.size()).toBe(0);
  });

  it("trần 1999999 ⟹ 422 FEE_PAYER_FRONTING_ABOVE_MAX; CẶP: trần 2000000 ⟹ 200", async () => {
    const low = harness({ extra: { fee_payer_fronting_max_lovelace: "1999999" }, cbor: { open_thread: openTx() } });
    expect(codeOf(await handle(open(), low.router))).toBe("FEE_PAYER_FRONTING_ABOVE_MAX");
    const exact = harness({ extra: { fee_payer_fronting_max_lovelace: "2000000" }, cbor: { open_thread: openTx() } });
    expect((await handle(open(), exact.router)).status).toBe(200);
  });
});

// ── bind-did ─────────────────────────────────────────────────────────────────

const bind = () => post("/tx/bind-did", { owner_pkh: OWNER_PKH, did_commit: DID, fee_payer: FEE_PAYER });

describe("/tx/bind-did qua ví trả phí — chủ có 0 UTxO", () => {
  it("dương: 200; ví chỉ mất phí (không ứng); hạn dùng ≤ 1 giờ từ ví trả phí", async () => {
    const h = harness({ cbor: { bind_did: bindTx() }, threads: [UNBOUND] });
    const r = await handle(bind(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(feePayerOf(r)).toMatchObject({ fronted_lovelace: "0", fronted_output_index: null });
    expect(h.builder.lastCall).toMatchObject({ feePayerUtxo: FEE_UTXO, validToMs: BigInt(NOW) + 3_600_000n });
    expect(h.issued.lookup(txHashOf(r), NOW)?.feePayerUtxo).toBe(FEE_PAYER.utxo);
  });

  it("CỰC ĐỐI: thêm một input từ ví khoá của chủ ⟹ 422 FEE_PAYER_TX_MISMATCH", async () => {
    const h = harness({ cbor: { bind_did: bindTx({ ownerInput: true }) }, threads: [UNBOUND] });
    const r = await handle(bind(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codeOf(r)).toBe("FEE_PAYER_TX_MISMATCH");
  });
});

// ── create-vault két instant 0 LAMP ──────────────────────────────────────────

const create = (over: Record<string, unknown> = {}) => post("/tx/create-vault", {
  kind: "instant", owner_pkh: OWNER_PKH, lamp_amount: "0", did_commit: DID, fee_payer: FEE_PAYER, ...over,
});

describe("/tx/create-vault két instant 0 LAMP qua ví trả phí — chủ có 0 UTxO", () => {
  it("dương: 200; seed + thế chấp + hạn dùng từ ví trả phí; ứng trọn lovelace output két mới", async () => {
    const h = harness({ vaultType: "Instant", vaults: [], cbor: { create_vault: createTx() } });
    const r = await handle(create(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(feePayerOf(r)).toMatchObject({ fronted_lovelace: NEW_VAULT_LOVELACE.toString(), fronted_output_index: 0 });
    expect(h.builder.lastCall).toMatchObject({
      feePayerUtxo: FEE_UTXO, collateralLovelace: 3_000_000n, validToMs: BigInt(NOW) + 3_600_000n, changeAddress: FEE_ADDRESS,
    });
    expect(h.builder.lastCall?.funding).toBeUndefined();
    expect(h.issued.lookup(txHashOf(r), NOW)?.feePayerUtxo).toBe(FEE_PAYER.utxo);
  });

  it("CỰC ĐỐI: thêm một input từ ví khoá của chủ ⟹ 422 FEE_PAYER_TX_MISMATCH", async () => {
    const h = harness({ vaultType: "Instant", vaults: [], cbor: { create_vault: createTx({ ownerInput: true }) } });
    const r = await handle(create(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(codeOf(r)).toBe("FEE_PAYER_TX_MISMATCH");
  });

  it("CỰC ĐỐI hình dạng: lamp_amount > 0 với fee_payer gốc ⟹ 400 FEE_PAYER_UNSUPPORTED, bộ dựng không bị gọi", async () => {
    const h = harness({ vaultType: "Instant", vaults: [], cbor: { create_vault: createTx() } });
    const r = await handle(create({ lamp_amount: "5" }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(codeOf(r)).toBe("FEE_PAYER_UNSUPPORTED");
    expect(h.builder.lastCall).toBeNull();
  });

  it("CỰC ĐỐI hình dạng: két schedule với fee_payer gốc ⟹ 400 FEE_PAYER_UNSUPPORTED", async () => {
    const h = harness({ vaultType: "Schedule", vaults: [], cbor: { create_vault: createTx() } });
    const r = await handle(create({ kind: "schedule", lamp_amount: "5", did_commit: undefined }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(codeOf(r)).toBe("FEE_PAYER_UNSUPPORTED");
  });
});
