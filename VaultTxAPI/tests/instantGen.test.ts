// VaultTxAPI/tests/instantGen.test.ts — `POST /tx/instant-gen` và `POST /tx/refresh-checkpoint`
// (Gen v2.0).
//
// ══ HAI CẶP GHIM QUAN TRỌNG NHẤT ═══════════════════════════════════════════════
// (1) `m = max_m` ⟹ 200; `m = max_m + 1` ⟹ 422 `INSTANT_GEN_M_ABOVE_MAX`, bộ dựng KHÔNG được
//     gọi. `max_m` lấy từ `instantGenLimits` của gói nền trên ĐÚNG các UTxO beacon/shard ghi
//     sẵn — bài kiểm cũng tự đòi `max_m > 0`, để cặp này không xanh vì lý do rỗng.
// (2) refresh-checkpoint có beacon ρ ⟹ 200; beacon ρ vắng trên chuỗi ⟹ 502, không dựng.
// Cộng: thiếu khối `gen_v2` / ref `gb_shard` ⟹ 501 `CONFIG_MISSING` có `details.missing`.
// ══════════════════════════════════════════════════════════════════════════════

import { posixMsToEpoch } from "@magiclamp/protocol-utils";
import type { UTxO } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder } from "../src/txBuilder.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex, datumV1Hex,
} from "./fixtures/preview.js";
import { GB_SHARD_REF, genV2Chain, genV2Json, type GenNet } from "./fixtures/genV2.js";
import { buildTxCbor, prerecordedTtlSlot } from "./fixtures/tx.js";

const FEE = 178_000n;
const TTL = 180_000;
const NOW = 1_789_100_703_000;
const FIXTURE_TTL_SLOT = prerecordedTtlSlot(NOW, undefined, "Preprod");
const TIP: ChainTip = {
  blockHeight: 4_651_976,
  blockHash: "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f",
  blockTimePosixMs: BigInt(NOW),
};
/** Preprod có két Wakeme ⟹ apply-param #8 có giá trị; Preview thì không (ca 501 riêng). */
const EPOCH = posixMsToEpoch(BigInt(NOW), "Preprod");
/** `max_m` của fixture — tính bằng `instantGenLimits` (gói nền) trên chuỗi ghi sẵn dưới đây:
 *  L_avail 1001 LAMP, ρ = 1 (Q), cửa sổ lạnh, GB rộng ⟹ vế ràng buộc là `cap_nanogic`.
 *  Bài "max_m khớp gói nền" bên dưới đo lại con số này, không tin nó. */
const MAX_M = 750_750_000n;
const MINTED = 4_000_000n;

function deploymentJson(net: GenNet, o: { genV2?: boolean; gbShardRef?: boolean; legacyInstant?: boolean } = {}): string {
  const base: Record<string, unknown> = {
    source: "bản dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    vaults: [{ vault_type: "Instant", address: VAULT_ADDRESS }],
    shard_address: SHARD_ADDRESS,
    ref_script_utxos: {
      vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
      ...(o.gbShardRef === false ? {} : { gb_shard: GB_SHARD_REF }),
    },
    consume: {
      engage_address: VAULT_ADDRESS,
      price_beacon_address: VAULT_ADDRESS,
      price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
    },
  };
  if (o.genV2 !== false) base.gen_v2 = genV2Json(net);
  if (o.legacyInstant === true) {
    base.instant = { um_datum_address: VAULT_ADDRESS, um_nft_unit: `${"66".repeat(28)}554d` };
  }
  return JSON.stringify(base);
}

/** Datum ra: két Instant 20 trường đã làm mới checkpoint ở `EPOCH`, thêm một lô `MINTED`. */
function outDatum(): string {
  return datumHex({
    lampLockedOildrop: 0n,
    batches: [{ id: "c0".repeat(16), createdEpoch: EPOCH, amountNanogic: MINTED }],
    instantUnlockMs: 1_789_000_000_000n,
    lastUpdatedEpoch: EPOCH,
    capEpoch: EPOCH, capNanogic: MAX_M, usageWindowEpoch: EPOCH,
    usageWindow: [{ generated: MINTED, consumed: 0n }, ...Array.from({ length: 6 }, () => ({ generated: 0n, consumed: 0n }))],
  });
}

function vaultTxCbor(datum: string): string {
  return buildTxCbor({ ttlSlot: FIXTURE_TTL_SLOT,
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    feeLovelace: FEE,
    // LAMP Ở LẠI trong vault: sinh MAGIC KHÔNG làm LAMP rời vault (I-ACT-7).
    outputs: [{
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      inlineDatumHex: datum,
    }],
  });
}

/** Két Instant v2.0 chưa từng sinh (cap_epoch 0 < EPOCH ⟹ lượt này làm mới checkpoint). */
function vaultUtxo(v1 = false): UTxO {
  const spec = { lampLockedOildrop: 0n, batches: [], instantUnlockMs: 0n, lastUpdatedEpoch: EPOCH - 41n };
  return {
    txHash: INPUT_TX_HASH, outputIndex: 0, address: VAULT_ADDRESS,
    assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
    datum: v1 ? datumV1Hex(spec) : datumHex(spec),
  };
}

interface HarnessOpts {
  net?: GenNet; genV2?: boolean; gbShardRef?: boolean; noRate?: boolean; v1Vault?: boolean;
}

function harness(o: HarnessOpts = {}) {
  const net = o.net ?? "Preprod";
  const deployment: Deployment = parseDeployment(
    deploymentJson(net, { genV2: o.genV2, gbShardRef: o.gbShardRef }), net);
  const chain = new RecordedChainReader(
    { [VAULT_ADDRESS]: [vaultUtxo(o.v1Vault === true)], ...genV2Chain(net, { epoch: EPOCH, noRate: o.noRate }) },
    TIP, []);
  const cbor = vaultTxCbor(outDatum());
  const builder = new RecordedTxBuilder({ instant_gen: cbor, refresh_checkpoint: cbor });
  const service = new VaultTxService({
    network: net, deployment, chain, builder,
    locks: new OwnerLockTable(TTL), issued: new IssuedTxRegistry(),
    lockTtlMs: TTL, now: () => NOW,
  });
  const router: RouterDeps = {
    service, deploymentSource: deployment.source, vaultScopes: deployment.vaults, network: net,
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { service, builder, router, deployment };
}

const post = (url: string, body: unknown) => ({ method: "POST", url, headers: {}, body });
const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const detailsOf = (r: { body: unknown }) => (r.body as { error: { details: Record<string, unknown> } }).error.details;
const summaryOf = (r: { body: unknown }) => (r.body as { summary: Record<string, unknown> }).summary;

describe("POST /tx/instant-gen — `m` (Gen v2.0)", () => {
  it("CẶP (a): m = max_m ⟹ 200, `m` đi nguyên xuống bộ dựng, summary có gen_limits", async () => {
    expect(MAX_M).toBeGreaterThan(0n);
    const h = harness();
    const r = await handle(post("/tx/instant-gen", { owner_pkh: OWNER_PKH, m: MAX_M.toString() }), h.router);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.builder.lastCall).toMatchObject({ route: "instant_gen", params: { m: MAX_M } });
    const bp = h.builder.lastCall!.buildParams as { includeRateBeacon: boolean; refs: { gbShardUtxo: UTxO } };
    // cap_epoch 0 < EPOCH ⟹ làm mới ⟹ beacon ρ phải vào tx.
    expect(bp.includeRateBeacon).toBe(true);
    const s = summaryOf(r);
    expect(s.gen_limits).toEqual({
      max_m_nanogic: MAX_M.toString(),
      remaining_after_nanogic: (MAX_M - MINTED).toString(),
      l_lent_oildrop: "0",
      gen_so_far_nanogic: "0",
      cap_nanogic: MAX_M.toString(),
      cap_lamp_nanogic: "4004000000",
      gb_available_nanogic: "1000000000000000",
      checkpoint_refreshed: true,
    });
    expect(s.gen).toMatchObject({
      cap_epoch: EPOCH.toString(), cap_nanogic: MAX_M.toString(), wakeme_link: "",
      usage_window_epoch: EPOCH.toString(),
    });
  });

  it("CẶP (b): m = max_m + 1 ⟹ 422 INSTANT_GEN_M_ABOVE_MAX kèm max_m, bộ dựng KHÔNG được gọi", async () => {
    const h = harness();
    const r = await handle(post("/tx/instant-gen", { owner_pkh: OWNER_PKH, m: (MAX_M + 1n).toString() }), h.router);
    expect(r.status).toBe(422);
    expect(codeOf(r)).toBe("INSTANT_GEN_M_ABOVE_MAX");
    expect(detailsOf(r).max_m).toBe(MAX_M.toString());
    expect(detailsOf(r).m).toBe((MAX_M + 1n).toString());
    expect(h.builder.lastCall).toBeNull();
  });

  it("m vắng / 0 / số JSON / không phải chữ số ⟹ 400 INSTANT_GEN_M_INVALID, không chạm bộ dựng", async () => {
    const h = harness();
    for (const bad of [undefined, "0", 5, "1.5", "-3", ""]) {
      const body: Record<string, unknown> = { owner_pkh: OWNER_PKH };
      if (bad !== undefined) body.m = bad;
      const r = await handle(post("/tx/instant-gen", body), h.router);
      expect(r.status, `m=${String(bad)}`).toBe(400);
      expect(codeOf(r)).toBe("INSTANT_GEN_M_INVALID");
    }
    expect(h.builder.lastCall).toBeNull();
  });

  it("🔴 thiếu khối `gen_v2` ⟹ 501 CONFIG_MISSING, details.missing nêu khoá", async () => {
    const h = harness({ genV2: false });
    expect(h.deployment.genV2).toBeUndefined();
    const r = await handle(post("/tx/instant-gen", { owner_pkh: OWNER_PKH, m: "1" }), h.router);
    expect(r.status).toBe(501);
    expect(codeOf(r)).toBe("CONFIG_MISSING");
    expect(detailsOf(r).missing).toBe("deployment.gen_v2");
    expect(h.builder.lastCall).toBeNull();
  });

  it("🔴 thiếu `ref_script_utxos.gb_shard` ⟹ 501 CONFIG_MISSING", async () => {
    const h = harness({ gbShardRef: false });
    const r = await handle(post("/tx/instant-gen", { owner_pkh: OWNER_PKH, m: "1" }), h.router);
    expect(r.status).toBe(501);
    expect(detailsOf(r).missing).toBe("deployment.ref_script_utxos.gb_shard");
  });

  it("mạng chưa có két Wakeme (Preview) ⟹ 501 WAKEME_VAULT_UNAVAILABLE", async () => {
    const h = harness({ net: "Preview" });
    const r = await handle(post("/tx/instant-gen", { owner_pkh: OWNER_PKH, m: "1" }), h.router);
    expect(r.status).toBe(501);
    expect(codeOf(r)).toBe("WAKEME_VAULT_UNAVAILABLE");
  });

  it("két mang datum v1 (18 trường) ⟹ không 200, bộ dựng không được gọi", async () => {
    const h = harness({ v1Vault: true });
    const r = await handle(post("/tx/instant-gen", { owner_pkh: OWNER_PKH, m: "1" }), h.router);
    expect(r.status).not.toBe(200);
    expect(h.builder.lastCall).toBeNull();
  });

  it("thiếu owner ⟹ 400; GET ⟹ 405", async () => {
    const h = harness();
    expect((await handle(post("/tx/instant-gen", { m: "1" }), h.router)).status).toBe(400);
    expect((await handle({ method: "GET", url: "/tx/instant-gen", headers: {} }, h.router)).status).toBe(405);
  });
});

describe("POST /tx/refresh-checkpoint", () => {
  it("CẶP (a): có beacon ρ ⟹ 200, beacon ρ giao xuống bộ dựng", async () => {
    const h = harness();
    const r = await handle(post("/tx/refresh-checkpoint", { owner_pkh: OWNER_PKH }), h.router);
    expect(r.status).toBe(200);
    expect(h.builder.lastCall?.route).toBe("refresh_checkpoint");
    const bp = h.builder.lastCall!.buildParams as { rateBeaconUtxo: UTxO; wakemeVaultUtxo?: UTxO };
    expect(bp.rateBeaconUtxo.txHash).toBe("a9".repeat(32));
    expect(bp.wakemeVaultUtxo).toBeUndefined();
    expect(summaryOf(r).requested_intent).toBe("refresh_checkpoint");
  });

  it("CẶP (b): beacon ρ KHÔNG có trên chuỗi ⟹ 502 CHAIN_UNAVAILABLE, bộ dựng không được gọi", async () => {
    const h = harness({ noRate: true });
    const r = await handle(post("/tx/refresh-checkpoint", { owner_pkh: OWNER_PKH }), h.router);
    expect(r.status).toBe(502);
    expect(codeOf(r)).toBe("CHAIN_UNAVAILABLE");
    expect(h.builder.lastCall).toBeNull();
  });

  it("thiếu khối `gen_v2` ⟹ 501 CONFIG_MISSING", async () => {
    const h = harness({ genV2: false });
    const r = await handle(post("/tx/refresh-checkpoint", { owner_pkh: OWNER_PKH }), h.router);
    expect(r.status).toBe(501);
    expect(detailsOf(r).missing).toBe("deployment.gen_v2");
  });
});

describe("parseDeployment — khối `gen_v2`", () => {
  it("vắng hẳn thì hợp lệ, `genV2` là undefined", () => {
    expect(parseDeployment(deploymentJson("Preprod", { genV2: false }), "Preprod").genV2).toBeUndefined();
  });

  it("có thì đọc đủ, script hash suy từ địa chỉ, cap là bigint", () => {
    const g = parseDeployment(deploymentJson("Preprod"), "Preprod").genV2!;
    expect(g.rateScriptHash).toBe("a1".repeat(28));
    expect(g.gbBeaconScriptHash).toBe("b1".repeat(28));
    expect(g.gbShardPolicyId).toBe("c3".repeat(28));
    expect(g.vaultRegistryPolicy).toBe("d4".repeat(28));
    expect(g.gbShardCapNanogic).toBe(1_000_000_000_000_000n);
  });

  it("🔴 khai THIẾU `gb_shard_cap_nanogic` ⟹ NÉM (không mặc định)", () => {
    const broken = JSON.parse(deploymentJson("Preprod"));
    delete broken.gen_v2.gb_shard_cap_nanogic;
    expect(() => parseDeployment(JSON.stringify(broken), "Preprod")).toThrow();
  });

  it("🔴 khoá `instant` (v1) còn nằm trong bản deploy ⟹ NÉM lúc khởi động", () => {
    expect(() => parseDeployment(deploymentJson("Preprod", { legacyInstant: true }), "Preprod")).toThrow(/gen_v2/);
  });
});
