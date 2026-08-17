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
// In ra: REF_VAULT_SCHEDULE_UTXO, REF_SHARD_UTXO, REF_VAULT_INSTANT_UTXO — dạng
// txHash#index.
//
// VAULT INSTANT ở đây, CONSUME ở bước 09: hash của `consume` chỉ tính được SAU khi
// biết `price_nft_policy` và `price_param_script_hash` — hai thứ do chính bước 09 đúc
// ra. Nên 09 tự công bố ref-script của nó; bước này chỉ lo những script mà tham số đã
// biết từ `config.ts`.

import {
  Lucid, Blockfrost,
  credentialToAddress, scriptHashToCredential, validatorToScriptHash,
  scriptFromNative, getAddressDetails,
  type Script,
} from "@lucid-evolution/lucid";
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
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Không lấy được payment credential của ví");

  // Bãi đỗ: script native chỉ chủ khoá mở được. Ví KHÔNG tự chọn UTxO ở đây.
  const parkScript = scriptFromNative({ type: "sig", keyHash: paymentCredential.hash });
  const parkAddr = credentialToAddress(NETWORK, scriptHashToCredential(validatorToScriptHash(parkScript)));

  console.log(`Network:            ${NETWORK}`);
  console.log(`Vault Schedule hash:${vaultHash}`);
  console.log(`Shard hash:         ${shardHash}`);
  console.log(`Vault Instant hash: ${igVaultHash}`);
  console.log(`Bãi đỗ:             ${parkAddr}\n`);

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
