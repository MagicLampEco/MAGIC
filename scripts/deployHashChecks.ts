// scripts/deployHashChecks.ts — "tính + so" của các bước deploy KHÔNG có seed one-shot riêng
// (05 két Instant · 07 két Schedule · 09 chuỗi consume · 10 cặp Prepaid).
//
// Mỗi hàm dựng script qua ĐÚNG hàm apply mà bước deploy và `clusterHashes.ts` dùng
// (`deployParams.ts`), rồi so mọi hash nó ra với tệp kỳ vọng (`deploySeeds.ts` ▸
// `checkExpectedHashes`) — lệch hoặc tệp thiếu tên ⟹ ném. Bước deploy gọi hàm này TRƯỚC mọi giao
// dịch, nên phép so không nằm chìm trong `main()` nơi không bài kiểm nào với tới:
// `test_deploy_hash_checks.ts` gọi thẳng từng hàm với một tệp kỳ vọng sai một tên.
//
// Hai bước còn lại có hàm cùng vai nằm cạnh phần tính của chúng: bước 03 ▸ `shardStepChecked`
// (`deploy/03_deploy_shards.ts`), bước 11 ▸ `beaconScriptsChecked` + `registryHashesChecked`
// (`deploy/11_deploy_gen_beacons.ts`).
//
// Thuần: blueprint đã nạp + tham số + tệp kỳ vọng; không đọc env, đĩa hay mạng.

import type { Blueprint } from "./applyParams.js";
import { appliedScript, findValidator } from "./applyParams.js";
import {
  consumeScriptChain, instantVaultParams, prepaidScriptPair, scheduleScriptPair,
  type ConsumeScriptChain, type ConsumeScriptChainInputs, type InstantVaultParamInputs,
  type PaidFundParamInputs, type PrepaidScriptPair, type ScheduleScriptPair, type ScheduleScriptParamInputs,
} from "./deployParams.js";
import { checkExpectedHashes, type ExpectedHashes } from "./deploySeeds.js";
import type { VaultKind } from "./consumeBook.js";
import type { Validator } from "@lucid-evolution/lucid";

type Log = (line: string) => void;

/** Bước 05: két InstantGen. So `vault_instant`. */
export function instantVaultChecked(
  bp: Blueprint, i: InstantVaultParamInputs, expected: ExpectedHashes | undefined, log: Log = console.log,
): { script: Validator; hash: string } {
  const v = appliedScript(findValidator(bp, "vault.vault.spend"), instantVaultParams(i));
  checkExpectedHashes("bước 05", { vault_instant: v.hash }, expected, log);
  return v;
}

/** Bước 07: cặp `commit` → két ScheduleGen. So `shard_nft` (policy đọc từ sổ, do bước 03 đúc)
 *  cùng `commit` · `vault_schedule`: so cả policy shard để một sổ mang `SHARD_NFT_POLICY_ID` của
 *  đời khác lộ ra ở đúng tên của nó, không chỉ ở hash két. */
export function scheduleVaultChecked(
  bp: Blueprint, i: ScheduleScriptParamInputs, expected: ExpectedHashes | undefined, log: Log = console.log,
): ScheduleScriptPair {
  const pair = scheduleScriptPair(bp, i);
  checkExpectedHashes("bước 07", {
    shard_nft: i.shardPolicyId,
    commit: pair.commitHash,
    vault_schedule: pair.vaultHash,
  }, expected, log);
  return pair;
}

/** Bước 09: chuỗi price_nft → price_param → consume của MỘT loại két. */
export function consumeChainChecked(
  bp: Blueprint, kind: VaultKind, i: ConsumeScriptChainInputs, expected: ExpectedHashes | undefined, log: Log = console.log,
): ConsumeScriptChain {
  const ch = consumeScriptChain(bp, i);
  checkExpectedHashes(`bước 09 (${kind})`, {
    [`price_nft_${kind}`]: ch.priceNftPolicy,
    [`price_param_${kind}`]: ch.priceParamHash,
    [`consume_${kind}`]: ch.consumeHash,
  }, expected, log);
  return ch;
}

/** Bước 10: cặp `paid_fund` → két Prepaid. So `paid_fund` · `vault_prepaid`. */
export function prepaidPairChecked(
  bp: Blueprint, i: PaidFundParamInputs, expected: ExpectedHashes | undefined, log: Log = console.log,
): PrepaidScriptPair {
  const pair = prepaidScriptPair(bp, i);
  checkExpectedHashes("bước 10", { paid_fund: pair.fundHash, vault_prepaid: pair.vaultHash }, expected, log);
  return pair;
}
