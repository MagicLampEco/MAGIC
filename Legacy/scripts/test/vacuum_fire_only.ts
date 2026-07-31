// scripts/test/vacuum_fire_only.ts — VacuumGen Fire phase smoke test.
//
//   NETWORK=Preview npm run test:vacuum-fire
//
// Prereq: vault has a vacuum_order with fire_epoch == currentEpoch.
// Either: (a) wait 2 epochs after Commit, or (b) deploy with PRESEED_ORDER_LAMBDA (06_create_vacuum_vault).
//
// Env knobs:
//   VAULT_TX_HASH=<hex>   — pick specific vault UTxO
//   ORDER_ID=<hex>        — order to fire (default = first order in vault)
//   TAMPER=<mode>         — tamper output (lamp_balance, missing_treasury_xfer)

import {
  Lucid, Blockfrost, Data, Constr,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, ADDRESSES, PROTOCOL, SCRIPT_HASHES,
} from "../../../scripts/config.js";
import { buildVacuumFireTx } from "../../VacuumGen/offchain/src/vacuum.js";
import { VaultDatumSchema } from "../../VacuumGen/offchain/src/types.js";

async function fetchTip() {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await res.json() as { slot: number; time: number };
  return { slot: BigInt(tip.slot), posixMs: BigInt(tip.time) * 1000n };
}

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  VacuumFire smoke test — Preview testnet   ║");
  console.log("╚════════════════════════════════════════════╝\n");

  // Load + apply VacuumGen validator.
  const plutusJson = JSON.parse(
    await readFile(new URL("../../VacuumGen/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) throw new Error("vault.vault.spend not in VacuumGen plutus.json");

  const treasuryDetails = getAddressDetails(ADDRESSES.treasury);
  if (!treasuryDetails.paymentCredential) throw new Error("Invalid TREASURY_ADDRESS");
  const treasuryPaymentCred = treasuryDetails.paymentCredential.type === "Key"
    ? new Constr(0, [treasuryDetails.paymentCredential.hash])
    : new Constr(1, [treasuryDetails.paymentCredential.hash]);
  const treasuryStakeCred = treasuryDetails.stakeCredential
    ? new Constr(0, [new Constr(0, [new Constr(0, [treasuryDetails.stakeCredential.hash])])])
    : new Constr(1, []);
  const treasuryAddrData = new Constr(0, [treasuryPaymentCred, treasuryStakeCred]);

  const vaultScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(unapplied.compiledCode, [
      POLICY_IDS.lamp, treasuryAddrData, POLICY_IDS.um_nft, SCRIPT_HASHES.um_datum, PROTOCOL.MS_PER_EPOCH,
    ]),
  };
  const vaultScriptHash    = validatorToScriptHash(vaultScript);
  const vaultScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(vaultScriptHash));

  // Load UMKeeper for UM address.
  const umPlutus = JSON.parse(
    await readFile(new URL("../../UMKeeper/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const umUnapplied = umPlutus.validators.find((v: any) => v.title?.endsWith(".spend"));
  const umScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(umUnapplied.compiledCode, [PROTOCOL.MS_PER_EPOCH]),
  };
  const umAddress = credentialToAddress(NETWORK, scriptHashToCredential(validatorToScriptHash(umScript)));

  console.log(`Vault address: ${vaultScriptAddress}`);
  console.log(`UM address:    ${umAddress}\n`);

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  const ownerPkh = paymentCredential!.hash;

  const wantedTx = process.env.VAULT_TX_HASH;
  const vaultUtxos = await lucid.utxosAt(vaultScriptAddress);
  const vaultUtxo = vaultUtxos.find((u) => {
    if (!u.datum) return false;
    if (wantedTx && u.txHash !== wantedTx) return false;
    try { return Data.from(u.datum, VaultDatumSchema).owner === ownerPkh; } catch { return false; }
  });
  if (!vaultUtxo) { console.error("❌ Vault not found"); process.exit(1); }

  // Decode vault datum to find an order.
  const vd = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  if (vd.vacuum_orders.length === 0) {
    console.error("❌ Vault has no vacuum_orders. Run Commit first or deploy with PRESEED_ORDER_LAMBDA.");
    process.exit(1);
  }
  const orderId = process.env.ORDER_ID ?? vd.vacuum_orders[0].order_id;
  console.log(`Vault UTxO:  ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`);
  console.log(`Order ID:    ${orderId}`);
  console.log(`Fire epoch:  ${vd.vacuum_orders[0].fire_epoch}\n`);

  // UM datum
  const umNftUnit = POLICY_IDS.um_nft + ASSET_NAMES.um_nft;
  const umUtxos = await lucid.utxosAt(umAddress);
  const umDatumUtxo = umUtxos.find(u => (u.assets[umNftUnit] ?? 0n) > 0n);
  if (!umDatumUtxo) { console.error("❌ UM datum UTxO not found"); process.exit(1); }
  console.log(`UM UTxO:     ${umDatumUtxo.txHash}#${umDatumUtxo.outputIndex}\n`);

  const tip = await fetchTip();
  console.log(`Tip POSIX ms:  ${tip.posixMs}`);
  console.log(`Current epoch: ${tip.posixMs / PROTOCOL.MS_PER_EPOCH}\n`);

  const tamper = process.env.TAMPER;
  const tamperOutputDatum = tamper ? ((d: any) => {
    if (tamper === "lamp_balance") return { ...d, lamp_balance: d.lamp_balance + 1n };
    if (tamper === "no_batch")     return { ...d, magic_batches: [] };
    throw new Error(`Unknown TAMPER: ${tamper}`);
  }) : undefined;

  try {
    if (tamper) console.log(`⚠  TEST MODE: ${tamper} — expecting REJECT.\n`);
    const result = await buildVacuumFireTx({
      lucid, vaultUtxo, orderId, umDatumUtxo,
      vaultScript,
      lampPolicyId:    POLICY_IDS.lamp,
      lampAssetName:   ASSET_NAMES.lamp,
      treasuryAddress: ADDRESSES.treasury,
      network: NETWORK, tipPosixMs: tip.posixMs,
      tamperOutputDatum,
    });
    console.log(result.summary);
    const signed = await result.tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("\n╔════════════════════════════════════════════╗");
    console.log("║              ✅ SUCCESS                    ║");
    console.log("╚════════════════════════════════════════════╝");
    console.log(`TX hash:  ${txHash}`);
    console.log(`Explorer: https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  } catch (err: any) {
    console.error("\n╔════════════════════════════════════════════╗");
    console.error("║              ❌ FAILED                     ║");
    console.error("╚════════════════════════════════════════════╝");
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
