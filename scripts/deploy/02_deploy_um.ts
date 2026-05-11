// scripts/deploy/02_deploy_um.ts — Deploy UM datum UTxO
// Chạy: npx ts-node deploy/02_deploy_um.ts
// Prerequisite: 01_mint_lamp.ts đã chạy xong + LAMP_POLICY_ID trong .env

import { Lucid, Blockfrost, Data } from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PRIVATE_KEY,
  SCRIPT_HASHES, POLICY_IDS, ASSET_NAMES, PROTOCOL,
} from "../config.js";

// UM datum initial state (§20.2: neutral UM = 1.0)
const UMDatumSchema = Data.Object({
  smoothed_q:          Data.Integer(),
  last_updated_epoch:  Data.Integer(),
  history:             Data.Array(Data.Integer()),
});

async function main() {
  console.log("=== Step 2: Deploy UM Datum UTxO ===\n");

  if (SCRIPT_HASHES.um_datum === "FILL_AFTER_AIKEN_BUILD") {
    throw new Error("Run: cd UMKeeper/onchain && aiken build\nThen copy hash to .env as UM_DATUM_HASH");
  }

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

  // Get current epoch from tip
  const tip = await (lucid.provider as any).getBlock("latest");
  const currentEpoch = BigInt(tip.slot ?? 0) / PROTOCOL.SLOTS_PER_EPOCH;
  console.log(`Current epoch: ${currentEpoch}`);

  // Initial UM state — neutral (§20.2)
  const initialUM = {
    smoothed_q:         PROTOCOL.Q,    // 1.0 = neutral
    last_updated_epoch: currentEpoch,
    history:            [] as bigint[],
  };

  const umDatum = Data.to(initialUM, UMDatumSchema);

  // UM datum script address
  const umScriptAddress = lucid.utils.validatorToAddress({
    type:   "PlutusV3",
    script: SCRIPT_HASHES.um_datum,
  });

  console.log(`UM script address: ${umScriptAddress}`);
  console.log(`Initial smoothed_q: ${initialUM.smoothed_q} (1.0×)`);

  // Mint UM NFT (1 token to identify this UTxO as the UM datum)
  // Simple native script policy
  const address = await lucid.wallet().address();
  const { paymentCredential } = lucid.utils.getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");

  const umNftPolicy = {
    type: "Native" as const,
    script: Data.to({ type: "sig", keyHash: paymentCredential.hash }),
  };
  const umNftPolicyId = lucid.utils.mintingPolicyToId(umNftPolicy);
  const umNftUnit = umNftPolicyId + ASSET_NAMES.um_nft;

  const tx = await lucid
    .newTx()
    .mintAssets({ [umNftUnit]: 1n }, Data.void())
    .attach.MintingPolicy(umNftPolicy)
    .pay.ToAddressWithData(
      umScriptAddress,
      { kind: "inline", value: umDatum },
      {
        lovelace:   2_000_000n,   // min ADA
        [umNftUnit]: 1n,
      },
    )
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log(`\n✅ UM Datum deployed!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://preview.cardanoscan.io/transaction/${txHash}`);
  console.log(`\n📋 Copy to .env:`);
  console.log(`   UM_NFT_POLICY_ID=${umNftPolicyId}`);
  console.log(`\nWait ~20 seconds, then run: npx ts-node deploy/03_deploy_shards.ts`);
}

main().catch(console.error);
