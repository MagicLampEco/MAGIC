// MagicSDK/src/validatorScripts.ts — apply ms_per_epoch + other params per vault type
//
// Each of the 4 vault validators takes a DIFFERENT set of compile-time parameters:
//   Snapshot: vault(ms_per_epoch)
//   Instant:  vault(lamp_policy_id, treasury_addr, um_nft_policy, um_script_hash, ms_per_epoch)
//   Vacuum:   vault(lamp_policy_id, treasury_addr, um_nft_policy, um_script_hash, ms_per_epoch)
//   Schedule: vault(lamp_policy_id, treasury_addr, shard_policy_id, ms_per_epoch)
//
// `um_script_hash` pins the UM reference input to the canonical UM script
// address (MAINNET-BLOCK fix, defense-in-depth layer b).
//
// `applyParamsToScript` bakes them into the CBOR → produces a network-specific
// validator hash. The hash defines the on-chain address, so every consumer
// (vault creation, snapshot, instant, etc.) MUST use the same applied script.

import {
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  Constr, Data, getAddressDetails,
  type Validator,
} from "@lucid-evolution/lucid";
import { msPerEpoch } from "@magiclamp/protocol-utils";
import type { ProtocolParams, ValidatorBundle, VaultType } from "./types.js";

/**
 * Build the applied vault Validator for a given vault type + protocol params.
 * Returns the Validator (CBOR + type tag) and its derived address+hash.
 */
export function applyVaultValidator(
  vaultType : VaultType,
  validators: ValidatorBundle,
  protocol  : ProtocolParams,
): { vaultScript: Validator; vaultScriptHash: string; vaultAddress: string } {
  const msPer = protocol.msPerEpoch ?? msPerEpoch(protocol.network);
  const params = buildParamsList(vaultType, protocol, msPer);

  const appliedCbor = applyParamsToScript(validators.vaultUnappliedCbor, params);
  const vaultScript: Validator = { type: "PlutusV3", script: appliedCbor };
  const vaultScriptHash = validatorToScriptHash(vaultScript);
  const vaultAddress = credentialToAddress(
    protocol.network,
    scriptHashToCredential(vaultScriptHash),
  );

  return { vaultScript, vaultScriptHash, vaultAddress };
}

/**
 * Build the applied shard Validator (only meaningful for ScheduleGen).
 * Shard validator currently takes 0 params, so applied == unapplied.
 */
export function applyShardValidator(
  validators: ValidatorBundle,
  protocol  : ProtocolParams,
): { shardScript: Validator; shardScriptHash: string; shardAddress: string } {
  if (!validators.shardUnappliedCbor) {
    throw new Error("shardUnappliedCbor required when vaultType=Schedule");
  }
  // Shard validator has no compile-time params; apply with [] for symmetry.
  const appliedCbor = applyParamsToScript(validators.shardUnappliedCbor, []);
  const shardScript: Validator = { type: "PlutusV3", script: appliedCbor };
  const shardScriptHash = validatorToScriptHash(shardScript);
  const shardAddress = credentialToAddress(
    protocol.network,
    scriptHashToCredential(shardScriptHash),
  );
  return { shardScript, shardScriptHash, shardAddress };
}

// ── internals ────────────────────────────────────────────────

function buildParamsList(
  vaultType: VaultType,
  protocol : ProtocolParams,
  msPer    : bigint,
): Data[] {
  switch (vaultType) {
    case "Snapshot":
      // vault(ms_per_epoch)
      return [msPer];

    case "Instant":
    case "Vacuum": {
      // vault(lamp_policy_id, treasury_addr, um_nft_policy, um_script_hash, ms_per_epoch)
      requireField(protocol.umNftPolicyId, "umNftPolicyId", vaultType);
      requireField(protocol.umScriptHash, "umScriptHash", vaultType);
      requireField(protocol.treasuryAddress, "treasuryAddress", vaultType);
      return [
        protocol.lampPolicyId,
        addressToPlutusData(protocol.treasuryAddress!),
        protocol.umNftPolicyId!,
        protocol.umScriptHash!,   // um_script_hash — pins UM ref input (layer b)
        msPer,
      ];
    }

    case "Schedule": {
      // vault(lamp_policy_id, treasury_addr, shard_policy_id, ms_per_epoch)
      requireField(protocol.shardPolicyId, "shardPolicyId", "Schedule");
      requireField(protocol.treasuryAddress, "treasuryAddress", "Schedule");
      return [
        protocol.lampPolicyId,
        addressToPlutusData(protocol.treasuryAddress!),
        protocol.shardPolicyId!,
        msPer,
      ];
    }
  }
}

function requireField(v: unknown, name: string, vaultType: string): void {
  if (!v) throw new Error(`${name} required for vaultType="${vaultType}"`);
}

/**
 * Encode a bech32 Cardano address as Plutus Address Constr.
 * Aiken `Address` = Constr 0 { payment_credential, stake_credential? } where
 *   payment_credential = Constr 0 (key_hash) | Constr 1 (script_hash)
 *   stake_credential   = None | Some(Constr 0 (Constr 0 / 1 (hash)))
 *
 * For treasury addresses (typically `addr_test1v...` = key-only or simple),
 * we extract the payment credential and serialize with no stake credential.
 */
function addressToPlutusData(addressBech32: string): Data {
  const details = getAddressDetails(addressBech32);
  const pc = details.paymentCredential;
  if (!pc) throw new Error(`addressToPlutusData: no payment credential in ${addressBech32}`);
  const sc = details.stakeCredential;

  // Payment credential: Constr 0 (Key) or Constr 1 (Script)
  const paymentData = pc.type === "Key"
    ? new Constr(0, [pc.hash])
    : new Constr(1, [pc.hash]);

  // Stake credential: None (Constr 1) or Some(Constr 0 (Inline (Constr 0 (Constr 0/1 hash))))
  // Most validator params accept the simplified shape; if Aiken uses
  // Address { payment_credential, stake_credential }, omit stake by passing None.
  const stakeData = sc
    ? new Constr(0, [new Constr(0, [
        sc.type === "Key" ? new Constr(0, [sc.hash]) : new Constr(1, [sc.hash]),
      ])])
    : new Constr(1, []);

  return new Constr(0, [paymentData, stakeData]);
}
