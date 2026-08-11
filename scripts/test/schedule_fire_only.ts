// scripts/test/schedule_fire_only.ts — ScheduleGen Fire smoke test.
// Reads first gen_schedule from vault datum; fires up to MAX_FIRES_PER_TX_CATCHUP.

import {
  Lucid, Blockfrost, Data, Constr,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, ADDRESSES, PROTOCOL,
} from "../config.js";
import { buildScheduleFireTx } from "../../ScheduleGen/offchain/src/schedule.js";
import { VaultDatumSchema } from "../../ScheduleGen/offchain/src/types.js";

async function fetchTip() {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await res.json() as { slot: number; time: number };
  return { posixMs: BigInt(tip.time) * 1000n };
}

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  ScheduleFire smoke test — Preview         ║");
  console.log("╚════════════════════════════════════════════╝\n");

  const plutusJson = JSON.parse(
    await readFile(new URL("../../ScheduleGen/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const vaultUnapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  const shardUnapplied = plutusJson.validators.find((v: any) =>
    v.title === "vault.shard.spend" || v.title === "shard.shard.spend",
  );

  const td = getAddressDetails(ADDRESSES.treasury);
  const tPaymentCred = td.paymentCredential!.type === "Key"
    ? new Constr(0, [td.paymentCredential!.hash])
    : new Constr(1, [td.paymentCredential!.hash]);
  const tStakeCred = td.stakeCredential
    ? new Constr(0, [new Constr(0, [new Constr(0, [td.stakeCredential.hash])])])
    : new Constr(1, []);
  const treasuryAddrData = new Constr(0, [tPaymentCred, tStakeCred]);

  const vaultScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(vaultUnapplied.compiledCode, [
      POLICY_IDS.lamp, ASSET_NAMES.lamp, treasuryAddrData, POLICY_IDS.shard_nft,
      POLICY_IDS.vault_id_nft, ASSET_NAMES.vault_id_nft, PROTOCOL.MS_PER_EPOCH,
    ]),
  };
  // Shard validator now takes 1 param: shard NFT policy id (same value the vault
  // is parameterized with). Apply it before hashing — hash changed vs v1.0.
  const shardScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(shardUnapplied.compiledCode, [POLICY_IDS.shard_nft]),
  };
  const vaultAddr = credentialToAddress(NETWORK, scriptHashToCredential(validatorToScriptHash(vaultScript)));
  const shardAddr = credentialToAddress(NETWORK, scriptHashToCredential(validatorToScriptHash(shardScript)));

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const ownerPkh = getAddressDetails(address).paymentCredential!.hash;

  const wantedTx = process.env.VAULT_TX_HASH;
  const vaultUtxos = await lucid.utxosAt(vaultAddr);
  const vaultUtxo = vaultUtxos.find((u) => {
    if (!u.datum) return false;
    if (wantedTx && u.txHash !== wantedTx) return false;
    try { return Data.from(u.datum, VaultDatumSchema).owner === ownerPkh; } catch { return false; }
  });
  if (!vaultUtxo) { console.error("❌ Vault not found"); process.exit(1); }

  const vd = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  if (vd.gen_schedules.length === 0) {
    console.error("❌ No schedules. Run Commit first or deploy with PRESEED_SCHEDULE_L>0.");
    process.exit(1);
  }
  const scheduleId = process.env.SCHEDULE_ID ?? vd.gen_schedules[0].schedule_id;
  const sched = vd.gen_schedules.find(s => s.schedule_id === scheduleId)!;
  console.log(`Vault UTxO:        ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`);
  console.log(`Schedule ID:       ${scheduleId.slice(0, 16)}...`);
  console.log(`Start fire epoch:  ${sched.start_fire_epoch}`);
  console.log(`Fired count:       ${sched.fired_count} / ${sched.schedule_length}`);

  // One-shot policy issues 16 DISTINCT asset names (SHARD#0..15). Match any
  // asset under the shard NFT policy id, not a single shared "SHARD" name.
  const allShards = await lucid.utxosAt(shardAddr);
  const shardUtxos = allShards.filter(u =>
    Object.keys(u.assets).some(unit => unit.startsWith(POLICY_IDS.shard_nft) && u.assets[unit] > 0n));
  console.log(`Shards (total/active): ${allShards.length}/${shardUtxos.length}\n`);

  const tip = await fetchTip();
  console.log(`Current epoch:     ${tip.posixMs / PROTOCOL.MS_PER_EPOCH}\n`);

  const tamper = process.env.TAMPER;
  const tamperOutputDatum = tamper ? ((d: any) => {
    if (tamper === "lamp_balance") return { ...d, lamp_balance: d.lamp_balance + 1n };
    throw new Error(`Unknown TAMPER: ${tamper}`);
  }) : undefined;

  try {
    if (tamper) console.log(`⚠  TEST MODE: ${tamper} — expecting REJECT.\n`);
    const result = await buildScheduleFireTx({
      lucid, vaultUtxo, shardUtxos, scheduleId,
      vaultScript, shardScript,
      lampPolicyId: POLICY_IDS.lamp,
      lampAssetName: ASSET_NAMES.lamp,
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
