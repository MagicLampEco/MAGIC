// scripts/deploy/03_deploy_shards.ts — Deploy 16 Shard UTxOs
// Chạy: npx ts-node deploy/03_deploy_shards.ts
// Prerequisite: 02_deploy_um.ts đã chạy xong

import { Lucid, Blockfrost, Data } from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PRIVATE_KEY,
  SCRIPT_HASHES, ASSET_NAMES, PROTOCOL,
} from "../config.js";

const ShardDatumSchema = Data.Object({
  shard_id:                    Data.Integer(),
  shard_locked_lamp:            Data.Integer(),
  shard_active_count:           Data.Integer(),
  shard_cumulative_committed:   Data.Integer(),
  shard_cumulative_fired:       Data.Integer(),
  last_updated_epoch:           Data.Integer(),
  shard_cap:                    Data.Integer(),
});

async function main() {
  console.log("=== Step 3: Deploy 16 Shard UTxOs ===\n");
  console.log("This deploys one UTxO per shard (0-15) for ScheduleGen participation cap.\n");

  if (SCRIPT_HASHES.shard === "FILL_AFTER_AIKEN_BUILD") {
    throw new Error("Run: cd ScheduleGen/onchain && aiken build\nThen copy shard hash to .env as SHARD_HASH");
  }

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

  const tip = await (lucid.provider as any).getBlock("latest");
  const currentEpoch = BigInt(tip.slot ?? 0) / PROTOCOL.SLOTS_PER_EPOCH;

  const shardScriptAddress = lucid.utils.validatorToAddress({
    type:   "PlutusV3",
    script: SCRIPT_HASHES.shard,
  });

  // Mint shard NFT policy (identifies each shard UTxO)
  const address = await lucid.wallet().address();
  const { paymentCredential } = lucid.utils.getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");

  const shardNftPolicy = {
    type: "Native" as const,
    script: Data.to({ type: "sig", keyHash: paymentCredential.hash }),
  };
  const shardNftPolicyId = lucid.utils.mintingPolicyToId(shardNftPolicy);

  console.log(`Shard script address: ${shardScriptAddress}`);
  console.log(`Deploying shards 0-15...\n`);

  // Deploy all 16 shards in one transaction
  const shardMints: Record<string, bigint> = {};
  const txBuilder = lucid.newTx();

  for (let shardId = 0; shardId < PROTOCOL.SHARD_COUNT; shardId++) {
    // NFT asset name = "SHARD" + shard_id encoded
    const shardAssetName = ASSET_NAMES.shard_nft + shardId.toString(16).padStart(2, "0");
    const shardUnit = shardNftPolicyId + shardAssetName;
    shardMints[shardUnit] = 1n;

    const shardDatum = Data.to({
      shard_id:                    BigInt(shardId),
      shard_locked_lamp:            0n,
      shard_active_count:           0n,
      shard_cumulative_committed:   0n,
      shard_cumulative_fired:       0n,
      last_updated_epoch:           currentEpoch,
      shard_cap:                    PROTOCOL.SHARD_CAP,  // 4.5×10^14 oil = 450M LAMP
    }, ShardDatumSchema);

    txBuilder.pay.ToAddressWithData(
      shardScriptAddress,
      { kind: "inline", value: shardDatum },
      {
        lovelace:   2_000_000n,
        [shardUnit]: 1n,
      },
    );

    process.stdout.write(`  Shard ${shardId.toString().padStart(2)}: cap=450M LAMP, locked=0\n`);
  }

  const tx = await txBuilder
    .mintAssets(shardMints, Data.void())
    .attach.MintingPolicy(shardNftPolicy)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log(`\n✅ 16 Shards deployed!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://preview.cardanoscan.io/transaction/${txHash}`);
  console.log(`   Total cap: ${PROTOCOL.SHARD_COUNT} × 450M = 7.2B LAMP (20% of total supply)`);
  console.log(`\n📋 Copy to .env:`);
  console.log(`   SHARD_NFT_POLICY_ID=${shardNftPolicyId}`);
  console.log(`\nWait ~20 seconds, then run: npx ts-node deploy/04_create_vault.ts`);
}

main().catch(console.error);
