// scripts/deploy/06_publish_ref_scripts.ts — Công bố script tham chiếu (CIP-33).
// Run: npx tsx deploy/06_publish_ref_scripts.ts
//
// Vì sao BẮT BUỘC, không phải tối ưu: ScheduleCommit/ScheduleFire tiêu HAI UTxO
// script (vault + shard). Đính kèm cả hai validator vào tx làm tx = 17303 byte,
// vượt trần giao thức 16384 — đo thật trên Preview, tx không dựng nổi. Đưa script
// lên chain một lần rồi `readFrom` là đường duy nhất chạy được.
//
// Bãi đỗ và phép công bố nằm ở `scripts/refScripts.ts` — dùng chung với bước 09,
// vì hai bên PHẢI dẫn xuất cùng một địa chỉ bãi đỗ. Ở đó có luôn lý do 🔴 không
// đỗ script ở địa chỉ ví.
//
// Chạy được nhiều lần: chỉ công bố cái nào chưa có mặt ở địa chỉ đỗ.
//
// In ra: REF_VAULT_SCHEDULE_UTXO, REF_SHARD_UTXO — dạng txHash#index.
//
// PHẠM VI: chỉ ScheduleGen. Quy tắc chung của repo là **bước nào tính ra hash thì
// bước đó công bố ref-script**, nên vault InstantGen nằm ở bước 05 và `consume` nằm
// ở bước 09 (hash của consume chỉ tính được sau khi 09 đúc price_nft và price_param).
// Gom hết về đây thì chuỗi e2e consume phải deploy cả shard ScheduleGen mới chạy được
// — một phụ thuộc không có lý do gì tồn tại.

import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { parkAddressFor, publishRefScript } from "../refScripts.js";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, PROTOCOL,
} from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { scheduleVaultParams, shardSpendParams } from "../deployParams.js";

async function main() {
  console.log("=== Step 6: Công bố script tham chiếu ScheduleGen (CIP-33) ===\n");

  const blueprint = await loadBlueprint("ScheduleGen");
  const { script: vaultScript, hash: vaultHash } = appliedScript(
    findValidator(blueprint, "vault.vault.spend"),
    scheduleVaultParams({
      lampPolicyId:  POLICY_IDS.lamp,
      lampAssetName: ASSET_NAMES.lamp,
      shardPolicyId: POLICY_IDS.shard_nft,
      msPerEpoch:    PROTOCOL.MS_PER_EPOCH,
    }),
  );
  const { script: shardScript, hash: shardHash } = appliedScript(
    findValidator(blueprint, "vault.shard.spend"),
    shardSpendParams({ shardPolicyId: POLICY_IDS.shard_nft }),
  );

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const parkAddr = parkAddressFor(NETWORK, await lucid.wallet().address());

  console.log(`Network:      ${NETWORK}`);
  console.log(`Vault hash:   ${vaultHash}`);
  console.log(`Shard hash:   ${shardHash}`);
  console.log(`Bãi đỗ:       ${parkAddr}\n`);

  // Lấy MỘT lần rồi truyền vào từng lượt: mỗi lượt tự truy vấn lại thì tốn ba
  // vòng gọi Blockfrost mà kết quả không mới hơn — script vừa đỗ chưa kịp index.
  const parked = await lucid.utxosAt(parkAddr);
  const publish = (label: string, script: typeof vaultScript, hash: string, lovelace: bigint) =>
    publishRefScript({ lucid, parkAddr, label, script, hash, lovelace, parked });

  const vaultRef = await publish("vault ref", vaultScript, vaultHash, 35_000_000n);
  const shardRef = await publish("shard ref", shardScript, shardHash, 20_000_000n);

  console.log("\n── nạp vào env ──");
  console.log(`   REF_VAULT_SCHEDULE_UTXO=${vaultRef}`);
  console.log(`   REF_SHARD_UTXO=${shardRef}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
