// MagicSDK/src/types.ts — public types for createVault and friends
import type { LucidEvolution, TxSignBuilder, Validator } from "@lucid-evolution/lucid";
import type { Network } from "@magiclamp/protocol-utils";
import type { PlutusJson } from "./redeemerIndex.js";

export type Profile = "Ember" | "Flame" | "Lantern";

/**
 * The 4 vault types correspond to 4 different on-chain validators.
 * Each user-mechanism pair lives in its own vault:
 *   - "Snapshot": per-epoch lazy generation (no LAMP cost; T16)
 *   - "Instant":  on-demand purchase (LAMP → Treasury)
 *   - "Vacuum":   2-phase lock-then-fire (LAMP → Treasury at fire)
 *   - "Schedule": forward contract with locked rate (LAMP → Treasury per fire)
 *
 * A user who wants all 4 mechanisms needs 4 separate vaults (4 UTxOs at 4
 * different addresses). The Vault*Datum shape is identical across all 4,
 * but the validator code (and hence the address) differs.
 */
export type VaultType = "Snapshot" | "Instant" | "Vacuum" | "Schedule";

/**
 * Unapplied (raw aiken-built) validator script CBOR strings.
 * Caller is responsible for sourcing these — typically by reading
 * `<Module>/onchain/plutus.json` of the MAGIC repo for the matching
 * `<vaultType>` (and `Shard` for ScheduleGen).
 *
 * Keeping CBOR strings (not file paths) here makes the SDK environment-
 * agnostic: works in Node, browser bundlers, edge runtimes — anywhere
 * Lucid Evolution runs.
 */
export interface ValidatorBundle {
  /** Unapplied vault validator CBOR hex (from plutus.json). */
  vaultUnappliedCbor: string;
  /** Unapplied shard validator CBOR hex (REQUIRED for vaultType "Schedule"). */
  shardUnappliedCbor?: string;
  /** Full plutus.json content for the vault module. REQUIRED for actions that
   *  use a redeemer (withdrawLamp, updateProfile, trigger…) — SDK reads
   *  `validators[].redeemer.schema.$ref` → `definitions[].anyOf[]` to resolve
   *  constructor indices by title. Avoids hardcoded indices that desync when
   *  the Aiken enum reorders. Optional for createVault (no redeemer needed). */
  vaultPlutusJson?: PlutusJson;
  /** Shard module plutus.json (REQUIRED for ScheduleGen actions). */
  shardPlutusJson?: PlutusJson;
}

/**
 * Required network/protocol params that the validator will be applied with.
 * `ms_per_epoch` is auto-derived from `network` if omitted.
 *
 * `treasuryAddress` is the Cardano address that receives transferred LAMP
 * (used by Instant/Vacuum/Schedule). MUST be a separate address from the
 * user's wallet — otherwise the validator's `treasury_receives_lamp` check
 * is vacuously satisfied (wallet change aggregates). Snapshot doesn't need
 * one (T16: no LAMP movement).
 */
export interface ProtocolParams {
  /** "Preview" | "Preprod" | "Mainnet". */
  network: Network;
  /** LAMP minting-policy ID. Required for Instant/Vacuum/Schedule;
   *  required for Snapshot for the vault's LAMP UTxO asset unit. */
  lampPolicyId: string;
  /** LAMP asset name as hex (default "744c414d50" = "tLAMP"). */
  lampAssetName?: string;
  /** UM datum NFT policy ID. Required for Instant + Vacuum. */
  umNftPolicyId?: string;
  /** UM script hash (= applied UMKeeper validator hash). Required for
   *  Instant + Vacuum. Pins the UM reference input to the canonical UM
   *  script address (MAINNET-BLOCK fix, defense-in-depth layer b). */
  umScriptHash?: string;
  /** Shard NFT policy ID. Required for Schedule. */
  shardPolicyId?: string;
  /** Treasury address. Required for Instant + Vacuum + Schedule. */
  treasuryAddress?: string;
  /** Override ms_per_epoch (advanced). Derived from `network` otherwise. */
  msPerEpoch?: bigint;
}

/**
 * Initial vault datum shape — what gets baked into the new vault UTxO.
 * Most fields have sensible defaults; advanced callers can override.
 */
export interface InitialVaultConfig {
  /** Owner payment key hash (28-byte hex). The only key authorized to
   *  sign owner-required actions (TriggerSnapshot, InstantGen,
   *  VacuumCommit, ScheduleCommit, UpdateProfile, BurnBatch). */
  ownerPkh: string;
  /** Initial LAMP locked into the vault, in oildrop (1 LAMP = 10^6 oildrop).
   *  Caller's wallet MUST hold ≥ this amount of LAMP. */
  lampDeposit: bigint;
  /** Profile at creation. Default "Flame". */
  profile?: Profile;
  /** Min-ADA lovelace to attach to vault UTxO (default 2_000_000). */
  vaultLovelace?: bigint;
  /** Optional personal delegate PKH (28-byte hex) — reserved for
   *  future session-key / delegated-signing semantics. Stored in
   *  `personal_delegate` datum field. Default null. */
  personalDelegate?: string | null;
}

/** Inputs to `createVault()`. */
export interface CreateVaultParams {
  /** Lucid Evolution instance with a wallet already selected. */
  lucid: LucidEvolution;
  /** Which mechanism this vault will be used for. */
  vaultType: VaultType;
  /** Network + policy configuration. */
  protocol: ProtocolParams;
  /** Validator script CBOR (unapplied). */
  validators: ValidatorBundle;
  /** Initial vault state. */
  vault: InitialVaultConfig;
  /** Override current epoch derivation (for deterministic tests). */
  tipPosixMs?: bigint;
}

/** Result of `createVault()` — ready for caller to sign + submit. */
export interface CreateVaultResult {
  /** Built tx (TxSignBuilder). Caller calls `.sign.withWallet().complete()` then `.submit()`. */
  tx: TxSignBuilder;
  /** Network-specific vault address (where the vault UTxO will live). */
  vaultAddress: string;
  /** Network-specific vault script hash (after applyParamsToScript). */
  vaultScriptHash: string;
  /** Applied vault script (for downstream tx builders that need
   *  `.attach.SpendingValidator(vaultScript)`). */
  vaultScript: Validator;
  /** Human-readable summary for logs / UI. */
  summary: string;
}
