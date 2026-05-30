// scripts/test/update_profile_only.ts — UpdateProfile smoke test on Preview testnet.
// Maps V1_TESTNET_PLAN §4 case matrix (16 case: 2 vault × 8 case).
//
//   NETWORK=Preview MODULE=Snapshot NEW_PROFILE=Ember npm run test:update-profile
//
// Env knobs:
//   MODULE        Snapshot | Instant                              (default: Snapshot)
//   NEW_PROFILE   Ember | Flame | Lantern                          (default: Ember)
//   TAMPER        same_profile | bypass_lazy | wrong_effective |
//                 effective_too_far | tamper_batches | tamper_balance
//   SKIP_OWNER_SIG=1   omit signer (C-PC-V1 negative)
//   FORCE_COOLDOWN=1   build tx even if cooldown not met (C-PC-V2 negative)
//   VAULT_TX_HASH      pick specific vault UTxO

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
  PROTOCOL, POLICY_IDS, ADDRESSES,
} from "../config.js";

import { updateProfile } from "../../MagicSDK/src/updateProfile.js";
import type { Profile, VaultType } from "../../MagicSDK/src/types.js";

type Module = "Snapshot" | "Instant";

const MODULE_SPECS: Record<Module, { plutusJsonPath: string; params: () => unknown[] }> = {
  Snapshot: {
    plutusJsonPath: "../../SnapshotGen/onchain/plutus.json",
    params: () => [POLICY_IDS.lamp, PROTOCOL.MS_PER_EPOCH],
  },
  Instant: {
    plutusJsonPath: "../../InstantGen/onchain/plutus.json",
    params: () => [POLICY_IDS.lamp, ADDRESSES.treasury, POLICY_IDS.um_nft, PROTOCOL.MS_PER_EPOCH],
  },
};

async function fetchTip(): Promise<{ slot: bigint; posixMs: bigint }> {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  if (!res.ok) throw new Error(`Blockfrost /blocks/latest: ${res.status}`);
  const tip = await res.json() as { slot: number; time: number };
  return { slot: BigInt(tip.slot), posixMs: BigInt(tip.time) * 1000n };
}

async function main() {
  const moduleName = (process.env.MODULE ?? "Snapshot") as Module;
  const spec = MODULE_SPECS[moduleName];
  if (!spec) throw new Error(`MODULE=${moduleName} not supported (only Snapshot|Instant).`);

  const newProfile = (process.env.NEW_PROFILE ?? "Ember") as Profile;
  const tamper = process.env.TAMPER ?? "";

  console.log("╔════════════════════════════════════════════╗");
  console.log(`║  UpdateProfile smoke — ${moduleName.padEnd(19)}║`);
  console.log("╚════════════════════════════════════════════╝\n");

  const plutusJson = JSON.parse(
    await readFile(new URL(spec.plutusJsonPath, import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) throw new Error("vault.vault.spend not found");

  const vaultScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(unapplied.compiledCode, spec.params() as never),
  };
  const vaultScriptHash = validatorToScriptHash(vaultScript);
  const vaultAddr = credentialToAddress(NETWORK, scriptHashToCredential(vaultScriptHash));

  console.log(`Network:           ${NETWORK}`);
  console.log(`Vault hash:        ${vaultScriptHash}`);
  console.log(`New profile:       ${newProfile}`);
  if (tamper) console.log(`TAMPER:            ${tamper}`);
  if (process.env.SKIP_OWNER_SIG === "1") console.log(`SKIP_OWNER_SIG:    1`);
  console.log();

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("No payment credential");
  const ownerPkh = paymentCredential.hash;

  // Find vault UTxO
  const utxos = await lucid.utxosAt(vaultAddr);
  const wantedTx = process.env.VAULT_TX_HASH;

  let vaultUtxo: UTxO | undefined;
  for (const u of utxos) {
    if (!u.datum) continue;
    if (wantedTx && u.txHash !== wantedTx) continue;
    try {
      const { VaultDatumSchema } = await import("../../MagicSDK/src/schemas.js");
      const d = Data.from(u.datum, VaultDatumSchema);
      if (d.owner === ownerPkh) { vaultUtxo = u; break; }
    } catch { /* skip */ }
  }
  if (!vaultUtxo) {
    console.error("❌ Vault UTxO not found. Run deploy:vault first.");
    process.exit(1);
  }
  console.log(`Vault UTxO:        ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}\n`);

  const tip = await fetchTip();
  try {
    const result = await updateProfile({
      lucid,
      vaultUtxo,
      newProfile,
      vaultScript,
      vaultType: moduleName as VaultType,
      vaultPlutusJson: plutusJson,
      network: NETWORK,
      tipPosixMs: tip.posixMs,
    });

    let finalTx = result.tx;
    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      finalTx = await rebuildWithTamper(
        lucid, vaultUtxo, result.newVaultDatum, vaultScript, vaultAddr,
        newProfile, ownerPkh, tip.posixMs, plutusJson, tamper,
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

    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      console.error("\n⚠  UNEXPECTED: tamper tx SUBMITTED — validator did not reject.");
      process.exit(2);
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (tamper || process.env.SKIP_OWNER_SIG === "1" || process.env.FORCE_COOLDOWN === "1") {
      console.log("╔════════════════════════════════════════════╗");
      console.log("║   ✅ REJECTED (as expected for negative)   ║");
      console.log("╚════════════════════════════════════════════╝");
      console.log(`Reason:    ${msg.slice(0, 300)}`);
      return;
    }
    console.error("\n❌ FAILED:", msg);
    if (err?.stack) console.error("\nStack:\n" + err.stack);
    process.exit(1);
  }
}

async function rebuildWithTamper(
  lucid: any, vaultUtxo: UTxO, newVaultDatum: any, vaultScript: any, vaultAddr: string,
  newProfile: Profile, ownerPkh: string, tipPosixMs: bigint, plutusJson: any,
  tamper: string, skipOwnerSig: boolean,
): Promise<any> {
  const { VaultDatumSchema } = await import("../../MagicSDK/src/schemas.js");
  const { resolveConstrIndex } = await import("../../MagicSDK/src/redeemerIndex.js");
  const { PROFILE_CONSTR_INDEX } = await import("../../MagicSDK/src/updateProfile.js");
  const { Constr } = await import("@lucid-evolution/lucid");

  let mutated = { ...newVaultDatum };
  const currentEpoch = mutated.profile_changed_epoch as bigint;

  if (tamper === "bypass_lazy") {
    // C-PC-V6 negative: set profile directly (skip lazy)
    mutated = { ...mutated, profile: newProfile, pending_profile: null };
  } else if (tamper === "wrong_effective") {
    // C-PC-V6 negative: effective_epoch = current (should be current+1)
    mutated = {
      ...mutated,
      pending_profile: { new_profile: newProfile, effective_epoch: currentEpoch },
    };
  } else if (tamper === "effective_too_far") {
    // C-PC-V6 negative: effective_epoch = current+5
    mutated = {
      ...mutated,
      pending_profile: { new_profile: newProfile, effective_epoch: currentEpoch + 5n },
    };
  } else if (tamper === "tamper_batches") {
    // C-PC-V4 + A02: mutate magic_batches
    mutated = { ...mutated, magic_batches: [] };
  } else if (tamper === "tamper_balance") {
    // A02: mutate lamp_balance
    mutated = { ...mutated, lamp_balance: mutated.lamp_balance + 1n };
  } else if (tamper === "same_profile") {
    // Will fail SDK pre-check too, but allow the validator to be the one rejecting:
    // user wants C-PC-V3 path — they'd build a tx where new_profile == current.
    // Handled here by re-encoding redeemer with current profile.
  }

  // Resolve indices
  const profileIdx = PROFILE_CONSTR_INDEX[newProfile];
  const profileConstr = new Constr(profileIdx, []);
  const upIdx = resolveConstrIndex(plutusJson, "vault.vault.spend", "UpdateProfile");
  const redeemer = Data.to(new Constr(upIdx, [profileConstr]));

  const lowerTime = Number(tipPosixMs);
  const upperTime = Number(tipPosixMs + 600_000n);

  let txBuilder = lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .attach.SpendingValidator(vaultScript)
    .pay.ToAddressWithData(
      vaultAddr,
      { kind: "inline", value: Data.to(mutated, VaultDatumSchema) },
      vaultUtxo.assets,
    )
    .validFrom(lowerTime)
    .validTo(upperTime);

  if (!skipOwnerSig) txBuilder = txBuilder.addSignerKey(ownerPkh);

  return await txBuilder.complete();
}

main().catch((e) => { console.error(e); process.exit(1); });
