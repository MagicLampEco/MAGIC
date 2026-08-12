// scripts/test/instant_only.ts — InstantGen-only smoke test on Preview testnet.
// Prereq:
//   - 01_mint_lamp + 02_deploy_um + 05_create_instant_vault all run
//   - .env: VAULT_INSTANT_HASH, UM_DATUM_HASH, UM_NFT_POLICY_ID, LAMP_POLICY_ID,
//           BACKING_NFT_POLICY_ID, BACKING_SCRIPT_HASH  (§6.3 — no beacon ⟹ Gen shut)
//
//   NETWORK=Preview npm run test:instant
//
// Env-var knobs:
//   VAULT_TX_HASH=<hex>          — pick a specific vault UTxO (else first match by owner)
//   (LAMP_PAID removed — PHA 2 pays no LAMP; the grant is keyed to consumed MAGIC)
//   TAMPER=<mode>                — tamper mode for negative tests
//   SKIP_OWNER_SIG=1             — negative test for owner sig

import {
  Lucid, Blockfrost, Data, Constr, toUnit,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, ADDRESSES, PROTOCOL, SCRIPT_HASHES,
  lampToOildrop,
} from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { instantVaultParams, umDatumParams } from "../deployParams.js";
import { buildInstantGenTx } from "../../InstantGen/offchain/src/instant.js";
import { VaultDatumSchema, UMDatumSchema } from "../../InstantGen/offchain/src/types.js";

// PHA 2: nothing is paid. LAMP only sits in the vault to open eligibility.

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
  console.log(`║  InstantGen smoke test — ${NETWORK.padEnd(18)}║`);
  console.log("╚════════════════════════════════════════════╝\n");

  // Apply-param THEO TÊN (scripts/applyParams.ts) — tên + thứ tự đọc từ
  // blueprint, dùng chung bản đồ giá trị với deploy/05 nên hash không thể lệch.
  const blueprint = await loadBlueprint("InstantGen");
  const unapplied = findValidator(blueprint, "vault.vault.spend");
  const { script: vaultScript, hash: vaultScriptHash } = appliedScript(
    unapplied,
    instantVaultParams({
      lampPolicyId:      POLICY_IDS.lamp,
      lampAssetName:     ASSET_NAMES.lamp,
      umNftPolicy:       POLICY_IDS.um_nft,
      umScriptHash:      SCRIPT_HASHES.um_datum,        // pins UM ref input (layer b)
      backingNftPolicy:  POLICY_IDS.backing,            // pins the BackingBeacon NFT (§6.3)
      backingScriptHash: SCRIPT_HASHES.backing_beacon,  // pins the BackingBeacon address (§6.3)
      msPerEpoch:        PROTOCOL.MS_PER_EPOCH,
    }),
  );
  const vaultScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(vaultScriptHash));

  console.log(`Network:            ${NETWORK}`);
  console.log(`Vault script hash:  ${vaultScriptHash}`);
  console.log(`Vault address:      ${vaultScriptAddress}`);

  // UM address — um_datum_validator nhận 3 tham số (ms_per_epoch, um_policy, um_name).
  const umBlueprint = await loadBlueprint("UMKeeper");
  const umUnapplied = findValidator(umBlueprint, "um_datum.um_datum_validator.spend");
  const { hash: umScriptHash } = appliedScript(
    umUnapplied,
    umDatumParams({
      msPerEpoch: PROTOCOL.MS_PER_EPOCH,
      umPolicy:   POLICY_IDS.um_nft,
      umName:     ASSET_NAMES.um_nft,
    }),
  );
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
  // ── BackingBeacon reference input (§6.3) ────────────────────
  // Fail-closed: without it InstantGen cannot be built at all.
  const beaconScriptAddress = credentialToAddress(
    NETWORK, scriptHashToCredential(SCRIPT_HASHES.backing_beacon),
  );
  const beaconUtxos = await lucid.utxosAt(beaconScriptAddress);
  const backingBeaconUtxo = beaconUtxos.find(u =>
    (u.assets[toUnit(POLICY_IDS.backing, ASSET_NAMES.backing)] ?? 0n) > 0n && u.datum,
  );
  if (!backingBeaconUtxo) {
    console.error("\n❌ BackingBeacon UTxO not found at", beaconScriptAddress);
    console.error("   InstantGen is SHUT until CARP ships the beacon (§6.3, fail-closed).");
    console.error("   Set BACKING_NFT_POLICY_ID + BACKING_SCRIPT_HASH once it exists.");
    process.exit(1);
  }
  console.log(`Backing beacon:     ${backingBeaconUtxo.txHash}#${backingBeaconUtxo.outputIndex}\n`);

  // Tamper helpers (negative tests).
  const tamper = process.env.TAMPER;
  const tamperOutputDatum = tamper && tamper !== "lamp_out" ? ((d: any) => {
    if (tamper === "lamp_balance") return { ...d, lamp_balance: d.lamp_balance + 1n };
    if (tamper === "keep_credit")
      return { ...d, activity_state: { ...d.activity_state, consumed_credit: 1n } };
    if (tamper === "wrong_owner") return { ...d, owner: "ff".repeat(28) };
    throw new Error(`Unknown TAMPER: ${tamper}`);
  }) : undefined;
  // TAMPER=lamp_out sends LAMP out of the vault — must be REJECTED (I-ACT-7).
  const tamperLampOutOil = tamper === "lamp_out" ? 1_000_000n : undefined;

  try {
    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      console.log(`⚠  TEST MODE: ${tamper ?? "skipOwnerSig"} — expecting REJECT.\n`);
    }

    const result = await buildInstantGenTx({
      lucid,
      vaultUtxo,
      umDatumUtxo,
      backingBeaconUtxo,
      userAddress:     address,
      vaultScript,
      lampPolicyId:    POLICY_IDS.lamp,
      lampAssetName:   ASSET_NAMES.lamp,
      network:         NETWORK,
      tipPosixMs:      tip.posixMs,
      tamperOutputDatum,
      tamperLampOutOil,
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
