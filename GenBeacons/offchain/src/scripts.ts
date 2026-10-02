// GenBeacons/offchain/src/scripts.ts — nạp blueprint, apply-param theo TÊN, suy hash/địa chỉ/unit.
//
// Nguồn chữ ký validator: GenBeacons/onchain/validators/*.ak ▸ `validator <tên>(…)`.
// Blueprint `GenBeacons/onchain/plutus.json` là artifact (gitignored) — sinh bằng
// `aiken build GenBeacons/onchain` trước khi dùng.
//
// VÌ SAO apply theo TÊN chứ không theo vị trí: `applyParamsToScript` KHÔNG kiểm arity. Truyền
// thiếu/thừa/sai thứ tự vẫn ra một hash 28 byte trông hợp lệ, và mọi giao dịch về sau chết
// (khuôn: `scripts/applyParams.ts`). Ở đây mỗi validator khai danh sách tên THEO ĐÚNG chữ ký
// .ak, và cổng so danh sách đó với `parameters[].title` của blueprint — lệch là NÉM.
//
// THỨ TỰ DEPLOY (đầu tệp `validators/vault_registry.ak`), không có vòng hash:
//   1. `vault_registry(seed)`                      ⟹ hash sổ (= policy "VRG"). CHƯA đúc.
//   2. `greenback_beacon(writer, ms, seed, origin)` ⟹ hash beacon GB (= policy "GBB").
//   3. `gb_shard(gbPolicy, gbHash, hash sổ, cap, seed)` ⟹ hash shard (= policy "GBS"‖id).
//   4. két InstantGen / ScheduleGen apply hash shard ⟹ hash két (gói khác).
//   5. đúc sổ: tiêu seed sổ, datum `VaultRegistry { [hash két] }` (build.ts ▸ `mintVaultRegistryTx`).
// `rate_param` độc lập với chuỗi trên.

import {
  applyParamsToScript,
  Constr,
  toUnit,
  validatorToAddress,
  validatorToScriptHash,
  type Data,
  type Network,
  type Script,
} from "@lucid-evolution/lucid";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_HASH_BYTES } from "./types.js";

// ── Hằng tên NFT (khớp `lib/genbeacons/constants.ak`) ─────────────────────────

/** Số shard của bộ đếm `GB_available` — `constants.shard_count`. */
export const SHARD_COUNT = 16n;
/** "RHO" — `constants.rate_nft_name`. */
export const RATE_NFT_NAME = "52484f";
/** "GBB" — `constants.greenback_nft_name`. */
export const GREENBACK_NFT_NAME = "474242";
/** "VRG" — `constants.vault_registry_nft_name`. */
export const VAULT_REGISTRY_NFT_NAME = "565247";
/** "GBS" — `constants.shard_nft_prefix`; byte cuối là `shard_id`. */
export const SHARD_NFT_PREFIX = "474253";

/** Tên NFT shard `id` (0 ≤ id < 16): "GBS" ‖ một byte `id` — `constants.shard_nft_name`. */
export function shardNftName(id: bigint): string {
  if (id < 0n || id >= SHARD_COUNT) {
    throw new Error(`shard_id ${id} ngoài [0, ${SHARD_COUNT}).`);
  }
  return SHARD_NFT_PREFIX + id.toString(16).padStart(2, "0");
}

// ── Blueprint ─────────────────────────────────────────────────────────────────

export interface BlueprintValidator {
  title: string;
  compiledCode: string;
  hash: string;
  parameters?: { title?: string }[];
}

export interface Blueprint {
  /** Đường dẫn hiển thị — chỉ cho thông điệp lỗi. */
  path: string;
  validators: BlueprintValidator[];
}

/** Đường mặc định của blueprint, tính từ vị trí tệp này (src/ → ../../onchain/plutus.json). */
export const DEFAULT_BLUEPRINT_PATH = fileURLToPath(
  new URL("../../onchain/plutus.json", import.meta.url),
);

/** Đọc + kiểm sơ bộ `plutus.json`. Chưa build ⟹ ném lỗi chỉ đúng lệnh cần chạy. */
export function loadBlueprint(path: string = DEFAULT_BLUEPRINT_PATH): Blueprint {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Không đọc được blueprint GenBeacons (${path}). Chạy \`aiken build GenBeacons/onchain\` trước.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} không phải JSON hợp lệ — build lại bằng \`aiken build GenBeacons/onchain\`.`);
  }
  return blueprintFromJson(parsed, path);
}

/** Dựng `Blueprint` từ JSON đã parse (cho môi trường không đọc được đĩa). */
export function blueprintFromJson(parsed: unknown, path = "GenBeacons/onchain/plutus.json"): Blueprint {
  const bp = parsed as { validators?: unknown };
  if (!Array.isArray(bp.validators)) {
    throw new Error(`${path} thiếu mảng "validators".`);
  }
  return { path, validators: bp.validators as BlueprintValidator[] };
}

/**
 * Chữ ký của bốn validator — ĐÚNG thứ tự trong `validators/*.ak`. Nguồn chân lý là .ak;
 * bảng này chỉ để cổng `appliedByName` so với blueprint, lệch thì ném.
 */
export const VALIDATOR_PARAMS = {
  vault_registry: ["seed"],
  greenback_beacon: ["greenback_beacon_writer", "ms_per_epoch", "seed", "window_origin_ms"],
  gb_shard: [
    "gb_beacon_nft_policy",
    "gb_beacon_script_hash",
    "vault_registry_policy",
    "gb_shard_cap_nanogic",
    "seed",
  ],
  rate_param: ["rate_key", "rho_max_q", "ms_per_epoch", "seed", "window_origin_ms"],
} as const;

export type ValidatorName = keyof typeof VALIDATOR_PARAMS;

/**
 * Validator `<name>.<name>` trong blueprint. Mint/spend/else của cùng một validator chung
 * `compiledCode` (mint gộp vào cùng script) — kiểm điều đó thay vì giả định, vì policy id
 * = hash script chỉ đúng khi ba điểm vào là MỘT script.
 */
export function findValidator(bp: Blueprint, name: ValidatorName): BlueprintValidator {
  const prefix = `${name}.${name}.`;
  const entries = bp.validators.filter((v) => v.title.startsWith(prefix));
  const mint = entries.find((v) => v.title === `${prefix}mint`);
  if (!mint) {
    throw new Error(
      `Không thấy "${prefix}mint" trong ${bp.path}. Hiện có: ${bp.validators.map((v) => v.title).join(", ")}.`,
    );
  }
  for (const e of entries) {
    if (e.compiledCode !== mint.compiledCode) {
      throw new Error(`${e.title} và ${mint.title} khác compiledCode — blueprint hỏng hoặc trộn bản build.`);
    }
  }
  return mint;
}

/** Apply-param theo TÊN; cổng so tên + thứ tự với blueprint VÀ với `VALIDATOR_PARAMS`. */
export function appliedByName(
  bp: Blueprint,
  name: ValidatorName,
  byName: Record<string, Data>,
): Script {
  const v = findValidator(bp, name);
  const fromBlueprint = (v.parameters ?? []).map((p, i) => {
    if (typeof p.title !== "string" || p.title.length === 0) {
      throw new Error(`Tham số #${i + 1} của ${v.title} không có title trong blueprint.`);
    }
    return p.title;
  });
  const declared: readonly string[] = VALIDATOR_PARAMS[name];
  const given = Object.keys(byName);
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  if (!same(fromBlueprint, declared) || !same(given, declared)) {
    throw new Error(
      `APPLY-PARAM LỆCH — ${v.title}\n` +
        `  blueprint : ${fromBlueprint.join(", ")}\n` +
        `  khai ở TS : ${declared.join(", ")}\n` +
        `  đưa vào   : ${given.join(", ")}`,
    );
  }
  const params = declared.map((n) => {
    const val = byName[n];
    if (val === undefined || val === null) {
      throw new Error(`Tham số "${n}" của ${v.title} là ${String(val)}.`);
    }
    return val;
  });
  return { type: "PlutusV3", script: applyParamsToScript(v.compiledCode, params) };
}

// ── Mã hoá tham số ────────────────────────────────────────────────────────────

/** Tham chiếu UTxO làm seed one-shot. */
export interface OutRef {
  txHash: string;
  outputIndex: number;
}

/** `OutputReference { transaction_id, output_index }` = Constr 0 [bytes, int] (stdlib v3). */
export function outRefData(ref: OutRef): Data {
  if (!/^[0-9a-f]{64}$/.test(ref.txHash)) {
    throw new Error(`txHash seed không phải 32 byte hex: "${ref.txHash}".`);
  }
  if (!Number.isInteger(ref.outputIndex) || ref.outputIndex < 0) {
    throw new Error(`outputIndex seed không hợp lệ: ${ref.outputIndex}.`);
  }
  return new Constr(0, [ref.txHash, BigInt(ref.outputIndex)]);
}

function hash28(label: string, h: string): string {
  if (!new RegExp(`^[0-9a-f]{${SCRIPT_HASH_BYTES * 2}}$`).test(h)) {
    throw new Error(`${label} phải là ${SCRIPT_HASH_BYTES} byte hex, nhận "${h}".`);
  }
  return h;
}

function positive(label: string, x: bigint): bigint {
  if (x <= 0n) throw new Error(`${label} phải > 0, nhận ${x}.`);
  return x;
}

function nonNegative(label: string, x: bigint): bigint {
  if (x < 0n) throw new Error(`${label} phải ≥ 0, nhận ${x}.`);
  return x;
}

// ── Bộ script đã apply ────────────────────────────────────────────────────────

/** Một script đã apply: policy id = script hash (mint gộp vào cùng validator). */
export interface AppliedScript {
  script: Script;
  hash: string;
  /** Địa chỉ `Script(hash)` KHÔNG stake credential — genesis ép đúng hình dạng này. */
  address: string;
}

function applied(network: Network, script: Script): AppliedScript {
  return {
    script,
    hash: validatorToScriptHash(script),
    address: validatorToAddress(network, script),
  };
}

export interface VaultRegistryScript extends AppliedScript {
  seed: OutRef;
  /** Unit NFT "VRG". */
  nftUnit: string;
}

export interface GreenBackBeaconScript extends AppliedScript {
  writer: string;
  msPerEpoch: bigint;
  seed: OutRef;
  /** Gốc cửa sổ (apply-param CUỐI) — `@magiclamp/protocol-utils` ▸ `windowOriginMs(network)`. */
  windowOriginMs: bigint;
  /** Unit NFT "GBB". */
  nftUnit: string;
}

export interface GbShardScript extends AppliedScript {
  gbBeaconNftPolicy: string;
  gbBeaconScriptHash: string;
  vaultRegistryPolicy: string;
  capNanogic: bigint;
  seed: OutRef;
  /** Unit NFT shard `id`. */
  nftUnit(id: bigint): string;
}

export interface RateParamScript extends AppliedScript {
  rateKey: string;
  rhoMaxQ: bigint;
  msPerEpoch: bigint;
  seed: OutRef;
  /** Gốc cửa sổ (apply-param CUỐI) — `@magiclamp/protocol-utils` ▸ `windowOriginMs(network)`. */
  windowOriginMs: bigint;
  /** Unit NFT "RHO". */
  nftUnit: string;
}

/** Bước 1: `vault_registry(seed)`. */
export function vaultRegistryScript(bp: Blueprint, network: Network, seed: OutRef): VaultRegistryScript {
  const a = applied(network, appliedByName(bp, "vault_registry", { seed: outRefData(seed) }));
  return { ...a, seed, nftUnit: toUnit(a.hash, VAULT_REGISTRY_NFT_NAME) };
}

/** Bước 2: `greenback_beacon(greenback_beacon_writer, ms_per_epoch, seed, window_origin_ms)`. */
export function greenbackBeaconScript(
  bp: Blueprint,
  network: Network,
  p: { writer: string; msPerEpoch: bigint; seed: OutRef; windowOriginMs: bigint },
): GreenBackBeaconScript {
  const a = applied(
    network,
    appliedByName(bp, "greenback_beacon", {
      greenback_beacon_writer: hash28("greenback_beacon_writer", p.writer),
      ms_per_epoch: positive("ms_per_epoch", p.msPerEpoch),
      seed: outRefData(p.seed),
      window_origin_ms: nonNegative("window_origin_ms", p.windowOriginMs),
    }),
  );
  return { ...a, ...p, nftUnit: toUnit(a.hash, GREENBACK_NFT_NAME) };
}

/**
 * Bước 3: `gb_shard(gb_beacon_nft_policy, gb_beacon_script_hash, vault_registry_policy,
 * gb_shard_cap_nanogic, seed)`. Nhận CHÍNH bộ script beacon + sổ để hai hash không gõ tay
 * được: theo hình dạng mint-trong-validator, policy NFT beacon = hash script beacon.
 */
export function gbShardScript(
  bp: Blueprint,
  network: Network,
  p: {
    greenback: Pick<GreenBackBeaconScript, "hash">;
    vaultRegistry: Pick<VaultRegistryScript, "hash">;
    capNanogic: bigint;
    seed: OutRef;
  },
): GbShardScript {
  const gbBeaconNftPolicy = hash28("gb_beacon_nft_policy", p.greenback.hash);
  const gbBeaconScriptHash = hash28("gb_beacon_script_hash", p.greenback.hash);
  const vaultRegistryPolicy = hash28("vault_registry_policy", p.vaultRegistry.hash);
  const a = applied(
    network,
    appliedByName(bp, "gb_shard", {
      gb_beacon_nft_policy: gbBeaconNftPolicy,
      gb_beacon_script_hash: gbBeaconScriptHash,
      vault_registry_policy: vaultRegistryPolicy,
      gb_shard_cap_nanogic: nonNegative("gb_shard_cap_nanogic", p.capNanogic),
      seed: outRefData(p.seed),
    }),
  );
  return {
    ...a,
    gbBeaconNftPolicy,
    gbBeaconScriptHash,
    vaultRegistryPolicy,
    capNanogic: p.capNanogic,
    seed: p.seed,
    nftUnit: (id: bigint) => toUnit(a.hash, shardNftName(id)),
  };
}

/** `rate_param(rate_key, rho_max_q, ms_per_epoch, seed, window_origin_ms)`. */
export function rateParamScript(
  bp: Blueprint,
  network: Network,
  p: { rateKey: string; rhoMaxQ: bigint; msPerEpoch: bigint; seed: OutRef; windowOriginMs: bigint },
): RateParamScript {
  const a = applied(
    network,
    appliedByName(bp, "rate_param", {
      rate_key: hash28("rate_key", p.rateKey),
      rho_max_q: nonNegative("rho_max_q", p.rhoMaxQ),
      ms_per_epoch: positive("ms_per_epoch", p.msPerEpoch),
      seed: outRefData(p.seed),
      window_origin_ms: nonNegative("window_origin_ms", p.windowOriginMs),
    }),
  );
  return { ...a, ...p, nftUnit: toUnit(a.hash, RATE_NFT_NAME) };
}

/** Bộ đủ bốn script, dựng theo đúng thứ tự deploy (bước 1 → 2 → 3, ρ độc lập). */
export interface GenBeaconsScripts {
  vaultRegistry: VaultRegistryScript;
  greenback: GreenBackBeaconScript;
  gbShard: GbShardScript;
  rate: RateParamScript;
}

export interface GenBeaconsParams {
  msPerEpoch: bigint;
  /** Gốc cửa sổ của mạng — `@magiclamp/protocol-utils` ▸ `windowOriginMs(network)`. */
  windowOriginMs: bigint;
  vaultRegistrySeed: OutRef;
  greenbackWriter: string;
  greenbackSeed: OutRef;
  gbShardCapNanogic: bigint;
  gbShardSeed: OutRef;
  rateKey: string;
  rhoMaxQ: bigint;
  rateSeed: OutRef;
}

export function deriveGenBeaconsScripts(
  bp: Blueprint,
  network: Network,
  p: GenBeaconsParams,
): GenBeaconsScripts {
  const seeds = [p.vaultRegistrySeed, p.greenbackSeed, p.gbShardSeed, p.rateSeed].map(
    (s) => `${s.txHash}#${s.outputIndex}`,
  );
  if (new Set(seeds).size !== seeds.length) {
    // Hai validator one-shot chung seed ⟹ chỉ cái đúc trước sống, cái sau không bao giờ đúc được.
    throw new Error(`Bốn seed phải khác nhau đôi một: ${seeds.join(", ")}.`);
  }
  const vaultRegistry = vaultRegistryScript(bp, network, p.vaultRegistrySeed);
  const greenback = greenbackBeaconScript(bp, network, {
    writer: p.greenbackWriter,
    msPerEpoch: p.msPerEpoch,
    seed: p.greenbackSeed,
    windowOriginMs: p.windowOriginMs,
  });
  const gbShard = gbShardScript(bp, network, {
    greenback,
    vaultRegistry,
    capNanogic: p.gbShardCapNanogic,
    seed: p.gbShardSeed,
  });
  const rate = rateParamScript(bp, network, {
    rateKey: p.rateKey,
    rhoMaxQ: p.rhoMaxQ,
    msPerEpoch: p.msPerEpoch,
    seed: p.rateSeed,
    windowOriginMs: p.windowOriginMs,
  });
  return { vaultRegistry, greenback, gbShard, rate };
}
