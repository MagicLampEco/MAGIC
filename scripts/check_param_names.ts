// scripts/check_param_names.ts — CỔNG MÁY: đối chiếu tên + thứ tự apply-param.
//
// Với mỗi validator mà scripts/ có deploy, in ra:
//   • `parameters[].title` đọc từ `<Module>/onchain/plutus.json`
//   • danh sách tên mà scripts/deployParams.ts cung cấp
// rồi khẳng định TRÙNG KHỚP CẢ TÊN LẪN THỨ TỰ.
//
// Không đọc .env, không cần ví, không dựng tx, không gửi gì lên mạng.
// Chạy:  npx tsx check_param_names.ts
//
// VÌ SAO CẦN: `applyParamsToScript` không kiểm arity. Thiếu một tham số vẫn ra
// script hash 28 byte trông hợp lệ, và mọi tx spend về sau fail vĩnh viễn.

import {
  loadBlueprint, findValidator, paramTitles, orderedParams,
  type Blueprint, type ParamMap,
} from "./applyParams.js";
import {
  instantVaultParams, scheduleVaultParams, umDatumParams, shardSpendParams,
  oneShotGenesisParams, priceParamParams, consumeParams, paymasterParams,
  addressData, otcOrderParams, consolidateParams, profileChangeParams,
} from "./deployParams.js";

// Giá trị giữ chỗ — chỉ TÊN và THỨ TỰ mới được kiểm ở đây.
const P28 = "00".repeat(28);
const SEED = { txHash: "11".repeat(32), outputIndex: 0 };
const MS = 86_400_000n;

interface Case {
  module: string;
  title:  string;
  /** Script deploy nào tiêu thụ danh sách này (để người đọc lần ra gốc). */
  usedBy: string;
  params: ParamMap;
}

const CASES: Case[] = [
  {
    module: "InstantGen", title: "vault.vault.spend",
    usedBy: "deploy/05_create_instant_vault.ts + verify_per_network.ts",
    params: instantVaultParams({
      lampPolicyId: P28, lampAssetName: "744c414d50", umNftPolicy: P28,
      umScriptHash: P28, backingNftPolicy: P28, backingScriptHash: P28,
      msPerEpoch: MS,
    }),
  },
  {
    // Cùng một script đa-mục-đích: mint và spend PHẢI cùng danh sách tham số.
    module: "InstantGen", title: "vault.vault.mint",
    usedBy: "deploy/05 (mint NFT danh-tính vault)",
    params: instantVaultParams({
      lampPolicyId: P28, lampAssetName: "744c414d50", umNftPolicy: P28,
      umScriptHash: P28, backingNftPolicy: P28, backingScriptHash: P28,
      msPerEpoch: MS,
    }),
  },
  {
    module: "ScheduleGen", title: "vault.vault.spend",
    usedBy: "deploy/07_create_schedule_vault.ts + verify_per_network.ts",
    params: scheduleVaultParams({
      lampPolicyId: P28, lampAssetName: "744c414d50", shardPolicyId: P28,
      msPerEpoch: MS,
    }),
  },
  {
    module: "ScheduleGen", title: "vault.vault.mint",
    usedBy: "deploy/07 (mint NFT danh-tính vault)",
    params: scheduleVaultParams({
      lampPolicyId: P28, lampAssetName: "744c414d50", shardPolicyId: P28,
      msPerEpoch: MS,
    }),
  },
  {
    module: "ScheduleGen", title: "vault.shard.spend",
    usedBy: "ScheduleGen shard UTxO",
    params: shardSpendParams({ shardPolicyId: P28 }),
  },
  {
    module: "ScheduleGen", title: "shard_nft.shard_nft.mint",
    usedBy: "deploy/03_deploy_shards.ts",
    params: oneShotGenesisParams(SEED),
  },
  {
    module: "UMKeeper", title: "um_datum.um_datum_validator.spend",
    usedBy: "deploy/02_deploy_um.ts + verify_per_network.ts",
    params: umDatumParams({ msPerEpoch: MS, umPolicy: P28, umName: "554d44" }),
  },
  {
    module: "UMKeeper", title: "um_nft.um_nft.mint",
    usedBy: "deploy/02_deploy_um.ts",
    params: oneShotGenesisParams(SEED),
  },
  {
    module: "ConsumeMAGIC", title: "price_nft.price_nft.mint",
    usedBy: "deploy/09_deploy_consume.ts",
    params: oneShotGenesisParams(SEED),
  },
  {
    module: "ConsumeMAGIC", title: "price_param.price_param.spend",
    usedBy: "deploy/09_deploy_consume.ts",
    params: priceParamParams({
      committee: [P28], threshold: 1n, priceNftPolicy: P28,
      priceNftName: "5052494345", msPerEpoch: MS,
    }),
  },
  {
    module: "ConsumeMAGIC", title: "consume.consume.spend",
    usedBy: "deploy/09_deploy_consume.ts + test/consume_only.ts",
    params: consumeParams({
      priceNftPolicy: P28, priceNftName: "5052494345",
      vaultScriptHash: P28, burnBatchConstr: 2n,
      maxPriceStale: 1n, msPerEpoch: MS, priceParamScriptHash: P28,
    }),
  },
  {
    // Multi-purpose: `mint` là policy của thread token Engage — cùng danh sách tham số.
    module: "ConsumeMAGIC", title: "consume.consume.mint",
    usedBy: "deploy/09 (mint thread token Engage)",
    params: consumeParams({
      priceNftPolicy: P28, priceNftName: "5052494345",
      vaultScriptHash: P28, burnBatchConstr: 2n,
      maxPriceStale: 1n, msPerEpoch: MS, priceParamScriptHash: P28,
    }),
  },
  {
    // Paymaster CHƯA có deploy script — case này có mặt TRƯỚC cái nó gác.
    // Lý do: module này từng nằm ngoài mọi cổng, và `paymaster.ts` mô tả
    // "đã apply 9 param" trong khi validator nhận 11. Hai cái thiếu là hai bản
    // vá SEC-01 (`treasury_addr`, `lamp_asset_name`) — đúng thứ mà truyền sót
    // sẽ dựng ra một Paymaster gửi LAMP đi đâu cũng được.
    module: "Paymaster", title: "paymaster.paymaster.spend",
    usedBy: "(chưa có deploy script — cổng dựng trước)",
    params: paymasterParams({
      vaultScriptHash: P28, burnBatchConstr: 2n, lampPolicyId: P28,
      policyNftPolicy: P28, meterNftPolicy: P28, protocolNftPolicy: P28,
      maxPolicyStale: 1n, maxDidEntries: 8n, msPerEpoch: MS,
      treasuryAddr: addressData({ hash: P28, isScript: true }),
      lampAssetName: "744c414d50",
    }),
  },
  {
    // Đây là chỗ SÓT thật, không phải cổng dựng trước: `deploy/08` CÓ chạy, và nó
    // là script deploy DUY NHẤT còn apply-param theo VỊ TRÍ. Thêm một tham số vào
    // otc_order.ak là deploy/08 lặng lẽ sinh hash sai — không ai đỏ.
    module: "GetMAGIC", title: "otc_order.otc_order.spend",
    usedBy: "deploy/08_deploy_getmagic.ts + test/getmagic_flow.ts",
    params: otcOrderParams({ allocScriptHash: P28 }),
  },
  {
    // Chưa có deploy script. Vào cổng vì tài liệu của chính module này từng khai
    // 2 tham số trong khi validator nhận 3 — ai làm theo tài liệu sẽ bake
    // ms_per_epoch vào đúng chỗ của lamp_asset_name.
    module: "Consolidate", title: "vault_consolidate.vault_consolidate.spend",
    usedBy: "(chưa có deploy script — cổng dựng trước)",
    params: consolidateParams({
      lampPolicyId: P28, lampAssetName: "744c414d50", msPerEpoch: MS,
    }),
  },
  {
    module: "ProfileChange", title: "vault_profile.vault_profile.spend",
    usedBy: "(chưa có deploy script — cổng dựng trước)",
    params: profileChangeParams({ msPerEpoch: MS }),
  },
];

async function main() {
  console.log("=== Đối chiếu tên apply-param: blueprint ↔ script deploy ===\n");
  console.log(`(giữ chỗ 28-byte ${P28.slice(0, 8)}…, seed ${SEED.txHash.slice(0, 8)}…, ` +
              `ms_per_epoch=${MS}; chỉ TÊN + THỨ TỰ được kiểm)\n`);

  const cache = new Map<string, Blueprint | Error>();
  let ok = 0, mismatch = 0, unbuilt = 0;

  for (const c of CASES) {
    console.log(`── ${c.module} / ${c.title}`);
    console.log(`   dùng bởi: ${c.usedBy}`);

    if (!cache.has(c.module)) {
      try { cache.set(c.module, await loadBlueprint(c.module)); }
      catch (e: unknown) { cache.set(c.module, e as Error); }
    }
    const bp = cache.get(c.module)!;
    if (bp instanceof Error) {
      console.log(`   ⏭  CHƯA BUILD — ${bp.message.split("\n")[1]?.trim() ?? bp.message}\n`);
      unbuilt++;
      continue;
    }

    let v;
    try { v = findValidator(bp, c.title); }
    catch (e: unknown) {
      console.log(`   ❌ ${(e as Error).message}\n`);
      mismatch++;
      continue;
    }

    const expected = paramTitles(v);
    const given    = Object.keys(c.params);
    console.log(`   blueprint (${expected.length}): [${expected.join(", ")}]`);
    console.log(`   script    (${given.length}): [${given.join(", ")}]`);

    try {
      const applied = orderedParams(v, c.params);
      if (expected.join(" ") !== given.join(" ")) throw new Error("thứ tự lệch");
      console.log(`   ✓ TRÙNG KHỚP cả tên lẫn thứ tự (${applied.length} tham số)\n`);
      ok++;
    } catch (e: unknown) {
      console.log(`   ❌ ${(e as Error).message}\n`);
      mismatch++;
    }
  }

  console.log(`── Tổng kết: ${ok} khớp, ${mismatch} lệch, ${unbuilt} chưa build`);
  if (unbuilt > 0) {
    console.log(
      `   ❌ ${unbuilt} module CHƯA BUILD — cổng không kết luận được về chúng.\n` +
      `   Chạy \`aiken build\` ở <Module>/onchain rồi chạy lại. Trên bản clone sạch thì\n` +
      `   mọi plutus.json đều thiếu (artifact đã gitignore) — bản cũ của cổng này thoát 0\n` +
      `   trong đúng ca đó, tức nó im lặng đúng lúc cần nói nhất.`,
    );
  }
  if (mismatch > 0 || unbuilt > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
