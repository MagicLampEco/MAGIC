// scripts/test/e2e_flow.ts — End-to-end testnet flow
// Chạy sau khi deploy xong cả 4 bước
// npx ts-node test/e2e_flow.ts
//
// Flow: SnapshotGen → InstantGen → VacuumGen commit → [wait] → VacuumGen fire

import { Lucid, Blockfrost, Data, toUnit } from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PRIVATE_KEY,
  SCRIPT_HASHES, POLICY_IDS, ASSET_NAMES, PROTOCOL,
  lampToOil,
} from "../config.js";

const SLOTS_PER_EPOCH = PROTOCOL.SLOTS_PER_EPOCH;

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function getCurrentEpoch(lucid: Lucid): Promise<bigint> {
  const tip = await (lucid.provider as any).getBlock("latest");
  return BigInt(tip.slot ?? 0) / SLOTS_PER_EPOCH;
}

async function findVaultUtxo(lucid: Lucid, ownerPkh: string): Promise<any> {
  const vaultAddr = lucid.utils.validatorToAddress({
    type: "PlutusV3", script: SCRIPT_HASHES.vault_snapshot,
  });
  const utxos = await lucid.utxosAt(vaultAddr);
  return utxos.find(u => {
    if (!u.datum) return false;
    try {
      const d = Data.from(u.datum) as any;
      return d?.owner === ownerPkh;
    } catch { return false; }
  });
}

async function findUMUtxo(lucid: Lucid): Promise<any> {
  const umAddr = lucid.utils.validatorToAddress({
    type: "PlutusV3", script: SCRIPT_HASHES.um_datum,
  });
  const utxos = await lucid.utxosAt(umAddr);
  return utxos[0];
}

// ══════════════════════════════════════════════════════════════
// STEP A: Trigger SnapshotGen
// ══════════════════════════════════════════════════════════════
async function testSnapshotGen(lucid: Lucid, vaultUtxo: any, epoch: bigint) {
  console.log(`\n── Test A: SnapshotGen ──`);
  console.log(`  Vault has ${JSON.parse(vaultUtxo.datum || "{}").magic_batches?.length ?? 0} batches`);

  // Import SnapshotGen SDK
  const { buildSnapshotGenTx } = await import("../../SnapshotGen/offchain/src/snapshot.js");
  const address = await lucid.wallet().address();

  const result = await buildSnapshotGenTx({
    lucid, vaultUtxo, userAddress: address,
  });

  console.log(result.summary);
  const txHash = await (await result.tx.sign.withWallet().complete()).submit();
  console.log(`  ✅ TX: ${txHash}`);
  return txHash;
}

// ══════════════════════════════════════════════════════════════
// STEP B: InstantGen purchase
// ══════════════════════════════════════════════════════════════
async function testInstantGen(lucid: Lucid, vaultUtxo: any, umUtxo: any) {
  console.log(`\n── Test B: InstantGen ──`);

  const { buildInstantGenTx } = await import("../../InstantGen/offchain/src/instant.js");
  const address = await lucid.wallet().address();
  const lampPaid = lampToOil(100n);  // 100 LAMP

  const result = await buildInstantGenTx({
    lucid, vaultUtxo, lampPaidOil: lampPaid,
    umDatumUtxo: umUtxo, userAddress: address,
  });

  console.log(result.summary);
  const txHash = await (await result.tx.sign.withWallet().complete()).submit();
  console.log(`  ✅ TX: ${txHash}`);
  return txHash;
}

// ══════════════════════════════════════════════════════════════
// STEP C: VacuumGen commit
// ══════════════════════════════════════════════════════════════
async function testVacuumCommit(lucid: Lucid, vaultUtxo: any) {
  console.log(`\n── Test C: VacuumGen Commit ──`);

  const { buildVacuumCommitTx } = await import("../../VacuumGen/offchain/src/vacuum.js");
  const address = await lucid.wallet().address();
  const lambda  = lampToOil(50n);  // 50 LAMP

  const result = await buildVacuumCommitTx({
    lucid, vaultUtxo, lambdaOil: lambda, userAddress: address,
  });

  console.log(result.summary);
  const txHash = await (await result.tx.sign.withWallet().complete()).submit();
  console.log(`  ✅ TX: ${txHash}`);
  console.log(`  ⏳ Waiting for fire epoch ${result.fireEpoch}...`);
  return { txHash, orderId: result.orderId, fireEpoch: result.fireEpoch };
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  MagicLamp E2E Flow Test — Preview   ║");
  console.log("╚══════════════════════════════════════╝\n");

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

  const address    = await lucid.wallet().address();
  const { paymentCredential } = lucid.utils.getAddressDetails(address);
  const ownerPkh   = paymentCredential!.hash;
  const epoch      = await getCurrentEpoch(lucid);

  console.log(`Wallet:  ${address}`);
  console.log(`Owner:   ${ownerPkh}`);
  console.log(`Epoch:   ${epoch}\n`);

  // Find UTxOs
  const vaultUtxo = await findVaultUtxo(lucid, ownerPkh);
  if (!vaultUtxo) throw new Error("Vault UTxO not found. Run deploy/04_create_vault.ts first.");

  const umUtxo = await findUMUtxo(lucid);
  if (!umUtxo) throw new Error("UM UTxO not found. Run deploy/02_deploy_um.ts first.");

  console.log("Found vault UTxO ✅");
  console.log("Found UM UTxO ✅\n");

  // Run tests sequentially
  await sleep(2000);
  const snapshotTx = await testSnapshotGen(lucid, vaultUtxo, epoch);

  await sleep(5000); // Wait for confirmation
  const freshVault = await findVaultUtxo(lucid, ownerPkh);

  await sleep(2000);
  const instantTx = await testInstantGen(lucid, freshVault, umUtxo);

  await sleep(5000);
  const freshVault2 = await findVaultUtxo(lucid, ownerPkh);

  await sleep(2000);
  const { fireEpoch, orderId } = await testVacuumCommit(lucid, freshVault2);

  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║           TEST SUMMARY               ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║ A: SnapshotGen  ✅ ${snapshotTx.slice(0, 20)}...`);
  console.log(`║ B: InstantGen   ✅ ${instantTx.slice(0, 20)}...`);
  console.log(`║ C: VacuumGen    ✅ committed`);
  console.log(`║    Fire epoch:  ${fireEpoch} (~${Number(fireEpoch - epoch) * 5} days)`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║ D: VacuumGen fire → run at epoch ${fireEpoch} ║`);
  console.log(`║ E: ScheduleGen  → run separately    ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`\nAll basic flows working! ✅`);
}

main().catch(console.error);
