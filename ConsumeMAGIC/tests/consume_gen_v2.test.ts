// tests/consume_gen_v2.test.ts — phía két của `buildConsumeTx` dưới Gen v2.0 (gói d4, #128).
//
// Két InstantGen v2.0 tiêu bằng BurnBatch lần đầu trong epoch mới ⟹ validator làm mới
// checkpoint (`checkpoint.ak ▸ expected_checkpoint`, `FollowVault`): đọc ρ từ beacon
// RateParam, và đọc két Wakeme nếu `wakeme_link` khác "". Bộ dựng phải đưa đúng các
// reference input đó vào tx, và NÉM rõ lý do khi thiếu — trước khi gửi, không phải ở
// phase-2. Mỗi cặp ca dưới đây khác nhau ĐÚNG MỘT ô.
//
// Đi qua bộ dựng THẬT với `LucidEvolution` giả (TestSupport/lucidFake.ts), không cần mạng.

import { describe, it, expect } from "vitest";
import {
  credentialToAddress, validatorToAddress, validatorToScriptHash,
  type LucidEvolution, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { msPerEpoch } from "@magiclamp/protocol-utils";
import { makeLucidFake } from "../../TestSupport/lucidFake.js";
import { buildConsumeTx, type ConsumeParams } from "../offchain/src/consume.js";
import { encodeEngageDatum, encodePriceParam } from "../offchain/src/types.js";
import {
  igDatum, sgDatum, nFieldDatum, burnRedeemer, wakemeDatum, rateDatum, zeroWindow,
  type Cell, type IgCheckpoint, type OwnerCred,
} from "./genV2Fixtures.js";

const consumeScript: Validator = { type: "PlutusV3", script: "49480100002221200101" };
const vaultScript:   Validator = { type: "PlutusV3", script: "4d4d01000033222220051200120011" };
const CONSUME_POLICY = validatorToScriptHash(consumeScript);
const THREAD_NFT = CONSUME_POLICY + "ee".repeat(32);
const VAULT_H = validatorToScriptHash(vaultScript);
const VAULT_NAME = "aa".repeat(32);
const VAULT_ADDR = validatorToAddress("Preview", vaultScript);

const OWNER: OwnerCred = { VerificationKey: ["0b".repeat(28)] };
const REQUIRED = 10_000_000n;                     // 10_000_000 × 1e9 × 1 / 1e9
const TIP = 1_700_000_000_000n;
const E = TIP / msPerEpoch("Preview");            // epoch két thấy (cận dưới = tip)

const RATE_POLICY = "7a".repeat(28);
const RATE_SH = "7b".repeat(28);
const WAKEME_H = "cc".repeat(28);
const OWNER_COMMIT = "d1".repeat(32);

const priceDatum = encodePriceParam({
  op_prices: [{ op_type: 1n, base_price: 10_000_000n, demand_mult: 1_000_000_000n }],
  m_min: 500_000_000n,
  m_max: 2_000_000_000n,
  epoch: 0n,
});

const engageDatum = encodeEngageDatum({
  owner: OWNER as never,
  consumed_count: 0n,
  last_epoch: 0n,
  did_commit: "",
  consumed_nanogic: 0n,
});

const mkUtxo = (over: Partial<UTxO>): UTxO => ({
  txHash: "00".repeat(32),
  outputIndex: 0,
  address: "addr_test1wq0000000000000000000000000000000000000000000000000000",
  assets: { lovelace: 2_000_000n },
  ...over,
});

const rateBeacon = (over: Partial<UTxO> = {}): UTxO => mkUtxo({
  txHash: "7c".repeat(32),
  address: credentialToAddress("Preview", { type: "Script", hash: RATE_SH }),
  assets: { lovelace: 2_000_000n, [RATE_POLICY + "52484f"]: 1n },
  datum: rateDatum(1_000_000_000n, 1_000_000_000n, 0n),
  ...over,
});

const wakemeVault = (pinnedName = VAULT_NAME): UTxO => mkUtxo({
  txHash: "cd".repeat(32),
  address: credentialToAddress("Preview", { type: "Script", hash: WAKEME_H }),
  assets: { lovelace: 2_000_000n, [WAKEME_H + OWNER_COMMIT]: 1n },
  datum: wakemeDatum({
    ownerCommit: OWNER_COMMIT, pinnedVaultHash: VAULT_H, pinnedVaultName: pinnedName,
    conditional: 700_000_000n, owned: 301_000_000n,
  }),
});

/** Cửa sổ vào có số khác 0 ở hai ô đầu, để phép dịch có dấu vết đo được. */
const IN_WIN: Cell[] = [[5n, 7n], [1n, 2n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [3n, 4n]];
/** IN_WIN dịch 1 ô rồi cộng REQUIRED vào `consumed` ô 0 (ô (3,4) cuối rơi khỏi cửa sổ). */
const SHIFTED_1_PLUS: Cell[] = [[0n, REQUIRED], [5n, 7n], [1n, 2n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]];
/** IN_WIN không dịch, cộng REQUIRED vào ô 0. */
const SAME_PLUS: Cell[] = [[5n, 7n + REQUIRED], [1n, 2n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [3n, 4n]];

/** Két IG CŨ một epoch (cap_epoch = E−1) ⟹ lượt này làm mới. */
const IG_IN_STALE = (link = ""): IgCheckpoint =>
  ({ link, capEpoch: E - 1n, capNanogic: 123n, window: IN_WIN, windowEpoch: E - 1n });
/** Datum ra đúng luật làm mới: cap_epoch = E, cửa sổ dịch + cộng, link theo két Wakeme. */
const IG_OUT_REFRESHED = (link = "", over: Partial<IgCheckpoint> = {}): IgCheckpoint =>
  ({ link, capEpoch: E, capNanogic: 999n, window: SHIFTED_1_PLUS, windowEpoch: E, ...over });

function params(vaultIn: string, vaultOut: string, over: Partial<ConsumeParams> = {}): ConsumeParams {
  return {
    lucid: {} as LucidEvolution,
    engageUtxo: mkUtxo({ datum: engageDatum, assets: { lovelace: 2_000_000n, [THREAD_NFT]: 1n } }),
    vaultUtxo: mkUtxo({
      txHash: "ab".repeat(32), outputIndex: 1, address: VAULT_ADDR, datum: vaultIn,
      assets: { lovelace: 3_000_000n, [VAULT_H + VAULT_NAME]: 1n },
    }),
    priceBeaconUtxo: mkUtxo({ outputIndex: 2, datum: priceDatum }),
    consumeScript,
    vaultScript,
    opType: 1,
    opCount: 1n,
    vaultBurnRedeemerCbor: burnRedeemer([REQUIRED]),
    vaultOutDatumCbor: vaultOut,
    network: "Preview",
    tipPosixMs: TIP,
    ...over,
  } as ConsumeParams;
}

/** Dựng với bộ giả, trả giao dịch đã ghi. */
async function build(p: ConsumeParams) {
  const fake = makeLucidFake();
  const r = await buildConsumeTx({ ...p, lucid: fake.lucid as LucidEvolution });
  return { r, tx: fake.onlyTx() };
}

/** Dựng với bộ giả khi mong NÉM; khẳng định không giao dịch nào tới `complete`. */
async function buildRejects(p: ConsumeParams, re: RegExp) {
  const fake = makeLucidFake();
  await expect(buildConsumeTx({ ...p, lucid: fake.lucid as LucidEvolution })).rejects.toThrow(re);
  expect(fake.txs.every((t) => !t.completed)).toBe(true);
}

const refKeys = (tx: { readFrom: unknown[][] }) =>
  tx.readFrom.flat().map((u) => `${(u as UTxO).txHash}#${(u as UTxO).outputIndex}`);
const inputKeys = (tx: { collectFrom: Array<{ utxos: unknown[] }> }) =>
  tx.collectFrom.flatMap((c) => c.utxos).map((u) => `${(u as UTxO).txHash}#${(u as UTxO).outputIndex}`);
const keyOf = (u: UTxO) => `${u.txHash}#${u.outputIndex}`;

// ── InstantGen: lượt tiêu đầu epoch ──────────────────────────────────────────

describe("InstantGen v2.0 — BurnBatch đầu epoch cần beacon ρ", () => {
  it("DƯƠNG — cap_epoch < e, có ref ρ ⟹ dựng được, ρ nằm trong readFrom", async () => {
    const rate = rateBeacon();
    const { r, tx } = await build(params(
      igDatum(OWNER, IG_IN_STALE()), igDatum(OWNER, IG_OUT_REFRESHED()), { rateBeaconUtxo: rate },
    ));
    expect(tx.completed).toBe(true);
    expect(refKeys(tx)).toContain(keyOf(rate));
    expect(inputKeys(tx)).not.toContain(keyOf(rate));
    expect(r.vaultCheckpoint).toEqual({ kind: "instant", refreshed: true });
  });

  it("CỰC ĐỐI — chỉ bỏ ref ρ ⟹ NÉM CONSUME-012 trước khi dựng", async () => {
    await buildRejects(
      params(igDatum(OWNER, IG_IN_STALE()), igDatum(OWNER, IG_OUT_REFRESHED())),
      /CONSUME-012.*ĐẦU TIÊN.*rateBeaconUtxo/s,
    );
  });

  it("CỰC ĐỐI — beacon không mang NFT \"RHO\" ⟹ CONSUME-012", async () => {
    const noNft = rateBeacon({ assets: { lovelace: 2_000_000n, [RATE_POLICY + "525830"]: 1n } });
    await buildRejects(
      params(igDatum(OWNER, IG_IN_STALE()), igDatum(OWNER, IG_OUT_REFRESHED()), { rateBeaconUtxo: noNft }),
      /CONSUME-012.*RHO/s,
    );
  });

  it("CỰC ĐỐI — ρ hiệu lực ngoài [0, rho_max_q] ⟹ CONSUME-012", async () => {
    const tooBig = rateBeacon({ datum: rateDatum(4_000_000_001n, 0n, 0n) });
    await buildRejects(
      params(igDatum(OWNER, IG_IN_STALE()), igDatum(OWNER, IG_OUT_REFRESHED()), { rateBeaconUtxo: tooBig }),
      /CONSUME-012.*ngoài/s,
    );
  });

  it("cùng epoch (cap_epoch == e) ⟹ không cần ρ; ρ/Wakeme truyền thừa KHÔNG vào tx", async () => {
    const inCp: IgCheckpoint = { link: OWNER_COMMIT, capEpoch: E, capNanogic: 123n, window: IN_WIN, windowEpoch: E };
    const outCp: IgCheckpoint = { ...inCp, window: SAME_PLUS };
    const rate = rateBeacon();
    const wake = wakemeVault();
    const { r, tx } = await build(params(igDatum(OWNER, inCp), igDatum(OWNER, outCp), {
      rateBeaconUtxo: rate, wakemeVaultUtxo: wake,
    }));
    expect(tx.completed).toBe(true);
    expect(refKeys(tx)).not.toContain(keyOf(rate));
    expect(refKeys(tx)).not.toContain(keyOf(wake));
    expect(r.vaultCheckpoint).toEqual({ kind: "instant", refreshed: false });
  });

  it("CỰC ĐỐI cùng epoch — datum ra đổi cap_nanogic ⟹ CONSUME-016 (năm ô phải ghim)", async () => {
    const inCp: IgCheckpoint = { link: "", capEpoch: E, capNanogic: 123n, window: IN_WIN, windowEpoch: E };
    await buildRejects(
      params(igDatum(OWNER, inCp), igDatum(OWNER, { ...inCp, window: SAME_PLUS, capNanogic: 124n })),
      /CONSUME-016.*cap_nanogic/s,
    );
  });
});

// ── InstantGen: két đã nối Wakeme ─────────────────────────────────────────────

describe("InstantGen v2.0 — két đã nối Wakeme, lượt làm mới", () => {
  it("DƯƠNG — link đặt, có ρ + két Wakeme ⟹ dựng được; két Wakeme CHỈ ở readFrom", async () => {
    const rate = rateBeacon();
    const wake = wakemeVault();
    const { tx } = await build(params(
      igDatum(OWNER, IG_IN_STALE(OWNER_COMMIT)), igDatum(OWNER, IG_OUT_REFRESHED(OWNER_COMMIT)),
      { rateBeaconUtxo: rate, wakemeVaultUtxo: wake },
    ));
    expect(tx.completed).toBe(true);
    expect(refKeys(tx)).toEqual(expect.arrayContaining([keyOf(rate), keyOf(wake)]));
    expect(inputKeys(tx)).not.toContain(keyOf(wake));
  });

  it("CỰC ĐỐI — chỉ bỏ két Wakeme ⟹ NÉM CONSUME-013 (luật 2)", async () => {
    await buildRejects(
      params(
        igDatum(OWNER, IG_IN_STALE(OWNER_COMMIT)), igDatum(OWNER, IG_OUT_REFRESHED(OWNER_COMMIT)),
        { rateBeaconUtxo: rateBeacon() },
      ),
      /CONSUME-013.*wakemeVaultUtxo/s,
    );
  });

  it("CỰC ĐỐI — két Wakeme ghim két IG KHÁC ⟹ CONSUME-013", async () => {
    await buildRejects(
      params(
        igDatum(OWNER, IG_IN_STALE(OWNER_COMMIT)), igDatum(OWNER, IG_OUT_REFRESHED(OWNER_COMMIT)),
        { rateBeaconUtxo: rateBeacon(), wakemeVaultUtxo: wakemeVault("bb".repeat(32)) },
      ),
      /CONSUME-013.*KHÔNG ghim/s,
    );
  });

  it("link rỗng + két Wakeme ghim két này ⟹ lượt này NỐI: link ra phải = owner_commit", async () => {
    const { tx } = await build(params(
      igDatum(OWNER, IG_IN_STALE("")), igDatum(OWNER, IG_OUT_REFRESHED(OWNER_COMMIT)),
      { rateBeaconUtxo: rateBeacon(), wakemeVaultUtxo: wakemeVault() },
    ));
    expect(tx.completed).toBe(true);
  });

  it("CỰC ĐỐI — cùng đầu vào, link ra để rỗng ⟹ CONSUME-016 wakeme_link", async () => {
    await buildRejects(
      params(
        igDatum(OWNER, IG_IN_STALE("")), igDatum(OWNER, IG_OUT_REFRESHED("")),
        { rateBeaconUtxo: rateBeacon(), wakemeVaultUtxo: wakemeVault() },
      ),
      /CONSUME-016.*wakeme_link/s,
    );
  });
});

// ── InstantGen: datum ra lệch luật làm mới ────────────────────────────────────

describe("InstantGen v2.0 — datum ra phải đúng luật làm mới", () => {
  const ok = { rateBeaconUtxo: rateBeacon() };

  it("CỰC ĐỐI — cap_epoch ra không phải e ⟹ CONSUME-016", async () => {
    await buildRejects(
      params(igDatum(OWNER, IG_IN_STALE()), igDatum(OWNER, IG_OUT_REFRESHED("", { capEpoch: E - 1n })), ok),
      /CONSUME-016.*cap_epoch/s,
    );
  });

  it("CỰC ĐỐI — cửa sổ ra quên dịch (chỉ cộng) ⟹ CONSUME-016 usage_window", async () => {
    await buildRejects(
      params(igDatum(OWNER, IG_IN_STALE()), igDatum(OWNER, IG_OUT_REFRESHED("", { window: SAME_PLUS })), ok),
      /CONSUME-016.*usage_window \(#18\)/s,
    );
  });

  it("CỰC ĐỐI — cửa sổ ra dịch nhưng quên cộng Σburns ⟹ CONSUME-016 usage_window", async () => {
    const noAdd: Cell[] = [[0n, 0n], ...SHIFTED_1_PLUS.slice(1)];
    await buildRejects(
      params(igDatum(OWNER, IG_IN_STALE()), igDatum(OWNER, IG_OUT_REFRESHED("", { window: noAdd })), ok),
      /CONSUME-016.*usage_window \(#18\)/s,
    );
  });

  it("CỰC ĐỐI — Σburns ≠ required ⟹ CONSUME-015", async () => {
    await buildRejects(
      params(igDatum(OWNER, IG_IN_STALE()), igDatum(OWNER, IG_OUT_REFRESHED()), {
        ...ok, vaultBurnRedeemerCbor: burnRedeemer([REQUIRED - 1n]),
      }),
      /CONSUME-015.*DẤU BẰNG/s,
    );
  });
});

// ── ScheduleGen ───────────────────────────────────────────────────────────────

describe("ScheduleGen v2.0 — BurnBatch dịch cửa sổ, không đọc beacon", () => {
  it("DƯƠNG — cửa sổ cũ 2 epoch ⟹ dịch 2 + cộng; không ref nào thêm", async () => {
    const out: Cell[] = [[0n, REQUIRED], [0n, 0n], [5n, 7n], [1n, 2n], [0n, 0n], [0n, 0n], [0n, 0n]];
    const { r, tx } = await build(params(sgDatum(OWNER, IN_WIN, E - 2n), sgDatum(OWNER, out, E)));
    expect(tx.completed).toBe(true);
    expect(tx.readFrom.flat()).toHaveLength(1);                 // chỉ beacon giá
    expect(r.vaultCheckpoint).toEqual({ kind: "schedule", refreshed: false });
  });

  it("CỰC ĐỐI — dịch 1 thay vì 2 ⟹ CONSUME-016 usage_window (#17)", async () => {
    const out: Cell[] = [[0n, REQUIRED], [5n, 7n], [1n, 2n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]];
    await buildRejects(
      params(sgDatum(OWNER, IN_WIN, E - 2n), sgDatum(OWNER, out, E)),
      /CONSUME-016.*usage_window \(#17\)/s,
    );
  });

  it("CỰC ĐỐI — usage_window_epoch ra không phải e ⟹ CONSUME-016", async () => {
    const out: Cell[] = [[0n, REQUIRED], [0n, 0n], [5n, 7n], [1n, 2n], [0n, 0n], [0n, 0n], [0n, 0n]];
    await buildRejects(
      params(sgDatum(OWNER, IN_WIN, E - 2n), sgDatum(OWNER, out, E - 1n)),
      /CONSUME-016.*usage_window_epoch \(#18\)/s,
    );
  });
});

// ── Nhận diện loại két ────────────────────────────────────────────────────────

describe("nhận diện datum két", () => {
  it("datum InstantGen v1 (18 trường) ⟹ CONSUME-014, nói rõ là đời v1", async () => {
    await buildRejects(params(nFieldDatum(OWNER, 18), nFieldDatum(OWNER, 18)), /CONSUME-014.*InstantGen v1/s);
  });

  it("datum ScheduleGen v1 (17 trường) ⟹ CONSUME-014", async () => {
    await buildRejects(params(nFieldDatum(OWNER, 17), nFieldDatum(OWNER, 17)), /CONSUME-014.*ScheduleGen v1/s);
  });

  it("vaultKind khai lệch số trường ⟹ CONSUME-014", async () => {
    await buildRejects(
      params(sgDatum(OWNER, zeroWindow(), E), sgDatum(OWNER, zeroWindow(), E), { vaultKind: "instant" }),
      /CONSUME-014.*vaultKind="instant"/s,
    );
  });

  it("PrepaidGen (8 trường) ⟹ không kiểm checkpoint, vẫn kiểm Σburns", async () => {
    const { r } = await build(params(nFieldDatum(OWNER, 8), nFieldDatum(OWNER, 8)));
    expect(r.vaultCheckpoint).toEqual({ kind: "prepaid", refreshed: false });
    await buildRejects(
      params(nFieldDatum(OWNER, 8), nFieldDatum(OWNER, 8), { vaultBurnRedeemerCbor: burnRedeemer([1n]) }),
      /CONSUME-015/,
    );
  });
});
