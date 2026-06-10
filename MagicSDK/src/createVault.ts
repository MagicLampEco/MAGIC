// MagicSDK/src/createVault.ts — public entry point for vault creation
//
// Builds an UNSIGNED tx that pays LAMP into a new vault UTxO with a clean
// initial datum. Caller signs + submits.
//
// Usage (PhoenixKey-style integration):
//
//   import { createVault } from "@magiclamp/sdk";
//   import { readFile } from "node:fs/promises";
//
//   // 1. Load the unapplied vault validator CBOR (from MAGIC repo build output).
//   const snapshotPlutus = JSON.parse(await readFile("path/to/SnapshotGen/onchain/plutus.json", "utf8"));
//   const vaultUnappliedCbor = snapshotPlutus.validators.find(
//     v => v.title === "vault.vault.spend"
//   ).compiledCode;
//
//   // 2. Build the unsigned tx.
//   const { tx, vaultAddress, summary } = await createVault({
//     lucid,                  // Lucid Evolution with wallet selected
//     vaultType: "Snapshot",
//     protocol: {
//       network: "Preview",
//       lampPolicyId: "...",
//     },
//     validators: { vaultUnappliedCbor },
//     vault: {
//       ownerPkh: "<28-byte hex>",
//       lampDeposit: 1_000_000_000n,   // 1000 LAMP in oil
//       profile: "Flame",
//     },
//   });
//   console.log(summary);
//
//   // 3. Sign + submit (PhoenixKey's wallet abstraction does this).
//   const signed = await tx.sign.withWallet().complete();
//   const txHash = await signed.submit();

import { Data, toUnit } from "@lucid-evolution/lucid";
import { msPerEpoch, type Network } from "@magiclamp/protocol-utils";

import type { CreateVaultParams, CreateVaultResult } from "./types.js";
import { VaultDatumSchema } from "./schemas.js";
import { applyVaultValidator } from "./validatorScripts.js";
import { buildInitialVaultDatum } from "./vaultDatum.js";

const DEFAULT_LAMP_ASSET_NAME = "744c414d50"; // "tLAMP" in hex
const DEFAULT_VAULT_LOVELACE  = 2_000_000n;
const DEFAULT_PROFILE         = "Flame" as const;

export async function createVault(params: CreateVaultParams): Promise<CreateVaultResult> {
  const { lucid, vaultType, protocol, validators, vault } = params;

  // ── Defaults ─────────────────────────────────────────────────
  const lampAssetName = protocol.lampAssetName ?? DEFAULT_LAMP_ASSET_NAME;
  const vaultLovelace = vault.vaultLovelace ?? DEFAULT_VAULT_LOVELACE;
  const profile       = vault.profile ?? DEFAULT_PROFILE;

  // ── Sanity checks ────────────────────────────────────────────
  if (!protocol.lampPolicyId) {
    throw new Error("protocol.lampPolicyId is required");
  }
  if (vault.lampDeposit <= 0n) {
    throw new Error(`vault.lampDeposit must be > 0 oil (got ${vault.lampDeposit})`);
  }
  // Per-vault-type sanity is enforced inside applyVaultValidator.

  // ── Apply validator per-network → vault address ──────────────
  const { vaultScript, vaultScriptHash, vaultAddress } = applyVaultValidator(
    vaultType, validators, protocol,
  );

  // ── Current PROTOCOL epoch ────────────────────────────────────
  // Validator computes epoch = posix_ms / ms_per_epoch. Initial datum's
  // `last_updated_epoch` should match the current epoch so that snapshot
  // can fire from the NEXT epoch boundary.
  const tipPosixMs   = params.tipPosixMs ?? BigInt(Date.now());
  const msPer        = protocol.msPerEpoch ?? msPerEpoch(protocol.network);
  const currentEpoch = tipPosixMs / msPer;

  // ── Verify caller's wallet has enough LAMP ───────────────────
  const lampUnit = toUnit(protocol.lampPolicyId, lampAssetName);
  const walletAddress = await lucid.wallet().address();
  const walletUtxos   = await lucid.wallet().getUtxos();
  const lampBalance   = walletUtxos.reduce(
    (s, u) => s + (u.assets[lampUnit] ?? 0n), 0n,
  );
  if (lampBalance < vault.lampDeposit) {
    throw new Error(
      `Wallet has ${lampBalance} oil LAMP (= ${lampBalance / 1_000_000n} LAMP); ` +
      `need ${vault.lampDeposit} oil (= ${vault.lampDeposit / 1_000_000n} LAMP).`,
    );
  }

  // ── Build initial VaultDatum ─────────────────────────────────
  const initialVault = buildInitialVaultDatum({
    ownerPkh:         vault.ownerPkh,
    lampBalanceOil:   vault.lampDeposit,
    profile,
    currentEpoch,
    personalDelegate: vault.personalDelegate ?? null,
  });

  // Lucid Evolution's Data.to expects a TObject-typed value; the
  // plain-bigint shape from buildInitialVaultDatum() is structurally
  // compatible at runtime but the inferred TS type doesn't match the
  // schema's TUnsafe<...> wrappers. Cast — same workaround used by
  // every other vault SDK in this repo (snapshot.ts, instant.ts, ...).
  const vaultDatumCbor = Data.to(initialVault as never, VaultDatumSchema);

  // ── Build tx: pay LAMP + lovelace to vault address with inline datum ─
  const tx = await lucid
    .newTx()
    .pay.ToAddressWithData(
      vaultAddress,
      { kind: "inline", value: vaultDatumCbor },
      { lovelace: vaultLovelace, [lampUnit]: vault.lampDeposit },
    )
    .complete();

  const summary = formatSummary({
    vaultType,
    network: protocol.network,
    walletAddress,
    vaultAddress,
    vaultScriptHash,
    ownerPkh: vault.ownerPkh,
    profile,
    lampDeposit: vault.lampDeposit,
    currentEpoch,
  });

  return { tx, vaultAddress, vaultScriptHash, vaultScript, summary };
}

// ── helpers ───────────────────────────────────────────────────

function formatSummary(o: {
  vaultType:        string;
  network:          Network;
  walletAddress:    string;
  vaultAddress:     string;
  vaultScriptHash:  string;
  ownerPkh:         string;
  profile:          string;
  lampDeposit:      bigint;
  currentEpoch:     bigint;
}): string {
  return [
    `═══ MagicLamp createVault ═══`,
    `Vault type:      ${o.vaultType}  (${o.network})`,
    `Owner pkh:       ${o.ownerPkh}`,
    `Profile:         ${o.profile}`,
    `LAMP deposit:    ${o.lampDeposit / 1_000_000n} LAMP (${o.lampDeposit} oil)`,
    `Current epoch:   ${o.currentEpoch}  (POSIX-derived)`,
    `Vault address:   ${o.vaultAddress}`,
    `Vault hash:      ${o.vaultScriptHash}`,
    `Wallet (funder): ${o.walletAddress}`,
    ``,
    `✓  Unsigned tx ready. Caller must sign + submit.`,
  ].join("\n");
}

// ── re-exports for convenience ────────────────────────────────
export { applyVaultValidator, applyShardValidator } from "./validatorScripts.js";
export { buildInitialVaultDatum } from "./vaultDatum.js";
export { VaultDatumSchema } from "./schemas.js";
export type {
  Profile, VaultType, ProtocolParams, ValidatorBundle,
  InitialVaultConfig, CreateVaultParams, CreateVaultResult,
} from "./types.js";
