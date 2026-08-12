// scripts/deploy/06_publish_ref_scripts.ts — Công bố script tham chiếu (CIP-33).
// Run: npx tsx deploy/06_publish_ref_scripts.ts
//
// Vì sao BẮT BUỘC, không phải tối ưu: ScheduleCommit/ScheduleFire tiêu HAI UTxO
// script (vault + shard). Đính kèm cả hai validator vào tx làm tx = 17303 byte,
// vượt trần giao thức 16384 — đo thật trên Preview, tx không dựng nổi. Đưa script
// lên chain một lần rồi `readFrom` là đường duy nhất chạy được.
//
// 🔴 KHÔNG đỗ script ở địa chỉ ví. Bản đầu làm vậy và mất script ngay trong cùng
// đợt chạy: bộ chọn UTxO của ví coi đó là tiền lẻ và tiêu mất, nên bước sau báo
// MISSING_SCRIPT dù explorer vẫn thấy output. Đỗ ở một địa chỉ script riêng thì
// ví không bao giờ đụng tới, mà chủ khoá vẫn thu hồi được khi cần.
//
// Chạy được nhiều lần: chỉ công bố cái nào chưa có mặt ở địa chỉ đỗ.
//
// In ra: REF_VAULT_SCHEDULE_UTXO, REF_SHARD_UTXO dạng txHash#index.

import {
  Lucid, Blockfrost,
  credentialToAddress, scriptHashToCredential, validatorToScriptHash,
  scriptFromNative, getAddressDetails,
  type Script,
} from "@lucid-evolution/lucid";
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
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Không lấy được payment credential của ví");

  // Bãi đỗ: script native chỉ chủ khoá mở được. Ví KHÔNG tự chọn UTxO ở đây.
  const parkScript = scriptFromNative({ type: "sig", keyHash: paymentCredential.hash });
  const parkAddr = credentialToAddress(NETWORK, scriptHashToCredential(validatorToScriptHash(parkScript)));

  console.log(`Network:      ${NETWORK}`);
  console.log(`Vault hash:   ${vaultHash}`);
  console.log(`Shard hash:   ${shardHash}`);
  console.log(`Bãi đỗ:       ${parkAddr}\n`);

  const parked = await lucid.utxosAt(parkAddr);
  const findParked = (hash: string) =>
    parked.find((u) => u.scriptRef && validatorToScriptHash(u.scriptRef) === hash);

  // HAI tx riêng: hai script cộng lại là 16643 byte, chính chúng đã vượt trần
  // 16384 nếu công bố chung một tx.
  const publish = async (label: string, script: Script, hash: string, lovelace: bigint) => {
    const already = findParked(hash);
    if (already) {
      console.log(`✓ ${label} đã có sẵn: ${already.txHash}#${already.outputIndex}`);
      return `${already.txHash}#${already.outputIndex}`;
    }
    // Blockfrost trả danh sách UTxO trễ vài giây sau khi tx trước xác nhận, nên
    // lần dựng đầu hay chọn phải input vừa bị tiêu ("All inputs are spent").
    // Dựng lại là hết — không phải lỗi logic, nên thử lại thay vì bỏ cuộc.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const tx = await lucid.newTx()
          .pay.ToAddressWithData(parkAddr, undefined, { lovelace }, script)
          .complete();
        const signed = await tx.sign.withWallet().complete();
        const txHash = await signed.submit();
        await lucid.awaitTx(txHash);
        console.log(`✔ ${label}: ${txHash}#0`);
        return `${txHash}#0`;
      } catch (e) {
        lastErr = e;
        console.log(`  … lần ${attempt} chưa được, dựng lại sau 15s`);
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
    throw lastErr;
  };

  const vaultRef = await publish("vault ref", vaultScript, vaultHash, 35_000_000n);
  const shardRef = await publish("shard ref", shardScript, shardHash, 20_000_000n);

  console.log("\n── nạp vào env ──");
  console.log(`   REF_VAULT_SCHEDULE_UTXO=${vaultRef}`);
  console.log(`   REF_SHARD_UTXO=${shardRef}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
