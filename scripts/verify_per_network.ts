// scripts/verify_per_network.ts — Verify applied validator hash per network.
//
// Run AFTER `aiken build` in each module (InstantGen/ScheduleGen/UMKeeper).
//
// Run:
//   npx tsx verify_per_network.ts
//
// ⚠  BÀI HỌC ĐÃ TRẢ GIÁ: bản trước của file này TỰ KHAI danh sách tham số
// (Instant 6, Schedule 3, UMKeeper 1) — y hệt cái sai của các script deploy.
// Deploy sai + verify sai giống nhau ⇒ đối chiếu thấy "khớp" ⇒ cổng kiểm biến
// thành cổng XÁC NHẬN LỖI. Nay cả hai phía dùng CHUNG scripts/deployParams.ts,
// và tên + thứ tự tham số đọc thẳng từ `plutus.json` qua scripts/applyParams.ts.
//
// Optional env (chỉ cần khi verify một deploy THẬT — nếu thiếu thì dùng giá trị
// giữ chỗ và hash chỉ có ý nghĩa kiểm HÌNH DẠNG):
//   LAMP_POLICY_ID  UM_NFT_POLICY_ID  SHARD_NFT_POLICY_ID
//   UM_DATUM_HASH   BACKING_NFT_POLICY_ID   BACKING_SCRIPT_HASH

import { validatorToScriptHash } from "@lucid-evolution/lucid";
import { lampAssetName, msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import {
  loadBlueprint, findValidator, paramTitles, appliedValidator,
  type ParamMap,
} from "./applyParams.js";
import {
  instantVaultParams, scheduleVaultParams, umDatumParams,
} from "./deployParams.js";

// ── Mạng cần đối chiếu ───────────────────────────────────────────
const NETWORKS: Network[] = ["Preview", "Preprod", "Mainnet"];

// ── Giá trị giữ chỗ khi thiếu env (chỉ kiểm hình dạng) ───────────
const PLACEHOLDER_POLICY = "00".repeat(28);

const LAMP_POLICY   = process.env.LAMP_POLICY_ID      ?? PLACEHOLDER_POLICY;
const UM_NFT_POLICY = process.env.UM_NFT_POLICY_ID    ?? PLACEHOLDER_POLICY;
const SHARD_POLICY  = process.env.SHARD_NFT_POLICY_ID ?? PLACEHOLDER_POLICY;
const UM_SCRIPT_HASH      = process.env.UM_DATUM_HASH          ?? PLACEHOLDER_POLICY;
const BACKING_POLICY      = process.env.BACKING_NFT_POLICY_ID  ?? PLACEHOLDER_POLICY;
const BACKING_SCRIPT_HASH = process.env.BACKING_SCRIPT_HASH    ?? PLACEHOLDER_POLICY;
// um_name / shard asset names là hằng giao thức, không phải env.
const UM_NFT_NAME = "554d44"; // "UMD" — khớp ASSET_NAMES.um_nft trong config.ts

// ── Bảng module ──────────────────────────────────────────────────
// SnapshotGen/VacuumGen đã dời sang Legacy/genmagic-v3.3 — không verify nữa.
interface ModuleSpec {
  /** Tên thư mục module ở gốc repo. */
  module: string;
  /** Title đầy đủ của validator trong plutus.json. */
  title: string;
  /** Bản đồ tên → giá trị, dùng CHUNG với script deploy. */
  build: (network: Network) => ParamMap;
}

const MODULES: ModuleSpec[] = [
  {
    module: "InstantGen",
    title:  "vault.vault.spend",
    build:  (net) => instantVaultParams({
      lampPolicyId:      LAMP_POLICY,
      lampAssetName:     lampAssetName(net),
      umNftPolicy:       UM_NFT_POLICY,
      umScriptHash:      UM_SCRIPT_HASH,
      backingNftPolicy:  BACKING_POLICY,
      backingScriptHash: BACKING_SCRIPT_HASH,
      msPerEpoch:        msPerEpoch(net),
    }),
  },
  {
    module: "ScheduleGen",
    title:  "vault.vault.spend",
    build:  (net) => scheduleVaultParams({
      lampPolicyId:  LAMP_POLICY,
      lampAssetName: lampAssetName(net),
      shardPolicyId: SHARD_POLICY,
      msPerEpoch:    msPerEpoch(net),
    }),
  },
  {
    module: "UMKeeper",
    title:  "um_datum.um_datum_validator.spend",
    build:  (net) => umDatumParams({
      msPerEpoch: msPerEpoch(net),
      umPolicy:   UM_NFT_POLICY,
      umName:     UM_NFT_NAME,
    }),
  },
];

// ── Run ──────────────────────────────────────────────────────────
async function main() {
  console.log("MagicLamp validator hash — per network × module verification\n");

  if (LAMP_POLICY === PLACEHOLDER_POLICY) {
    console.log("⚠  Đang dùng policy id GIỮ CHỖ — hash dưới đây chỉ để kiểm HÌNH DẠNG.");
    console.log("   Verify deploy thật thì đặt: LAMP_POLICY_ID UM_NFT_POLICY_ID SHARD_NFT_POLICY_ID\n");
  }

  let failures = 0;

  for (const mod of MODULES) {
    console.log(`── ${mod.module} / ${mod.title} ─────────────────────────`);

    let unapplied;
    try {
      const bp = await loadBlueprint(mod.module);
      unapplied = findValidator(bp, mod.title);
    } catch (e: unknown) {
      console.log(`  ❌ ${(e as Error).message}\n`);
      failures++;
      continue;
    }

    console.log(`  unapplied hash:  ${unapplied.hash}`);

    // Đối chiếu TÊN + THỨ TỰ trước khi nói tới hash.
    const expected = paramTitles(unapplied);
    const given    = Object.keys(mod.build("Preview"));
    console.log(`  blueprint params (${expected.length}): ${expected.join(", ")}`);
    console.log(`  script provides  (${given.length}): ${given.join(", ")}`);
    if (expected.join(" ") !== given.join(" ")) {
      console.log(`  ❌ LỆCH tên/thứ tự tham số — xem chi tiết ở lỗi apply bên dưới.`);
      failures++;
    } else {
      console.log(`  ✓ tên + thứ tự khớp blueprint`);
    }

    const hashes = new Map<string, string>();
    for (const net of NETWORKS) {
      try {
        const hash = validatorToScriptHash(appliedValidator(unapplied, mod.build(net)));
        hashes.set(net, hash);
        console.log(`  ${net.padEnd(8)} → ${hash}`);
      } catch (e: unknown) {
        console.log(`  ${net.padEnd(8)} → ❌ apply failed:\n${(e as Error).message}`);
        failures++;
      }
    }

    // Preview và Preprod DÙNG CHUNG mọi tham số theo mạng (cùng ms_per_epoch
    // 86_400_000, cùng asset name "tLAMP") ⇒ hash trùng nhau là ĐÚNG, không
    // phải dấu hiệu rơi tham số. Discriminator thật là testnet ↔ Mainnet.
    const preview = hashes.get("Preview");
    const mainnet = hashes.get("Mainnet");
    if (preview && mainnet && preview === mainnet) {
      console.log(
        `  ❌ Preview == Mainnet — tham số theo mạng KHÔNG vào được script ` +
        `(ms_per_epoch và/hoặc lamp_asset_name bị rơi).`,
      );
      failures++;
    }
    console.log();
  }

  if (failures > 0) {
    console.log(`❌ ${failures} vấn đề. KHÔNG deploy cho tới khi sạch.`);
    process.exit(1);
  }
  console.log("✓ Done. Đối chiếu hash với địa chỉ validator đã deploy trước khi gửi tx.");
}

main().catch((e) => { console.error(e); process.exit(1); });
