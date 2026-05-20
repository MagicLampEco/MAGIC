// MagicSDK/examples/phoenixkey_integration.ts
//
// Reference integration showing how PhoenixKey (or any DID provider) wraps
// `createVault()`. End-to-end flow:
//
//   1. PhoenixKey resolves the user's DID → Cardano payment key hash (PKH).
//   2. PhoenixKey caller chooses which vault type to create (or all 4).
//   3. SDK builds unsigned tx → PhoenixKey wallet abstraction signs → submit.
//
// This file is illustrative — adapt to your wallet abstraction (CIP-30,
// WebAuthn-backed signer, server-side hot wallet, etc.). The MAGIC SDK does
// NOT manage keys; it only builds txs.
//
// Run (after the MAGIC repo's `aiken build` + minted LAMP + deployed UM/shards):
//   cd MagicSDK
//   NETWORK=Preview BLOCKFROST_KEY=preview... PRIVATE_KEY=ed25519_sk... \
//     LAMP_POLICY_ID=... UM_NFT_POLICY_ID=... SHARD_NFT_POLICY_ID=... \
//     TREASURY_ADDRESS=addr_test1... \
//     npx tsx examples/phoenixkey_integration.ts

import { readFile } from "node:fs/promises";
import { Lucid, Blockfrost, getAddressDetails } from "@lucid-evolution/lucid";
import { createVault, type VaultType } from "../src/index.js";

// ── 1. Pretend this is what PhoenixKey gives us after DID resolution. ────────
function resolveUserFromDID(did: string): { ownerPkh: string; preferredProfile: "Ember" | "Flame" | "Lantern" } {
  // In real PhoenixKey, the DID resolver returns the Cardano payment key hash
  // bound to this DID, plus app-level preferences (profile choice via UI).
  // Stub: derive PKH from the example wallet (just for the demo).
  void did; // unused in stub
  // Caller would replace with their real DID → PKH mapping.
  throw new Error("Stub: replace resolveUserFromDID with PhoenixKey DID resolver");
}

// ── 2. Load unapplied validator CBOR from MAGIC repo build output. ──────────
async function loadVaultCbor(vaultType: VaultType): Promise<{ vault: string; shard?: string }> {
  const moduleName = ({
    Snapshot: "SnapshotGen",
    Instant:  "InstantGen",
    Vacuum:   "VacuumGen",
    Schedule: "ScheduleGen",
  } as const)[vaultType];

  const plutusPath = new URL(`../../${moduleName}/onchain/plutus.json`, import.meta.url);
  const plutus = JSON.parse(await readFile(plutusPath, "utf8"));
  const vault = plutus.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!vault) throw new Error(`vault.vault.spend not found in ${moduleName} plutus.json`);

  // ScheduleGen also needs the shard validator (separate spend purpose).
  const shard = plutus.validators.find(
    (v: any) => v.title === "vault.shard.spend" || v.title === "shard.shard.spend",
  );

  return { vault: vault.compiledCode, shard: shard?.compiledCode };
}

// ── 3. Main: create one Snapshot vault for the user. ────────────────────────
async function main() {
  const NETWORK         = (process.env.NETWORK ?? "Preview") as "Preview" | "Preprod" | "Mainnet";
  const BLOCKFROST_URL  = `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0`;
  const BLOCKFROST_KEY  = required("BLOCKFROST_KEY");
  const PRIVATE_KEY     = required("PRIVATE_KEY");
  const LAMP_POLICY_ID  = required("LAMP_POLICY_ID");
  const TREASURY_ADDR   = process.env.TREASURY_ADDRESS;     // optional for Snapshot
  const UM_NFT_POLICY   = process.env.UM_NFT_POLICY_ID;     // required for Instant/Vacuum
  const SHARD_NFT_POLICY= process.env.SHARD_NFT_POLICY_ID;  // required for Schedule

  // Lucid setup — PhoenixKey would use CIP-30 / WebAuthn instead.
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);
  const walletAddr = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(walletAddr);
  if (!paymentCredential) throw new Error("Wallet has no payment credential");
  const ownerPkh = paymentCredential.hash;

  console.log(`Wallet:  ${walletAddr}`);
  console.log(`Owner pkh: ${ownerPkh}\n`);

  // Pick vault type. PhoenixKey UI would let user choose; default Snapshot
  // (no LAMP cost, just locks LAMP into vault for generation).
  const vaultType: VaultType = (process.env.VAULT_TYPE as VaultType) ?? "Snapshot";

  const { vault: vaultCbor, shard: shardCbor } = await loadVaultCbor(vaultType);

  const { tx, vaultAddress, vaultScriptHash, summary } = await createVault({
    lucid,
    vaultType,
    protocol: {
      network:         NETWORK,
      lampPolicyId:    LAMP_POLICY_ID,
      treasuryAddress: TREASURY_ADDR,
      umNftPolicyId:   UM_NFT_POLICY,
      shardPolicyId:   SHARD_NFT_POLICY,
    },
    validators: {
      vaultUnappliedCbor: vaultCbor,
      shardUnappliedCbor: shardCbor,
    },
    vault: {
      ownerPkh,
      lampDeposit: BigInt(process.env.LAMP_DEPOSIT ?? "1000") * 1_000_000n, // 1000 LAMP default
      profile:     (process.env.PROFILE as any) ?? "Flame",
    },
  });

  console.log(summary);
  console.log();

  // Sign + submit (in real PhoenixKey, this goes through their wallet abstraction).
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log(`✅ TX submitted: ${txHash}`);
  console.log(`   Scan: https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  console.log(`   Vault will appear at: ${vaultAddress}`);
  console.log(`   Script hash: ${vaultScriptHash}`);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Env var ${name} required`);
  return v;
}

main().catch((e) => { console.error(e); process.exit(1); });
