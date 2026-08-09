// scripts/deploy/02_deploy_um.ts — Deploy parameterized UM datum UTxO
// Run: npx tsx deploy/02_deploy_um.ts
// Prereq: 01_mint_lamp.ts done; UMKeeper/onchain/plutus.json built with ms_per_epoch param.
//
// Output: UM datum UTxO at applied UMKeeper validator address, with 1 UM NFT.
// Prints: UM_DATUM_HASH (applied), UM_NFT_POLICY_ID — copy both into .env.

import {
  Lucid, Blockfrost, Data, Constr,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  mintingPolicyToId, getAddressDetails,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  ASSET_NAMES, PROTOCOL,
} from "../config.js";

const UMDatumSchema = Data.Object({
  smoothed_q:          Data.Integer(),
  last_updated_epoch:  Data.Integer(),
  history:             Data.Array(Data.Integer()),
});

async function main() {
  console.log("=== Step 2: Deploy UM Datum UTxO (parameterized) ===\n");

  // Load and apply UMKeeper validator (1 param: ms_per_epoch)
  const plutusJson = JSON.parse(
    await readFile(new URL("../../UMKeeper/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) =>
    v.title === "um_datum.um_datum_validator.spend"
    || v.title === "um_datum_validator.um_datum_validator.spend"
    || v.title?.endsWith(".spend"),
  );
  if (!unapplied) {
    console.error("Available validators:", plutusJson.validators.map((v: any) => v.title));
    throw new Error("UMKeeper validator not found in UMKeeper/onchain/plutus.json");
  }

  const appliedCbor    = applyParamsToScript(unapplied.compiledCode, [PROTOCOL.MS_PER_EPOCH]);
  const umScript       = { type: "PlutusV3" as const, script: appliedCbor };
  const umScriptHash   = validatorToScriptHash(umScript);
  const umScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(umScriptHash));

  console.log(`Network:             ${NETWORK}`);
  console.log(`ms_per_epoch:        ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`UM script hash:      ${umScriptHash}`);
  console.log(`UM script address:   ${umScriptAddress}`);

  // Lucid + wallet
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");

  // ── Mint the UM authority NFT as a TRUE one-shot singleton ───────────────
  // MAINNET-BLOCK fix, layer (a): the previous native `sig` policy could be
  // re-minted arbitrarily by the key holder, so the UM NFT was not a global
  // singleton and the UM reference input was forgeable. The one-shot Plutus
  // policy is parameterized by a specific genesis OutputReference that the tx
  // MUST consume → it can run at most once → supply fixed at 1, never re-mint.
  const umNftPlutus = JSON.parse(
    await readFile(new URL("../../UMKeeper/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const unappliedNft = umNftPlutus.validators.find((v: any) =>
    v.title === "um_nft.um_nft.mint" || v.title?.startsWith("um_nft."),
  );
  if (!unappliedNft) {
    console.error("Available validators:", umNftPlutus.validators.map((v: any) => v.title));
    throw new Error("um_nft.um_nft.mint not found in UMKeeper/onchain/plutus.json");
  }

  // Pick a genesis UTxO from the wallet to consume (must have lovelace).
  const walletUtxos = await lucid.wallet().getUtxos();
  const genesisUtxo = walletUtxos.find((u) => u.assets.lovelace >= 3_000_000n);
  if (!genesisUtxo) throw new Error("No wallet UTxO with ≥3 ADA to seed the one-shot mint");

  // OutputReference = Constr 0 [transaction_id (Bytes), output_index (Int)].
  const genesisRefData = new Constr(0, [genesisUtxo.txHash, BigInt(genesisUtxo.outputIndex)]);
  const umNftPolicyScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(unappliedNft.compiledCode, [genesisRefData]),
  };
  const umNftPolicyId = mintingPolicyToId(umNftPolicyScript);
  const umNftUnit     = umNftPolicyId + ASSET_NAMES.um_nft;

  // Current epoch from tip POSIX ms (matches validator semantics).
  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await tipRes.json() as { slot: number; time: number };
  const tipPosixMs   = BigInt(tip.time) * 1000n;
  const currentEpoch = tipPosixMs / PROTOCOL.MS_PER_EPOCH;

  // Initial UM datum (neutral 1.0 = Q).
  // UM_AGE env: how many epochs ago last_updated_epoch was. Default 0 = fresh.
  // Use UM_AGE=2 (or more) to test C-UM-6 stale fallback (validator uses 0.5× when UM > 1 epoch old).
  const umAge = BigInt(process.env.UM_AGE ?? "0");
  const initialUM = {
    smoothed_q:         PROTOCOL.Q,
    last_updated_epoch: currentEpoch - umAge,
    history:            [] as bigint[],
  };
  const umDatum = Data.to(initialUM, UMDatumSchema);

  console.log(`Current epoch:       ${currentEpoch}`);
  console.log(`Initial smoothed_q:  ${initialUM.smoothed_q} (1.000×)`);
  console.log(`UM NFT policy:       ${umNftPolicyId}`);

  const tx = await lucid
    .newTx()
    .collectFrom([genesisUtxo])      // consume the genesis UTxO → enforces one-shot
    .mintAssets({ [umNftUnit]: 1n }, Data.void())
    .attach.MintingPolicy(umNftPolicyScript)
    .pay.ToAddressWithData(
      umScriptAddress,
      { kind: "inline", value: umDatum },
      {
        lovelace:    2_000_000n,
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
  console.log(`   UM_DATUM_HASH=${umScriptHash}      # = um_script_hash param pinned by InstantGen vaults`);
  console.log(`   UM_NFT_POLICY_ID=${umNftPolicyId}  # one-shot singleton (genesis ${genesisUtxo.txHash}#${genesisUtxo.outputIndex})`);
}

main().catch(console.error);
