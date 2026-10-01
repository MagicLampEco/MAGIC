// MagicSDK/src/validatorScripts.ts — apply-param của két theo loại (Gen v2.0)
//
// SDK KHÔNG giữ bảng tham số riêng nữa. Nguồn duy nhất của thứ tự apply-param là hai gói
// nền, mỗi gói đối chiếu với chữ ký `validator ...(` của module mình:
//
//   Instant:  `@magiclamp/instantgen-sdk` ▸ `vaultScript.ts` ▸ `instantVaultParamList`
//             9 tham số: lamp_policy_id, lamp_asset_name, gb_beacon_nft_policy,
//             gb_beacon_script_hash, gb_shard_policy_id, rate_nft_policy,
//             rate_script_hash, wakeme_vault_hash, ms_per_epoch.
//   Schedule: `@magiclamp/schedulegen-sdk` ▸ `params.ts` ▸ `applyScheduleScripts`
//             `commit` (withdraw-zero, 9 tham số) apply TRƯỚC → hash → két (6 tham số,
//             tham số cuối = hash `commit`). Đối chiếu TÊN tham số với blueprint.
//
// Bản trước dựng danh sách ở đây và nó trôi ngay khi Gen v2.0 bỏ UM/backing: bài
// `vaultParams.test.ts` đỏ vì blueprint có năm tham số mà danh sách SDK không biết.
//
// `lamp_asset_name` suy theo `protocol.network` (tLAMP testnet / LAMP mainnet), không bao
// giờ mặc định một hằng testnet. `lamp_policy_id` đi qua `assertLampPolicyId` — cổng đặt
// ở ĐÂY vì mọi đường apply (createVault · listVaults · applyShardValidator) đều qua đây.
//
// `applyParamsToScript` nướng tham số vào CBOR ⟹ hash ⟹ địa chỉ; mọi bên (tạo két, sinh,
// tiêu, rút) PHẢI dùng cùng script đã apply.

import {
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  type Data,
  type Validator,
} from "@lucid-evolution/lucid";
import { msPerEpoch, lampAssetName, assertWakemeVaultHash } from "@magiclamp/protocol-utils";
import {
  applyInstantVaultParams, instantVaultParamList, type InstantVaultParams,
} from "@magiclamp/instantgen-sdk";
import {
  applyScheduleScripts, scheduleCommitParamList, scheduleVaultParamList,
  SCHEDULE_VAULT_BLUEPRINT_TITLE,
  type ScheduleBlueprint, type ScheduleScriptParams,
} from "@magiclamp/schedulegen-sdk";
import { assertLampPolicyId } from "./lampPolicy.js";
import type { ProtocolParams, ValidatorBundle, VaultType } from "./types.js";

/** Kết quả apply. Két Schedule có thêm `commit` (withdraw-zero) đã apply — bộ dựng
 *  `buildScheduleCommitTx` BẮT BUỘC nó, và két đã nướng hash của nó vào tham số #5. */
export interface AppliedVault {
  vaultScript:       Validator;
  vaultScriptHash:   string;
  vaultAddress:      string;
  commitScript?:     Validator;
  commitScriptHash?: string;
}

/**
 * Build the applied vault Validator for a given vault type + protocol params.
 *
 * Schedule: đòi `validators.vaultPlutusJson` (blueprint trọn) vì `applyScheduleScripts`
 * cần cả `vault.commit.withdraw` lẫn `vault.vault.spend` và đối chiếu tên tham số với
 * blueprint. `vaultUnappliedCbor` phải TRÙNG `compiledCode` của `vault.vault.spend` —
 * hai nguồn cho cùng một thứ mà lệch nhau thì NÉM, không chọn bên.
 */
export function applyVaultValidator(
  vaultType : VaultType,
  validators: ValidatorBundle,
  protocol  : ProtocolParams,
): AppliedVault {
  const msPer = protocol.msPerEpoch ?? msPerEpoch(protocol.network);
  const addr = (h: string) => credentialToAddress(protocol.network, scriptHashToCredential(h));

  if (vaultType === "Instant") {
    const vaultScript = applyInstantVaultParams(validators.vaultUnappliedCbor, instantVaultParamsFromProtocol(protocol));
    const vaultScriptHash = validatorToScriptHash(vaultScript);
    return { vaultScript, vaultScriptHash, vaultAddress: addr(vaultScriptHash) };
  }

  const bp = scheduleBlueprintOf(validators);
  const s = applyScheduleScripts(bp, scheduleScriptParamsFromProtocol(protocol, msPer));
  return {
    vaultScript: s.vaultScript, vaultScriptHash: s.vaultScriptHash, vaultAddress: addr(s.vaultScriptHash),
    commitScript: s.commitScript, commitScriptHash: s.commitScriptHash,
  };
}

/**
 * Build the applied shard Validator (ScheduleGen).
 *
 * `validator shard(shard_policy_id_param: PolicyId, vault_script_hash: ByteArray)` — HAI
 * tham số. `vault_script_hash` được SUY RA từ `applyVaultValidator("Schedule", …)`, không
 * nhận qua `ProtocolParams`: thêm một trường cấu hình cho giá trị suy ra được là dựng nguồn
 * thứ hai lệch được với két thật mà không gì kêu. `applyParamsToScript` không kiểm arity —
 * bản apply `[]` trước đây ra một hash trông hợp lệ nhưng không khớp 16 shard đã đặt.
 */
export function applyShardValidator(
  validators: ValidatorBundle,
  protocol  : ProtocolParams,
): { shardScript: Validator; shardScriptHash: string; shardAddress: string } {
  if (!validators.shardUnappliedCbor) {
    throw new Error("shardUnappliedCbor required when vaultType=Schedule");
  }
  requireField(protocol.shardPolicyId, "shardPolicyId", "Schedule (shard validator)");
  const { vaultScriptHash } = applyVaultValidator("Schedule", validators, protocol);
  const appliedCbor = applyParamsToScript(validators.shardUnappliedCbor, [
    protocol.shardPolicyId!,
    vaultScriptHash,
  ]);
  const shardScript: Validator = { type: "PlutusV3", script: appliedCbor };
  const shardScriptHash = validatorToScriptHash(shardScript);
  const shardAddress = credentialToAddress(protocol.network, scriptHashToCredential(shardScriptHash));
  return { shardScript, shardScriptHash, shardAddress };
}

// ── Ánh xạ ProtocolParams → tham số của gói nền ──────────────────────────────

/** 9 apply-param của két Instant dựng từ `ProtocolParams`. Thiếu một ô ⟹ NÉM. Xuất ra vì
 *  mọi bộ dựng InstantGen (`buildInstantGenTx`, `buildRefreshCheckpointTx`, …) đòi đúng
 *  giá trị đã apply vào két. */
export function instantVaultParamsFromProtocol(protocol: ProtocolParams): InstantVaultParams {
  // Cổng policy LAMP chạy TRƯỚC mọi kiểm trường riêng: policy nhái phải nhận đúng câu lỗi
  // của nó, không phải "thiếu trường X" rồi đi sửa nhầm chỗ.
  const lampPolicyId = lampPolicyOf(protocol);
  rejectLegacyFields(protocol);
  const vt = "Instant";
  requireField(protocol.gbBeaconNftPolicy, "gbBeaconNftPolicy", vt);
  requireField(protocol.gbBeaconScriptHash, "gbBeaconScriptHash", vt);
  requireField(protocol.gbShardPolicyId, "gbShardPolicyId", vt);
  requireField(protocol.rateNftPolicy, "rateNftPolicy", vt);
  requireField(protocol.rateScriptHash, "rateScriptHash", vt);
  requireField(protocol.wakemeVaultHash, "wakemeVaultHash", vt);
  return {
    lampPolicyId,
    lampAssetName:      protocol.lampAssetName ?? lampAssetName(protocol.network),
    gbBeaconNftPolicy:  protocol.gbBeaconNftPolicy!,
    gbBeaconScriptHash: protocol.gbBeaconScriptHash!,
    gbShardPolicyId:    protocol.gbShardPolicyId!,
    rateNftPolicy:      protocol.rateNftPolicy!,
    rateScriptHash:     protocol.rateScriptHash!,
    wakemeVaultHash:    assertWakemeVaultHash(protocol.wakemeVaultHash, `vaultType="Instant".wakemeVaultHash`),
    msPerEpoch:         protocol.msPerEpoch ?? msPerEpoch(protocol.network),
  };
}

/** Tham số cặp script ScheduleGen (`commit` + két) dựng từ `ProtocolParams`. */
export function scheduleScriptParamsFromProtocol(protocol: ProtocolParams, msPer?: bigint): ScheduleScriptParams {
  const lampPolicyId = lampPolicyOf(protocol);
  rejectLegacyFields(protocol);
  const vt = "Schedule";
  requireField(protocol.shardPolicyId, "shardPolicyId", vt);
  requireField(protocol.gbBeaconNftPolicy, "gbBeaconNftPolicy", vt);
  requireField(protocol.gbBeaconScriptHash, "gbBeaconScriptHash", vt);
  requireField(protocol.gbShardPolicyId, "gbShardPolicyId", vt);
  requireField(protocol.rateNftPolicy, "rateNftPolicy", vt);
  requireField(protocol.rateScriptHash, "rateScriptHash", vt);
  return {
    lampPolicyId,
    lampAssetName:      protocol.lampAssetName ?? lampAssetName(protocol.network),
    shardPolicyId:      protocol.shardPolicyId!,
    msPerEpoch:         msPer ?? protocol.msPerEpoch ?? msPerEpoch(protocol.network),
    gbBeaconNftPolicy:  protocol.gbBeaconNftPolicy!,
    gbBeaconScriptHash: protocol.gbBeaconScriptHash!,
    gbShardPolicyId:    protocol.gbShardPolicyId!,
    rateNftPolicy:      protocol.rateNftPolicy!,
    rateScriptHash:     protocol.rateScriptHash!,
  };
}

/**
 * Danh sách apply-param THEO THỨ TỰ của két — do gói nền dựng, ở đây chỉ chọn nhánh.
 *  - Instant: 9 tham số (`instantVaultParamList`).
 *  - Schedule: 6 tham số (`scheduleVaultParamList`), tham số cuối là hash `commit` ĐÃ apply
 *    ⟹ BẮT BUỘC `commitScriptHash` (lấy từ `applyVaultValidator(..).commitScriptHash`).
 */
export function buildParamsList(
  vaultType: VaultType,
  protocol : ProtocolParams,
  msPer    : bigint,
  commitScriptHash?: string,
): Data[] {
  if (vaultType === "Instant") {
    return instantVaultParamList({ ...instantVaultParamsFromProtocol(protocol), msPerEpoch: msPer });
  }
  const scheduleParams = scheduleScriptParamsFromProtocol(protocol, msPer);
  if (commitScriptHash === undefined) {
    throw new Error(`commitScriptHash required for vaultType="Schedule" (tham số #5 của két = hash \`commit\` đã apply).`);
  }
  return scheduleVaultParamList(scheduleParams, commitScriptHash);
}

/** 9 apply-param của `commit` (ScheduleGen, withdraw-zero). */
export function buildCommitParamsList(protocol: ProtocolParams, msPer: bigint): Data[] {
  return scheduleCommitParamList(scheduleScriptParamsFromProtocol(protocol, msPer));
}

// ── internals ────────────────────────────────────────────────

function scheduleBlueprintOf(validators: ValidatorBundle): ScheduleBlueprint {
  const bp = validators.vaultPlutusJson as unknown as ScheduleBlueprint | undefined;
  if (bp === undefined) {
    throw new Error(
      `vaultPlutusJson required for vaultType="Schedule": két Gen v2.0 nướng hash của ` +
      `validator \`commit\` (vault.commit.withdraw) vào tham số #5, nên SDK cần blueprint trọn ` +
      `để apply \`commit\` trước.`,
    );
  }
  const spend = bp.validators.find(v => v.title === SCHEDULE_VAULT_BLUEPRINT_TITLE);
  if (spend !== undefined && spend.compiledCode !== validators.vaultUnappliedCbor) {
    throw new Error(
      `vaultUnappliedCbor KHÁC compiledCode của "${SCHEDULE_VAULT_BLUEPRINT_TITLE}" trong ` +
      `vaultPlutusJson — hai nguồn cho cùng một validator lệch nhau (blueprint cũ?).`,
    );
  }
  return bp;
}

function lampPolicyOf(protocol: ProtocolParams): string {
  // Param #1 on every vault, và là tham số ĐẮT NHẤT khi sai: nướng vào bytes ⟹ sai
  // policy là sai hash, sai địa chỉ, không sửa được bằng cấu hình sau.
  return assertLampPolicyId(protocol.lampPolicyId, "buildParamsList", protocol.lampRehearsalAck, protocol.network);
}

const LEGACY_FIELDS = ["umNftPolicyId", "umScriptHash", "backingNftPolicyId", "backingScriptHash"] as const;

/** Mã JS (không qua kiểm kiểu) vẫn truyền được bốn trường đời v1. Im lặng bỏ qua chúng là
 *  để người gọi tưởng két của mình còn đọc UM/backing — NÉM để họ biết cấu hình đã đổi. */
function rejectLegacyFields(protocol: ProtocolParams): void {
  const got = LEGACY_FIELDS.filter(k => (protocol as unknown as Record<string, unknown>)[k] !== undefined);
  if (got.length > 0) {
    throw new Error(
      `ProtocolParams mang trường đời Gen v1 đã bỏ: ${got.join(", ")}. Gen v2.0 không đọc ` +
      `UM/BackingBeacon; thay bằng gbBeaconNftPolicy, gbBeaconScriptHash, gbShardPolicyId, ` +
      `rateNftPolicy, rateScriptHash.`,
    );
  }
}

function requireField(v: unknown, name: string, vaultType: string): void {
  if (!v) throw new Error(`${name} required for vaultType="${vaultType}"`);
}
