// scripts/test/withdraw_only.ts — WithdrawLamp smoke test on Preview testnet
// Standalone: runs exactly 1 WithdrawLamp tx; reports result clearly.
// Maps V1_TESTNET_PLAN §3 case matrix (20 case total: 4 vault × 5 case core).
//
//   NETWORK=Preview MODULE=Snapshot npm run test:withdraw
//   NETWORK=Preview MODULE=Snapshot TAMPER=amount_zero npm run test:withdraw
//
// Env knobs:
//   MODULE        Snapshot | Instant | Vacuum | Schedule          (default: Snapshot)
//   AMOUNT_LAMP   amount to withdraw (in LAMP, integer)            (default: 5)
//   TAMPER        amount_zero | over_avail | tamper_balance |
//                 tamper_holdings | tamper_batches | tamper_value  (negative cases)
//   SKIP_OWNER_SIG=1   omit signer (W-2 negative)
//   VAULT_TX_HASH      pick specific vault UTxO by tx hash
//   DEST_ADDR          destination for withdrawn LAMP (default: caller wallet)

import {
  Lucid, Blockfrost, Data,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
  type UTxO,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  PROTOCOL, POLICY_IDS, ADDRESSES, SCRIPT_HASHES,
} from "../config.js";

import { withdrawLamp } from "../../MagicSDK/src/withdrawLamp.js";
import { applyVaultValidator } from "../../MagicSDK/src/validatorScripts.js";
import type { VaultType, ProtocolParams } from "../../MagicSDK/src/types.js";

type Module = "Snapshot" | "Instant" | "Vacuum" | "Schedule";

const PLUTUS_PATH: Record<Module, string> = {
  Snapshot: "../../SnapshotGen/onchain/plutus.json",
  Instant:  "../../InstantGen/onchain/plutus.json",
  Vacuum:   "../../VacuumGen/onchain/plutus.json",
  Schedule: "../../ScheduleGen/onchain/plutus.json",
};

function buildProtocol(): ProtocolParams {
  return {
    network: NETWORK,
    lampPolicyId: POLICY_IDS.lamp,
    umNftPolicyId: POLICY_IDS.um_nft,
    umScriptHash: SCRIPT_HASHES.um_datum,
    treasuryAddress: ADDRESSES.treasury,
    shardPolicyId: POLICY_IDS.shard_nft,
  };
}

async function fetchTip(): Promise<{ slot: bigint; posixMs: bigint }> {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  if (!res.ok) throw new Error(`Blockfrost /blocks/latest: ${res.status} ${res.statusText}`);
  const tip = await res.json() as { slot: number; time: number };
  return { slot: BigInt(tip.slot), posixMs: BigInt(tip.time) * 1000n };
}

async function main() {
  const moduleName = (process.env.MODULE ?? "Snapshot") as Module;
  if (!PLUTUS_PATH[moduleName]) throw new Error(`Unknown MODULE: ${moduleName}. Use Snapshot|Instant|Vacuum|Schedule.`);

  const amountLamp = BigInt(process.env.AMOUNT_LAMP ?? "5");
  const amountOil = amountLamp * 1_000_000n;
  const tamper = process.env.TAMPER ?? "";

  console.log("╔════════════════════════════════════════════╗");
  console.log(`║  WithdrawLamp smoke — ${moduleName.padEnd(20)}║`);
  console.log("╚════════════════════════════════════════════╝\n");

  // ── 1. Load + apply vault script (uses SDK helper — handles treasury
  //     bech32 → Plutus Constr conversion for Instant/Vacuum/Schedule)
  const plutusJson = JSON.parse(
    await readFile(new URL(PLUTUS_PATH[moduleName], import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) throw new Error(`vault.vault.spend not found in ${PLUTUS_PATH[moduleName]}`);

  const { vaultScript, vaultScriptHash, vaultAddress: vaultAddr } = applyVaultValidator(
    moduleName as VaultType,
    { vaultUnappliedCbor: unapplied.compiledCode },
    buildProtocol(),
  );

  console.log(`Network:           ${NETWORK}`);
  console.log(`Vault hash:        ${vaultScriptHash}`);
  console.log(`Vault address:     ${vaultAddr}`);
  console.log(`Amount:            ${amountLamp} LAMP (${amountOil} oil)`);
  if (tamper) console.log(`TAMPER:            ${tamper}`);
  if (process.env.SKIP_OWNER_SIG === "1") console.log(`SKIP_OWNER_SIG:    1`);
  console.log();

  // ── 2. Lucid + wallet ────────────────────────────────────────
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  // ── 3. Find vault UTxO ───────────────────────────────────────
  const utxos = await lucid.utxosAt(vaultAddr);
  const wantedTx = process.env.VAULT_TX_HASH;

  let vaultUtxo: UTxO | undefined;
  for (const u of utxos) {
    if (!u.datum) continue;
    if (wantedTx && u.txHash !== wantedTx) continue;
    // Match by owner — VaultDatumSchema lives per module; for simplicity use SDK schema
    // (identical across modules per types.ak shape).
    try {
      const { VaultDatumSchema } = await import("../../MagicSDK/src/schemas.js");
      const d = Data.from(u.datum, VaultDatumSchema);
      if (d.owner === ownerPkh) {
        vaultUtxo = u;
        break;
      }
    } catch { /* not a vault datum */ }
  }

  if (!vaultUtxo) {
    console.error("❌ Vault UTxO not found for owner. Run deploy:vault first.");
    process.exit(1);
  }
  console.log(`Vault UTxO:        ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}\n`);

  // ── 4. Build + (maybe tamper) + submit ───────────────────────
  const tip = await fetchTip();
  try {
    const result = await withdrawLamp({
      lucid,
      vaultUtxo,
      amountOil: tamperedAmount(amountOil, tamper),
      vaultScript,
      vaultType: moduleName as VaultType,
      vaultPlutusJson: plutusJson,
      network: NETWORK,
      lampPolicyId: POLICY_IDS.lamp,
      destinationAddress: process.env.DEST_ADDR ?? address,
      tipPosixMs: tip.posixMs,
    });

    // ── Tamper: rebuild tx with mutated output datum / signer ──
    let finalTx = result.tx;
    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      finalTx = await rebuildWithTamper(
        lucid, vaultUtxo, result.newVaultDatum, vaultScript, vaultAddr,
        amountOil, ownerPkh, tip.posixMs, plutusJson, tamper,
        process.env.SKIP_OWNER_SIG === "1",
      );
      console.log(`⚠  TEST MODE: ${tamper || "skipOwnerSig"} — expecting validator REJECT.\n`);
    }

    console.log(result.summary);
    console.log();

    const signed = await finalTx.sign.withWallet().complete();
    const txHash = await signed.submit();

    console.log("╔════════════════════════════════════════════╗");
    console.log("║              ✅ SUCCESS                    ║");
    console.log("╚════════════════════════════════════════════╝");
    console.log(`TX hash:   ${txHash}`);
    console.log(`Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);

    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      console.error("\n⚠  UNEXPECTED: tamper tx SUBMITTED — validator did not reject. Investigate.");
      process.exit(2);
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      console.log("╔════════════════════════════════════════════╗");
      console.log("║   ✅ REJECTED (as expected for negative)   ║");
      console.log("╚════════════════════════════════════════════╝");
      console.log(`Reason:    ${msg.slice(0, 300)}`);
      return;
    }
    console.error("\n╔════════════════════════════════════════════╗");
    console.error("║              ❌ FAILED                     ║");
    console.error("╚════════════════════════════════════════════╝");
    console.error(msg);
    if (err?.stack) console.error("\nStack:\n" + err.stack);
    process.exit(1);
  }
}

// W-NEG-1: amount = 0 → tamper at the SDK call level (or skip SDK and inject 0).
// W-NEG-2: amount > L_avail handled by SDK pre-check; to trigger validator path,
//          bypass the SDK check by setting an enormous amount but locked = 0.
function tamperedAmount(amountOil: bigint, tamper: string): bigint {
  if (tamper === "amount_zero") return 0n;
  return amountOil;
}

// Tamper output datum / signer to exercise W-5..W-6.
// Pattern: take the well-formed `newVaultDatum` from SDK, mutate, rebuild tx.
async function rebuildWithTamper(
  lucid: any, vaultUtxo: UTxO, newVaultDatum: any, vaultScript: any, vaultAddr: string,
  amountOil: bigint, ownerPkh: string, tipPosixMs: bigint, plutusJson: any,
  tamper: string, skipOwnerSig: boolean,
): Promise<any> {
  const { VaultDatumSchema } = await import("../../MagicSDK/src/schemas.js");
  const { resolveConstrIndex } = await import("../../MagicSDK/src/redeemerIndex.js");
  const { Constr, toUnit } = await import("@lucid-evolution/lucid");
  const lampUnit = toUnit(POLICY_IDS.lamp, "744c414d50");

  let mutatedDatum = { ...newVaultDatum };
  let outputLamp = vaultUtxo.assets[lampUnit] ?? 0n;
  outputLamp = outputLamp - amountOil;

  if (tamper === "tamper_balance") {
    mutatedDatum = { ...mutatedDatum, lamp_balance: mutatedDatum.lamp_balance + 1n };  // W-5
  } else if (tamper === "tamper_holdings") {
    mutatedDatum = { ...mutatedDatum, loyalty_holdings: [] };  // W-5 + W-7
  } else if (tamper === "tamper_batches") {
    mutatedDatum = { ...mutatedDatum, magic_batches: [] };  // W-5 (magic_batches mutated)
  } else if (tamper === "tamper_value") {
    outputLamp = outputLamp + 1n;  // W-6: vault output value LAMP qty wrong
  }

  const idx = resolveConstrIndex(plutusJson, "vault.vault.spend", "WithdrawLamp");
  const redeemer = Data.to(new Constr(idx, [amountOil]));

  const lowerTime = Number(tipPosixMs);
  const upperTime = Number((BigInt(Math.floor(Date.now())) + 600_000n));

  const vaultOutputAssets: Record<string, bigint> = { lovelace: vaultUtxo.assets.lovelace };
  if (outputLamp > 0n) vaultOutputAssets[lampUnit] = outputLamp;

  let txBuilder = lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .attach.SpendingValidator(vaultScript)
    .pay.ToAddressWithData(
      vaultAddr,
      { kind: "inline", value: Data.to(mutatedDatum, VaultDatumSchema) },
      vaultOutputAssets,
    )
    .pay.ToAddress(await lucid.wallet().address(), { [lampUnit]: amountOil })
    .validFrom(lowerTime)
    .validTo(upperTime);

  if (!skipOwnerSig) txBuilder = txBuilder.addSignerKey(ownerPkh);

  return await txBuilder.complete();
}

main().catch((e) => { console.error(e); process.exit(1); });
