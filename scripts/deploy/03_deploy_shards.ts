// scripts/deploy/03_deploy_shards.ts — Deploy 16 Shard UTxOs for ScheduleGen.
// Run: npx tsx deploy/03_deploy_shards.ts
// Prereq: 02_deploy_um done.
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
// 07_create_schedule_vault.ts (vault takes shard_policy_id) — no param
// hash-cycle (the shard validator does NOT take the vault hash).

import {
  Lucid, Blockfrost, Data,
  credentialToAddress, scriptHashToCredential, mintingPolicyToId,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, PROTOCOL,
} from "../config.js";
import {
  loadBlueprint, findValidator, appliedScript, appliedValidator,
} from "../applyParams.js";
import { oneShotGenesisParams, shardSpendParams } from "../deployParams.js";

const ShardDatumSchema = Data.Object({
  shard_id:                    Data.Integer(),
  shard_locked_lamp:            Data.Integer(),
  shard_active_count:           Data.Integer(),
  shard_cumulative_committed:   Data.Integer(),
  shard_cumulative_fired:       Data.Integer(),
  last_updated_epoch:           Data.Integer(),
  shard_cap:                    Data.Integer(),
});

// shard_asset_name(id) = "SHARD" (5348415244) ∥ single byte 0x00..0x0f.
function shardAssetName(shardId: number): string {
  return "5348415244" + shardId.toString(16).padStart(2, "0");
}

async function main() {
  console.log("=== Step 3: Deploy 16 Shard UTxOs (one-shot NFT policy) ===\n");

  // Load ScheduleGen blueprint: shard NFT minting policy + shard spend validator.
  const blueprint         = await loadBlueprint("ScheduleGen");
  const shardNftUnapplied = findValidator(blueprint, "shard_nft.shard_nft.mint");
  const shardSpendUnapplied = findValidator(blueprint, "vault.shard.spend");

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();

  // ── Pick a genesis UTxO to consume (one-shot seed) ──────────────────────
  const utxos = await lucid.wallet().getUtxos();
  if (utxos.length === 0) throw new Error("Wallet has no UTxOs to seed the one-shot policy");
  const genesis = utxos[0]!;

  // Apply genesis ref to the minting policy → fixed policy id.
  // LƯU Ý: tham số phải là Plutus Data DẠNG CẤU TRÚC (Constr 0 [bytes, int]).
  // Bản cũ truyền `Data.to(genesisRef, OutRefSchema)` — tức một CHUỖI HEX CBOR —
  // nên tham số vào script là một ByteArray, không phải OutputReference: mint
  // luôn fail ở `i.output_reference == genesis_ref`.
  const shardNftPolicy = appliedValidator(
    shardNftUnapplied,
    oneShotGenesisParams({ txHash: genesis.txHash, outputIndex: genesis.outputIndex }),
  );
  const shardNftPolicyId = mintingPolicyToId(shardNftPolicy);

  // Apply policy id to the shard spend validator BEFORE hashing.
  const { script: shardScript, hash: shardScriptHash } = appliedScript(
    shardSpendUnapplied,
    shardSpendParams({ shardPolicyId: shardNftPolicyId }),
  );
  const shardScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(shardScriptHash));

  console.log(`Network:              ${NETWORK}`);
  console.log(`Genesis seed UTxO:    ${genesis.txHash}#${genesis.outputIndex}`);
  console.log(`Shard NFT policy:     ${shardNftPolicyId}  (one-shot)`);
  console.log(`Shard script hash:    ${shardScriptHash}  (NFT-policy applied)`);
  console.log(`Shard script address: ${shardScriptAddress}`);

  // Tip POSIX ms for current epoch.
  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await tipRes.json() as { slot: number; time: number };
  const tipPosixMs   = BigInt(tip.time) * 1000n;
  const currentEpoch = tipPosixMs / PROTOCOL.MS_PER_EPOCH;

  console.log(`Current epoch:        ${currentEpoch}`);
  console.log(`Deploying shards 0-15...\n`);

  // ── Build the mint: 16 distinct NFTs, qty 1 each ────────────────────────
  const shardMints: Record<string, bigint> = {};
  for (let shardId = 0; shardId < PROTOCOL.SHARD_COUNT; shardId++) {
    shardMints[shardNftPolicyId + shardAssetName(shardId)] = 1n;
  }

  // MUST consume the genesis UTxO so the one-shot policy runs.
  let txBuilder = lucid.newTx().collectFrom([genesis]);

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
    }, ShardDatumSchema);

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
  console.log(`   Explorer:  https://preview.cardanoscan.io/transaction/${txHash}`);
  console.log(`\n📋 Copy to .env:`);
  console.log(`   SHARD_HASH=${shardScriptHash}              # applied for NETWORK=${NETWORK}`);
  console.log(`   SHARD_NFT_POLICY_ID=${shardNftPolicyId}`);
}

main().catch(console.error);
