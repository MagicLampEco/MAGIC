// scripts/deploySeeds.ts — seed CHO TRƯỚC của các validator one-shot trong cụm phục vụ, và
// phép so hash tính trước ↔ hash thực của từng bước deploy.
//
// ── Vì sao có tệp này ────────────────────────────────────────────────────────────
// Hash của cụm phục vụ phụ thuộc vào outref của sáu seed one-shot: bốn seed GenBeacons (bước 11
// pha `beacons`: sổ két · beacon GB · gb_shard · beacon ρ), seed `shard_nft` (bước 03) và seed
// `price_nft` của mỗi loại két (bước 09). Trước tệp này, mỗi bước TỰ CHỌN seed lúc chạy (11 tạo
// bốn output rồi đúc ngay; 03 lấy `utxos[0]`; 09 lấy UTxO thuần ADA đầu tiên), nên không ai biết
// hash của cụm trước khi nộp giao dịch đúc — trong khi bên tiêu thụ (app ghim policy lúc build)
// cần nó TRƯỚC.
//
// Luồng mới (`scripts/README.md` ▸ "Seed cho trước"):
//   1. `deploy/park_seeds.ts` tạo các output seed ở BÃI ĐỖ, không đúc gì, in outref.
//   2. `clusterHashes.ts` tính mọi hash từ outref đó, ghi tệp hash kỳ vọng.
//   3. Các bước deploy nhận seed qua biến `DEPLOY_SEED_*`, so hash thực với
//      `DEPLOY_EXPECT_HASHES`, lệch ⟹ ném TRƯỚC khi nộp.
//
// Vắng mọi biến `DEPLOY_SEED_*` ⟹ hành vi CŨ của từng bước giữ nguyên.
// Có biến mà seed không dùng được ⟹ NÉM, không lùi về chọn tự động: lùi lặng lẽ là ra một cụm
// có hash khác hash đã gửi đi, đúng ca mà cả luồng này dựng ra để chặn.
//
// Các hàm ở đây THUẦN (không đọc config.ts, không chạm mạng) trừ `resolvePresetSeed`, hàm này
// nhận `lucid` từ nơi gọi.

import { readFileSync } from "node:fs";
import {
  credentialToAddress, getAddressDetails, scriptFromNative, scriptHashToCredential, validatorToScriptHash,
  type LucidEvolution, type Network, type Script, type TxBuilder, type UTxO,
} from "@lucid-evolution/lucid";
import { parkAddressFor } from "./refScripts.js";
import { parseOutRef, type OutRef } from "./runResult.js";
import type { VaultKind } from "./consumeBook.js";

// ══════════════════════════════════════════════════════════════════════════════
// Tên vai seed ↔ biến môi trường
// ══════════════════════════════════════════════════════════════════════════════

/** Vai của từng seed → tên biến môi trường. Tên vai TRÙNG khoá `seeds` của đầu vào
 *  `clusterHashes.ts`, nên khối JSON mà `park_seeds.ts` in ra dán thẳng được vào đó. */
export const SEED_ENV = {
  registry:         "DEPLOY_SEED_REGISTRY",
  greenback:        "DEPLOY_SEED_GREENBACK",
  gbShard:          "DEPLOY_SEED_GB_SHARD",
  rate:             "DEPLOY_SEED_RATE",
  shardNft:         "DEPLOY_SEED_SHARD_NFT",
  priceNftInstant:  "DEPLOY_SEED_PRICE_NFT_INSTANT",
  priceNftSchedule: "DEPLOY_SEED_PRICE_NFT_SCHEDULE",
  priceNftPrepaid:  "DEPLOY_SEED_PRICE_NFT_PREPAID",
} as const;
export type SeedRole = keyof typeof SEED_ENV;
export const SEED_ROLES = Object.keys(SEED_ENV) as SeedRole[];

/** Bốn seed của bước 11 pha `beacons`, theo ĐÚNG thứ tự bước đó đặt output khi tự tạo seed. */
export const BEACON_SEED_ROLES = ["registry", "greenback", "gbShard", "rate"] as const satisfies readonly SeedRole[];

export function priceNftSeedRole(kind: VaultKind): SeedRole {
  switch (kind) {
    case "instant":  return "priceNftInstant";
    case "schedule": return "priceNftSchedule";
    case "prepaid":  return "priceNftPrepaid";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** Seed cho trước của MỘT vai. Biến vắng ⟹ `undefined` (hành vi cũ). Biến CÓ đặt mà rỗng hay
 *  sai hình dạng ⟹ ném: `DEPLOY_SEED_X=` là một lệnh gõ sai, không phải "không đặt". */
export function readPresetSeed(env: Env, role: SeedRole): OutRef | undefined {
  const name = SEED_ENV[role];
  const raw = env[name];
  if (raw === undefined) return undefined;
  return parseOutRef(raw, name);
}

export interface BeaconPresetSeeds { registry: OutRef; greenback: OutRef; gbShard: OutRef; rate: OutRef }

/** Bốn seed GenBeacons: đủ cả bốn hoặc không cái nào. Đặt thiếu ⟹ ném nêu tên biến thiếu — trộn
 *  seed cho trước với seed tự tạo là ra một cụm mà bản hash tính trước chỉ đúng một phần. */
export function readBeaconPresetSeeds(env: Env): BeaconPresetSeeds | undefined {
  const got = BEACON_SEED_ROLES.map((r) => [r, readPresetSeed(env, r)] as const);
  const missing = got.filter(([, v]) => v === undefined).map(([r]) => SEED_ENV[r]);
  if (missing.length === BEACON_SEED_ROLES.length) return undefined;
  if (missing.length > 0) {
    throw new Error(
      `Seed GenBeacons phải đặt ĐỦ bốn biến hoặc không biến nào; thiếu ${missing.join(", ")}. ` +
        `Một phần cho trước, một phần tự tạo thì hash tính trước không còn đúng.`,
    );
  }
  const seeds = Object.fromEntries(got) as unknown as BeaconPresetSeeds;
  const refs = BEACON_SEED_ROLES.map((r) => outRefString(seeds[r]));
  if (new Set(refs).size !== refs.length) throw new Error(`Bốn seed GenBeacons phải khác nhau đôi một: ${refs.join(", ")}.`);
  return seeds;
}

export function outRefString(r: OutRef): string {
  return `${r.txHash}#${r.outputIndex}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Bãi đỗ + kiểm seed trên chuỗi
// ══════════════════════════════════════════════════════════════════════════════

/** Lượng lovelace mỗi seed. Chỉ cần đủ min-ADA của một output trơn; phí + output thật của tx
 *  tiêu seed do bộ chọn UTxO của ví bù. Dùng chung cho bước 11 (tự tạo seed) và `park_seeds.ts`. */
export const SEED_LOVELACE = 2_000_000n;

export interface Park {
  walletAddress: string;
  walletPkh: string;
  parkAddress: string;
  /** Script native `sig(walletPkh)` — witness để tiêu seed ở bãi đỗ. */
  parkScript: Script;
}

/** Bãi đỗ của ví ký, kèm script để tiêu. Dựng lại script ở đây vì `refScripts.ts` chỉ xuất ĐỊA
 *  CHỈ; hai cách dẫn xuất phải ra cùng một chỗ — lệch thì seed đỗ ở nơi script này không tiêu được. */
export function parkFor(network: Network, walletAddress: string): Park {
  const cred = getAddressDetails(walletAddress).paymentCredential;
  if (cred?.type !== "Key") throw new Error(`Ví ký ${walletAddress} không có payment key credential.`);
  const parkScript = scriptFromNative({ type: "sig", keyHash: cred.hash });
  const parkAddress = parkAddressFor(network, walletAddress);
  const parkHash = getAddressDetails(parkAddress).paymentCredential?.hash;
  if (parkHash !== validatorToScriptHash(parkScript)) {
    throw new Error(`Script bãi đỗ dựng lại (${validatorToScriptHash(parkScript)}) ≠ bãi đỗ của refScripts.ts (${parkHash}).`);
  }
  if (credentialToAddress(network, scriptHashToCredential(parkHash)) !== parkAddress) {
    throw new Error(`Địa chỉ bãi đỗ không dựng lại được từ hash ${parkHash}.`);
  }
  return { walletAddress, walletPkh: cred.hash, parkAddress, parkScript };
}

/** Gắn witness tiêu một seed ở bãi đỗ: script native + chữ ký khoá ví. */
export function spendsParkedSeed(tx: TxBuilder, park: Park): TxBuilder {
  return tx.attach.SpendingValidator(park.parkScript).addSignerKey(park.walletPkh);
}

export interface ResolvedSeed {
  utxo: UTxO;
  /** true ⟹ seed nằm ở bãi đỗ, tx tiêu nó phải gắn `spendsParkedSeed`. */
  atPark: boolean;
}

/**
 * Tra seed cho trước trên chuỗi và kiểm nó DÙNG ĐƯỢC, không thì ném nêu lý do:
 *   · còn chưa tiêu (provider trả về đúng outref đó);
 *   · thuộc ví deploy — ở bãi đỗ của ví, hoặc (khi `allowWallet`) ở chính địa chỉ ví;
 *   · là output trơn: chỉ lovelace, không datum, không ref-script — tiêu một output mang token
 *     hay ref-script làm seed là dời tài sản đi mà không ai định.
 *
 * `allowWallet = false` cho bước 11: seed sổ két phải nằm chờ ở bãi đỗ tới pha `registry`
 * (đầu tệp `deploy/11_deploy_gen_beacons.ts` nói vì sao), và pha đó chỉ tiêu được từ bãi đỗ.
 */
export async function resolvePresetSeed(
  lucid: LucidEvolution,
  park: Park,
  role: SeedRole,
  ref: OutRef,
  opts: { allowWallet: boolean },
): Promise<ResolvedSeed> {
  const label = `${SEED_ENV[role]}=${outRefString(ref)}`;
  const found = await lucid.utxosByOutRef([ref]);
  const utxo = found.find((u) => u.txHash === ref.txHash && u.outputIndex === ref.outputIndex);
  if (!utxo) throw new Error(`${label}: UTxO không còn trên chuỗi (đã tiêu, hoặc chưa từng có) — không dùng làm seed được.`);
  const atPark = utxo.address === park.parkAddress;
  const atWallet = utxo.address === park.walletAddress;
  if (!atPark && !(opts.allowWallet && atWallet)) {
    const where = opts.allowWallet ? `ví ${park.walletAddress} hay bãi đỗ ${park.parkAddress}` : `bãi đỗ ${park.parkAddress}`;
    throw new Error(`${label}: UTxO nằm ở ${utxo.address}, không phải ${where} của ví deploy.`);
  }
  const units = Object.keys(utxo.assets).filter((k) => k !== "lovelace");
  if (units.length > 0 || utxo.scriptRef || utxo.datum || utxo.datumHash) {
    throw new Error(`${label}: seed phải là output trơn (chỉ lovelace, không datum, không ref-script).`);
  }
  return { utxo, atPark };
}

// ══════════════════════════════════════════════════════════════════════════════
// Hash kỳ vọng
// ══════════════════════════════════════════════════════════════════════════════

/** Tên hash dùng chung giữa `clusterHashes.ts` (bên ghi) và các bước deploy (bên so). */
export type ClusterHashName =
  | "vault_registry" | "greenback_beacon" | "gb_shard" | "rate_param"
  | "vault_instant"
  | "shard_nft" | "commit" | "vault_schedule" | "shard_schedule"
  | "paid_fund" | "vault_prepaid"
  | `price_nft_${VaultKind}` | `price_param_${VaultKind}` | `consume_${VaultKind}`;

export const EXPECT_HASHES_ENV = "DEPLOY_EXPECT_HASHES";

export type ExpectedHashes = Readonly<Record<string, string>>;

/** Đọc tệp hash kỳ vọng (`clusterHashes.ts --out`): một đối tượng JSON phẳng tên → 56 hex.
 *  Biến vắng ⟹ `undefined`. Có đặt mà đọc không được / sai hình dạng ⟹ ném. */
export function loadExpectedHashes(env: Env): ExpectedHashes | undefined {
  const path = env[EXPECT_HASHES_ENV];
  if (path === undefined) return undefined;
  if (path === "") throw new Error(`${EXPECT_HASHES_ENV} đặt mà rỗng — cần đường dẫn tới tệp JSON hash kỳ vọng.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${EXPECT_HASHES_ENV}: không đọc được JSON ở ${path} — ${(e as Error).message}`);
  }
  return parseExpectedHashes(parsed, path);
}

export function parseExpectedHashes(parsed: unknown, source: string): ExpectedHashes {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source}: tệp hash kỳ vọng phải là một đối tượng JSON tên → hash.`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string" || !/^[0-9a-f]{56}$/.test(v)) {
      throw new Error(`${source}: "${k}" phải là 56 hex chữ thường, nhận ${JSON.stringify(v)}.`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * In hash thực của một bước và — khi có tệp kỳ vọng — so từng cái. Ném (TRƯỚC khi nơi gọi nộp
 * giao dịch) khi một hash LỆCH hoặc tệp kỳ vọng KHÔNG CÓ tên đó: thiếu tên là "không đo được",
 * và nó không được đi qua như "khớp".
 */
export function checkExpectedHashes(
  step: string,
  actual: Partial<Record<ClusterHashName, string>>,
  expected: ExpectedHashes | undefined,
  log: (line: string) => void = console.log,
): void {
  const bad: string[] = [];
  for (const [name, hash] of Object.entries(actual) as [string, string][]) {
    if (!expected) {
      log(`   hash ${name.padEnd(22)} ${hash}`);
      continue;
    }
    const want = expected[name];
    if (want === undefined) {
      log(`   hash ${name.padEnd(22)} ${hash}  KHÔNG ĐO ĐƯỢC (tệp kỳ vọng không có tên này)`);
      bad.push(`${name}: tệp kỳ vọng không có`);
    } else if (want !== hash) {
      log(`   hash ${name.padEnd(22)} ${hash}  LỆCH (kỳ vọng ${want})`);
      bad.push(`${name}: thực ${hash} ≠ kỳ vọng ${want}`);
    } else {
      log(`   hash ${name.padEnd(22)} ${hash}  KHỚP`);
    }
  }
  if (bad.length > 0) {
    throw new Error(`${step}: hash thực không khớp tệp kỳ vọng — KHÔNG nộp giao dịch.\n  ${bad.join("\n  ")}`);
  }
}

/** Có tệp kỳ vọng mà bước này KHÔNG dùng seed cho trước ⟹ ném sớm, trước mọi giao dịch: hash của
 *  seed tự chọn không thể khớp hash tính trước, và bước 11 sẽ tiêu ADA tạo seed rồi mới lệch. */
export function requirePresetForExpect(step: string, expected: ExpectedHashes | undefined, hasPreset: boolean, seedVars: string[]): void {
  if (expected && !hasPreset) {
    throw new Error(
      `${step}: có ${EXPECT_HASHES_ENV} nhưng không có seed cho trước (${seedVars.join(", ")}). Seed tự chọn ` +
        `cho hash khác bản tính trước — đặt seed, hoặc bỏ ${EXPECT_HASHES_ENV}.`,
    );
  }
}
