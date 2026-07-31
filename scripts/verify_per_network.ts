// scripts/verify_per_network.ts — Verify applied vault hash per network for all 5 modules.
//
// Run AFTER `aiken build` in each module (Snapshot/Instant/Vacuum/Schedule/UMKeeper).
// Outputs a table: for each module × network, prints the applied script hash so
// you can cross-check before deploying.
//
// Run:
//   npx tsx verify_per_network.ts
//
// Optional env (only needed for actual mainnet deploy verification — runtime
// params for Instant/Vacuum/Schedule validators that take 4 params):
//   LAMP_POLICY_ID    LAMP minting policy (56-hex)
//   TREASURY_ADDRESS  Treasury bech32 address (separate from wallet!)
//   UM_NFT_POLICY_ID  UM NFT policy (56-hex)
//   SHARD_NFT_POLICY_ID Shard NFT policy (56-hex)
//
// If env vars missing, uses placeholder values — output hash is for SHAPE check
// (does this build produce a deterministic per-network hash?), NOT for deploy.

import {
  applyParamsToScript, validatorToScriptHash,
  Constr, Data, getAddressDetails,
  type Validator,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";

// ── Network × ms_per_epoch ───────────────────────────────────────
const NETWORKS = [
  { name: "Preview", msPerEpoch: 86_400_000n },
  { name: "Preprod", msPerEpoch: 86_400_000n },
  { name: "Mainnet", msPerEpoch: 432_000_000n },
] as const;

// ── Placeholder values when env vars absent (shape check only) ──
const PLACEHOLDER_POLICY  = "00".repeat(28);   // 28-byte zero policy id
const PLACEHOLDER_ADDRESS = "addr_test1vp00000000000000000000000000000000000000000000000000000000000000000";

const LAMP_POLICY   = process.env.LAMP_POLICY_ID     ?? PLACEHOLDER_POLICY;
const UM_NFT_POLICY = process.env.UM_NFT_POLICY_ID   ?? PLACEHOLDER_POLICY;
const SHARD_POLICY  = process.env.SHARD_NFT_POLICY_ID ?? PLACEHOLDER_POLICY;
const TREASURY_ADDR = process.env.TREASURY_ADDRESS   ?? PLACEHOLDER_ADDRESS;

/** Encode bech32 address as Plutus Constr (Address { paymentCredential, stakeCredential? }). */
function addressToPlutusData(addressBech32: string): Data {
  try {
    const details = getAddressDetails(addressBech32);
    const pc = details.paymentCredential;
    if (!pc) throw new Error("no payment credential");
    const sc = details.stakeCredential;
    const paymentData = pc.type === "Key"
      ? new Constr(0, [pc.hash])
      : new Constr(1, [pc.hash]);
    const stakeData = sc
      ? new Constr(0, [new Constr(0, [
          sc.type === "Key" ? new Constr(0, [sc.hash]) : new Constr(1, [sc.hash]),
        ])])
      : new Constr(1, []);
    return new Constr(0, [paymentData, stakeData]);
  } catch {
    // Placeholder address may not parse — fall back to zero-bytes payment credential.
    return new Constr(0, [new Constr(0, ["00".repeat(28)]), new Constr(1, [])]);
  }
}

// ── Module table — must match `<Module>/onchain/plutus.json` + Aiken validator() signature ──
interface ModuleSpec {
  name:      string;
  /** Path to plutus.json (relative to this script). */
  plutusPath: string;
  /** Validator title in plutus.json (Aiken: `validator vault { spend ... }` → "vault.vault.spend"). */
  title:     string;
  /** Build the param list (in Aiken declaration order) given an ms_per_epoch. */
  buildParams: (msPer: bigint) => Data[];
}

const MODULES: ModuleSpec[] = [
  {
    name:      "SnapshotGen",
    plutusPath: "../Legacy/stale-genmodel-2026-07/SnapshotGen/onchain/plutus.json",
    title:     "vault.vault.spend",
    buildParams: (msPer) => [msPer],
  },
  {
    name:      "InstantGen",
    plutusPath: "../Legacy/stale-genmodel-2026-07/InstantGen/onchain/plutus.json",
    title:     "vault.vault.spend",
    buildParams: (msPer) => [
      LAMP_POLICY,
      addressToPlutusData(TREASURY_ADDR),
      UM_NFT_POLICY,
      msPer,
    ],
  },
  {
    name:      "VacuumGen",
    plutusPath: "../Legacy/VacuumGen/onchain/plutus.json",
    title:     "vault.vault.spend",
    buildParams: (msPer) => [
      LAMP_POLICY,
      addressToPlutusData(TREASURY_ADDR),
      UM_NFT_POLICY,
      msPer,
    ],
  },
  {
    name:      "ScheduleGen",
    plutusPath: "../ScheduleGen/onchain/plutus.json",
    title:     "vault.vault.spend",
    buildParams: (msPer) => [
      LAMP_POLICY,
      addressToPlutusData(TREASURY_ADDR),
      SHARD_POLICY,
      msPer,
    ],
  },
  {
    name:      "UMKeeper",
    plutusPath: "../Legacy/UMKeeper/onchain/plutus.json",
    title:     "um_datum.um_datum_validator.spend",
    buildParams: (msPer) => [msPer],
  },
];

// ── Run ──────────────────────────────────────────────────────────
async function main() {
  console.log("MagicLamp validator hash — per network × module verification\n");

  if (LAMP_POLICY === PLACEHOLDER_POLICY) {
    console.log("⚠  Using PLACEHOLDER policy IDs / treasury — hashes here are for SHAPE check only.");
    console.log("   For real deploy verification, set: LAMP_POLICY_ID UM_NFT_POLICY_ID SHARD_NFT_POLICY_ID TREASURY_ADDRESS\n");
  }

  for (const mod of MODULES) {
    console.log(`── ${mod.name} (${mod.plutusPath}) ─────────────────────────`);

    let plutus: any;
    try {
      plutus = JSON.parse(await readFile(new URL(mod.plutusPath, import.meta.url), "utf8"));
    } catch (e: any) {
      console.log(`  ❌ Cannot load plutus.json — run \`aiken build\` in ${mod.name}/onchain first.\n`);
      continue;
    }

    const unapplied = plutus.validators.find((v: any) => v.title === mod.title);
    if (!unapplied) {
      console.log(`  ❌ validator "${mod.title}" not found in ${mod.plutusPath}\n`);
      continue;
    }

    console.log(`  unapplied hash:  ${unapplied.hash}`);

    for (const { name, msPerEpoch } of NETWORKS) {
      try {
        const params  = mod.buildParams(msPerEpoch);
        const applied = applyParamsToScript(unapplied.compiledCode, params);
        const script: Validator = { type: "PlutusV3", script: applied };
        const hash    = validatorToScriptHash(script);
        console.log(`  ${name.padEnd(8)} → ${hash}`);
      } catch (e: any) {
        console.log(`  ${name.padEnd(8)} → ❌ apply failed: ${e.message}`);
      }
    }
    console.log();
  }

  console.log("✓ Done. Cross-check hashes against deployed validator addresses before submitting tx.");
}

main().catch((e) => { console.error(e); process.exit(1); });
