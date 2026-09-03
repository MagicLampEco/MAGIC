// scripts/test/multi_vault_only.ts — multi-vault scenarios on Preview testnet.
// Maps V1_TESTNET_PLAN §5 case matrix (4 case):
//
//   MV-1: 2 Instant vaults same address — discovery liệt kê đủ, không lẫn vault
//   MV-2: 2 vaults with different profiles (Flame vs Ember) — M differs
//   MV-3: Instant + Schedule vaults — withdraw from Instant only
//   MV-4: 3 Instant vaults — UpdateProfile vault 1 only (pending set only on vault 1)
//
// SnapshotGen/VacuumGen đã dời sang Legacy/genmagic-v3.3 (mô hình GenMAGIC v3.3,
// đã bỏ) — các case trước đây chạy trên vault Snapshot nay chạy trên vault Instant.
//
// Each case is a discovery + isolation assertion — the script does NOT auto-create
// vaults; you must have deployed N vaults beforehand (e.g. running
// deploy:instant-vault twice, then deploy:schedule-vault once).
//
//   NETWORK=Preview CASE=mv1 npm run test:multi-vault
//   NETWORK=Preview CASE=mv2 npm run test:multi-vault
//   NETWORK=Preview CASE=mv3 npm run test:multi-vault
//   NETWORK=Preview CASE=mv4 npm run test:multi-vault

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
  PROTOCOL, POLICY_IDS, ASSET_NAMES, SCRIPT_HASHES,
} from "../config.js";
import { withdrawLamp } from "../../MagicSDK/src/withdrawLamp.js";
import { updateProfile } from "../../MagicSDK/src/updateProfile.js";
import { listVaultsForOwner } from "../../MagicSDK/src/listVaults.js";
import { applyVaultValidator } from "../../MagicSDK/src/validatorScripts.js";
import { VaultDatumSchema } from "../../MagicSDK/src/schemas.js";
import type { Profile, ProtocolParams, ValidatorBundle, VaultType } from "../../MagicSDK/src/types.js";

async function fetchTip(): Promise<{ posixMs: bigint }> {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await res.json() as { time: number };
  return { posixMs: BigInt(tip.time) * 1000n };
}

interface ModuleBundle {
  vaultType: VaultType;
  plutusJsonPath: string;
}

const MODULES: ModuleBundle[] = [
  { vaultType: "Instant",  plutusJsonPath: "../../InstantGen/onchain/plutus.json" },
  { vaultType: "Schedule", plutusJsonPath: "../../ScheduleGen/onchain/plutus.json" },
];

async function loadValidators(spec: ModuleBundle): Promise<{
  plutusJson: any;
  bundle: ValidatorBundle;
}> {
  const plutusJson = JSON.parse(await readFile(new URL(spec.plutusJsonPath, import.meta.url), "utf8"));
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) throw new Error(`vault.vault.spend not found in ${spec.plutusJsonPath}`);
  return {
    plutusJson,
    bundle: { vaultUnappliedCbor: unapplied.compiledCode },
  };
}

function buildProtocol(): ProtocolParams {
  return {
    network: NETWORK,
    lampPolicyId: POLICY_IDS.lamp,
    lampAssetName: ASSET_NAMES.lamp,
    umNftPolicyId: POLICY_IDS.um_nft,
    umScriptHash: SCRIPT_HASHES.um_datum,
    // Không truyền treasuryAddress: dưới I-ACT-7 không handler nào của vault
    // Instant/Schedule chuyển LAMP, nên không còn tham số Treasury.
    shardPolicyId: POLICY_IDS.shard_nft,
    // §6.3 BackingBeacon pins (Instant). All-zero default ⟹ Gen shut.
    backingNftPolicyId: POLICY_IDS.backing,
    backingScriptHash: SCRIPT_HASHES.backing_beacon,
  };
}

async function main() {
  const caseName = (process.env.CASE ?? "mv1").toLowerCase();

  console.log("╔════════════════════════════════════════════╗");
  console.log(`║  Multi-vault scenario — ${caseName.padEnd(17)} ║`);
  console.log("╚════════════════════════════════════════════╝\n");

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("No payment credential");
  const ownerPkh = paymentCredential.hash;

  const protocol = buildProtocol();
  const tip = await fetchTip();

  switch (caseName) {
    case "mv1":
      await runMv1(lucid, ownerPkh, protocol, tip);
      break;
    case "mv2":
      await runMv2(lucid, ownerPkh, protocol, tip);
      break;
    case "mv3":
      await runMv3(lucid, ownerPkh, protocol, tip, address);
      break;
    case "mv4":
      await runMv4(lucid, ownerPkh, protocol, tip);
      break;
    default:
      throw new Error(`Unknown CASE=${caseName}. Use mv1|mv2|mv3|mv4.`);
  }
}

// MV-1: ≥2 Instant vaults cùng một script address — discovery phải liệt kê đủ,
// mỗi vault có tuổi loyalty / profile độc lập.
//
// Chân "trigger 1 vault rồi soi vault kia không đổi" trước đây chạy qua
// buildSnapshotGenTx của SnapshotGen; module đó đã dời sang
// Legacy/genmagic-v3.3 (mô hình GenMAGIC v3.3, đã bỏ). Chân sinh MAGIC hiện
// hành nằm ở `npm run test:instant` — chạy nó trên vault 1 rồi truy vấn lại để
// khẳng định vault 2 không đổi.
async function runMv1(lucid: any, ownerPkh: string, protocol: ProtocolParams, tip: { posixMs: bigint }) {
  const { bundle } = await loadValidators(MODULES[0]);
  const vaults = await listVaultsForOwner({
    lucid, vaultType: "Instant", protocol, validators: bundle, ownerPkh,
  });

  console.log(`Instant vaults discovered: ${vaults.length}`);
  if (vaults.length < 2) {
    console.error("❌ MV-1 needs ≥2 Instant vaults. Run deploy:instant-vault twice.");
    process.exit(1);
  }

  for (const v of vaults) {
    console.log(`  - ${v.vaultId.slice(0, 16)}...  balance=${v.lampBalanceOildrop / 1_000_000n} LAMP  profile=${v.profile}  oldest=ep${v.oldestEpoch}`);
  }

  const v1 = vaults[0];
  const v2BalanceBefore = vaults[1].datum.lamp_balance;

  console.log(`\n✓ Discovery isolation OK — ${vaults.length} vault riêng biệt cùng địa chỉ.`);
  console.log(`  Vault 1: ${v1.vaultId}`);
  console.log(`  Vault 2 balance: ${v2BalanceBefore / 1_000_000n} LAMP`);
  console.log(`\n→ Chân on-chain: VAULT_TX_HASH=${v1.utxo.txHash} npm run test:instant`);
  console.log(`  rồi chạy lại case này để khẳng định vault 2 giữ nguyên balance trên.`);
}

// MV-2: 2 vaults with different profiles — both trigger, expect different M.
async function runMv2(lucid: any, ownerPkh: string, protocol: ProtocolParams, tip: { posixMs: bigint }) {
  const { bundle } = await loadValidators(MODULES[0]);
  const vaults = await listVaultsForOwner({
    lucid, vaultType: "Instant", protocol, validators: bundle, ownerPkh,
  });

  const profiles = new Set(vaults.map(v => v.profile));
  if (profiles.size < 2) {
    console.error("❌ MV-2 needs ≥2 Instant vaults with DIFFERENT profiles.");
    console.error(`   Found profiles: ${[...profiles].join(", ")}`);
    process.exit(1);
  }

  console.log(`✓ Profile diversity verified: ${[...profiles].join(", ")}`);
  console.log(`  Discovery alone exercises MV-2 — actual M difference is observable`);
  console.log(`  by generating on each vault then comparing batch.initial_amount.`);

  for (const v of vaults) {
    console.log(`  - ${v.vaultId.slice(0, 16)}...  profile=${v.profile}  balance=${v.lampBalanceOildrop / 1_000_000n} LAMP`);
  }
}

// MV-3: Instant + Schedule vaults — withdraw from Instant only, expect Schedule untouched.
async function runMv3(lucid: any, ownerPkh: string, protocol: ProtocolParams, tip: { posixMs: bigint }, address: string) {
  const { bundle: instBundle, plutusJson: instPlutus } = await loadValidators(MODULES[0]);
  const { bundle: schedBundle } = await loadValidators(MODULES[1]);

  const instVaults = await listVaultsForOwner({
    lucid, vaultType: "Instant", protocol, validators: instBundle, ownerPkh,
  });
  const schedVaults = await listVaultsForOwner({
    lucid, vaultType: "Schedule", protocol, validators: schedBundle, ownerPkh,
  });

  if (instVaults.length === 0 || schedVaults.length === 0) {
    console.error(`❌ MV-3 needs ≥1 Instant + ≥1 Schedule vault. Instant=${instVaults.length}, Schedule=${schedVaults.length}`);
    process.exit(1);
  }

  const instVault  = instVaults[0];
  const schedVault = schedVaults[0];
  const schedLampBefore = schedVault.datum.lamp_balance;

  console.log(`Instant vault:  ${instVault.vaultId.slice(0, 16)}... balance=${instVault.lampBalanceOildrop / 1_000_000n} LAMP`);
  console.log(`Schedule vault: ${schedVault.vaultId.slice(0, 16)}... balance=${schedLampBefore / 1_000_000n} LAMP (must be unchanged)`);
  console.log();

  const amountLamp = BigInt(process.env.AMOUNT_LAMP ?? "5");
  const amountOildrop = amountLamp * 1_000_000n;
  const { vaultScript } = applyVaultValidator("Instant", instBundle, protocol);

  const result = await withdrawLamp({
    lucid,
    vaultUtxo: instVault.utxo,
    amountOildrop,
    vaultScript,
    vaultType: "Instant",
    vaultPlutusJson: instPlutus,
    network: NETWORK,
    lampPolicyId: POLICY_IDS.lamp,
    lampAssetName: ASSET_NAMES.lamp,
    destinationAddress: address,
    tipPosixMs: tip.posixMs,
  });

  const signed = await result.tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`✓ Withdrew ${amountLamp} LAMP from Instant vault: ${txHash}`);
  console.log(`  Schedule vault expected unchanged — re-query post-finality to verify.`);
}

// MV-4: 3 Instant vaults — UpdateProfile vault 1 → pending set only on vault 1.
async function runMv4(lucid: any, ownerPkh: string, protocol: ProtocolParams, tip: { posixMs: bigint }) {
  const { bundle, plutusJson } = await loadValidators(MODULES[0]);
  const vaults = await listVaultsForOwner({
    lucid, vaultType: "Instant", protocol, validators: bundle, ownerPkh,
  });

  if (vaults.length < 3) {
    console.error(`❌ MV-4 needs ≥3 Instant vaults. Found ${vaults.length}.`);
    process.exit(1);
  }

  const v1 = vaults[0];
  console.log(`Total vaults: ${vaults.length}`);
  console.log(`Targeting vault 1: ${v1.vaultId.slice(0, 16)}...`);
  console.log(`Vault 1 profile before: ${v1.profile}`);

  // Choose a NEW profile different from current
  const newProfile: Profile = v1.profile === "Ember" ? "Flame" : "Ember";

  const { vaultScript } = applyVaultValidator("Instant", bundle, protocol);
  const result = await updateProfile({
    lucid,
    vaultUtxo: v1.utxo,
    newProfile,
    vaultScript,
    vaultType: "Instant",
    vaultPlutusJson: plutusJson,
    network: NETWORK,
    tipPosixMs: tip.posixMs,
  });

  const signed = await result.tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`✓ UpdateProfile vault 1 → ${newProfile}: ${txHash}`);
  console.log(`  Vault 2, 3 expected: profile unchanged, pending_profile = None.`);
  console.log(`  Re-query post-finality and assert: only vault 1's pending_profile is Some(...).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
