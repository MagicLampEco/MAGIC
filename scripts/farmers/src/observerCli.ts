// scripts/farmers/src/observerCli.ts — chụp sổ TRẠNG THÁI: mỗi nông dân × mỗi loại vault một
// (hoặc nhiều) dòng JSONL. Chỉ đọc chuỗi, không ký gì.
//
// Dùng:  npx tsx src/observerCli.ts --out state.jsonl [--at-epoch <n>] [--network Preprod]
// Vault đích đọc từ môi trường theo tên của sổ triển khai: VAULT_INSTANT_HASH + VAULT_INSTANT_ADDR,
// VAULT_SCHEDULE_HASH + VAULT_SCHEDULE_ADDR. Thiếu cả hai cặp ⟹ dừng, không trả sổ rỗng.

import { appendFileSync } from "node:fs";

import { posixMsToEpoch, type Network } from "../../../ProtocolUtils/src/index.ts";
import { enumerateFarmers } from "./farmers.ts";
import { fetchAddressUtxos, observeFarmer, type ChainSource, type VaultTarget } from "./observer.ts";
import { ownerOf } from "./owner.ts";
import { deriveFarmerWallets } from "./wallets.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const out = arg("--out");
  if (!out) throw new Error("cần --out <tệp .jsonl>");
  const network = (arg("--network") ?? "Preprod") as Network;
  const env = process.env;

  const targets: VaultTarget[] = [];
  for (const [kind, prefix] of [["Instant", "VAULT_INSTANT"], ["Schedule", "VAULT_SCHEDULE"]] as const) {
    const h = env[`${prefix}_HASH`];
    const a = env[`${prefix}_ADDR`];
    if (h && a) targets.push({ kind, scriptHash: h, address: a });
    else if (h || a) throw new Error(`${prefix}_HASH và ${prefix}_ADDR phải đi cùng nhau`);
  }
  if (targets.length === 0) throw new Error("không có vault đích nào (VAULT_INSTANT_HASH/ADDR, VAULT_SCHEDULE_HASH/ADDR)");

  const atRaw = arg("--at-epoch");
  if (atRaw !== undefined && !/^[0-9]+$/.test(atRaw)) throw new Error("--at-epoch phải là số nguyên không âm");
  const atEpoch = atRaw !== undefined ? BigInt(atRaw) : posixMsToEpoch(BigInt(Date.now()), network);
  const atSource = atRaw !== undefined ? "caller" : "wall-clock";

  const key = env.BLOCKFROST_KEY?.trim();
  const src: ChainSource = key ? { kind: "blockfrost", key, network } : { kind: "koios", network };
  const wallets = deriveFarmerWallets(enumerateFarmers(env), env, network);
  if (wallets.size === 0) throw new Error("không có nông dân nào (FARMER_SEED_<số>)");

  let rows = 0;
  for (const t of targets) {
    const utxos = await fetchAddressUtxos(src, t.address);
    for (const [farmer, w] of wallets) {
      for (const o of observeFarmer(utxos, t, farmer, ownerOf(w), atEpoch, atSource)) {
        appendFileSync(out, JSON.stringify(o) + "\n");
        rows++;
      }
    }
    console.log(`${t.kind}: ${utxos.length} UTxO tại địa chỉ · ${wallets.size} nông dân`);
  }
  console.log(`đã ghi ${rows} dòng vào ${out} · epoch giao thức ${atEpoch} (${atSource}) · nguồn ${src.kind}`);
}

main().catch((e) => {
  console.error(`✗ ${String((e as Error)?.message ?? e)}`);
  process.exit(1);
});
