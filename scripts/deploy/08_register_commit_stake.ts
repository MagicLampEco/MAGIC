// scripts/deploy/08_register_commit_stake.ts — Đăng ký stake credential của validator
// withdraw-zero `commit` (ScheduleGen Gen v2.0). MỘT LẦN mỗi cụm (mỗi bản `commit` đã apply).
// Run: npx tsx deploy/08_register_commit_stake.ts
// Prereq: cùng bộ khoá mà bước 07 đọc (01 LAMP · 11 pha `beacons` · 03 Shards).
//
// Vì sao cần: nhánh ký của két ScheduleGen v2.0 uỷ cho `commit` qua một mục rút 0 từ reward
// address của nó. Ledger chỉ nhận mục rút từ reward address ĐÃ đăng ký ⟹ chưa chạy bước này thì
// MỌI tx ký của MỌI két bị ledger bác ở phase-1, trước khi script nào chạy — và UPLC chạy thử
// cục bộ vẫn xanh, nên lỗi chỉ lộ lúc nộp.
//
// Tx dựng bằng gói nền: `ScheduleGen/offchain/src/schedule.ts` ▸ `buildRegisterCommitStakeTx`
// (chứng chỉ đăng ký kiểu cũ, không chạy `publish` — lý do ở chú thích hàm đó). Tiền cọc stake
// key (2 ADA theo tham số giao thức hiện hành) bị khoá trong chứng chỉ.
//
// IDEMPOTENT: đã đăng ký thì bỏ qua, không dựng tx. Trạng thái đăng ký đọc bằng một đầu dò
// TRẢ LỜI CÓ/KHÔNG, không bằng `getDelegation`: `getDelegation` của Lucid trả
// `{poolId: null, rewards: 0}` cho CẢ ca chưa đăng ký lẫn ca đã đăng ký chưa uỷ quyền, nên nó
// không phân biệt được đúng hai ca cần phân biệt. Blockfrost: `/accounts/{stake}` — 404 ⟹ chưa
// từng thấy; 200 ⟹ trường `active` (boolean). Hình dạng khác ⟹ NÉM, không đoán.
//
// Env:
//   DRY_RUN=1 — hỏi trạng thái, DỰNG tx nếu cần để đo; KHÔNG ký, KHÔNG gửi.
//
// Không ghi khoá sổ nào: reward address suy lại được từ hash `commit` (in ra để đối chiếu), và
// trạng thái đăng ký là của chuỗi, không phải của sổ — một dòng sổ "đã đăng ký" sẽ già đi mà
// không gì báo (vd. sau một lần huỷ đăng ký).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Lucid, Blockfrost, validatorToRewardAddress, validatorToScriptHash,
  type LucidEvolution, type Network, type Validator,
} from "@lucid-evolution/lucid";
import { parseFlag, assertTxHash } from "../runResult.js";
import { loadBlueprint } from "../applyParams.js";
import { scheduleScriptPair, genV2BeaconRefsFromBook } from "../deployParams.js";
import { buildRegisterCommitStakeTx } from "../../ScheduleGen/offchain/src/schedule.js";

/** Trả lời đúng một câu: reward address này ĐANG đăng ký trên chuỗi không. */
export type StakeRegistrationProbe = (rewardAddress: string) => Promise<boolean>;

export function blockfrostStakeProbe(url: string, projectId: string): StakeRegistrationProbe {
  return async (rewardAddress) => {
    const res = await fetch(`${url}/accounts/${rewardAddress}`, { headers: { project_id: projectId } });
    if (res.status === 404) return false;   // chưa từng xuất hiện trên chuỗi
    if (!res.ok) throw new Error(`Blockfrost /accounts/${rewardAddress} trả HTTP ${res.status} — không kết luận được trạng thái đăng ký.`);
    const body = await res.json() as { active?: unknown };
    if (typeof body.active !== "boolean") {
      throw new Error(`Blockfrost /accounts/${rewardAddress}: trường \`active\` không phải boolean (${JSON.stringify(body.active)}).`);
    }
    return body.active;
  };
}

export type RegisterCommitStakeOutcome =
  | { status: "already-registered"; rewardAddress: string; commitHash: string }
  | { status: "dry-run"; rewardAddress: string; commitHash: string; txBytes: number }
  | { status: "registered"; rewardAddress: string; commitHash: string; txBytes: number; txHash: string };

/** Lõi của bước: hỏi trạng thái → bỏ qua, hoặc dựng + (không dry run) ký, gửi, chờ. */
export async function registerCommitStake(i: {
  lucid: LucidEvolution; network: Network; commitScript: Validator;
  isRegistered: StakeRegistrationProbe; dryRun: boolean;
}): Promise<RegisterCommitStakeOutcome> {
  // Hỏi TRƯỚC khi dựng: đã đăng ký thì không cần ví có tiền, không cần dựng gì.
  const rewardAddress = validatorToRewardAddress(i.network, i.commitScript);
  const commitHash = validatorToScriptHash(i.commitScript);
  if (await i.isRegistered(rewardAddress)) return { status: "already-registered", rewardAddress, commitHash };

  // Gói nền khai `Network` từ bản Lucid của CHÍNH nó — cùng tập chuỗi, khác định danh kiểu.
  type BaseNetwork = NonNullable<Parameters<typeof buildRegisterCommitStakeTx>[0]["network"]>;
  const built = await buildRegisterCommitStakeTx({ lucid: i.lucid, commitScript: i.commitScript, network: i.network as BaseNetwork });
  // Địa chỉ đã hỏi và địa chỉ gói nền đăng ký phải là MỘT — lệch là đầu dò đã hỏi nhầm chỗ.
  if (built.rewardAddress !== rewardAddress || built.commitScriptHash !== commitHash) {
    throw new Error(`Reward address lệch: đã hỏi ${rewardAddress}, gói nền đăng ký ${built.rewardAddress}.`);
  }
  const txBytes = built.tx.toCBOR().length / 2;
  if (i.dryRun) return { status: "dry-run", rewardAddress, commitHash, txBytes };
  const signed = await built.tx.sign.withWallet().complete();
  const txHash = assertTxHash(await signed.submit(), "submit()");
  await i.lucid.awaitTx(txHash);
  return { status: "registered", rewardAddress, commitHash, txBytes, txHash };
}

async function main() {
  const dryRun = parseFlag(process.env.DRY_RUN, "DRY_RUN");
  const beacons = genV2BeaconRefsFromBook(process.env);
  const {
    NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, POLICY_IDS, ASSET_NAMES, PROTOCOL,
  } = await import("../config.js");
  console.log(`=== Step 8: Đăng ký stake credential \`commit\` (ScheduleGen v2.0)${dryRun ? " · DRY RUN" : ""} ===\n`);
  if (!/^[0-9a-f]{56}$/.test(POLICY_IDS.shard_nft)) {
    throw new Error(`Step 03 chưa chạy: SHARD_NFT_POLICY_ID phải là 56 ký tự hex, nhận "${POLICY_IDS.shard_nft}".`);
  }
  const pair = scheduleScriptPair(await loadBlueprint("ScheduleGen"), {
    lampPolicyId: POLICY_IDS.lamp, lampAssetName: ASSET_NAMES.lamp,
    shardPolicyId: POLICY_IDS.shard_nft, msPerEpoch: PROTOCOL.MS_PER_EPOCH, ...beacons,
  });
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const r = await registerCommitStake({
    lucid, network: NETWORK, commitScript: pair.commitScript,
    isRegistered: blockfrostStakeProbe(BLOCKFROST_URL, BLOCKFROST_KEY), dryRun,
  });
  console.log(`Commit script hash: ${r.commitHash}`);
  console.log(`Reward address:     ${r.rewardAddress}`);
  switch (r.status) {
    case "already-registered": console.log(`\n✓ Đã đăng ký — không làm gì.`); break;
    case "dry-run":            console.log(`\n✔ DRY RUN: tx đăng ký dựng được (${r.txBytes} byte chưa ký). Không ký, không gửi.`); break;
    case "registered":         console.log(`\n✅ Đã đăng ký. TX hash: ${r.txHash} (${r.txBytes} byte)`); break;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
