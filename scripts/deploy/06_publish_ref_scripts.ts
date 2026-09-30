// scripts/deploy/06_publish_ref_scripts.ts — Công bố script tham chiếu (CIP-33) ScheduleGen Gen v2.0.
// Run: npx tsx deploy/06_publish_ref_scripts.ts
// Prereq: 01 LAMP · 11 pha `beacons` · 03 Shards (cùng bộ khoá mà bước 07 đọc).
//
// Vì sao BẮT BUỘC, không phải tối ưu: ScheduleCommit/ScheduleFire tiêu HAI UTxO script (vault +
// shard), và v2.0 thêm validator withdraw-zero `commit` cùng shard GB vào tx ký. Đính kèm các
// validator vào tx vượt trần giao thức 16.384 byte ⟹ đưa script lên chain một lần rồi `readFrom`.
//
// BA ref-script, MỖI CÁI MỘT TX (`refScripts.ts ▸ publishRefScript`): két SG ~12,5 KB, `commit`
// ~9,5 KB — gộp hai cái đã vượt trần. Kích thước từng tx đo ở `scripts/test_deploy_gen_v2.ts`.
//
// Bãi đỗ và phép công bố nằm ở `scripts/refScripts.ts` — dùng chung với bước 05/09/11.
// Chạy được nhiều lần: chỉ công bố cái nào chưa có mặt ở địa chỉ đỗ.
//
// Env:
//   DRY_RUN=1 — tính hash, kiểm cái nào đã đỗ (đọc bãi đỗ), DỰNG tx cho cái còn thiếu để đo
//               kích thước; KHÔNG ký, KHÔNG gửi, KHÔNG in dòng cho sổ.
//
// In ra (sổ): REF_VAULT_SCHEDULE_UTXO, REF_SHARD_UTXO, REF_COMMIT_SCHEDULE_UTXO — `txHash#index`.
// Tên khoá `REF_COMMIT_SCHEDULE_UTXO` ghim bằng KIỂU vào `gen_vault_tx_api_deployment.ts` ▸
// `SCHEDULE_ONLY_STATE_KEYS` (bộ sinh deployment đòi nó); đổi tên ở nguồn ⟹ gãy lúc typecheck.
//
// PHẠM VI: chỉ ScheduleGen. Vault InstantGen công bố ở bước 05, `consume` ở bước 09, `gb_shard`
// ở bước 11 — bước nào tính ra hash thì bước đó công bố.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Lucid, Blockfrost, validatorToScriptHash, type Validator } from "@lucid-evolution/lucid";
import { parkAddressFor, publishRefScript } from "../refScripts.js";
import { minAdaForRefScriptWithMargin } from "../minAda.js";
import { parseFlag } from "../runResult.js";
import { loadBlueprint, findValidator, appliedScript, type Blueprint } from "../applyParams.js";
import {
  scheduleScriptPair, shardSpendParams, genV2BeaconRefsFromBook, type ScheduleScriptParamInputs,
} from "../deployParams.js";
import type { SCHEDULE_ONLY_STATE_KEYS } from "../gen_vault_tx_api_deployment.js";

/** Khoá sổ của từng ref-script. `REF_COMMIT_SCHEDULE_UTXO` ghim vào bảng của bộ sinh. */
export const REF_COMMIT_KEY = "REF_COMMIT_SCHEDULE_UTXO" as const satisfies keyof typeof SCHEDULE_ONLY_STATE_KEYS;

export interface RefScriptPlanItem { label: string; bookKey: string; script: Validator; hash: string }

/** Ba ref-script ScheduleGen v2.0 theo thứ tự công bố. Thuần: blueprint đã nạp + tham số. */
export function scheduleRefScriptPlan(bp: Blueprint, i: ScheduleScriptParamInputs): RefScriptPlanItem[] {
  const pair = scheduleScriptPair(bp, i);
  const shard = appliedScript(
    findValidator(bp, "vault.shard.spend"),
    shardSpendParams({ shardPolicyId: i.shardPolicyId, vaultScriptHash: pair.vaultHash }),
  );
  return [
    { label: "vault ref",  bookKey: "REF_VAULT_SCHEDULE_UTXO", script: pair.vaultScript,  hash: pair.vaultHash },
    { label: "shard ref",  bookKey: "REF_SHARD_UTXO",          script: shard.script,      hash: shard.hash },
    { label: "commit ref", bookKey: REF_COMMIT_KEY,            script: pair.commitScript, hash: pair.commitHash },
  ];
}

async function main() {
  const dryRun = parseFlag(process.env.DRY_RUN, "DRY_RUN");
  const beacons = genV2BeaconRefsFromBook(process.env);   // thiếu ⟹ ném nêu tên khoá
  const {
    NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, POLICY_IDS, ASSET_NAMES, PROTOCOL,
  } = await import("../config.js");
  console.log(`=== Step 6: Công bố script tham chiếu ScheduleGen v2.0 (CIP-33)${dryRun ? " · DRY RUN" : ""} ===\n`);
  if (!/^[0-9a-f]{56}$/.test(POLICY_IDS.shard_nft)) {
    throw new Error(`Step 03 chưa chạy: SHARD_NFT_POLICY_ID phải là 56 ký tự hex, nhận "${POLICY_IDS.shard_nft}".`);
  }

  const plan = scheduleRefScriptPlan(await loadBlueprint("ScheduleGen"), {
    lampPolicyId:  POLICY_IDS.lamp,
    lampAssetName: ASSET_NAMES.lamp,
    shardPolicyId: POLICY_IDS.shard_nft,
    msPerEpoch:    PROTOCOL.MS_PER_EPOCH,
    ...beacons,
  });

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const parkAddr = parkAddressFor(NETWORK, await lucid.wallet().address());
  console.log(`Network:      ${NETWORK}`);
  for (const p of plan) console.log(`${p.label.padEnd(12)} ${p.hash} (script ${p.script.script.length / 2} byte)`);
  console.log(`Bãi đỗ:       ${parkAddr}\n`);

  // Lấy MỘT lần rồi truyền vào từng lượt: script vừa đỗ chưa kịp index thì truy vấn lại
  // cũng không mới hơn.
  const parked = await lucid.utxosAt(parkAddr);
  const out: [string, string][] = [];
  for (const p of plan) {
    // min-ADA TÍNH từ chính script đã apply-param, không gõ cứng (`scripts/minAda.ts`).
    const lovelace = minAdaForRefScriptWithMargin(p.script.script);
    console.log(`min-ADA ${p.label}: ${lovelace / 1_000_000n} ADA`);
    if (dryRun) {
      const have = parked.find((u) => u.scriptRef && validatorToScriptHash(u.scriptRef) === p.hash);
      if (have) { console.log(`  ✓ đã đỗ: ${have.txHash}#${have.outputIndex}`); continue; }
      const tx = await lucid.newTx().pay.ToAddressWithData(parkAddr, undefined, { lovelace }, p.script).complete();
      console.log(`  (dry run) tx công bố dựng được: ${tx.toCBOR().length / 2} byte chưa ký — không gửi`);
      continue;
    }
    out.push([p.bookKey, await publishRefScript({ lucid, parkAddr, label: p.label, script: p.script, hash: p.hash, lovelace, parked })]);
  }
  if (dryRun) { console.log(`\n✔ DRY RUN: không ký, không gửi, không in dòng cho sổ.`); return; }

  console.log("\n── nạp vào env ──");
  for (const [k, v] of out) console.log(`   ${k}=${v}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
