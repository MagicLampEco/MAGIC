// scripts/verify_per_network.ts — Verify applied vault hash per network for all live modules.
//
// Run AFTER `aiken build` in each module (Instant/Schedule/UMKeeper).
// Outputs a table: for each module × network, prints the applied script hash so
// you can cross-check before deploying.
//
// Run:
//   npx tsx verify_per_network.ts
//
// Optional env (only needed for actual mainnet deploy verification — runtime
// params for Instant/Schedule validators):
//   LAMP_POLICY_ID    LAMP minting policy (56-hex)
//   UM_NFT_POLICY_ID  UM NFT policy (56-hex)
//   SHARD_NFT_POLICY_ID Shard NFT policy (56-hex)
//
// If env vars missing, uses placeholder values — output hash is for SHAPE check
// (does this build produce a deterministic per-network hash?), NOT for deploy.

import {
  applyParamsToScript, validatorToScriptHash,
  Data,
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

const LAMP_POLICY   = process.env.LAMP_POLICY_ID     ?? PLACEHOLDER_POLICY;
const UM_NFT_POLICY = process.env.UM_NFT_POLICY_ID   ?? PLACEHOLDER_POLICY;
const SHARD_POLICY  = process.env.SHARD_NFT_POLICY_ID ?? PLACEHOLDER_POLICY;
// PHA 2 — Instant needs the UM script hash + the §6.3 BackingBeacon pins.
const UM_SCRIPT_HASH      = process.env.UM_DATUM_HASH       ?? PLACEHOLDER_POLICY;
const BACKING_POLICY      = process.env.BACKING_NFT_POLICY_ID ?? "00".repeat(28);
const BACKING_SCRIPT_HASH = process.env.BACKING_SCRIPT_HASH   ?? "00".repeat(28);

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

// SnapshotGen/VacuumGen đã dời sang Legacy/genmagic-v3.3 (mô hình GenMAGIC v3.3,
// đã bỏ) — không verify hash cho hai module đó nữa.
const MODULES: ModuleSpec[] = [
  {
    name:      "InstantGen",
    plutusPath: "../InstantGen/onchain/plutus.json",
    title:     "vault.vault.spend",
    // PHA 2 — 6 params, treasury_addr removed (I-ACT-7), beacon pins added (§6.3)
    buildParams: (msPer) => [
      LAMP_POLICY,
      UM_NFT_POLICY,
      UM_SCRIPT_HASH,
      BACKING_POLICY,
      BACKING_SCRIPT_HASH,
      msPer,
    ],
  },
  {
    name:      "ScheduleGen",
    plutusPath: "../ScheduleGen/onchain/plutus.json",
    title:     "vault.vault.spend",
    // PHA 2 — 3 params, treasury_addr removed (I-ACT-7)
    buildParams: (msPer) => [
      LAMP_POLICY,
      SHARD_POLICY,
      msPer,
    ],
  },
  {
    name:      "UMKeeper",
    plutusPath: "../UMKeeper/onchain/plutus.json",
    title:     "um_datum.um_datum_validator.spend",
    buildParams: (msPer) => [msPer],
  },
];

// ── Run ──────────────────────────────────────────────────────────
async function main() {
  console.log("MagicLamp validator hash — per network × module verification\n");

  if (LAMP_POLICY === PLACEHOLDER_POLICY) {
    console.log("⚠  Using PLACEHOLDER policy IDs — hashes here are for SHAPE check only.");
    console.log("   For real deploy verification, set: LAMP_POLICY_ID UM_NFT_POLICY_ID SHARD_NFT_POLICY_ID\n");
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
