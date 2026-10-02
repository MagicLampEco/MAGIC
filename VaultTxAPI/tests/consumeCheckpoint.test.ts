// VaultTxAPI/tests/consumeCheckpoint.test.ts — `POST /tx/consume` trên két Instant Gen v2.0,
// lượt tiêu ĐẦU TIÊN trong epoch mới (`cap_epoch < e`) ⟹ nhánh BurnBatch làm mới checkpoint.
//
// ══ HAI CẶP GHIM ═══════════════════════════════════════════════════════════════
// (1) ρ: beacon ρ có trên chuỗi ⟹ 200 và bộ dựng NHẬN đúng UTxO beacon đó ở `checkpoint`;
//     beacon ρ vắng ⟹ 502 `CHAIN_UNAVAILABLE`, bộ dựng KHÔNG được gọi. Kèm ca đối chứng:
//     cùng epoch (`cap_epoch = e`) mà beacon vắng vẫn 200 và KHÔNG có `checkpoint` — nên cặp
//     trên đỏ vì lượt làm mới, không phải vì mọi lượt tiêu đều đọc ρ.
// (2) Két Wakeme: `wakeme_link` khác rỗng mà thiếu `wakeme_vault_ref` ⟹ 400
//     `WAKEME_VAULT_REF_REQUIRED`, bộ dựng không được gọi; có ref ⟹ 200, két đi xuống bộ dựng.
// Bộ dựng ở tệp này là bản GHI SẴN; đường qua bộ dựng THẬT nằm ở `consumeSdkBuilder.test.ts`.
// ══════════════════════════════════════════════════════════════════════════════

import { Constr, Data, credentialToAddress, type UTxO } from "@lucid-evolution/lucid";
import { posixMsToEpoch, wakemeVaultHash } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder } from "../src/txBuilder.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, VAULT_SCRIPT_HASH, datumHex,
} from "./fixtures/preview.js";
import { ENGAGE_ADDRESS, threadUtxo } from "./fixtures/engage.js";
import { GB_SHARD_REF, genV2Chain, genV2Json } from "./fixtures/genV2.js";
import { buildTxCbor } from "./fixtures/tx.js";

const NET = "Preprod" as const;
const TTL = 180_000;
const NOW = 1_789_100_703_000;
const TIP: ChainTip = {
  blockHeight: 4_651_976,
  blockHash: "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f",
  blockTimePosixMs: BigInt(NOW),
};
const EPOCH = posixMsToEpoch(BigInt(NOW), NET);
const RATE_TX = "a9".repeat(32);

const WAKEME_HASH = wakemeVaultHash(NET);
const WAKEME_ADDRESS = credentialToAddress(NET, { type: "Script", hash: WAKEME_HASH });
const WAKEME_TX = "ab".repeat(32);
const WAKEME_REF = `${WAKEME_TX}#1`;
const OWNER_COMMIT = "c1".repeat(32);
const CONDITIONAL = 300_000_000n;
const OWNED = 200_000_000n;

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

const LIVE_BATCH = { id: "b0".repeat(16), createdEpoch: EPOCH, amountNanogic: 5_000_000n };

interface VaultSpec {
  /** `cap_epoch` của két. `< EPOCH` ⟹ lượt tiêu này làm mới checkpoint. */
  capEpoch: bigint;
  wakemeLink?: string;
}

function vaultUtxo(s: VaultSpec): UTxO {
  return {
    txHash: INPUT_TX_HASH, outputIndex: 0, address: VAULT_ADDRESS,
    assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
    datum: datumHex({
      lampLockedOildrop: 0n, batches: [LIVE_BATCH], instantUnlockMs: 0n,
      lastUpdatedEpoch: EPOCH - 1n, capEpoch: s.capEpoch, wakemeLink: s.wakemeLink ?? "",
    }),
  };
}

/** Két Wakeme ghim đúng két này, `owner_commit` = `OWNER_COMMIT` (= `wakeme_link` của két). */
function wakemeUtxo(): UTxO {
  const pin = new Constr(0, [new Constr(0, [VAULT_SCRIPT_HASH, VAULT_ID_UNIT.slice(56)])]);
  return {
    txHash: WAKEME_TX, outputIndex: 1, address: WAKEME_ADDRESS,
    assets: { lovelace: 2_000_000n, [WAKEME_HASH + OWNER_COMMIT]: 1n, [LAMP_UNIT]: CONDITIONAL + OWNED },
    datum: Data.to(new Constr(0, [
      OWNER_COMMIT, 0n, 0n, CONDITIONAL, 0n, 0n, 0n, OWNED, 0n, 0n, 0n, pin, EPOCH - 1n,
    ])),
  };
}

/** CBOR ghi sẵn của lượt tiêu: két đốt 1 MAGIC; két Wakeme (nếu có) ở reference input. */
function consumeTxCbor(withWakeme: boolean): string {
  return buildTxCbor({
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    ...(withWakeme ? { referenceInputs: [{ txHash: WAKEME_TX, outputIndex: 1 }] } : {}),
    feeLovelace: 178_000n,
    outputs: [{
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      inlineDatumHex: datumHex({
        lampLockedOildrop: 0n, batches: [{ ...LIVE_BATCH, amountNanogic: 4_000_000n }], instantUnlockMs: 0n,
        lastUpdatedEpoch: EPOCH, capEpoch: EPOCH, usageWindowEpoch: EPOCH,
        consumedCreditNanogic: 1_000_000n,
      }),
    }],
  });
}

interface HarnessOpts extends VaultSpec { noRate?: boolean; withWakeme?: boolean }

function harness(o: HarnessOpts) {
  const deployment = parseDeployment(DEPLOYMENT_JSON, NET);
  const chain = new RecordedChainReader(
    {
      [VAULT_ADDRESS]: [vaultUtxo(o)],
      [ENGAGE_ADDRESS]: [threadUtxo({ type: "key", hash: OWNER_PKH }, "7e".repeat(32))],
      ...genV2Chain(NET, { epoch: EPOCH, noRate: o.noRate }),
    },
    TIP, o.withWakeme === true ? [wakemeUtxo()] : []);
  const builder = new RecordedTxBuilder({ consume: consumeTxCbor(o.withWakeme === true) });
  const service = new VaultTxService({
    network: NET, deployment, chain, builder,
    locks: new OwnerLockTable(TTL), issued: new IssuedTxRegistry(TTL * 4),
    lockTtlMs: TTL, now: () => NOW,
  });
  const router: RouterDeps = {
    service, deploymentSource: deployment.source, vaultScopes: deployment.vaults, network: NET,
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { builder, router };
}

const post = (body: Record<string, unknown>) => ({
  method: "POST", url: "/tx/consume", headers: {},
  body: { owner_pkh: OWNER_PKH, op_type: 1, op_count: "1", ...body },
});
const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const detailsOf = (r: { body: unknown }) => (r.body as { error: { details: Record<string, unknown> } }).error.details;
type Checkpoint = { rateBeaconUtxo: UTxO; wakemeVaultUtxo?: UTxO; vaultParams: { rateScriptHash: string } };
const checkpointOf = (b: RecordedTxBuilder) =>
  (b.lastCall!.buildParams as { checkpoint?: Checkpoint }).checkpoint;

describe("POST /tx/consume — lượt đầu epoch làm mới checkpoint (beacon ρ)", () => {
  it("CẶP (a): cap_epoch < e, beacon ρ có trên chuỗi ⟹ 200, bộ dựng nhận đúng beacon ρ", async () => {
    const h = harness({ capEpoch: EPOCH - 1n });
    const r = await handle(post({}), h.router);
    expect(r.status).toBe(200);
    expect(h.builder.lastCall?.route).toBe("consume");
    const cp = checkpointOf(h.builder);
    expect(cp).toBeDefined();
    expect(`${cp!.rateBeaconUtxo.txHash}#${cp!.rateBeaconUtxo.outputIndex}`).toBe(`${RATE_TX}#0`);
    expect(cp!.vaultParams.rateScriptHash).toBe("a1".repeat(28));
    expect(cp!.wakemeVaultUtxo).toBeUndefined();
  });

  it("CẶP (b): cap_epoch < e, beacon ρ VẮNG ⟹ 502 CHAIN_UNAVAILABLE, bộ dựng không được gọi", async () => {
    const h = harness({ capEpoch: EPOCH - 1n, noRate: true });
    const r = await handle(post({}), h.router);
    expect(r.status).toBe(502);
    expect(codeOf(r)).toBe("CHAIN_UNAVAILABLE");
    expect(detailsOf(r).what).toBe("beacon ρ (RHO)");
    expect(h.builder.lastCall).toBeNull();
  });

  it("đối chứng: cùng epoch (cap_epoch = e), beacon ρ vắng ⟹ vẫn 200, KHÔNG có checkpoint", async () => {
    const h = harness({ capEpoch: EPOCH, noRate: true });
    const r = await handle(post({}), h.router);
    expect(r.status).toBe(200);
    expect(checkpointOf(h.builder)).toBeUndefined();
  });
});

describe("POST /tx/consume — `wakeme_vault_ref` khi két đang ghim két Wakeme", () => {
  // Bản trước của ca (a) đặt két Wakeme TRÊN chuỗi rồi đòi 400 — đúng với hợp đồng cũ (vắng
  // `wakeme_vault_ref` là lỗi). Hợp đồng nay tự định vị theo NFT `(wakeme_vault_hash, wakeme_link)`
  // (`service.ts` ▸ `wakemeSource`), nên 400 chỉ còn đúng khi định vị ra 0 két mà lượt này đòi két.
  it("CẶP (a): wakeme_link khác rỗng, THIẾU wakeme_vault_ref, KHÔNG két nào trên chuỗi ⟹ 400 WAKEME_VAULT_REF_REQUIRED", async () => {
    const h = harness({ capEpoch: EPOCH - 1n, wakemeLink: OWNER_COMMIT, withWakeme: false });
    const r = await handle(post({}), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("WAKEME_VAULT_REF_REQUIRED");
    expect(detailsOf(r).wakeme_link).toBe(OWNER_COMMIT);
    expect(detailsOf(r).located_count).toBe(0);
    expect(h.builder.lastCall).toBeNull();
  });

  it("CẶP (a'): cùng két, THIẾU wakeme_vault_ref, két Wakeme CÓ trên chuỗi ⟹ 200, tự định vị (source located)", async () => {
    const h = harness({ capEpoch: EPOCH - 1n, wakemeLink: OWNER_COMMIT, withWakeme: true });
    const r = await handle(post({}), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const cp = checkpointOf(h.builder);
    expect(`${cp!.wakemeVaultUtxo!.txHash}#${cp!.wakemeVaultUtxo!.outputIndex}`).toBe(WAKEME_REF);
    expect((r.body as { summary: { wakeme: { source?: string; ref?: string } } }).summary.wakeme)
      .toMatchObject({ source: "located", ref: WAKEME_REF });
  });

  it("CẶP (b): cùng két, CÓ wakeme_vault_ref ⟹ 200, két Wakeme + beacon ρ đi xuống bộ dựng", async () => {
    const h = harness({ capEpoch: EPOCH - 1n, wakemeLink: OWNER_COMMIT, withWakeme: true });
    const r = await handle(post({ wakeme_vault_ref: WAKEME_REF }), h.router);
    expect(r.status).toBe(200);
    const cp = checkpointOf(h.builder);
    expect(`${cp!.wakemeVaultUtxo!.txHash}#${cp!.wakemeVaultUtxo!.outputIndex}`).toBe(WAKEME_REF);
    expect(cp!.rateBeaconUtxo.txHash).toBe(RATE_TX);
    expect((r.body as { summary: { wakeme?: unknown } }).summary.wakeme).toBeDefined();
  });
});
