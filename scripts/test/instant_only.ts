// scripts/test/instant_only.ts — InstantGen-only smoke test on Preview testnet.
// Prereq:
//   - 01_mint_lamp + 02_deploy_um + 05_create_instant_vault all run
//   - .env: VAULT_INSTANT_HASH, UM_DATUM_HASH, UM_NFT_POLICY_ID, LAMP_POLICY_ID, TREASURY_ADDRESS
//
//   NETWORK=Preview npm run test:instant
//
// Env-var knobs:
//   VAULT_TX_HASH=<hex>          — pick a specific vault UTxO (else first match by owner)
//   LAMP_PAID=<int>              — LAMP amount in tLAMP units (default 100)
//   TAMPER=<mode>                — tamper mode for negative tests
//   SKIP_OWNER_SIG=1             — negative test for owner sig

import {
  Lucid, Blockfrost, Data, Constr, toUnit,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, ADDRESSES, PROTOCOL, SCRIPT_HASHES,
  lampToOil,
} from "../config.js";
import { buildInstantGenTx } from "../../InstantGen/offchain/src/instant.js";
import { VaultDatumSchema, UMDatumSchema } from "../../InstantGen/offchain/src/types.js";

const LAMP_PAID = lampToOil(BigInt(process.env.LAMP_PAID ?? "100"));

async function fetchTip(): Promise<{ slot: bigint; posixMs: bigint }> {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  if (!res.ok) throw new Error(`Blockfrost /blocks/latest: ${res.status}`);
  const tip = await res.json() as { slot: number; time: number };
  return { slot: BigInt(tip.slot), posixMs: BigInt(tip.time) * 1000n };
}

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  InstantGen smoke test — Preview testnet   ║");
  console.log("╚════════════════════════════════════════════╝\n");

  // Load InstantGen validator (4 params).
  const plutusJson = JSON.parse(
    await readFile(new URL("../../InstantGen/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) throw new Error("vault.vault.spend not in InstantGen plutus.json");

  // Treasury Address Plutus encoding (must match the encoding used at deploy time).
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
      POLICY_IDS.lamp,
      ASSET_NAMES.lamp,
      treasuryAddrData,
      POLICY_IDS.um_nft,
      SCRIPT_HASHES.um_datum,   // um_script_hash — pins UM ref input (layer b)
      PROTOCOL.MS_PER_EPOCH,
    ]),
  };
  const vaultScriptHash    = validatorToScriptHash(vaultScript);
  const vaultScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(vaultScriptHash));

  console.log(`Network:            ${NETWORK}`);
  console.log(`Vault script hash:  ${vaultScriptHash}`);
  console.log(`Vault address:      ${vaultScriptAddress}`);

  // Load UMKeeper validator to derive UM address.
  const umPlutus = JSON.parse(
    await readFile(new URL("../../UMKeeper/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const umUnapplied = umPlutus.validators.find((v: any) => v.title?.endsWith(".spend"));
  if (!umUnapplied) throw new Error("UMKeeper validator not found");
  const umScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(umUnapplied.compiledCode, [PROTOCOL.MS_PER_EPOCH]),
  };
  const umScriptHash    = validatorToScriptHash(umScript);
  const umScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(umScriptHash));
  console.log(`UM address:         ${umScriptAddress}\n`);

  // Lucid + wallet
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  // Find vault UTxO.
  const wantedTx = process.env.VAULT_TX_HASH;
  const vaultUtxos = await lucid.utxosAt(vaultScriptAddress);
  console.log(`UTxOs at vault:     ${vaultUtxos.length}`);
  const vaultUtxo = vaultUtxos.find((u) => {
    if (!u.datum) return false;
    if (wantedTx && u.txHash !== wantedTx) return false;
    try {
      const d = Data.from(u.datum, VaultDatumSchema);
      return d.owner === ownerPkh;
    } catch { return false; }
  });
  if (!vaultUtxo) {
    console.error("\n❌ Vault UTxO not found. Run: npm run deploy:instant-vault");
    process.exit(1);
  }
  console.log(`Vault UTxO:         ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`);

  // Find UM datum UTxO (identified by UM NFT).
  // UM_TX_HASH env var selects a specific UM UTxO (useful when multiple UMs exist).
  const umNftUnit = POLICY_IDS.um_nft + ASSET_NAMES.um_nft;
  const wantedUmTx = process.env.UM_TX_HASH;
  const umUtxos = await lucid.utxosAt(umScriptAddress);
  const umDatumUtxo = umUtxos.find(u => {
    if (wantedUmTx && u.txHash !== wantedUmTx) return false;
    return (u.assets[umNftUnit] ?? 0n) > 0n;
  });
  if (!umDatumUtxo) {
    console.error("\n❌ UM datum UTxO not found at", umScriptAddress);
    console.error("   Run: npm run deploy:um");
    process.exit(1);
  }
  console.log(`UM datum UTxO:      ${umDatumUtxo.txHash}#${umDatumUtxo.outputIndex}\n`);

  // Tip POSIX ms.
  const tip = await fetchTip();
  console.log(`Tip POSIX ms:       ${tip.posixMs}`);
  console.log(`Current epoch:      ${tip.posixMs / PROTOCOL.MS_PER_EPOCH}`);
  console.log(`LAMP to pay:        ${LAMP_PAID / 1_000_000n} tLAMP\n`);

  // Tamper helpers (negative tests).
  const tamper = process.env.TAMPER;
  const tamperOutputDatum = tamper && tamper !== "half_treasury" ? ((d: any) => {
    if (tamper === "lamp_balance") return { ...d, lamp_balance: d.lamp_balance + 1n };
    if (tamper === "no_lamp_transfer") return { ...d, lamp_balance: d.lamp_balance }; // skip the reduction
    if (tamper === "wrong_owner") return { ...d, owner: "ff".repeat(28) };
    throw new Error(`Unknown TAMPER: ${tamper}`);
  }) : undefined;
  // TAMPER=half_treasury sends only half of LAMP_PAID to treasury (rest disappears via balancing).
  const treasuryAmountOverride = tamper === "half_treasury" ? LAMP_PAID / 2n : undefined;

  try {
    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      console.log(`⚠  TEST MODE: ${tamper ?? "skipOwnerSig"} — expecting REJECT.\n`);
    }

    const result = await buildInstantGenTx({
      lucid,
      vaultUtxo,
      lampPaidOil:     LAMP_PAID,
      umDatumUtxo,
      userAddress:     address,
      vaultScript,
      lampPolicyId:    POLICY_IDS.lamp,
      lampAssetName:   ASSET_NAMES.lamp,
      treasuryAddress: ADDRESSES.treasury,
      network:         NETWORK,
      tipPosixMs:      tip.posixMs,
      tamperOutputDatum,
      treasuryAmountOverride,
      skipOwnerSig:    process.env.SKIP_OWNER_SIG === "1",
    });

    console.log(result.summary);

    const signed = await result.tx.sign.withWallet().complete();
    const txHash = await signed.submit();

    console.log("\n╔════════════════════════════════════════════╗");
    console.log("║              ✅ SUCCESS                    ║");
    console.log("╚════════════════════════════════════════════╝");
    console.log(`TX hash:   ${txHash}`);
    console.log(`Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  } catch (err: any) {
    console.error("\n╔════════════════════════════════════════════╗");
    console.error("║              ❌ FAILED                     ║");
    console.error("╚════════════════════════════════════════════╝");
    const msg = String(err?.message ?? err);
    console.error(msg);
    if (err?.stack) console.error("\nStack:\n" + err.stack);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
