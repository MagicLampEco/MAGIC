// scripts/deploy/01_mint_lamp.ts — Mint testnet LAMP token
// Run: npx tsx deploy/01_mint_lamp.ts
// Result: LAMP_POLICY_ID printed → copy vào .env

import {
  Lucid, Blockfrost, Data,
  getAddressDetails, mintingPolicyToId,
  type MintingPolicy,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, ASSET_NAMES,
} from "../config.js";

const LAMP_TOTAL_SUPPLY = 36_000_000_000_000_000n; // 36 × 10^15 oil (§19.9)
const LAMP_ASSET_NAME   = ASSET_NAMES.lamp;         // "LAMP" hex

async function main() {
  console.log("=== Step 1: Mint testnet LAMP ===\n");

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  const address = await lucid.wallet().address();
  console.log(`Wallet address: ${address}`);

  // Simple time-locked minting policy (testnet only)
  // Production: use multi-sig or native script with proper governance
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential from wallet");

  const mintingPolicy: MintingPolicy = {
    type: "Native",
    script: Data.to({
      type: "sig",
      keyHash: paymentCredential.hash,
    }),
  };

  const policyId = mintingPolicyToId(mintingPolicy);
  const lampUnit = policyId + LAMP_ASSET_NAME;

  console.log(`\nPolicy ID: ${policyId}`);
  console.log(`LAMP unit: ${lampUnit}`);
  console.log(`Minting:   ${LAMP_TOTAL_SUPPLY} oil = 36,000,000,000 LAMP\n`);

  const utxos = await lucid.wallet().getUtxos();
  const balance = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  console.log(`tADA balance: ${balance / 1_000_000n} ADA`);
  if (balance < 5_000_000n) {
    throw new Error("Need ≥ 5 tADA. Get from: https://docs.cardano.org/cardano-testnet/tools/faucet");
  }

  const tx = await lucid
    .newTx()
    .mintAssets({ [lampUnit]: LAMP_TOTAL_SUPPLY }, Data.void())
    .attach.MintingPolicy(mintingPolicy)
    .pay.ToAddress(address, { [lampUnit]: LAMP_TOTAL_SUPPLY })
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log(`✅ LAMP minted!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  console.log(`\n📋 Copy to .env:`);
  console.log(`   LAMP_POLICY_ID=${policyId}`);
  console.log(`\nWait ~20s for confirmation, then run: npx tsx deploy/02_deploy_um.ts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
