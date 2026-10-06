// VaultTxAPI/tests/scheduleCommitConfig.test.ts — cổng cấu hình của `POST /tx/schedule-commit`
// (Gen v2.0): nhánh ký của két Schedule uỷ cho validator withdraw-zero `commit`, nên bản deploy
// phải khai `ref_script_utxos.commit`.
//
// CẶP chỉ khác đúng một khoá: có `commit` ⟹ 200; bỏ `commit` ⟹ 501 `CONFIG_MISSING` với
// `details.missing = "deployment.ref_script_utxos.commit"`, bộ dựng KHÔNG được gọi. Kèm ca bỏ
// `gb_shard` để hai cổng không che nhau (cả hai cùng một mã, khác `details.missing`).

import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../src/txBuilder.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { ENGAGE_ADDRESS } from "./fixtures/engage.js";
import { GEN_V2_REF_SCRIPTS, genV2Chain, genV2Json } from "./fixtures/genV2.js";
import { buildTxCbor } from "./fixtures/tx.js";

const TTL = 180_000;
const NOW = 1_789_100_703_000;
const LAMBDA = 7_000_000n;
const TIP: ChainTip = {
  blockHeight: 4_651_976,
  blockHash: "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f",
  blockTimePosixMs: BigInt(NOW),
};

type RefKey = keyof typeof GEN_V2_REF_SCRIPTS;

function deployment(drop?: RefKey) {
  const refs: Record<string, string> = {
    vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
    ...GEN_V2_REF_SCRIPTS,
  };
  if (drop !== undefined) delete refs[drop];
  return parseDeployment(JSON.stringify({
    source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    vaults: [{ vault_type: "Schedule", address: VAULT_ADDRESS }],
    shard_address: SHARD_ADDRESS,
    ref_script_utxos: refs,
    gen_v2: genV2Json("Preview"),
    consume: {
      engage_address: ENGAGE_ADDRESS,
      price_beacon_address: VAULT_ADDRESS,
      price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
    },
  }), "Preview");
}

/** Giao dịch khoá 3 × λ — datum Schedule 19 trường. */
function commitTxCbor(): string {
  return buildTxCbor({
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    feeLovelace: 178_000n,
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({ lampLockedOildrop: 3n * LAMBDA, genScheduleCount: 1 }),
      },
      { address: enterpriseAddressOf("Preview", OWNER_PKH), assets: { lovelace: 9_400_000n } },
    ],
  });
}

function harness(drop?: RefKey) {
  const d = deployment(drop);
  const chain = new RecordedChainReader({
    [VAULT_ADDRESS]: [{
      txHash: INPUT_TX_HASH, outputIndex: 0, address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      datum: datumHex({ lampLockedOildrop: 0n }),
    }],
    ...genV2Chain("Preview", { epoch: 20_707n }),
  }, TIP, []);
  const builder = new RecordedTxBuilder({ schedule_commit: commitTxCbor() });
  const service = new VaultTxService({
    network: "Preview", deployment: d, chain, builder,
    locks: new OwnerLockTable(TTL), issued: new IssuedTxRegistry(),
    lockTtlMs: TTL, now: () => NOW,
  });
  const router: RouterDeps = {
    service, deploymentSource: d.source, vaultScopes: d.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { builder, router, deployment: d };
}

const post = () => ({
  method: "POST", url: "/tx/schedule-commit", headers: {},
  body: { owner_pkh: OWNER_PKH, schedule_length: "3", lamp_per_epoch: LAMBDA.toString() },
});
const errOf = (r: { body: unknown }) =>
  (r.body as { error: { code: string; details: Record<string, unknown> } }).error;

describe("POST /tx/schedule-commit — ref-script `commit` (Gen v2.0)", () => {
  it("CẶP (a): bản deploy CÓ `ref_script_utxos.commit` ⟹ 200, bộ dựng được gọi", async () => {
    const h = harness();
    expect(h.deployment.refScriptUtxos.commit).toBeDefined();
    const r = await handle(post(), h.router);
    expect(r.status).toBe(200);
    expect(h.builder.lastCall?.route).toBe("schedule_commit");
  });

  it("CẶP (b): bỏ ĐÚNG khoá `commit` ⟹ 501 CONFIG_MISSING, details.missing đúng, không dựng", async () => {
    const h = harness("commit");
    expect(h.deployment.refScriptUtxos.commit).toBeUndefined();
    const r = await handle(post(), h.router);
    expect(r.status).toBe(501);
    expect(errOf(r).code).toBe("CONFIG_MISSING");
    expect(errOf(r).details.missing).toBe("deployment.ref_script_utxos.commit");
    expect(errOf(r).details.route).toBe("/tx/schedule-commit");
    expect(h.builder.lastCall).toBeNull();
  });

  it("bỏ `gb_shard` (giữ `commit`) ⟹ 501 CONFIG_MISSING nêu đúng `gb_shard`", async () => {
    const h = harness("gb_shard");
    const r = await handle(post(), h.router);
    expect(r.status).toBe(501);
    expect(errOf(r).details.missing).toBe("deployment.ref_script_utxos.gb_shard");
    expect(h.builder.lastCall).toBeNull();
  });
});
