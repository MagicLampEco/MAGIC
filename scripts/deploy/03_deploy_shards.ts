// scripts/deploy/03_deploy_shards.ts — Deploy 16 Shard UTxOs for ScheduleGen.
// Run: npx tsx deploy/03_deploy_shards.ts
// Prereq: 02_deploy_um done.
//
// Loads ScheduleGen plutus.json, picks shard validator (0 params), creates 16 UTxOs
// each with unique shard NFT (asset name = "SHARD" + shardId hex) and ScheduleAggregateShardDatum.

import {
  Lucid, Blockfrost, Data,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  mintingPolicyToId, getAddressDetails, scriptFromNative,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  ASSET_NAMES, PROTOCOL,
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

  // Load ScheduleGen plutus.json and find the shard validator (no params).
  const plutusJson = JSON.parse(
    await readFile(new URL("../../ScheduleGen/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const shardUnapplied = plutusJson.validators.find((v: any) =>
    v.title === "vault.shard.spend" || v.title === "shard.shard.spend",
  );
  if (!shardUnapplied) {
    console.error("Validators:", plutusJson.validators.map((v: any) => v.title));
    throw new Error("Shard validator not found in ScheduleGen plutus.json");
  }

  // Shard validator has NO params — script is the unapplied compiledCode directly.
  const shardScript = { type: "PlutusV3" as const, script: shardUnapplied.compiledCode };
  const shardScriptHash = validatorToScriptHash(shardScript);
  const shardScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(shardScriptHash));

  console.log(`Network:              ${NETWORK}`);
  console.log(`Shard script hash:    ${shardScriptHash}`);
  console.log(`Shard script address: ${shardScriptAddress}`);

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");

  const shardNftPolicy = scriptFromNative({ type: "sig", keyHash: paymentCredential.hash });
  const shardNftPolicyId = mintingPolicyToId(shardNftPolicy);

  // Tip POSIX ms for current epoch.
  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await tipRes.json() as { slot: number; time: number };
  const tipPosixMs   = BigInt(tip.time) * 1000n;
  const currentEpoch = tipPosixMs / PROTOCOL.MS_PER_EPOCH;

  console.log(`Current epoch:        ${currentEpoch}`);
  console.log(`Shard NFT policy:     ${shardNftPolicyId}`);
  console.log(`Deploying shards 0-15...\n`);

  // Validator identifies shards by asset name = exactly "SHARD" (5 bytes hex `5348415244`).
  // All 16 UTxOs share the same asset unit; shard_id is stored in datum.
  const shardUnit = shardNftPolicyId + ASSET_NAMES.shard_nft;
  const shardMints: Record<string, bigint> = { [shardUnit]: BigInt(PROTOCOL.SHARD_COUNT) };
  let txBuilder = lucid.newTx();

  for (let shardId = 0; shardId < PROTOCOL.SHARD_COUNT; shardId++) {
    const shardDatum = Data.to({
      shard_id:                    BigInt(shardId),
      shard_locked_lamp:            0n,
      shard_active_count:           0n,
      shard_cumulative_committed:   0n,
      shard_cumulative_fired:       0n,
      last_updated_epoch:           currentEpoch,
      shard_cap:                    PROTOCOL.SHARD_CAP,
    }, ShardDatumSchema);

    txBuilder = txBuilder.pay.ToAddressWithData(
      shardScriptAddress,
      { kind: "inline", value: shardDatum },
      { lovelace: 2_000_000n, [shardUnit]: 1n },
    );

    process.stdout.write(`  Shard ${shardId.toString().padStart(2)}\n`);
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
  console.log(`\n📋 Copy to .env:`);
  console.log(`   SHARD_HASH=${shardScriptHash}              # applied for NETWORK=${NETWORK}`);
  console.log(`   SHARD_NFT_POLICY_ID=${shardNftPolicyId}`);
}

main().catch(console.error);
