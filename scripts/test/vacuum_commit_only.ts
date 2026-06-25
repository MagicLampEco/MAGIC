// scripts/test/vacuum_commit_only.ts — VacuumGen Commit phase smoke test.
//
//   NETWORK=Preview npm run test:vacuum-commit
//
// Env knobs:
//   VAULT_TX_HASH=<hex>   — pick specific vault UTxO
//   LAMBDA_LAMP=<int>     — λ in tLAMP (default 50)
//   TAMPER=<mode>         — tamper output (lamp_locked, no_order_added)
//   SKIP_OWNER_SIG=1      — negative test

import {
  Lucid, Blockfrost, Data, Constr,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ADDRESSES, PROTOCOL, SCRIPT_HASHES,
  lampToOildrop,
} from "../config.js";
import { buildVacuumCommitTx } from "../../VacuumGen/offchain/src/vacuum.js";
import { VaultDatumSchema } from "../../VacuumGen/offchain/src/types.js";

const LAMBDA = lampToOildrop(BigInt(process.env.LAMBDA_LAMP ?? "50"));

async function fetchTip() {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await res.json() as { slot: number; time: number };
  return { slot: BigInt(tip.slot), posixMs: BigInt(tip.time) * 1000n };
}

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  VacuumCommit smoke test — Preview testnet ║");
  console.log("╚════════════════════════════════════════════╝\n");

  // Load + apply VacuumGen validator (4 params).
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

  console.log(`Vault hash:    ${vaultScriptHash}`);
  console.log(`Vault address: ${vaultScriptAddress}\n`);

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  const ownerPkh = paymentCredential!.hash;

  const wantedTx = process.env.VAULT_TX_HASH;
  const vaultUtxos = await lucid.utxosAt(vaultScriptAddress);
  console.log(`UTxOs at vault: ${vaultUtxos.length}`);
  const vaultUtxo = vaultUtxos.find((u) => {
    if (!u.datum) return false;
    if (wantedTx && u.txHash !== wantedTx) return false;
    try {
      const d = Data.from(u.datum, VaultDatumSchema);
      return d.owner === ownerPkh;
    } catch { return false; }
  });
  if (!vaultUtxo) { console.error("❌ Vault not found"); process.exit(1); }
  console.log(`Vault UTxO:    ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}\n`);

  const tip = await fetchTip();
  console.log(`Tip POSIX ms:  ${tip.posixMs}`);
  console.log(`Current epoch: ${tip.posixMs / PROTOCOL.MS_PER_EPOCH}`);
  console.log(`λ to lock:     ${LAMBDA / 1_000_000n} tLAMP\n`);

  const tamper = process.env.TAMPER;
  const tamperOutputDatum = tamper ? ((d: any) => {
    if (tamper === "lamp_locked")    return { ...d, lamp_locked: d.lamp_locked + 1n };
    if (tamper === "no_order_added") return { ...d, vacuum_orders: [] };
    if (tamper === "wrong_owner")    return { ...d, owner: "ff".repeat(28) };
    throw new Error(`Unknown TAMPER: ${tamper}`);
  }) : undefined;

  try {
    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      console.log(`⚠  TEST MODE: ${tamper ?? "skipOwnerSig"} — expecting REJECT.\n`);
    }
    const result = await buildVacuumCommitTx({
      lucid, vaultUtxo, lambdaOildrop: LAMBDA, userAddress: address,
      vaultScript, network: NETWORK, tipPosixMs: tip.posixMs,
      tamperOutputDatum, skipOwnerSig: process.env.SKIP_OWNER_SIG === "1",
    });
    console.log(result.summary);
    const signed = await result.tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("\n╔════════════════════════════════════════════╗");
    console.log("║              ✅ SUCCESS                    ║");
    console.log("╚════════════════════════════════════════════╝");
    console.log(`TX hash:    ${txHash}`);
    console.log(`Order ID:   ${result.orderId}`);
    console.log(`Fire epoch: ${result.fireEpoch}`);
    console.log(`Explorer:   https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  } catch (err: any) {
    console.error("\n╔════════════════════════════════════════════╗");
    console.error("║              ❌ FAILED                     ║");
    console.error("╚════════════════════════════════════════════╝");
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
