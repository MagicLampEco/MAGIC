// scripts/deploy/03_deploy_shards.ts — Deploy 16 Shard UTxOs for ScheduleGen.
// Run: npx tsx deploy/03_deploy_shards.ts
// Prereq: 01 LAMP · 11 pha `beacons` (RATE_PARAM_HASH, GREENBACK_BEACON_HASH, GB_SHARD_HASH).
// Env tuỳ chọn (`deploySeeds.ts`): DEPLOY_SEED_SHARD_NFT=<tx>#<ix> — seed `shard_nft` cho trước
// (ở bãi đỗ của ví; ở ví thì chỉ nhận khi KHÔNG có DEPLOY_EXPECT_HASHES; đã tiêu / chỗ khác / trùng
// seed vai khác / trùng seed sổ két đã ghi ⟹ ném). DEPLOY_EXPECT_HASHES=<tệp JSON> — so
// shard_nft · commit · vault_schedule · shard_schedule, lệch ⟹ ném trước khi nộp. Có seed mà vắng
// tệp ⟹ ném, trừ DEPLOY_EXPECT_NONE=1. Vắng cả hai ⟹ như cũ.
//
// ── Gen v2.0 ──────────────────────────────────────────────────────────────
// `shard.spend` nhận `vault_script_hash` của két ScheduleGen, và két v2.0 nhận hash của
// `commit` ĐÃ apply — `commit` lại nướng ba hash GenBeacons. Nên hash shard mà bước này ghi
// ra (`SHARD_HASH`) phụ thuộc cả ba khoá GenBeacons trong sổ: tính két theo đời v1 (4 tham
// số) là ghi ra một shard mà bước 06 KHÔNG công bố và bước 07 KHÔNG tiêu được. Hàm thuần
// `scheduleShardScript` dưới đây dựng qua đúng `scheduleScriptPair` mà 06/07 dùng; bài
// `scripts/test_deploy_gen_v2.ts` (E) ghim hash của nó TRÙNG hash shard trong kế hoạch 06.
//
// ── MAINNET-BLOCK fix ─────────────────────────────────────────────────────
// The shard NFT policy is now a ONE-SHOT Aiken minting policy (shard_nft.ak),
// parameterized by a genesis OutputReference consumed in this tx. It mints
// EXACTLY 16 NFTs, one per DISTINCT asset name `SHARD#0..SHARD#15`
// (= "SHARD" ∥ byte(id)). The policy can never run again, so the cap-pinning
// shard UTxOs are unforgeable. The previous native `sig` policy (re-mintable,
// single shared "SHARD" name) is removed entirely.
//
// The SAME one-shot policy id is applied to the vault in
// 07_create_schedule_vault.ts (vault takes shard_policy_id). Từ 2026-09-07 shard
// nhận NGƯỢC lại `vault_script_hash` — vẫn KHÔNG có vòng, vì chuỗi đi một chiều:
//   shard_nft(genesis_ref) → shard_policy_id → vault(…) → vault_script_hash → shard(…)
// Câu cũ ở đây ("the shard validator does NOT take the vault hash") nay SAI.

import { windowOf } from "@magiclamp/protocol-utils";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Lucid, Blockfrost, Data,
  credentialToAddress, scriptHashToCredential, mintingPolicyToId,
  type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import {
  loadBlueprint, findValidator, appliedScript, appliedValidator, type Blueprint,
} from "../applyParams.js";
import {
  oneShotGenesisParams, shardSpendParams, scheduleScriptPair, genV2BeaconRefsFromBook,
  type ScheduleScriptParamInputs,
} from "../deployParams.js";
import {
  assertDistinctPresetSeeds, checkExpectedHashes, loadExpectedHashes, parkFor, presetSeedAllowWallet,
  readPresetSeed, REGISTRY_SEED_BOOK_KEY, requireExpectInPresetMode, requirePresetForExpect,
  resolvePresetSeed, SEED_ENV, spendsParkedSeed, type ExpectedHashes, type Park,
} from "../deploySeeds.js";
import { readBookEntries } from "./11_deploy_gen_beacons.js";
import { stateBookPath } from "../stateBookPath.js";

// Lược đồ datum shard lấy từ gói ScheduleGen, KHÔNG chép tại chỗ. Bản chép cũ ở đây dừng ở 7
// trường khi Gen v2.0 nối `shard_obligation_nanogic` (8 trường), và nó hỏng ồn ở `shard_nft`
// (`all_shards_start_clean` giải mã datum ⟹ "unexpected empty list") — đo 2026-09-30 trên Preprod,
// lúc dựng tx, trước khi gửi.
import { ScheduleShardDatum as ShardDatum } from "../../ScheduleGen/offchain/src/types.js";

// shard_asset_name(id) = "SHARD" (5348415244) ∥ single byte 0x00..0x0f.
function shardAssetName(shardId: number): string {
  return "5348415244" + shardId.toString(16).padStart(2, "0");
}

export interface ScheduleShardScript {
  shardScript: Validator; shardHash: string;
  vaultHash:   string;    // két ScheduleGen v2.0 mà shard này ghim (tham số #2)
  commitHash:  string;    // `commit` ĐÃ apply mà két trên nướng vào — để so với hash tính trước
}

/** `shard.spend` applied cho một bộ tham số ScheduleGen v2.0. Thuần: blueprint đã nạp
 *  (`loadBlueprint("ScheduleGen")`) + tham số, không đọc đĩa, env hay mạng.
 *
 *  Hash két lấy từ `scheduleScriptPair` — cùng hàm mà 06 (`scheduleRefScriptPlan`) và 07
 *  dùng — chứ không tự apply `vault.vault.spend`: nửa két cần hash `commit` ĐÃ apply, và tự
 *  dựng lại chuỗi đó ở đây là mở một đường thứ hai lệch được với 06. */
export function scheduleShardScript(bp: Blueprint, i: ScheduleScriptParamInputs): ScheduleShardScript {
  const { vaultHash, commitHash } = scheduleScriptPair(bp, i);
  const { script, hash } = appliedScript(
    findValidator(bp, "vault.shard.spend"),
    shardSpendParams({ shardPolicyId: i.shardPolicyId, vaultScriptHash: vaultHash }),
  );
  return { shardScript: script, shardHash: hash, vaultHash, commitHash };
}

/** Policy `shard_nft` one-shot cho một seed. Thuần — dùng chung với `clusterHashes.ts`. */
export function shardNftPolicyFor(bp: Blueprint, seed: { txHash: string; outputIndex: number }): { policy: Validator; policyId: string } {
  const policy = appliedValidator(
    findValidator(bp, "shard_nft.shard_nft.mint"),
    oneShotGenesisParams({ txHash: seed.txHash, outputIndex: seed.outputIndex }),
  );
  return { policy, policyId: mintingPolicyToId(policy) };
}

/** "Tính + so" của bước 03: policy `shard_nft` từ seed, rồi cặp két ScheduleGen + `shard.spend`
 *  trên policy đó; so bốn hash với tệp kỳ vọng, lệch ⟹ ném. Thuần — `main` gọi nó TRƯỚC khi dựng
 *  tx đúc, và `test_deploy_hash_checks.ts` gọi thẳng để ghim phép so. */
export function shardStepChecked(
  bp: Blueprint,
  seed: { txHash: string; outputIndex: number },
  i: Omit<ScheduleScriptParamInputs, "shardPolicyId">,
  expected: ExpectedHashes | undefined,
  log: (line: string) => void = console.log,
): ScheduleShardScript & { shardNftPolicy: Validator; shardNftPolicyId: string } {
  const { policy, policyId } = shardNftPolicyFor(bp, seed);
  const sched = scheduleShardScript(bp, { ...i, shardPolicyId: policyId });
  checkExpectedHashes("bước 03", {
    shard_nft: policyId,
    commit: sched.commitHash,
    vault_schedule: sched.vaultHash,
    shard_schedule: sched.shardHash,
  }, expected, log);
  return { ...sched, shardNftPolicy: policy, shardNftPolicyId: policyId };
}

async function main() {
  // Đọc sổ TRƯỚC khi nạp cấu hình mạng: thiếu khoá GenBeacons ⟹ ném nêu tên khoá, không
  // tiêu seed nào (bước này đúc policy one-shot — chạy hỏng giữa chừng là mất seed).
  const beacons = genV2BeaconRefsFromBook(process.env);
  // Seed cho trước (`DEPLOY_SEED_SHARD_NFT`) + hash kỳ vọng (`DEPLOY_EXPECT_HASHES`) —
  // `deploySeeds.ts`. Vắng seed ⟹ hành vi cũ: `utxos[0]` của ví.
  const presetSeed   = readPresetSeed(process.env, "shardNft");
  const expectHashes = loadExpectedHashes(process.env);
  requirePresetForExpect("bước 03", expectHashes, presetSeed !== undefined, [SEED_ENV.shardNft]);
  requireExpectInPresetMode("bước 03", process.env, expectHashes);
  const {
    NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, PROTOCOL, POLICY_IDS, ASSET_NAMES,
  } = await import("../config.js");
  console.log("=== Step 3: Deploy 16 Shard UTxOs (one-shot NFT policy) ===\n");
  // Seed khác vai phải khác outref, và seed `shard_nft` không được là seed sổ két đang chờ pha
  // registry (đọc cả sổ lẫn env) — tiêu nó ở đây là sổ két không bao giờ đúc được nữa.
  assertDistinctPresetSeeds(process.env, [
    ...readBookEntries(stateBookPath(NETWORK)).filter((e) => e.key === REGISTRY_SEED_BOOK_KEY).map((e) => e.value),
    ...(process.env[REGISTRY_SEED_BOOK_KEY] ? [process.env[REGISTRY_SEED_BOOK_KEY]!] : []),
  ]);

  // Load ScheduleGen blueprint: shard NFT minting policy + shard spend validator.
  const blueprint         = await loadBlueprint("ScheduleGen");

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();

  // ── Pick a genesis UTxO to consume (one-shot seed) ──────────────────────
  // Seed cho trước: phải còn chưa tiêu, ở ví hoặc bãi đỗ của ví, output trơn — không thì NÉM,
  // không lùi về `utxos[0]` (lùi là ra policy khác policy đã tính trước).
  let genesis: UTxO;
  let parkedSeed: Park | undefined;   // có ⟹ seed nằm ở bãi đỗ này, tx phải gắn witness
  if (presetSeed) {
    const park = parkFor(NETWORK, address);
    const r = await resolvePresetSeed(lucid, park, "shardNft", presetSeed, { allowWallet: presetSeedAllowWallet(expectHashes) });
    genesis = r.utxo;
    if (r.atPark) parkedSeed = park;
  } else {
    const utxos = await lucid.wallet().getUtxos();
    if (utxos.length === 0) throw new Error("Wallet has no UTxOs to seed the one-shot policy");
    genesis = utxos[0]!;
  }

  // Apply genesis ref to the minting policy → fixed policy id.
  // LƯU Ý: tham số phải là Plutus Data DẠNG CẤU TRÚC (Constr 0 [bytes, int]).
  // Bản cũ truyền `Data.to(genesisRef, OutRefSchema)` — tức một CHUỖI HEX CBOR —
  // nên tham số vào script là một ByteArray, không phải OutputReference: mint
  // luôn fail ở `i.output_reference == genesis_ref`.

  // ── THỨ TỰ APPLY: vault TRƯỚC shard, và đây là thứ tự BẮT BUỘC ────────────
  //
  // Từ 2026-09-07 `shard` nhận `vault_script_hash` làm tham số #2, nên phải có
  // hash vault trước khi apply shard. Chuỗi một chiều, không khép vòng (Gen v2.0):
  //   shard_nft(genesis_ref) → shard_policy_id → commit(…) → vault(…, commit_hash)
  //     → vault_script_hash → shard(…)
  // Vault KHÔNG nhận hash của shard. Ai đảo lại sẽ cần hash vault trước khi có nó,
  // và lối thoát duy nhất lúc đó là dựng một giá trị giữ chỗ — `applyParamsToScript`
  // không kiểm arity lẫn nội dung, nên nó vẫn trả về một hash trông hợp lệ.
  //
  // `shard_policy_id` của vault phải là policy VỪA sinh ở trên, KHÔNG phải
  // `POLICY_IDS.shard_nft` trong cấu hình — cái đó là của lần deploy trước. Ba hash
  // GenBeacons thì lấy từ SỔ (`genV2BeaconRefsFromBook`), đúng nguồn mà 06/07 đọc.
  // `shardStepChecked` dựng policy `shard_nft` từ seed rồi cặp két + shard trên policy đó, in bốn
  // hash và — có tệp kỳ vọng — SO, lệch ⟹ ném ở đây, trước khi dựng và nộp tx đúc.
  const {
    shardNftPolicy, shardNftPolicyId, shardScript, shardHash: shardScriptHash, vaultHash: vaultScriptHash,
  } = shardStepChecked(blueprint, genesis, {
    lampPolicyId:  POLICY_IDS.lamp,
    lampAssetName: ASSET_NAMES.lamp,
    msPerEpoch:    PROTOCOL.MS_PER_EPOCH,
    windowOriginMs:    PROTOCOL.WINDOW_ORIGIN_MS,
    ...beacons,
  }, expectHashes);
  const shardScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(shardScriptHash));

  console.log(`Network:              ${NETWORK}`);
  console.log(`Genesis seed UTxO:    ${genesis.txHash}#${genesis.outputIndex}`);
  console.log(`Shard NFT policy:     ${shardNftPolicyId}  (one-shot)`);
  console.log(`Vault (SG v2.0) hash: ${vaultScriptHash}  (đầu vào #2 của shard)`);
  console.log(`Shard script hash:    ${shardScriptHash}  (NFT-policy + vault hash applied)`);
  console.log(`Shard script address: ${shardScriptAddress}`);

  // Tip POSIX ms for current epoch.
  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await tipRes.json() as { slot: number; time: number };
  const tipPosixMs   = BigInt(tip.time) * 1000n;
  const currentEpoch = windowOf(tipPosixMs, PROTOCOL.MS_PER_EPOCH, PROTOCOL.WINDOW_ORIGIN_MS);

  console.log(`Current epoch:        ${currentEpoch}`);
  console.log(`Deploying shards 0-15...\n`);

  // ── Build the mint: 16 distinct NFTs, qty 1 each ────────────────────────
  const shardMints: Record<string, bigint> = {};
  for (let shardId = 0; shardId < PROTOCOL.SHARD_COUNT; shardId++) {
    shardMints[shardNftPolicyId + shardAssetName(shardId)] = 1n;
  }

  // MUST consume the genesis UTxO so the one-shot policy runs. Seed ở bãi đỗ ⟹ gắn witness
  // script native `sig(ví)` (`deploySeeds.ts` ▸ `spendsParkedSeed`).
  let txBuilder = lucid.newTx().collectFrom([genesis]);
  if (parkedSeed) txBuilder = spendsParkedSeed(txBuilder, parkedSeed);

  for (let shardId = 0; shardId < PROTOCOL.SHARD_COUNT; shardId++) {
    // Genesis cap-pin: every shard carries the Constitutional cap. The vault
    // also pins shard_cap == shard_cap on-chain (validate_commit / validate_fire).
    const shardCap = PROTOCOL.SHARD_CAP;
    const shardDatum = Data.to({
      shard_id:                    BigInt(shardId),
      shard_locked_lamp:            0n,
      shard_active_count:           0n,
      shard_cumulative_committed:   0n,
      shard_cumulative_fired:       0n,
      last_updated_epoch:           currentEpoch,
      shard_cap:                    shardCap,
      shard_obligation_nanogic:     0n,   // `shard_nft` ▸ `all_shards_start_clean` ghim = 0
    }, ShardDatum);

    if (shardCap !== PROTOCOL.SHARD_CAP) throw new Error("cap-pin assertion failed");

    const unit = shardNftPolicyId + shardAssetName(shardId);
    txBuilder = txBuilder.pay.ToAddressWithData(
      shardScriptAddress,
      { kind: "inline", value: shardDatum },
      { lovelace: 2_000_000n, [unit]: 1n },
    );

    process.stdout.write(`  Shard ${shardId.toString().padStart(2)}  name=${shardAssetName(shardId)}\n`);
  }

  const tx = await txBuilder
    .mintAssets(shardMints, Data.void())
    .attach.MintingPolicy(shardNftPolicy)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  // Chờ xác nhận: bước sau tiêu chính UTxO thối của tx này. Không chờ thì node
  // vẫn thấy UTxO cũ ⟹ BadInputsUTxO. Chuỗi deploy trước đây không bước nào chờ.
  await lucid.awaitTx(txHash);

  console.log(`\n✅ 16 Shards deployed (one-shot — policy can never re-mint)!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  console.log(`\n📋 Copy to .env:`);
  console.log(`   SHARD_HASH=${shardScriptHash}              # applied for NETWORK=${NETWORK}`);
  console.log(`   SHARD_NFT_POLICY_ID=${shardNftPolicyId}`);
}

// Xem lý do ở `02_deploy_um.ts` cùng đợt vá: mã thoát 0 sau một lỗi làm mọi vòng
// lặp và mọi `set -e` mù đúng ở lượt hỏng.
// Chỉ chạy khi gọi thẳng: bài kiểm import `scheduleShardScript` mà không được chạm mạng/ví.
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
