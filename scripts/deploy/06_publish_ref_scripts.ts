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
// In ra: REF_VAULT_SCHEDULE_UTXO, REF_SHARD_UTXO, REF_VAULT_INSTANT_UTXO — dạng
// txHash#index.
//
// VAULT INSTANT ở đây, CONSUME ở bước 09: hash của `consume` chỉ tính được SAU khi
// biết `price_nft_policy` và `price_param_script_hash` — hai thứ do chính bước 09 đúc
// ra. Nên 09 tự công bố ref-script của nó; bước này chỉ lo những script mà tham số đã
// biết từ `config.ts`.

import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { parkAddressFor, publishRefScript } from "../refScripts.js";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, SCRIPT_HASHES, PROTOCOL,
} from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import {
  scheduleVaultParams, shardSpendParams, instantVaultParams,
} from "../deployParams.js";

async function main() {
  console.log("=== Step 6: Công bố script tham chiếu (CIP-33) ===\n");

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

  // Vault InstantGen — tham số PHẢI khớp từng chữ với `05_create_instant_vault.ts`,
  // nếu không thì hash khác ⟹ công bố nhầm một script không ai tiêu được.
  const igBlueprint = await loadBlueprint("InstantGen");
  const { script: igVaultScript, hash: igVaultHash } = appliedScript(
    findValidator(igBlueprint, "vault.vault.spend"),
    instantVaultParams({
      lampPolicyId:      POLICY_IDS.lamp,
      lampAssetName:     ASSET_NAMES.lamp,
      umNftPolicy:       POLICY_IDS.um_nft,
      umScriptHash:      SCRIPT_HASHES.um_datum,
      backingNftPolicy:  POLICY_IDS.backing,
      backingScriptHash: SCRIPT_HASHES.backing_beacon,
      msPerEpoch:        PROTOCOL.MS_PER_EPOCH,
    }),
  );

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const parkAddr = parkAddressFor(NETWORK, await lucid.wallet().address());

  console.log(`Network:            ${NETWORK}`);
  console.log(`Vault Schedule hash:${vaultHash}`);
  console.log(`Shard hash:         ${shardHash}`);
  console.log(`Vault Instant hash: ${igVaultHash}`);
  console.log(`Bãi đỗ:             ${parkAddr}\n`);

  // Lấy MỘT lần rồi truyền vào từng lượt: mỗi lượt tự truy vấn lại thì tốn ba
  // vòng gọi Blockfrost mà kết quả không mới hơn — script vừa đỗ chưa kịp index.
  const parked = await lucid.utxosAt(parkAddr);
  const publish = (label: string, script: typeof vaultScript, hash: string, lovelace: bigint) =>
    publishRefScript({ lucid, parkAddr, label, script, hash, lovelace, parked });

  const vaultRef = await publish("vault schedule ref", vaultScript, vaultHash, 35_000_000n);
  const shardRef = await publish("shard ref", shardScript, shardHash, 20_000_000n);
  // Vault InstantGen: chân trái của tx consume (chân phải là `consume`, bước 09).
  const igVaultRef = await publish("vault instant ref", igVaultScript, igVaultHash, 35_000_000n);

  console.log("\n── nạp vào env ──");
  console.log(`   REF_VAULT_SCHEDULE_UTXO=${vaultRef}`);
  console.log(`   REF_SHARD_UTXO=${shardRef}`);
  console.log(`   REF_VAULT_INSTANT_UTXO=${igVaultRef}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
