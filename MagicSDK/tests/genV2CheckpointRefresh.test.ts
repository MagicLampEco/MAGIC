// MagicSDK/tests/genV2CheckpointRefresh.test.ts — lượt chủ ký ĐẦU TIÊN trong epoch mới trên
// két InstantGen Gen v2.0 làm mới checkpoint, và SDK phải mang đúng reference input theo.
//
// Luật (gương `checkpoint.ak ▸ expected_checkpoint`, mode `FollowVault`; SDK ở `genV2Refs.ts`):
//   `cap_epoch == e` ⟹ không làm mới, KHÔNG đọc ref nào.
//   `cap_epoch <  e` ⟹ làm mới: BẮT BUỘC beacon ρ; `wakeme_link != ""` ⟹ BẮT BUỘC két Wakeme.
//
// Mỗi ca dương đi cặp với một ca âm chỉ khác ĐÚNG MỘT ô (có/không beacon ρ · có/không két
// Wakeme · `cap_epoch` cũ/mới). Ca dương đứng một mình xanh được ở cả bản "không bao giờ
// đòi ρ" lẫn bản đúng.
//
// Hai đường gọi:
//   `buildVaultBurnBatch` — hàm thuần, đọc thẳng kết quả (`rateBeaconUtxo`, `wakemeVaultUtxo`
//                           chuyển tiếp cho `buildConsumeTx`).
//   `updateProfile`       — dựng giao dịch; `lucid` giả ghi lại `readFrom` (cùng cách
//                           `refScriptWiring.test.ts`), vì thứ cần ghim là HÌNH DẠNG giao dịch.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Constr, Data, credentialToAddress, scriptHashToCredential,
  type Data as TData, type LucidEvolution, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { epochStartMs, posixMsToEpoch } from "@magiclamp/protocol-utils";
import { RATE_NFT_NAME, RateParam } from "@magiclamp/instantgen-sdk";

import { buildVaultBurnBatch } from "../src/burnBatch.js";
import { updateProfile } from "../src/updateProfile.js";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";
import { InstantVaultDatumSchema, type InstantVaultDatum } from "../src/schemas.js";
import { ACCEPT_INLINE_SCRIPT_CEILING } from "../src/refScript.js";
import type { InstantRefParams } from "../src/genV2Refs.js";
import type { PlutusJson } from "../src/redeemerIndex.js";

// ── Tham số két Instant (giá trị giả, đúng hình dạng) ─────────────────────────────
// Preview chưa có gốc cửa sổ (`WIN-PREVIEW`, LAMP `Specs/Window/CONTRACT.md` v1.0 §4) và các bộ
// dựng tính epoch theo mạng ⟹ fixture chạy trên Preprod, mốc tip tính TỪ GỐC (`epochStartMs`).
const NET = "Preprod" as const;
const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const TLAMP       = "744c414d50";
const RHO_POLICY  = "bb".repeat(28);
const RHO_SCRIPT  = "cc".repeat(28);
const WAKEME_HASH = "66".repeat(28);
const VAULT_HASH  = "d1".repeat(28);
const VAULT_NAME  = "e2".repeat(32);
const OWNER_PKH   = "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21";
const COMMIT      = "c3".repeat(32);

const REF_PARAMS: InstantRefParams = {
  lampPolicyId: LAMP_POLICY, lampAssetName: TLAMP,
  rateNftPolicy: RHO_POLICY, rateScriptHash: RHO_SCRIPT, wakemeVaultHash: WAKEME_HASH,
};

// Epoch SUY RA từ mốc thời gian (gốc epoch theo mạng) — `updateProfile` tự tính epoch từ tip.
const TIP_MS = epochStartMs(60n, NET);
const E = posixMsToEpoch(TIP_MS, NET);

const scriptAddr = (h: string) => credentialToAddress(NET, scriptHashToCredential(h));

const IG_PLUTUS = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../InstantGen/onchain/plutus.json", import.meta.url)), "utf8",
)) as PlutusJson;

/** Datum két Instant 20 trường: genesis SDK + ghi đè. Mặc định `cap_epoch = E - 1` ⟹ làm mới. */
function vaultDatum(over: Partial<InstantVaultDatum> = {}): InstantVaultDatum {
  const g = buildInitialVaultDatum({
    ownerPkh: OWNER_PKH, lampBalanceOildrop: 1_000_000_000n, profile: "Flame",
    currentEpoch: E - 5n, vaultType: "Instant",
  });
  return {
    ...g,
    magic_batches: [{
      batch_id: "a1".repeat(32), source: "Instant", created_epoch: E, initial_amount: 500n,
      current_amount: 500n, decay_window: 1n, profile_at_creation: null, contract_id: null, halved: false,
    }] as InstantVaultDatum["magic_batches"],
    next_batch_index: 1n,
    last_updated_epoch: E - 1n,
    cap_epoch: E - 1n,
    usage_window_epoch: E - 1n,
    ...over,
  };
}

function vaultUtxo(d: InstantVaultDatum): UTxO {
  return {
    txHash: "ab".repeat(32), outputIndex: 0, address: scriptAddr(VAULT_HASH),
    assets: { lovelace: 5_000_000n, [LAMP_POLICY + TLAMP]: d.lamp_balance, [VAULT_HASH + VAULT_NAME]: 1n },
    datum: Data.to(d as never, InstantVaultDatumSchema), datumHash: null, scriptRef: null,
  } as UTxO;
}

function rateUtxo(): UTxO {
  const r = { rho_q: 1_000_000_000n, prev_rho_q: 500_000_000n, effective_epoch: E };
  return {
    txHash: "ab".repeat(32), outputIndex: 4, address: scriptAddr(RHO_SCRIPT),
    assets: { lovelace: 2_000_000n, [RHO_POLICY + RATE_NFT_NAME]: 1n },
    datum: Data.to(r, RateParam), datumHash: null, scriptRef: null,
  } as UTxO;
}

/** Két Wakeme ghim két IG này — hình dạng ≥13 trường mà `readWakemeVault` đọc theo vị trí
 *  (cùng hình dạng `InstantGen/tests/instantFixtures.ts ▸ wakemeUtxo`). */
function wakemeUtxo(): UTxO {
  const cond = 700_000_000n, owned = 300_000_000n;
  const pin = new Constr(0, [new Constr(0, [VAULT_HASH, VAULT_NAME])]);
  const fs: TData[] = [COMMIT, "e5e5", 0n, cond, 0n, 50n, 49n, owned, 0n, 0n, "f6f6", pin, E - 1n];
  return {
    txHash: "ab".repeat(32), outputIndex: 5, address: scriptAddr(WAKEME_HASH),
    assets: { lovelace: 2_000_000n, [WAKEME_HASH + COMMIT]: 1n, [LAMP_POLICY + TLAMP]: cond + owned },
    datum: Data.to(new Constr(0, fs)), datumHash: null, scriptRef: null,
  } as UTxO;
}

// ════════════════════════════════════════════════════════════════════════════════
describe("buildVaultBurnBatch (InstantGen) — làm mới checkpoint đầu epoch", () => {
  const burn = (d: InstantVaultDatum, refs: { rate?: boolean; wakeme?: boolean } = {}) => buildVaultBurnBatch({
    vaultUtxo: vaultUtxo(d), required: 100n, currentEpoch: E,
    vaultModule: "InstantGen", vaultPlutusJson: IG_PLUTUS,
    instantVaultParams: REF_PARAMS,
    ...(refs.rate ? { rateBeaconUtxo: rateUtxo() } : {}),
    ...(refs.wakeme ? { wakemeVaultUtxo: wakemeUtxo() } : {}),
  });

  it("cap_epoch < e, CÓ beacon ρ ⟹ dựng được, kết quả mang rateBeaconUtxo, checkpoint lên e", () => {
    const r = burn(vaultDatum(), { rate: true });
    expect(r.checkpointRefreshed).toBe(true);
    expect(r.rateBeaconUtxo).toEqual(rateUtxo());
    expect(r.wakemeVaultUtxo).toBeUndefined();
    const nd = r.newDatum as InstantVaultDatum;
    expect(nd.cap_epoch).toBe(E);
    expect(nd.usage_window_epoch).toBe(E);
    // Datum ra được mã hoá bằng chính lược đồ 20 trường — không phải bản trước khi làm mới.
    expect(Data.from(r.vaultOutDatumCbor, InstantVaultDatumSchema).cap_epoch).toBe(E);
  });

  it("cap_epoch < e, THIẾU beacon ρ ⟹ NÉM GEN-INST-011 nêu beacon ρ", () => {
    expect(() => burn(vaultDatum())).toThrow(/GEN-INST-011[\s\S]*beacon ρ/);
  });

  it("cap_epoch == e, có truyền ρ ⟹ KHÔNG làm mới, KHÔNG chuyển tiếp ρ (validator không đọc)", () => {
    const r = burn(vaultDatum({ cap_epoch: E, usage_window_epoch: E, last_updated_epoch: E }), { rate: true });
    expect(r.checkpointRefreshed).toBe(false);
    expect(r.rateBeaconUtxo).toBeUndefined();
  });

  it("wakeme_link != \"\", có ρ nhưng THIẾU két Wakeme ⟹ NÉM GEN-INST-011 (luật 2)", () => {
    expect(() => burn(vaultDatum({ wakeme_link: COMMIT }), { rate: true }))
      .toThrow(/GEN-INST-011[\s\S]*BẮT BUỘC có két đó/);
  });

  it("wakeme_link != \"\", có ρ VÀ két Wakeme ghim két này ⟹ dựng được, mang cả hai ref", () => {
    const r = burn(vaultDatum({ wakeme_link: COMMIT }), { rate: true, wakeme: true });
    expect(r.checkpointRefreshed).toBe(true);
    expect(r.rateBeaconUtxo).toEqual(rateUtxo());
    expect(r.wakemeVaultUtxo).toEqual(wakemeUtxo());
    expect((r.newDatum as InstantVaultDatum).wakeme_link).toBe(COMMIT);
  });

  it("có beacon ρ mà THIẾU apply-param két ⟹ NÉM SDK-GENV2-PARAMS (không soát được ref)", () => {
    expect(() => buildVaultBurnBatch({
      vaultUtxo: vaultUtxo(vaultDatum()), required: 100n, currentEpoch: E,
      vaultModule: "InstantGen", vaultPlutusJson: IG_PLUTUS, rateBeaconUtxo: rateUtxo(),
    })).toThrow(/SDK-GENV2-PARAMS/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
/** `lucid` giả: ghi lại mọi `readFrom` và mọi phương thức được gọi trên trình dựng. */
function recordingLucid() {
  const calls: string[] = [];
  const readInputs: UTxO[] = [];
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "attach") return { SpendingValidator: () => { calls.push("attach.SpendingValidator"); return proxy; } };
      if (prop === "pay") return { ToAddressWithData: () => { calls.push("pay.ToAddressWithData"); return proxy; } };
      if (prop === "readFrom") return (us: UTxO[]) => { calls.push("readFrom"); readInputs.push(...us); return proxy; };
      if (prop === "complete") return async () => ({ __fakeTxSignBuilder: true });
      if (prop === "then") return undefined;
      return () => { calls.push(String(prop)); return proxy; };
    },
  });
  const lucid = { newTx: () => { calls.push("newTx"); return proxy; } } as unknown as LucidEvolution;
  return { lucid, calls, readInputs };
}

const VAULT_SCRIPT: Validator = { type: "PlutusV3", script: "4746010000222220" };

describe("updateProfile (InstantGen) — làm mới checkpoint đầu epoch", () => {
  const run = (d: InstantVaultDatum, refs: { rate?: boolean; wakeme?: boolean } = {}) => {
    const rec = recordingLucid();
    const p = updateProfile({
      lucid: rec.lucid, vaultUtxo: vaultUtxo(d), newProfile: "Ember", vaultScript: VAULT_SCRIPT,
      vaultType: "Instant", vaultPlutusJson: IG_PLUTUS, network: NET, tipPosixMs: TIP_MS,
      vaultRefScriptUtxo: ACCEPT_INLINE_SCRIPT_CEILING, instantVaultParams: REF_PARAMS,
      ...(refs.rate ? { rateBeaconUtxo: rateUtxo() } : {}),
      ...(refs.wakeme ? { wakemeVaultUtxo: wakemeUtxo() } : {}),
    });
    return { p, ...rec };
  };

  it("cap_epoch < e, CÓ beacon ρ ⟹ tx ĐỌC beacon ρ, datum ra cap_epoch = e", async () => {
    const { p, readInputs } = run(vaultDatum(), { rate: true });
    const r = await p;
    expect(r.checkpointRefreshed).toBe(true);
    expect(r.newVaultDatum.cap_epoch).toBe(E);
    expect(r.newVaultDatum.usage_window_epoch).toBe(E);
    expect(readInputs).toEqual([rateUtxo()]);
  });

  it("cap_epoch < e, THIẾU beacon ρ ⟹ NÉM GEN-INST-011 TRƯỚC khi chạm trình dựng", async () => {
    const { p, calls } = run(vaultDatum());
    await expect(p).rejects.toThrow(/GEN-INST-011[\s\S]*beacon ρ/);
    expect(calls).toEqual([]);
  });

  it("cap_epoch == e, có truyền ρ ⟹ KHÔNG làm mới, tx KHÔNG đọc ρ", async () => {
    const { p, readInputs } = run(vaultDatum({ cap_epoch: E, usage_window_epoch: E, last_updated_epoch: E }), { rate: true });
    const r = await p;
    expect(r.checkpointRefreshed).toBe(false);
    expect(readInputs).toEqual([]);
  });

  it("wakeme_link != \"\", có ρ nhưng THIẾU két Wakeme ⟹ NÉM GEN-INST-011", async () => {
    const { p, calls } = run(vaultDatum({ wakeme_link: COMMIT }), { rate: true });
    await expect(p).rejects.toThrow(/GEN-INST-011[\s\S]*BẮT BUỘC có két đó/);
    expect(calls).toEqual([]);
  });

  it("wakeme_link != \"\", có ρ VÀ két Wakeme ⟹ tx đọc CẢ HAI", async () => {
    const { p, readInputs } = run(vaultDatum({ wakeme_link: COMMIT }), { rate: true, wakeme: true });
    const r = await p;
    expect(r.checkpointRefreshed).toBe(true);
    expect(r.newVaultDatum.wakeme_link).toBe(COMMIT);
    expect(readInputs).toEqual([rateUtxo(), wakemeUtxo()]);
  });
});
