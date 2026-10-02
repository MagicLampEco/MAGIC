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
//   RATE_PARAM_HASH  GREENBACK_BEACON_HASH  GB_SHARD_HASH   (GenBeacons — Gen v2.0)
// Gen v2.0: vault Instant 9 tham số, két ScheduleGen 6 tham số + `commit` 9 tham số. Hai
// hàng ScheduleGen dựng qua `scheduleScriptPair` — cùng hàm với deploy 03/06/07 — vì két
// nhận hash `commit` ĐÃ apply, không phải một giá trị tự khai.
// Két Wakeme (apply-param #8 của Instant) KHÔNG đọc env: lấy theo mạng từ
// `@magiclamp/protocol-utils` ▸ `wakemeVaultHash`; mạng chưa có két ⟹ giữ chỗ + báo.

import { validatorToScriptHash } from "@lucid-evolution/lucid";
import { lampAssetName, msPerEpoch, wakemeVaultHash, windowOriginMs, WindowOriginError, type Network } from "@magiclamp/protocol-utils";
import {
  loadBlueprint, findValidator, paramTitles, appliedValidator,
  type Blueprint, type ParamMap,
} from "./applyParams.js";
import {
  instantVaultParams, scheduleCommitParams, scheduleVaultParams, scheduleScriptPair, umDatumParams,
  type GenV2BeaconRefs, type ScheduleScriptParamInputs,
} from "./deployParams.js";

// ── Mạng cần đối chiếu ───────────────────────────────────────────
const NETWORKS: Network[] = ["Preview", "Preprod", "Mainnet"];

// ── Giá trị giữ chỗ khi thiếu env (chỉ kiểm hình dạng) ───────────
const PLACEHOLDER_POLICY = "00".repeat(28);

/** Tham số đang là giữ-chỗ, gom lại để báo ĐỦ chứ không báo mỗi cái đầu tiên. */
const usingPlaceholder: string[] = [];

function fromEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    usingPlaceholder.push(name);
    return PLACEHOLDER_POLICY;
  }
  return v;
}

const LAMP_POLICY   = fromEnv("LAMP_POLICY_ID");
const UM_NFT_POLICY = fromEnv("UM_NFT_POLICY_ID");
const SHARD_POLICY  = fromEnv("SHARD_NFT_POLICY_ID");
// Ba hash GenBeacons — cùng tên khoá sổ mà `genV2BeaconRefsFromBook` đọc. NFT beacon có
// policy = script hash của chính beacon, nên mỗi khoá điền hai ô.
const RATE_PARAM_HASH       = fromEnv("RATE_PARAM_HASH");
const GREENBACK_BEACON_HASH = fromEnv("GREENBACK_BEACON_HASH");
const GB_SHARD_HASH         = fromEnv("GB_SHARD_HASH");
const BEACONS: GenV2BeaconRefs = {
  gbBeaconNftPolicy: GREENBACK_BEACON_HASH, gbBeaconScriptHash: GREENBACK_BEACON_HASH,
  gbShardPolicyId:   GB_SHARD_HASH,
  rateNftPolicy:     RATE_PARAM_HASH,       rateScriptHash:     RATE_PARAM_HASH,
};
function scheduleInputs(net: Network): ScheduleScriptParamInputs {
  return {
    lampPolicyId: LAMP_POLICY, lampAssetName: lampAssetName(net), shardPolicyId: SHARD_POLICY,
    msPerEpoch: msPerEpoch(net), windowOriginMs: ORIGIN_BY_NET[net], ...BEACONS,
  };
}
/** Két Wakeme (apply-param #8 của vault Instant) THEO MẠNG, từ nguồn duy nhất
 *  `@magiclamp/protocol-utils` ▸ `wakemeVaultHash`. Mạng chưa có két thì công cụ này vẫn
 *  chạy tiếp bằng giá trị giữ chỗ và GHI TÊN vào danh sách giữ chỗ — hash Instant của mạng
 *  đó chỉ kiểm HÌNH DẠNG, và không vault Instant thật nào dựng được ở đó (deploy/05 ném). */
function wakemeFor(net: Network): string {
  try {
    return wakemeVaultHash(net);
  } catch {
    usingPlaceholder.push(`wakeme_vault_hash(${net}) — chưa có két Wakeme trên mạng này`);
    return PLACEHOLDER_POLICY;
  }
}
// Tính NGAY lúc nạp (không lười trong `build`) để khối cảnh báo giữ chỗ ở `main` — in
// TRƯỚC vòng dựng hash — đã thấy đủ tên.
const WAKEME_BY_NET: Record<Network, string> = {
  Preview: wakemeFor("Preview"),
  Preprod: wakemeFor("Preprod"),
  Mainnet: wakemeFor("Mainnet"),
};

/** Gốc cửa sổ (apply-param CUỐI) THEO MẠNG, từ `@magiclamp/protocol-utils` ▸ `windowOriginMs`.
 *  Mạng chưa có gốc (Preview, `WIN-PREVIEW`) thì cùng cách với két Wakeme: giá trị giữ chỗ
 *  `0n` + GHI TÊN vào danh sách giữ chỗ — hash của mạng đó chỉ kiểm HÌNH DẠNG; deploy thật ném. */
function originFor(net: Network): bigint {
  try {
    return windowOriginMs(net);
  } catch (e) {
    if (!(e instanceof WindowOriginError)) throw e;
    usingPlaceholder.push(`window_origin_ms(${net}) — ${e.code}, mạng chưa có gốc cửa sổ`);
    return 0n;
  }
}
const ORIGIN_BY_NET: Record<Network, bigint> = {
  Preview: originFor("Preview"),
  Preprod: originFor("Preprod"),
  Mainnet: originFor("Mainnet"),
};

// um_name / shard asset names là hằng giao thức, không phải env.
const UM_NFT_NAME = "554d44"; // "UMD" — khớp ASSET_NAMES.um_nft trong config.ts

// ── Bảng module ──────────────────────────────────────────────────
// SnapshotGen/VacuumGen đã dời sang Legacy/ — không verify nữa.
interface ModuleSpec {
  /** Tên thư mục module ở gốc repo. */
  module: string;
  /** Title đầy đủ của validator trong plutus.json. */
  title: string;
  /** Bản đồ tên → giá trị, dùng CHUNG với script deploy. Nhận blueprint của chính module
   *  vì két ScheduleGen v2.0 cần hash `commit` ĐÃ apply từ cùng blueprint đó. */
  build: (network: Network, bp: Blueprint) => ParamMap;
}

const MODULES: ModuleSpec[] = [
  {
    module: "InstantGen",
    title:  "vault.vault.spend",
    build:  (net) => instantVaultParams({
      lampPolicyId:    LAMP_POLICY,
      lampAssetName:   lampAssetName(net),
      msPerEpoch:      msPerEpoch(net),
      windowOriginMs:  ORIGIN_BY_NET[net],
      wakemeVaultHash: WAKEME_BY_NET[net],
      ...BEACONS,
    }),
  },
  {
    module: "ScheduleGen",
    title:  "vault.commit.withdraw",
    build:  (net) => scheduleCommitParams(scheduleInputs(net)),
  },
  {
    module: "ScheduleGen",
    title:  "vault.vault.spend",
    build:  (net, bp) => {
      const i = scheduleInputs(net);
      return scheduleVaultParams({
        lampPolicyId: i.lampPolicyId, lampAssetName: i.lampAssetName, shardPolicyId: i.shardPolicyId,
        msPerEpoch: i.msPerEpoch, gbShardPolicyId: i.gbShardPolicyId,
        commitScriptHash: scheduleScriptPair(bp, i).commitHash,
        windowOriginMs: i.windowOriginMs,
      });
    },
  },
  {
    module: "UMKeeper",
    title:  "um_datum.um_datum_validator.spend",
    build:  (net) => umDatumParams({
      msPerEpoch: msPerEpoch(net),
      windowOriginMs: ORIGIN_BY_NET[net],
      umPolicy:   UM_NFT_POLICY,
      umName:     UM_NFT_NAME,
    }),
  },
];

// ── Run ──────────────────────────────────────────────────────────
async function main() {
  console.log("MagicLamp validator hash — per network × module verification\n");

  // Cùng cổng với đường DEPLOY. Bản trước đọc thẳng `process.env` nên một policy
  // nằm trong danh sách từ chối của `config.ts` vẫn được công cụ này in ra hash kèm
  // "✓ Done" và thoát 0 — tức cổng KIỂM gật đầu với đúng giá trị mà cổng DEPLOY ném.
  // Đó là ca "deploy sai + verify sai giống nhau" mà đầu tệp này đã tự cảnh báo; chú
  // thích không phải cổng, nên nay gọi cổng thật.
  //
  // Chỉ kiểm khi có giá trị thật: giữ-chỗ toàn-số-0 cố ý không đúng hình dạng một
  // policy đã triển khai, và nó đã được báo riêng ở khối dưới.
  if (!usingPlaceholder.includes("LAMP_POLICY_ID")) {
    const { POLICY_IDS } = await import("./config.js");
    void POLICY_IDS.lamp;   // ném nếu policy nằm trong danh sách từ chối hoặc sai hình dạng
  }

  if (usingPlaceholder.length > 0) {
    // Đây là trạng thái KHÔNG ĐO ĐƯỢC, không phải trạng thái "khớp" — nên nó phải kêu
    // to hơn một dòng lệch. Bản trước chỉ cảnh báo cho LAMP; năm tham số còn lại rơi
    // về toàn-số-0 trong im lặng, và câu kết vẫn mời đi đối chiếu với địa chỉ đã
    // deploy. Hash của tham số bịa mà được đối chiếu là cách hỏng tệ nhất ở đây.
    console.log("⚠  KHÔNG ĐO ĐƯỢC — các tham số sau đang là GIỮ CHỖ (toàn số 0):");
    for (const n of usingPlaceholder) console.log(`     · ${n}`);
    console.log("   Hash dưới đây chỉ kiểm HÌNH DẠNG. ĐỪNG đối chiếu chúng với địa chỉ");
    console.log("   đã deploy — chúng là hash của tham số không có thật.\n");
  }

  let failures = 0;

  for (const mod of MODULES) {
    console.log(`── ${mod.module} / ${mod.title} ─────────────────────────`);

    let unapplied, bp: Blueprint;
    try {
      bp = await loadBlueprint(mod.module);
      unapplied = findValidator(bp, mod.title);
    } catch (e: unknown) {
      console.log(`  ❌ ${(e as Error).message}\n`);
      failures++;
      continue;
    }

    console.log(`  unapplied hash:  ${unapplied.hash}`);

    // Đối chiếu TÊN + THỨ TỰ trước khi nói tới hash.
    const expected = paramTitles(unapplied);
    const given    = Object.keys(mod.build("Preview", bp));
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
        const hash = validatorToScriptHash(appliedValidator(unapplied, mod.build(net, bp)));
        hashes.set(net, hash);
        console.log(`  ${net.padEnd(8)} → ${hash}`);
      } catch (e: unknown) {
        console.log(`  ${net.padEnd(8)} → ❌ apply failed:\n${(e as Error).message}`);
        failures++;
      }
    }

    // Hai mạng phải cho hash TRÙNG NHAU khi và CHỈ KHI bộ tham số dựng cho chúng
    // giống hệt nhau. Suy quan hệ đó từ chính `mod.build(net)` thay vì gõ tay một
    // cặp mạng, vì cặp gõ tay già đi theo mỗi lần đổi bảng tham số:
    //
    //   · Bản trước ghim "Preview == Preprod là ĐÚNG" — đúng khi hai mạng chung
    //     `ms_per_epoch = 86_400_000`. Chủ dự án chốt 2026-09-20 đưa Preprod về
    //     432_000_000, nên câu đó thành sai mà không phép kiểm nào đỏ.
    //   · Và nó chỉ so MỘT cặp (Preview ↔ Mainnet), nên nó mù với ca tham số rơi
    //     giữa hai mạng còn lại.
    //
    // Luật dưới đây không cần biết validator nào nhận tham số nào: validator chỉ
    // nhận `ms_per_epoch` thì Preprod và Mainnet dựng ra bộ tham số giống nhau và
    // hash trùng nhau là ĐÚNG; validator nhận thêm `lamp_asset_name` thì chúng khác.
    const paramKey = (net: Network) =>
      JSON.stringify(mod.build(net, bp), (_k, v) =>
        typeof v === "bigint" ? `${v}n` : v);

    for (let i = 0; i < NETWORKS.length; i++) {
      for (let j = i + 1; j < NETWORKS.length; j++) {
        const a = NETWORKS[i], b = NETWORKS[j];
        const ha = hashes.get(a), hb = hashes.get(b);
        if (!ha || !hb) continue;               // lượt apply đã hỏng, đã đếm ở trên
        const paramTrung = paramKey(a) === paramKey(b);
        if (paramTrung && ha !== hb) {
          console.log(
            `  ❌ ${a} và ${b} dựng CÙNG bộ tham số nhưng hash KHÁC nhau — ` +
            `có thứ ngoài bộ tham số đang lọt vào bytes.`,
          );
          failures++;
        } else if (!paramTrung && ha === hb) {
          console.log(
            `  ❌ ${a} và ${b} dựng bộ tham số KHÁC nhau mà hash TRÙNG — ` +
            `tham số theo mạng không vào được script (bị rơi).`,
          );
          failures++;
        }
      }
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
