// scripts/test/schedule_commit_only.ts — ScheduleGen Commit smoke test.
//
// Env knobs:
//   VAULT_TX_HASH=<hex>
//   SCHEDULE_LENGTH=<int>   (L ∈ [10, 200], default 10)
//   LAMP_PER_EPOCH=<int>    (λ in tLAMP, default 1)
//   TAMPER=<mode>
//   SKIP_OWNER_SIG=1

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
  lampToOil,
} from "../config.js";
import { buildScheduleCommitTx } from "../../ScheduleGen/offchain/src/schedule.js";
import { VaultDatumSchema } from "../../ScheduleGen/offchain/src/types.js";

const L = BigInt(process.env.SCHEDULE_LENGTH ?? "10");
const LAMBDA = lampToOil(BigInt(process.env.LAMP_PER_EPOCH ?? "1"));

async function fetchTip() {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await res.json() as { slot: number; time: number };
  return { slot: BigInt(tip.slot), posixMs: BigInt(tip.time) * 1000n };
}

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║  ScheduleCommit smoke test — Preview       ║");
  console.log("╚════════════════════════════════════════════╝\n");

  // Vault validator
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
      POLICY_IDS.lamp, treasuryAddrData, POLICY_IDS.shard_nft, PROTOCOL.MS_PER_EPOCH,
    ]),
  };
  const shardScript = { type: "PlutusV3" as const, script: shardUnapplied.compiledCode };
  const vaultAddr = credentialToAddress(NETWORK, scriptHashToCredential(validatorToScriptHash(vaultScript)));
  const shardAddr = credentialToAddress(NETWORK, scriptHashToCredential(validatorToScriptHash(shardScript)));

  console.log(`Vault address:  ${vaultAddr}`);
  console.log(`Shard address:  ${shardAddr}\n`);

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
  console.log(`Vault UTxO:     ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`);

  // Only consider shards whose NFT asset name is exactly "SHARD" (5348415244)
  // — matches validator's `quantity_of(..., "SHARD") > 0` lookup. Filters out
  // older deploys that used suffixed asset names.
  const shardUnit = POLICY_IDS.shard_nft + ASSET_NAMES.shard_nft;
  const allShards = await lucid.utxosAt(shardAddr);
  const shardUtxos = allShards.filter(u => (u.assets[shardUnit] ?? 0n) > 0n);
  console.log(`Shards (total/active): ${allShards.length}/${shardUtxos.length}\n`);
  if (shardUtxos.length < PROTOCOL.SHARD_COUNT) {
    console.error(`❌ Expected ${PROTOCOL.SHARD_COUNT} shards`); process.exit(1);
  }

  const tip = await fetchTip();
  console.log(`Current epoch:  ${tip.posixMs / PROTOCOL.MS_PER_EPOCH}`);
  console.log(`L = ${L}, λ = ${LAMBDA / 1_000_000n} tLAMP\n`);

  const tamper = process.env.TAMPER;
  const tamperOutputDatum = tamper ? ((d: any) => {
    if (tamper === "lamp_locked")        return { ...d, lamp_locked: d.lamp_locked + 1n };
    if (tamper === "no_schedule_added")  return { ...d, gen_schedules: [] };
    if (tamper === "fake_rate_locked")   return {
      ...d,
      gen_schedules: d.gen_schedules.map((s: any, i: number) =>
        i === d.gen_schedules.length - 1 ? { ...s, rate_locked_q: s.rate_locked_q * 2n } : s),
    };
    throw new Error(`Unknown TAMPER: ${tamper}`);
  }) : undefined;

  try {
    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      console.log(`⚠  TEST MODE: ${tamper ?? "skipOwnerSig"} — expecting REJECT.\n`);
    }
    const result = await buildScheduleCommitTx({
      lucid, vaultUtxo, shardUtxos,
      scheduleLength: L, lampPerEpoch: LAMBDA,
      userAddress: address,
      vaultScript, shardScript,
      lampPolicyId: POLICY_IDS.lamp,
      lampAssetName: ASSET_NAMES.lamp,
      treasuryAddress: ADDRESSES.treasury,
      network: NETWORK, tipPosixMs: tip.posixMs,
      tamperOutputDatum, skipOwnerSig: process.env.SKIP_OWNER_SIG === "1",
    });
    console.log(result.summary);
    const signed = await result.tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("\n╔════════════════════════════════════════════╗");
    console.log("║              ✅ SUCCESS                    ║");
    console.log("╚════════════════════════════════════════════╝");
    console.log(`TX hash:    ${txHash}`);
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
