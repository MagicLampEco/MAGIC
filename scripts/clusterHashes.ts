// scripts/clusterHashes.ts — tính TẤT ĐỊNH mọi script hash / policy id của cụm phục vụ Gen v2.0
// từ một tệp JSON đầu vào: cụm GenBeacons (sổ két · beacon GB · gb_shard · beacon ρ), két Instant,
// nhánh ScheduleGen (shard_nft · commit · két · shard), nhánh PrepaidGen (paid_fund · két) và một
// chuỗi price_nft → price_param → consume cho mỗi loại két. Không đọc mạng, không đọc khoá.
//
// Chạy (từ scripts/):
//   npx tsx clusterHashes.ts <input.json> [--out <hashes.json>] [--build] [--wakeme-ahead-of-code]
//     --out    ghi tệp hash kỳ vọng (JSON phẳng tên → hash) — đúng thứ mà các bước deploy đọc qua
//              `DEPLOY_EXPECT_HASHES` (`deploySeeds.ts`).
//     --build  chạy `aiken build` cho năm module trước khi tính (plutus.json đã gitignore,
//              BOUNDARIES.md §4) — thiếu cờ này thì hash tính trên blueprint ĐANG CÓ trên đĩa.
//     --wakeme-ahead-of-code
//              cho phép `wakemeVaultHash` đầu vào KHÁC hằng `wakemeVaultHash(network)` của
//              ProtocolUtils. Vắng cờ mà khác ⟹ NÉM: bước 05/10 (và 09 prepaid) apply bằng hằng
//              mã, nên sẽ ra hash khác bản tính trước. Có cờ ⟹ tính tiếp và in rõ các bước đó sẽ
//              ném tới khi hằng mã được cập nhật.
//   Đầu vào có khối `expected` ⟹ so từng tên, mã thoát 1 khi LỆCH hoặc KHÔNG ĐO ĐƯỢC.
//
// ── MỘT đường apply, không phải đường thứ hai ──────────────────────────────────────
// Tệp này KHÔNG tự khai danh sách tham số. Nó gọi đúng các hàm mà bước deploy gọi:
//   GenBeacons/offchain ▸ deriveGenBeaconsScripts            (bước 11 pha beacons)
//   deployParams.ts ▸ instantVaultParams                      (bước 05)
//   deploy/03_deploy_shards.ts ▸ shardNftPolicyFor + scheduleShardScript   (bước 03/06/07)
//   deployParams.ts ▸ prepaidScriptPair                       (bước 10)
//   deployParams.ts ▸ consumeScriptChain                      (bước 09)
// Hằng mà bước deploy lấy từ MÃ (nhịp epoch, gốc cửa sổ, `rho_max_q`, trần gb_shard, tên NFT
// giá, constr BurnBatch) cũng lấy từ đúng nguồn đó; đầu vào có ghi chúng thì phải TRÙNG, lệch ⟹
// ném — bản tính trước phải là hash mà bước deploy SẼ ra, không phải hash của một bộ số khác.
//
// ── Hình dạng đầu vào ─────────────────────────────────────────────────────────────
// {
//   "network": "Preprod",
//   "deployWalletAddress": "addr_test1…"   (hoặc "operatorPkh": "<56 hex>") — khoá ký bước 09/11,
//   "wakemeVaultHash": "<56 hex>" | null    — null ⟹ két Instant, paid_fund, két Prepaid và hai
//                                             bản consume của chúng ra KHÔNG TÍNH ĐƯỢC,
//   "constants": { "lampPolicyId", "lampAssetName", "carpPolicyId", "carpAssetName",
//                  "priceThreshold"?, "maxPriceStale"?  (núm env của bước 09, mặc định 1),
//                  … hằng lấy từ mã (tuỳ chọn, chỉ để đối chiếu) },
//   "priceCommittee": ["<56 hex>", …]?      (mặc định [operatorPkh], như bước 09),
//   "seeds": { "registry", "greenback", "gbShard", "rate", "shardNft",
//              "priceNftInstant"?, "priceNftSchedule"?, "priceNftPrepaid"? }   — `<tx>#<ix>`,
//   "expected": { "<tên>": "<56 hex>" }?
// }
// Vector đời 2 Preprod: `scripts/vectors/cluster_hashes.gen2-preprod.json`.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddressDetails, type Network } from "@lucid-evolution/lucid";
import { msPerEpoch as msPerEpochOf, wakemeVaultHash as codeWakemeVaultHash, windowOriginMs as windowOriginOf } from "@magiclamp/protocol-utils";
import {
  deriveGenBeaconsScripts,
  loadBlueprint as loadGenBeaconsBlueprint,
  type Blueprint as GenBeaconsBlueprint,
} from "../GenBeacons/offchain/src/index.js";
import { appliedScript, findValidator, loadBlueprint, type Blueprint } from "./applyParams.js";
import {
  BURN_BATCH_CONSTR, consumeScriptChain, instantVaultParams, prepaidScriptPair, PRICE_NFT_NAME,
} from "./deployParams.js";
import { SEED_ROLES, type ClusterHashName, type SeedRole } from "./deploySeeds.js";
import { parseOutRef, type OutRef } from "./runResult.js";
import { shardNftPolicyFor, scheduleShardScript } from "./deploy/03_deploy_shards.js";
import { compiledGbShardCap, compiledRhoMaxQ } from "./deploy/11_deploy_gen_beacons.js";
import type { VaultKind } from "./consumeBook.js";

// ══════════════════════════════════════════════════════════════════════════════
// Đầu vào
// ══════════════════════════════════════════════════════════════════════════════

export interface ClusterHashInput {
  network: "Preview" | "Preprod" | "Mainnet";
  deployWalletAddress?: string;
  operatorPkh?: string;
  wakemeVaultHash: string | null;
  constants: Record<string, string>;
  priceCommittee?: string[];
  seeds: Partial<Record<SeedRole, string>>;
  expected?: Record<string, string>;
}

export interface ClusterBlueprints {
  genBeacons: GenBeaconsBlueprint;
  instant: Blueprint;
  schedule: Blueprint;
  consume: Blueprint;
  prepaid: Blueprint;
}

/** Năm module Aiken mà cụm phục vụ apply-param. */
export const CLUSTER_MODULES = ["GenBeacons", "InstantGen", "ScheduleGen", "ConsumeMAGIC", "PrepaidGen"] as const;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEX56 = /^[0-9a-f]{56}$/;

function hex56(name: string, v: unknown): string {
  if (typeof v !== "string" || !HEX56.test(v)) throw new Error(`${name} phải là 56 hex chữ thường, nhận ${JSON.stringify(v)}.`);
  return v;
}

function hexAny(name: string, v: unknown): string {
  if (typeof v !== "string" || !/^([0-9a-f]{2})*$/.test(v)) throw new Error(`${name} phải là chuỗi hex chữ thường, nhận ${JSON.stringify(v)}.`);
  return v;
}

/** Hằng mà bước deploy lấy từ MÃ. Đầu vào ghi thì phải trùng; vắng thì lấy từ mã. */
function codeConstant(c: Record<string, string>, key: string, fromCode: bigint | string): string {
  const code = String(fromCode);
  if (c[key] !== undefined && c[key] !== code) {
    throw new Error(
      `constants.${key} = ${c[key]} nhưng mã deploy dùng ${code} — bản tính trước phải là hash mà bước deploy ` +
        `SẼ ra. Sửa đầu vào, hoặc đổi hằng trong mã trước (đổi là đổi hash).`,
    );
  }
  return code;
}

export function parseClusterHashInput(raw: unknown, source: string): ClusterHashInput {
  if (typeof raw !== "object" || raw === null) throw new Error(`${source}: đầu vào phải là đối tượng JSON.`);
  const r = raw as Record<string, unknown>;
  if (r.network !== "Preprod" && r.network !== "Preview" && r.network !== "Mainnet") {
    throw new Error(`${source}: network phải là Preprod | Preview | Mainnet, nhận ${JSON.stringify(r.network)}.`);
  }
  if (r.wakemeVaultHash !== null && r.wakemeVaultHash !== undefined) hex56(`${source}: wakemeVaultHash`, r.wakemeVaultHash);
  if (typeof r.constants !== "object" || r.constants === null) throw new Error(`${source}: thiếu khối constants.`);
  if (typeof r.seeds !== "object" || r.seeds === null) throw new Error(`${source}: thiếu khối seeds.`);
  const unknownSeeds = Object.keys(r.seeds).filter((k) => !(SEED_ROLES as string[]).includes(k));
  if (unknownSeeds.length > 0) throw new Error(`${source}: seeds có vai lạ ${unknownSeeds.join(", ")} (vai hợp lệ: ${SEED_ROLES.join(", ")}).`);
  // Hai vai cùng một outref ⟹ bước chạy trước tiêu seed của vai kia (vd. seed sổ két dán làm
  // `shardNft`: bước 03 tiêu nó, pha registry không bao giờ đúc được sổ) — ném ngay ở bản tính trước.
  const byRef = new Map<string, string[]>();
  for (const [role, ref] of Object.entries(r.seeds as Record<string, unknown>)) {
    if (typeof ref !== "string") throw new Error(`${source}: seeds.${role} phải là chuỗi "<tx>#<ix>".`);
    byRef.set(ref, [...(byRef.get(ref) ?? []), role]);
  }
  const dupSeeds = [...byRef.entries()].filter(([, roles]) => roles.length > 1);
  if (dupSeeds.length > 0) {
    throw new Error(`${source}: seeds trùng outref giữa các vai: ${dupSeeds.map(([ref, roles]) => `${roles.join(" = ")} = ${ref}`).join("; ")}.`);
  }
  return {
    network: r.network,
    deployWalletAddress: r.deployWalletAddress as string | undefined,
    operatorPkh: r.operatorPkh as string | undefined,
    wakemeVaultHash: (r.wakemeVaultHash as string | null | undefined) ?? null,
    constants: r.constants as Record<string, string>,
    priceCommittee: r.priceCommittee as string[] | undefined,
    seeds: r.seeds as Partial<Record<SeedRole, string>>,
    expected: r.expected as Record<string, string> | undefined,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Blueprint
// ══════════════════════════════════════════════════════════════════════════════

export async function loadClusterBlueprints(): Promise<ClusterBlueprints> {
  return {
    genBeacons: loadGenBeaconsBlueprint(),
    instant: await loadBlueprint("InstantGen"),
    schedule: await loadBlueprint("ScheduleGen"),
    consume: await loadBlueprint("ConsumeMAGIC"),
    prepaid: await loadBlueprint("PrepaidGen"),
  };
}

/**
 * `aiken build` năm module, rồi kiểm `plutus.json` thật sự được ghi MỚI (mtime ≥ lúc bắt đầu) —
 * không thì hash tính trên một blueprint cũ mà vẫn ra 56 hex trông hợp lệ.
 *
 * Mã thoát khác 0 ⟹ ném, kèm cách xem lỗi: `aiken build` khi stdout không phải terminal in RỖNG
 * cho lỗi biên dịch (BOUNDARIES.md §4), nên lỗi thật chỉ thấy khi chạy lại dưới `script -q`.
 */
export function buildClusterBlueprints(log: (l: string) => void = console.log): void {
  for (const m of CLUSTER_MODULES) {
    const dir = resolve(REPO_ROOT, m, "onchain");
    const started = Date.now();
    const r = spawnSync("aiken", ["build", dir], { encoding: "utf8" });
    if (r.error) throw new Error(`Không chạy được \`aiken\` (${r.error.message}) — không dựng được blueprint, hash KHÔNG ĐO ĐƯỢC.`);
    if (r.status !== 0) {
      throw new Error(
        `aiken build ${m}/onchain thoát ${r.status}. Xem lỗi: \`script -q /dev/null aiken build ${dir}\` ` +
          `(qua pipe aiken in rỗng cho lỗi biên dịch).`,
      );
    }
    const mtime = statSync(resolve(dir, "plutus.json")).mtimeMs;
    if (mtime + 2_000 < started) throw new Error(`aiken build ${m}/onchain thoát 0 mà plutus.json không được ghi mới.`);
    log(`   aiken build ${m.padEnd(13)} ✓`);
  }
}

/** Commit + trạng thái sạch của năm thư mục onchain — để biết hash tính trên mã nào. */
export function blueprintProvenance(): string {
  const head = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--short=8", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return "git: KHÔNG ĐO ĐƯỢC";
  const dirty = spawnSync("git", ["-C", REPO_ROOT, "status", "--porcelain", "--", ...CLUSTER_MODULES.map((m) => `${m}/onchain`)], { encoding: "utf8" });
  const changed = dirty.status === 0 ? dirty.stdout.split("\n").filter((l) => l.trim() !== "").length : -1;
  return `HEAD ${head.stdout.trim()} · onchain ${changed === 0 ? "sạch" : changed < 0 ? "KHÔNG ĐO ĐƯỢC" : `${changed} tệp đổi chưa commit`}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tính
// ══════════════════════════════════════════════════════════════════════════════

export interface ClusterHashResult {
  /** Tên → hash, hoặc `null` khi thiếu đầu vào (lý do ở `notes`). Thứ tự = thứ tự dựng. */
  hashes: Partial<Record<ClusterHashName, string | null>>;
  notes: Partial<Record<ClusterHashName, string>>;
  operatorPkh: string;
}

export function computeClusterHashes(bp: ClusterBlueprints, inp: ClusterHashInput): ClusterHashResult {
  const net = inp.network;
  const c = inp.constants;
  const hashes: ClusterHashResult["hashes"] = {};
  const notes: ClusterHashResult["notes"] = {};
  const skip = (k: ClusterHashName, why: string) => { hashes[k] = null; notes[k] = why; };

  const operatorPkh = inp.operatorPkh !== undefined
    ? hex56("operatorPkh", inp.operatorPkh)
    : (() => {
        const cred = inp.deployWalletAddress ? getAddressDetails(inp.deployWalletAddress).paymentCredential : undefined;
        if (cred?.type !== "Key") throw new Error("Cần operatorPkh hoặc deployWalletAddress mang payment key credential.");
        return cred.hash;
      })();

  // Hằng lấy từ mã — đúng nguồn bước deploy đọc.
  const msPerEpoch = BigInt(codeConstant(c, "msPerEpoch", msPerEpochOf(net)));
  const windowOriginMs = BigInt(codeConstant(c, "windowOriginMs", windowOriginOf(net)));
  const rhoMaxQ = BigInt(codeConstant(c, "rhoMaxQ", compiledRhoMaxQ()));
  const gbShardCapNanogic = BigInt(codeConstant(c, "gbShardCapNanogic", compiledGbShardCap()));
  codeConstant(c, "priceNftName", PRICE_NFT_NAME);
  codeConstant(c, "burnBatchConstr", BURN_BATCH_CONSTR);
  // Núm env của bước 09 (MAX_PRICE_STALE, PRICE_THRESHOLD, PRICE_COMMITTEE) — mặc định như bước đó.
  const maxPriceStale = BigInt(c.maxPriceStale ?? "1");
  const priceThreshold = BigInt(c.priceThreshold ?? "1");
  const committee = (inp.priceCommittee ?? [operatorPkh]).map((x, i) => hex56(`priceCommittee[${i}]`, x));
  const lampPolicyId = hex56("constants.lampPolicyId", c.lampPolicyId);
  const lampAssetName = hexAny("constants.lampAssetName", c.lampAssetName);

  const seed = (role: SeedRole): OutRef => {
    const raw = inp.seeds[role];
    if (raw === undefined) throw new Error(`Thiếu seeds.${role}.`);
    return parseOutRef(raw, `seeds.${role}`);
  };

  // ── GenBeacons (bước 11 pha beacons) ───────────────────────────────────────
  const gb = deriveGenBeaconsScripts(bp.genBeacons, net, {
    msPerEpoch, windowOriginMs,
    vaultRegistrySeed: seed("registry"),
    greenbackWriter: operatorPkh,
    greenbackSeed: seed("greenback"),
    gbShardCapNanogic,
    gbShardSeed: seed("gbShard"),
    rateKey: operatorPkh,
    rhoMaxQ,
    rateSeed: seed("rate"),
  });
  hashes.vault_registry = gb.vaultRegistry.hash;
  hashes.greenback_beacon = gb.greenback.hash;
  hashes.gb_shard = gb.gbShard.hash;
  hashes.rate_param = gb.rate.hash;
  const beacons = {
    gbBeaconNftPolicy: gb.greenback.hash, gbBeaconScriptHash: gb.greenback.hash,
    gbShardPolicyId: gb.gbShard.hash,
    rateNftPolicy: gb.rate.hash, rateScriptHash: gb.rate.hash,
  };

  // ── Két Instant (bước 05) ──────────────────────────────────────────────────
  const vaults: Partial<Record<VaultKind, string>> = {};
  if (inp.wakemeVaultHash) {
    vaults.instant = appliedScript(findValidator(bp.instant, "vault.vault.spend"), instantVaultParams({
      lampPolicyId, lampAssetName, ...beacons,
      wakemeVaultHash: inp.wakemeVaultHash, msPerEpoch, windowOriginMs,
    })).hash;
    hashes.vault_instant = vaults.instant;
  } else {
    skip("vault_instant", "thiếu wakemeVaultHash");
  }

  // ── ScheduleGen (bước 03 → 06/07) ──────────────────────────────────────────
  const shardNft = shardNftPolicyFor(bp.schedule, seed("shardNft"));
  hashes.shard_nft = shardNft.policyId;
  const sched = scheduleShardScript(bp.schedule, {
    lampPolicyId, lampAssetName, shardPolicyId: shardNft.policyId, msPerEpoch, windowOriginMs, ...beacons,
  });
  hashes.commit = sched.commitHash;
  hashes.vault_schedule = sched.vaultHash;
  hashes.shard_schedule = sched.shardHash;
  vaults.schedule = sched.vaultHash;

  // ── PrepaidGen (bước 10) ───────────────────────────────────────────────────
  if (inp.wakemeVaultHash) {
    const pp = prepaidScriptPair(bp.prepaid, {
      carpPolicyId: hex56("constants.carpPolicyId", c.carpPolicyId),
      carpAssetName: hexAny("constants.carpAssetName", c.carpAssetName),
      msPerEpoch, windowOriginMs, wakemeVaultHash: inp.wakemeVaultHash,
    });
    hashes.paid_fund = pp.fundHash;
    hashes.vault_prepaid = pp.vaultHash;
    vaults.prepaid = pp.vaultHash;
  } else {
    skip("paid_fund", "thiếu wakemeVaultHash");
    skip("vault_prepaid", "thiếu wakemeVaultHash");
  }

  // ── ConsumeMAGIC × loại két (bước 09) ──────────────────────────────────────
  const seedRoleOf: Record<VaultKind, SeedRole> = { instant: "priceNftInstant", schedule: "priceNftSchedule", prepaid: "priceNftPrepaid" };
  for (const kind of ["instant", "schedule", "prepaid"] as const) {
    const names = [`price_nft_${kind}`, `price_param_${kind}`, `consume_${kind}`] as const;
    const vault = vaults[kind];
    const rawSeed = inp.seeds[seedRoleOf[kind]];
    if (!vault || rawSeed === undefined) {
      const why = !vault ? `thiếu hash két ${kind}` : `thiếu seeds.${seedRoleOf[kind]}`;
      for (const n of names) skip(n, why);
      continue;
    }
    const ch = consumeScriptChain(bp.consume, {
      priceNftSeed: seed(seedRoleOf[kind]), committee, threshold: priceThreshold,
      vaultScriptHash: vault, maxPriceStale, msPerEpoch, windowOriginMs,
    });
    hashes[names[0]] = ch.priceNftPolicy;
    hashes[names[1]] = ch.priceParamHash;
    hashes[names[2]] = ch.consumeHash;
  }
  return { hashes, notes, operatorPkh };
}

/** So với `expected`: đếm KHỚP / LỆCH / KHÔNG ĐO ĐƯỢC. Tên có trong `expected` mà không có hash
 *  (null hoặc vắng) là KHÔNG ĐO ĐƯỢC — tính là hỏng, không tính là khớp. */
export function compareExpected(r: ClusterHashResult, expected: Record<string, string>): {
  ok: number; bad: number; unmeasured: number; lines: string[];
} {
  let ok = 0, bad = 0, unmeasured = 0;
  const lines: string[] = [];
  for (const [k, want] of Object.entries(expected)) {
    const got = (r.hashes as Record<string, string | null | undefined>)[k];
    if (got === undefined || got === null) { unmeasured++; lines.push(`${k}: KHÔNG ĐO ĐƯỢC`); }
    else if (got === want) ok++;
    else { bad++; lines.push(`${k}: LỆCH — tính ${got}, kỳ vọng ${want}`); }
  }
  return { ok, bad, unmeasured, lines };
}

/** Tệp hash kỳ vọng cho `DEPLOY_EXPECT_HASHES`: chỉ các hash tính được. */
export function expectedHashesFile(r: ClusterHashResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.hashes)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Đối chiếu `wakemeVaultHash` đầu vào với hằng `wakemeVaultHash(network)` của ProtocolUtils — nguồn
 * mà bước 05/10 (và 09 prepaid) apply. Khác ⟹ ném, trừ khi `aheadOfCode` (cờ
 * `--wakeme-ahead-of-code`): khi đó in rõ các bước đó sẽ NÉM (`DEPLOY_EXPECT_HASHES` lệch) tới khi
 * hằng mã được cập nhật. Đầu vào `null` ⟹ không đối chiếu (các hash phụ thuộc Wakeme ra
 * "CHƯA TÍNH ĐƯỢC").
 */
export function checkWakemeAgainstCode(
  inp: Pick<ClusterHashInput, "network" | "wakemeVaultHash">,
  aheadOfCode: boolean,
  codeOf: (net: ClusterHashInput["network"]) => string = codeWakemeVaultHash,
  log: (line: string) => void = console.log,
): void {
  let code: string | undefined;
  try { code = codeOf(inp.network); } catch { code = undefined; }
  const codeShown = code ?? "(mã chưa có cho mạng này)";
  if (inp.wakemeVaultHash === null) {
    log(`wakeme:     (chưa biết) · mã hiện tại ghi ${codeShown}`);
    return;
  }
  if (inp.wakemeVaultHash === code) {
    log(`wakeme:     ${inp.wakemeVaultHash} · TRÙNG hằng mã`);
    return;
  }
  if (!aheadOfCode) {
    throw new Error(
      `wakemeVaultHash đầu vào ${inp.wakemeVaultHash} ≠ hằng mã wakemeVaultHash(${inp.network}) = ${codeShown}. ` +
        `Bước 05/10 (và 09 prepaid) apply bằng hằng mã nên sẽ ra hash KHÁC bản tính trước. Cập nhật hằng ` +
        `ProtocolUtils trước, hoặc thêm --wakeme-ahead-of-code nếu cố ý tính trước cho hằng sắp đổi.`,
    );
  }
  log(`wakeme:     ${inp.wakemeVaultHash} · KHÁC hằng mã ${codeShown} (--wakeme-ahead-of-code)`);
  log(`⚠  Bước 05 (vault_instant), 10 (paid_fund · vault_prepaid) và 09 VAULT_KIND=prepaid sẽ NÉM khi so ` +
    `DEPLOY_EXPECT_HASHES cho tới khi wakemeVaultHash(${inp.network}) trong ProtocolUtils được cập nhật thành ` +
    `${inp.wakemeVaultHash}.`);
}

// ══════════════════════════════════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let inputPath: string | undefined, outPath: string | undefined, build = false, wakemeAhead = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out") outPath = args[++i];
    else if (a === "--build") build = true;
    else if (a === "--wakeme-ahead-of-code") wakemeAhead = true;
    else if (a.startsWith("--")) throw new Error(`Cờ lạ: ${a}`);
    else if (inputPath === undefined) inputPath = a;
    else throw new Error(`Thừa đối số: ${a}`);
  }
  if (!inputPath) throw new Error("Dùng: npx tsx clusterHashes.ts <input.json> [--out <hashes.json>] [--build] [--wakeme-ahead-of-code]");
  if (outPath === undefined && args.includes("--out")) throw new Error("--out cần đường dẫn tệp.");

  const inp = parseClusterHashInput(JSON.parse(readFileSync(inputPath, "utf8")), inputPath);
  // Đối chiếu Wakeme TRƯỚC khi dựng/tính: lệch mà không có cờ ⟹ ném, không ghi tệp kỳ vọng nào.
  checkWakemeAgainstCode(inp, wakemeAhead);
  if (build) buildClusterBlueprints();
  const r = computeClusterHashes(await loadClusterBlueprints(), inp);

  console.log(`input:      ${inputPath}`);
  console.log(`network:    ${inp.network} · operatorPkh ${r.operatorPkh}`);
  console.log(`blueprint:  ${blueprintProvenance()}${build ? " · vừa aiken build" : " · dùng plutus.json đang có trên đĩa (thêm --build để dựng lại)"}\n`);
  const exp = inp.expected;
  for (const [k, v] of Object.entries(r.hashes)) {
    let tag = "";
    if (exp && k in exp) tag = v === null ? "  KHÔNG ĐO ĐƯỢC" : v === exp[k] ? "  KHỚP" : `  LỆCH (kỳ vọng ${exp[k]})`;
    console.log(`${k.padEnd(22)} ${v ?? `CHƯA TÍNH ĐƯỢC — ${(r.notes as Record<string, string>)[k]}`}${tag}`);
  }
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(expectedHashesFile(r), null, 1) + "\n");
    console.log(`\nĐã ghi ${Object.keys(expectedHashesFile(r)).length} hash vào ${outPath} (dùng làm DEPLOY_EXPECT_HASHES).`);
  }
  if (exp) {
    const cmp = compareExpected(r, exp);
    console.log(`\nso kỳ vọng: ${cmp.ok} KHỚP · ${cmp.bad} LỆCH · ${cmp.unmeasured} KHÔNG ĐO ĐƯỢC (trên ${Object.keys(exp).length} mục)`);
    if (cmp.bad > 0 || cmp.unmeasured > 0) process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
