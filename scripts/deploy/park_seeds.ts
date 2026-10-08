// scripts/deploy/park_seeds.ts — tạo các output SEED ở bãi đỗ của ví deploy, KHÔNG đúc gì, rồi in
// outref. Chạy TRƯỚC chuỗi deploy khi cần biết hash của cụm trước khi nộp giao dịch đúc
// (`scripts/README.md` ▸ "Seed cho trước"):
//
//   npx tsx deploy/park_seeds.ts                       # đủ 8 vai
//   PARK_SEEDS=registry,greenback,gbShard,rate npx tsx deploy/park_seeds.ts
//   DRY_RUN=1 npx tsx deploy/park_seeds.ts             # dựng + ký cục bộ, KHÔNG nộp
//
// Vai (`deploySeeds.ts` ▸ `SEED_ENV`): registry · greenback · gbShard · rate (bước 11) · shardNft
// (bước 03) · priceNftInstant · priceNftSchedule · priceNftPrepaid (bước 09). Mỗi vai một output
// `SEED_LOVELACE` ở bãi đỗ (script native `sig(ví)`), tất cả trong MỘT giao dịch.
//
// Vì sao bãi đỗ mà không để ở ví: bộ chọn UTxO của bất kỳ bước nào chạy giữa lúc tạo seed và lúc
// đúc có thể tiêu một seed ở ví làm phí — và hash đã tính trước (đã gửi cho bên tiêu thụ) chết theo.
// Ví không bao giờ tự chọn UTxO ở bãi đỗ; chủ khoá vẫn tiêu được (`spendsParkedSeed`).
//
// Đầu ra: các dòng `DEPLOY_SEED_<VAI>=<tx>#<ix>` để nạp vào môi trường của bước deploy, và khối
// JSON `"seeds"` dán thẳng vào đầu vào của `clusterHashes.ts`. Không ghi sổ trạng thái.
//
// Env (ngoài bộ khoá mạng + ví đọc qua config.ts): PARK_SEEDS (tuỳ chọn, phẩy, tên vai) · DRY_RUN.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Blockfrost, Lucid, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { outRefString, parkFor, SEED_ENV, SEED_LOVELACE, SEED_ROLES, type SeedRole } from "../deploySeeds.js";
import { bodyOutputs, completeSignSubmit, liveChain, type Chain } from "./11_deploy_gen_beacons.js";
import { parseFlag, type OutRef } from "../runResult.js";

/** Danh sách vai từ `PARK_SEEDS`. Vắng ⟹ đủ tám vai. Tên lạ / trùng / rỗng ⟹ ném. */
export function parseParkRoles(raw: string | undefined): SeedRole[] {
  if (raw === undefined) return [...SEED_ROLES];
  const roles = raw.split(",").map((s) => s.trim());
  if (roles.length === 0 || roles.some((r) => r === "")) throw new Error(`PARK_SEEDS có mục rỗng: "${raw}".`);
  const bad = roles.filter((r) => !(SEED_ROLES as string[]).includes(r));
  if (bad.length > 0) throw new Error(`PARK_SEEDS có vai lạ: ${bad.join(", ")}. Vai hợp lệ: ${SEED_ROLES.join(", ")}.`);
  if (new Set(roles).size !== roles.length) throw new Error(`PARK_SEEDS có vai trùng: "${raw}".`);
  return roles as SeedRole[];
}

/** Gán output seed của một tx đã dựng cho từng vai, theo THỨ TỰ chỉ số output. Đọc từ thân tx
 *  (không đợi chỉ mục). Số output trơn đúng hình dạng ở bãi đỗ phải bằng đúng số vai. */
export function seedsFromBody(signed: TxSignBuilder, parkAddress: string, roles: readonly SeedRole[]): Record<SeedRole, OutRef> {
  const outs = bodyOutputs(signed)
    .filter((u: UTxO) => u.address === parkAddress && !u.scriptRef && !u.datum && !u.datumHash &&
      Object.keys(u.assets).length === 1 && u.assets.lovelace === SEED_LOVELACE)
    .sort((a, b) => a.outputIndex - b.outputIndex);
  if (outs.length !== roles.length) {
    throw new Error(`Tx seed phải có đúng ${roles.length} output seed ở bãi đỗ, thấy ${outs.length}.`);
  }
  const map = {} as Record<SeedRole, OutRef>;
  roles.forEach((r, i) => { map[r] = { txHash: outs[i]!.txHash, outputIndex: outs[i]!.outputIndex }; });
  return map;
}

/** Dựng (và nếu `chain.submit` thật thì nộp) MỘT tx tạo `roles.length` output seed ở bãi đỗ. */
export async function parkSeeds(chain: Chain, roles: readonly SeedRole[]): Promise<{ txHash: string; seeds: Record<SeedRole, OutRef> }> {
  if (roles.length === 0) throw new Error("Không có vai nào để đỗ seed.");
  const park = parkFor(chain.network, await chain.lucid.wallet().address());
  let tx = chain.lucid.newTx();
  for (let i = 0; i < roles.length; i++) tx = tx.pay.ToAddress(park.parkAddress, { lovelace: SEED_LOVELACE });
  const done = await completeSignSubmit(chain, `seed ×${roles.length} → bãi đỗ`, tx);
  return { txHash: done.report.hash, seeds: seedsFromBody(done.signed, park.parkAddress, roles) };
}

export function printSeeds(seeds: Partial<Record<SeedRole, OutRef>>, log: (l: string) => void = console.log): void {
  log(`\n📋 Biến môi trường cho bước deploy:`);
  for (const r of SEED_ROLES) if (seeds[r]) log(`   ${SEED_ENV[r]}=${outRefString(seeds[r]!)}`);
  const json: Record<string, string> = {};
  for (const r of SEED_ROLES) if (seeds[r]) json[r] = outRefString(seeds[r]!);
  log(`\n📋 Khối "seeds" cho đầu vào clusterHashes.ts:`);
  log(`"seeds": ${JSON.stringify(json, null, 2)}`);
}

async function main(): Promise<void> {
  // Kiểm env TRƯỚC khi nạp config.ts và trước mọi lệnh gọi mạng.
  const roles = parseParkRoles(process.env.PARK_SEEDS);
  const dryRun = parseFlag(process.env.DRY_RUN, "DRY_RUN");
  const { NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet } = await import("../config.js");
  console.log(`=== Đỗ seed cho trước · ${roles.length} vai${dryRun ? " · DRY RUN" : ""} ===\n`);
  const real = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(real);
  const park = parkFor(NETWORK, await real.wallet().address());
  console.log(`Network: ${NETWORK} · ví ${park.walletAddress}\nBãi đỗ:  ${park.parkAddress}`);
  console.log(`Vai:     ${roles.join(", ")}\n`);

  const live = liveChain(real, NETWORK);
  const chain: Chain = dryRun
    ? {
        ...live,
        // DRY_RUN: dựng + ký + đo như thật, nhưng KHÔNG nộp. Trả về hash thân tx để phép so hash
        // trong `completeSignSubmit` vẫn chạy; outref in ra KHÔNG tồn tại trên chuỗi.
        submit: async (signed) => signed.toHash(),
      }
    : live;
  const r = await parkSeeds(chain, roles);
  printSeeds(r.seeds);
  if (dryRun) {
    console.log(`\nDRY RUN: KHÔNG nộp — các outref trên KHÔNG có thật trên chuỗi, đừng dùng để tính hash.`);
  } else {
    console.log(`\nĐã nộp + xác nhận tx ${r.txHash}. Bước tiếp: điền khối "seeds" vào đầu vào clusterHashes.ts.`);
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
