// MagicSDK/src/validatorScripts.ts — apply ms_per_epoch + other params per vault type
//
// Each of the 2 live vault validators takes a DIFFERENT set of compile-time
// parameters. SOURCE OF TRUTH = the `validator vault(...)` header in each module;
// this table must be read off those files, never from memory:
//   Instant:  vault(lamp_policy_id, lamp_asset_name, um_nft_policy, um_script_hash,
//                   backing_nft_policy, backing_script_hash, ms_per_epoch)
//              ← InstantGen/onchain/validators/vault.ak
//   Schedule: vault(lamp_policy_id, lamp_asset_name, shard_policy_id, ms_per_epoch)
//              ← ScheduleGen/onchain/validators/vault.ak
//
// Snapshot và Vacuum không có mặt ở đây vì validator của chúng đã dời sang
// `Legacy/genmagic-v3.3/`. Đừng thêm case cho chúng nếu không kèm validator sống.
//
// `lamp_asset_name` is param #2 on EVERY vault (INV-VAULT-IDENTITY commit): the
// validator compares the vault's LAMP holding by (policy, asset_name), and the
// asset name differs per network ("tLAMP" on testnets, "LAMP" on mainnet). It is
// derived from `protocol.network`, never defaulted to a testnet literal.
//
// PHA 2 removed `treasury_addr` from Instant and Schedule: under I-ACT-7 no
// handler in those validators moves LAMP, so the parameter had no reader left.
// The only validator that ever took it (Vacuum) is now legacy — hence no
// `treasuryAddress` on ProtocolParams and no address→PlutusData encoder here.
//
// `um_script_hash` pins the UM reference input to the canonical UM script
// address (MAINNET-BLOCK fix, defense-in-depth layer b); `backing_script_hash`
// does the same for the BackingBeacon (§6.3).
//
// `applyParamsToScript` bakes them into the CBOR → produces a network-specific
// validator hash. The hash defines the on-chain address, so every consumer
// (vault creation, instant gen, schedule commit/fire) MUST use the same applied
// script.

import {
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  Data,
  type Validator,
} from "@lucid-evolution/lucid";
import { msPerEpoch, lampAssetName } from "@magiclamp/protocol-utils";
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
 *
 * `validator shard(shard_policy_id_param: PolicyId)` — MỘT tham số, không phải
 * không. Xem `ScheduleGen/onchain/validators/vault.ak`, khai báo `validator shard`.
 * Trước đây hàm này apply `[]`: `applyParamsToScript` không kiểm arity nên vẫn ra
 * một hash trông hợp lệ, chỉ khác hash thật mà `scripts/deploy/03_deploy_shards.ts`
 * đã dùng để đặt 16 shard UTxO ⇒ mọi ScheduleFire dựng qua SDK đính sai địa chỉ
 * shard và không tìm thấy shard input.
 */
export function applyShardValidator(
  validators: ValidatorBundle,
  protocol  : ProtocolParams,
): { shardScript: Validator; shardScriptHash: string; shardAddress: string } {
  if (!validators.shardUnappliedCbor) {
    throw new Error("shardUnappliedCbor required when vaultType=Schedule");
  }
  requireField(protocol.shardPolicyId, "shardPolicyId", "Schedule (shard validator)");
  const appliedCbor = applyParamsToScript(validators.shardUnappliedCbor, [
    protocol.shardPolicyId!,
  ]);
  const shardScript: Validator = { type: "PlutusV3", script: appliedCbor };
  const shardScriptHash = validatorToScriptHash(shardScript);
  const shardAddress = credentialToAddress(
    protocol.network,
    scriptHashToCredential(shardScriptHash),
  );
  return { shardScript, shardScriptHash, shardAddress };
}

// ── internals ────────────────────────────────────────────────

export function buildParamsList(
  vaultType: VaultType,
  protocol : ProtocolParams,
  msPer    : bigint,
): Data[] {
  // Param #2 on every vault. Network-derived; an explicit override is honoured
  // so a caller on a custom network can pass its own asset name.
  const assetName = protocol.lampAssetName ?? lampAssetName(protocol.network);

  switch (vaultType) {
    case "Instant": {
      // vault(lamp_policy_id, lamp_asset_name, um_nft_policy, um_script_hash,
      //       backing_nft_policy, backing_script_hash, ms_per_epoch)
      requireField(protocol.umNftPolicyId, "umNftPolicyId", vaultType);
      requireField(protocol.umScriptHash, "umScriptHash", vaultType);
      requireField(protocol.backingNftPolicyId, "backingNftPolicyId", vaultType);
      requireField(protocol.backingScriptHash, "backingScriptHash", vaultType);
      return [
        protocol.lampPolicyId,
        assetName,
        protocol.umNftPolicyId!,
        protocol.umScriptHash!,        // pins the UM ref input (layer b)
        protocol.backingNftPolicyId!,  // pins the BackingBeacon ref input (§6.3)
        protocol.backingScriptHash!,
        msPer,
      ];
    }

    case "Schedule": {
      // vault(lamp_policy_id, lamp_asset_name, shard_policy_id, ms_per_epoch)
      requireField(protocol.shardPolicyId, "shardPolicyId", "Schedule");
      return [
        protocol.lampPolicyId,
        assetName,
        protocol.shardPolicyId!,
        msPer,
      ];
    }
  }
}

function requireField(v: unknown, name: string, vaultType: string): void {
  if (!v) throw new Error(`${name} required for vaultType="${vaultType}"`);
}
