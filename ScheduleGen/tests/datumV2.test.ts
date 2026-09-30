// tests/datumV2.test.ts — hợp đồng NHỊ PHÂN Gen v2.0 của két ScheduleGen, phía TypeScript.
//
// Bốn nhóm:
//   1. Vector CBOR: bytes do Aiken sinh (`onchain/lib/magiclamp/protocol/datum_cbor_vectors.ak`,
//      ĐỌC từ tệp, không chép lại) == `Data.to(…)` của lược đồ Lucid, và giải mã ngược ra đúng
//      giá trị. Datum "một hợp đồng" dựng bằng `planScheduleCommit` — nên vector ghim luôn
//      đường tính thuần, không chỉ lược đồ.
//   2. Datum đời trước (17 trường / shard 7 trường) ⟹ NÉM `GEN-SCH-V1-DATUM`, cặp với ca v2 đi qua.
//   3. Thứ tự trường của từng lược đồ == thứ tự trường trong `.ak` (ScheduleGen + GenBeacons).
//   4. Apply-param 9 phần tử == chữ ký `validator vault(`; hằng gói (c) == `constants.ak`.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Data, Constr } from "@lucid-evolution/lucid";
import {
  VaultDatum, VaultDatumSchema, GenScheduleSchema, EpochUsageSchema,
  ScheduleShardDatum, ScheduleShardDatumSchema, RateParamSchema, GreenBackBeaconSchema,
  GbShardSchema, GbShardRedeemer, GbShardRedeemerSchema,
  decodeVaultDatum, decodeScheduleShardDatum, ERR_DATUM_V1,
  type VaultDatum as TVaultDatum,
} from "../offchain/src/types.js";
import { planScheduleCommit } from "../offchain/src/genPlan.js";
import {
  SCHEDULE_VAULT_PARAM_NAMES, scheduleVaultParamMap, scheduleVaultParamList,
} from "../offchain/src/params.js";
import * as C from "../offchain/src/constants.js";
import { makeRate, ZW } from "./genV2Fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const REPO = resolve(ROOT, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const readRepo = (p: string) => readFileSync(resolve(REPO, p), "utf8");

const VECTORS_AK = read("onchain/lib/magiclamp/protocol/datum_cbor_vectors.ak");
function akHex(name: string): string {
  const m = VECTORS_AK.match(new RegExp(`const ${name}: ByteArray =\\s*#"([0-9a-f]+)"`));
  expect(m, `không thấy hằng ${name} trong datum_cbor_vectors.ak`).not.toBeNull();
  return m![1]!;
}

// ── Giá trị khớp `datum_cbor_vectors.ak` ▸ `tv_genesis` / `tv_one_schedule` ──
function genesis(): TVaultDatum {
  return {
    owner: { VerificationKey: ["0a".repeat(28)] } as TVaultDatum["owner"],
    lamp_balance: 100_000_000_000n, lamp_locked: 0n,
    loyalty_holdings: [{ amount: 100_000_000_000n, acquired_epoch: 0n, is_locked: false }],
    magic_batches: [], next_batch_index: 0n, vacuum_orders: [], gen_schedules: [],
    profile: "Flame", profile_changed_epoch: 0n, pending_profile: null, last_updated_epoch: 0n,
    delegation_cert: { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state: { recent_burn_epochs: [], consumed_credit: 0n },
    streak_state: { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate: null,
    attribution: { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
    usage_window: ZW(), usage_window_epoch: 0n,
  };
}

function oneSchedulePlan() {
  return planScheduleCommit({
    vaultDatum: genesis(), vaultRef: { txHash: "33".repeat(32), outputIndex: 0 },
    scheduleLength: 10n, lampPerEpoch: 1_000_000_000n, currentEpoch: 100n,
    rateParam: makeRate(),
    gbBeacon: { gb_nanogic: 16n * 1_000_000_000_000_000n, seq: 1n, epoch: 100n, depeg: false },
    gbShardIn: { shard_id: 10n, seq: 0n, reset_amount: 0n, remaining: 0n },
    shardIn: {
      shard_id: 10n, shard_locked_lamp: 0n, shard_active_count: 0n, shard_cumulative_committed: 0n,
      shard_cumulative_fired: 0n, last_updated_epoch: 0n, shard_cap: 450_000_000_000_000n,
      shard_obligation_nanogic: 0n,
    },
  });
}

describe("Vector CBOR Gen v2.0 — bytes Aiken == bytes Lucid", () => {
  it("két genesis (19 trường)", () => {
    const hex = akHex("tv_cbor_vault_genesis_hex");
    expect(Data.to(genesis(), VaultDatum)).toBe(hex);
    expect(decodeVaultDatum(hex)).toEqual(genesis());
  });

  it("két sau MỘT lượt ký — datum ra của planScheduleCommit", () => {
    const hex = akHex("tv_cbor_vault_one_schedule_hex");
    const p = oneSchedulePlan();
    expect(p.mPerEpoch).toBe(3_000_000_000n);
    expect(p.newSchedule.usage_factor_locked_q).toBe(750_000_000n);
    expect(Data.to(p.vaultDatumOut, VaultDatum)).toBe(hex);
    expect(decodeVaultDatum(hex)).toEqual(p.vaultDatumOut);
  });

  it("shard LAMP sau lượt ký (8 trường, nghĩa vụ = M × N)", () => {
    const hex = akHex("tv_cbor_shard_one_schedule_hex");
    const p = oneSchedulePlan();
    expect(p.shardOut.shard_obligation_nanogic).toBe(30_000_000_000n);
    expect(Data.to(p.shardOut, ScheduleShardDatum)).toBe(hex);
    expect(decodeScheduleShardDatum(hex)).toEqual(p.shardOut);
  });

  it("redeemer shard GB `Draw { amount = M × min(N, 2) }`", () => {
    const hex = akHex("tv_cbor_gb_draw_hex");
    expect(Data.to({ amount: oneSchedulePlan().gbDraw }, GbShardRedeemer)).toBe(hex);
  });
});

describe("Datum đời trước Gen v2.0 ⟹ NÉM, không đệm", () => {
  const v2hex = Data.to(genesis(), VaultDatum);
  const v2 = Data.from(v2hex) as Constr<unknown>;

  it("CỰC ĐỐI: datum 19 trường giải mã được", () => {
    expect(v2.fields).toHaveLength(19);
    expect(() => decodeVaultDatum(v2hex)).not.toThrow();
  });

  it("datum 17 trường (bỏ usage_window + usage_window_epoch) ⟹ GEN-SCH-V1-DATUM", () => {
    const v1hex = Data.to(new Constr(0, v2.fields.slice(0, 17)) as never);
    expect(() => decodeVaultDatum(v1hex)).toThrow(ERR_DATUM_V1);
    expect(() => decodeVaultDatum(v1hex)).toThrow(/17 trường/);
  });

  it("datum 18 trường ⟹ NÉM (không nhận số trường lạ)", () => {
    const hex = Data.to(new Constr(0, v2.fields.slice(0, 18)) as never);
    expect(() => decodeVaultDatum(hex)).toThrow(/cần đúng 19/);
  });

  it("shard 7 trường ⟹ GEN-SCH-V1-DATUM; 8 trường đi qua", () => {
    const hex8 = akHex("tv_cbor_shard_one_schedule_hex");
    const s = Data.from(hex8) as Constr<unknown>;
    expect(() => decodeScheduleShardDatum(hex8)).not.toThrow();
    const hex7 = Data.to(new Constr(0, s.fields.slice(0, 7)) as never);
    expect(() => decodeScheduleShardDatum(hex7)).toThrow(ERR_DATUM_V1);
  });
});

// ── Thứ tự trường: lược đồ Lucid == `pub type` trong `.ak` ──────────────────
function akFields(src: string, typeName: string): string[] {
  const start = src.indexOf(`pub type ${typeName} {`);
  expect(start, `không thấy pub type ${typeName}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}", start);
  return src.slice(src.indexOf("{", start) + 1, end)
    .split("\n")
    .map(l => l.replace(/\/\/.*$/, "").trim())
    .map(l => l.match(/^([a-z_0-9]+)\s*:/)?.[1])
    .filter((x): x is string => x !== undefined);
}
// Lucid 0.4.30: `Data.Object` = `{ anyOf: [{ dataType: "constructor", index: 0, fields: [{ title }] }] }`
// (đo 2026-09-30). Hình dạng khác ⟹ NÉM, đừng trả mảng rỗng (rỗng == rỗng là xanh vô nghĩa).
const keys = (schema: unknown): string[] => {
  const alts = (schema as { anyOf?: Array<{ index?: number; fields?: Array<{ title?: string }> }> }).anyOf;
  if (!alts || alts.length !== 1 || alts[0]!.index !== 0 || !alts[0]!.fields) {
    throw new Error(`lược đồ không phải Data.Object một constructor: ${JSON.stringify(schema).slice(0, 120)}`);
  }
  return alts[0]!.fields.map(f => {
    if (typeof f.title !== "string") throw new Error("trường không có title");
    return f.title;
  });
};

describe("Thứ tự trường lược đồ TS == `.ak` (hợp đồng nhị phân)", () => {
  const sg = read("onchain/lib/magiclamp/protocol/types.ak");
  const gb = readRepo("GenBeacons/onchain/lib/genbeacons/types.ak");

  const cases: Array<[string, unknown, string[]]> = [
    ["VaultDatum", VaultDatumSchema, [sg]],
    ["GenSchedule", GenScheduleSchema, [sg]],
    ["EpochUsage", EpochUsageSchema, [sg]],
    ["ScheduleAggregateShardDatum", ScheduleShardDatumSchema, [sg]],
    ["RateParam", RateParamSchema, [sg, gb]],
    ["GreenBackBeacon", GreenBackBeaconSchema, [sg, gb]],
    ["GbShard", GbShardSchema, [sg, gb]],
  ].map(([n, s, srcs]) => [n as string, s, srcs as string[]]);

  for (const [name, schema, srcs] of cases) {
    it(name, () => {
      for (const src of srcs) expect(keys(schema)).toEqual(akFields(src, name));
    });
  }

  it("VaultDatum có đúng 19 trường, hai trường cuối là cửa sổ", () => {
    expect(keys(VaultDatumSchema)).toHaveLength(19);
    expect(keys(VaultDatumSchema).slice(17)).toEqual(["usage_window", "usage_window_epoch"]);
  });

  it("GbShardRedeemer: `Draw { amount }` là biến thể DUY NHẤT (constr 0) ở cả hai `.ak`", () => {
    for (const src of [sg, gb]) {
      expect(src).toMatch(/pub type GbShardRedeemer \{\s*Draw \{ amount: Int \}\s*\}/);
    }
    expect(keys(GbShardRedeemerSchema)).toEqual(["amount"]);
  });
});

// ── Apply-param + hằng gói (c) ────────────────────────────────
function vaultParamNames(src: string): string[] {
  const start = src.indexOf("validator vault(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(") {", start);
  return src.slice(start + "validator vault(".length, end)
    .split("\n")
    .map(l => l.replace(/\/\/.*$/, "").trim())
    .map(l => l.match(/^([a-z_0-9]+)\s*:/)?.[1])
    .filter((x): x is string => x !== undefined);
}

describe("Apply-param két ScheduleGen v2.0 — 9 phần tử, đúng thứ tự chữ ký", () => {
  const P = {
    lampPolicyId: "aa".repeat(28), lampAssetName: "744c414d50", shardPolicyId: "bb".repeat(28),
    msPerEpoch: 432_000_000n, gbBeaconNftPolicy: "67".repeat(28), gbBeaconScriptHash: "68".repeat(28),
    gbShardPolicyId: "66".repeat(28), rateNftPolicy: "69".repeat(28), rateScriptHash: "6a".repeat(28),
  };

  it("tên == chữ ký `validator vault(` trong vault.ak", () => {
    const names = vaultParamNames(read("onchain/validators/vault.ak"));
    expect(names).toHaveLength(9);
    expect([...SCHEDULE_VAULT_PARAM_NAMES]).toEqual(names);
  });

  it("bản đồ + danh sách giữ đúng thứ tự và giá trị", () => {
    expect(Object.keys(scheduleVaultParamMap(P))).toEqual([...SCHEDULE_VAULT_PARAM_NAMES]);
    expect(scheduleVaultParamList(P)).toEqual([
      P.lampPolicyId, P.lampAssetName, P.shardPolicyId, P.msPerEpoch, P.gbBeaconNftPolicy,
      P.gbBeaconScriptHash, P.gbShardPolicyId, P.rateNftPolicy, P.rateScriptHash,
    ]);
  });

  it("CỰC ĐỐI: policy sai độ dài / không phải hex / ms_per_epoch ≤ 0 ⟹ NÉM", () => {
    expect(() => scheduleVaultParamMap({ ...P, gbShardPolicyId: "66".repeat(27) })).toThrow(/28 byte/);
    expect(() => scheduleVaultParamMap({ ...P, rateScriptHash: "zz".repeat(28) })).toThrow(/hex/);
    expect(() => scheduleVaultParamMap({ ...P, msPerEpoch: 0n })).toThrow(/ms_per_epoch/);
  });
});

describe("Hằng Gen v2.0 gói (c) — TS == constants.ak (P8)", () => {
  const ak = read("onchain/lib/magiclamp/protocol/constants.ak");
  const gbc = readRepo("GenBeacons/onchain/lib/genbeacons/constants.ak");
  const akBytes = (src: string, n: string) =>
    src.match(new RegExp(`pub const ${n}\\s*:\\s*ByteArray\\s*=\\s*#"([0-9a-f]*)"`))?.[1];
  const akInt = (n: string) =>
    ak.match(new RegExp(`pub const ${n}\\s*:\\s*Int\\s*=\\s*([0-9_]+)`))?.[1]?.replace(/_/g, "");

  it("tên NFT", () => {
    expect(C.RATE_NFT_NAME).toBe(akBytes(ak, "rate_nft_name"));
    expect(C.GREENBACK_NFT_NAME).toBe(akBytes(ak, "greenback_nft_name"));
    expect(C.GB_SHARD_NFT_PREFIX).toBe(akBytes(ak, "gb_shard_nft_prefix"));
    expect(C.VAULT_REGISTRY_NFT_NAME).toBe(akBytes(gbc, "vault_registry_nft_name"));
  });

  it("tuổi beacon, horizon, trần κ", () => {
    expect(C.GREENBACK_BEACON_MAX_AGE_EPOCHS.toString()).toBe(akInt("greenback_beacon_max_age_epochs"));
    expect(C.SCHEDULE_SCALE_HORIZON_CAP.toString()).toBe(akInt("schedule_scale_horizon_cap"));
    expect(ak).toMatch(/pub const schedule_obligation_cap_per_shard\s*:\s*Int\s*=\s*gb_shard_cap_nanogic/);
    expect(C.SCHEDULE_OBLIGATION_CAP_PER_SHARD).toBe(C.GB_SHARD_CAP_NANOGIC);
  });
});
