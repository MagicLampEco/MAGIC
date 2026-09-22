// scripts/verify_deployed_generation.ts — cụm ĐANG SỐNG có cùng ĐỜI với mã hôm nay không?
//
// Run:
//   npx tsx verify_deployed_generation.ts Preprod
//   npx tsx verify_deployed_generation.ts Preprod --ledger /đường/khác/state.Preprod.sh
//
// ── VÌ SAO TỆP NÀY TỒN TẠI ───────────────────────────────────────────────────
//
// `verify_per_network.ts` đối chiếu hash GIỮA CÁC MẠNG (cùng mã, khác tham số).
// Nó trả lời "bộ tham số của tôi có tự mâu thuẫn không". Nó KHÔNG trả lời câu
// đắt hơn: "bytes đang sống trên chuỗi có phải bytes mã này dựng ra không?"
// Dòng cuối của nó nói thẳng — "Đối chiếu hash với địa chỉ validator đã deploy
// trước khi gửi tx" — tức nó giao việc đó cho NGƯỜI. Một lời dặn làm tay không
// phải một cổng: nó không chạy, không đỏ, và không ai biết lần cuối ai làm.
//
// Giá đã trả (đo 2026-09-22): cụm Preprod deploy 2026-09-16 lệch mã hiện hành ở
// BA trục cùng lúc — hình dạng datum (`instant_unlock_ms` vào lược đồ 2026-09-21,
// tức SAU khi cụm deploy), nhịp epoch (Preprod đổi 1 ngày → 5 ngày 2026-09-20),
// và sắp tới là `lampPid`. Không cổng nào kêu, và không kêu vì **không có cổng
// nào nhìn vào trục đó**. Một cổng xanh nhầm và một chỗ không có cổng cho ra
// CÙNG một kết quả trên màn hình: im lặng. Nên đếm số cổng đang xanh không đo
// được gì — phải đếm số TRỤC có cổng nhìn vào.
//
// ── BA TRẠNG THÁI, KHÔNG PHẢI HAI ────────────────────────────────────────────
//
// KHỚP · LỆCH · KHÔNG ĐO ĐƯỢC. Trạng thái thứ ba phải kêu TO HƠN thứ hai, vì nó
// là trạng thái MÙ: một phép đo trả giá trị hợp lệ đúng lúc nó không đo được gì
// thì màu xanh của nó vô nghĩa — nó không nói "ổn", nó nói "tôi không biết" bằng
// giọng của "ổn". Ở đây "không đo được" gồm: thiếu `plutus.json` (chưa
// `aiken build`), thiếu một tham số trong sổ, hoặc sổ không có dòng hash sống.
//
// Cổng này là cổng KHẲNG ĐỊNH, không phải hook chặn thao tác ⟹ **fail-safe**:
// hỏng thì ĐỎ. (Hook chặn thao tác thì ngược lại — fail-open — vì người bị chặn
// BIẾT mình bị chặn; ở đây không ai biết.)
//
// ── NÓ KHÔNG ĐỌC CHUỖI, VÀ ĐÓ LÀ CHỦ Ý ───────────────────────────────────────
//
// Nó so hash DỰNG LẠI với hash GHI TRONG SỔ, không với hash tra từ chuỗi. Nên nó
// chạy được không cần khoá nào, và chạy được trong CI. Đổi lại, nó chỉ mạnh bằng
// độ đúng của sổ: sổ ghi sai thì cổng im. Phạm vi đó in ra ở cuối mỗi lượt chạy,
// không giấu.
//
// Cũng vì thế nó KHÔNG import `scripts/config.ts` — tệp đó ném ở tầng module khi
// thiếu khoá Blockfrost, và một cổng chỉ-đọc mà đòi khoá là một cổng sẽ bị tắt.

import { readFile } from "node:fs/promises";
import { validatorToScriptHash } from "@lucid-evolution/lucid";
import { lampAssetName, msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import {
  loadBlueprint, findValidator, appliedValidator, type ParamMap,
} from "./applyParams.js";
import {
  instantVaultParams, scheduleVaultParams, umDatumParams,
} from "./deployParams.js";

const NETWORKS: readonly Network[] = ["Preview", "Preprod", "Mainnet"];

// Nhịp epoch đã từng dùng trong kho này. Danh sách ĐÓNG, chỉ để CHẨN ĐOÁN khi đã
// lệch — nó biến "lệch" thành "lệch VÌ nhịp epoch", tức thành một câu hành động
// được. KHÔNG dùng nó để kết luận KHỚP: khớp ở một nhịp không phải nhịp hiện
// hành vẫn là LỆCH.
const KNOWN_EPOCH_CADENCES: ReadonlyArray<readonly [string, bigint]> = [
  ["1 ngày  (Preview, và Preprod TRƯỚC 2026-09-20)", 86_400_000n],
  ["5 ngày  (Preprod + Mainnet, từ 2026-09-20)",     432_000_000n],
];

// ── Sổ trạng thái ────────────────────────────────────────────────────────────
//
// PHÂN TÍCH, không `source`. Hai lý do, và lý do thứ hai mới là lý do thật:
// (a) `source` chạy mã tuỳ ý trong một tệp không được track;
// (b) `source` in giá trị ra màn hình ở một số dạng gán, và bản ghi phiên là thứ
//     người khác đọc. Sổ này hôm nay không mang bí mật nào — đã soát tên biến
//     2026-09-22, toàn định danh công khai — nhưng cổng không được dựa vào việc
//     ngày mai nó vẫn thế.
type Ledger = Map<string, string>;

async function readLedger(path: string): Promise<Ledger> {
  const text = await readFile(path, "utf8");
  const ledger: Ledger = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    // Bỏ chú thích đuôi dòng, rồi bỏ nháy bao ngoài.
    let value = m[2]!.replace(/\s+#.*$/, "").trim();
    value = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    ledger.set(name, value);
  }
  return ledger;
}

// ── Bảng module ──────────────────────────────────────────────────────────────
//
// `liveHashKey` là dòng trong sổ mang hash của bytes ĐANG SỐNG. `params` dựng
// bản đồ tham số TỪ CHÍNH SỔ ẤY — cố ý không lấy từ `process.env`: nếu tham số
// đến từ một nguồn khác nguồn ghi hash, thì một lượt "khớp" chỉ chứng minh hai
// nguồn tình cờ bằng nhau. Phép thử: đổi MỘT trong hai, cổng có đỏ không?
interface ModuleSpec {
  module:      string;
  title:       string;
  liveHashKey: string;
  /** Trả mảng tên khoá THIẾU (thay vì ParamMap) ⟹ KHÔNG ĐO ĐƯỢC. */
  params: (ledger: Ledger, net: Network, msPerEpochValue: bigint) => ParamMap | string[];
}

/** Trả danh sách khoá THIẾU trong sổ (rỗng = đủ). */
function missingKeys(ledger: Ledger, ...keys: string[]): string[] {
  return keys.filter((k) => {
    const v = ledger.get(k);
    return v === undefined || v === "";
  });
}

const MODULES: readonly ModuleSpec[] = [
  {
    module: "InstantGen",
    title:  "vault.vault.spend",
    liveHashKey: "VAULT_INSTANT_HASH",
    params: (ledger, net, mspe) => {
      const absent = missingKeys(ledger, "LAMP_POLICY_ID", "UM_NFT_POLICY_ID",
        "UM_DATUM_HASH", "BACKING_NFT_POLICY_ID", "BACKING_SCRIPT_HASH");
      if (absent.length > 0) return absent;
      return instantVaultParams({
        lampPolicyId:      ledger.get("LAMP_POLICY_ID")!,
        lampAssetName:     lampAssetName(net),
        umNftPolicy:       ledger.get("UM_NFT_POLICY_ID")!,
        umScriptHash:      ledger.get("UM_DATUM_HASH")!,
        backingNftPolicy:  ledger.get("BACKING_NFT_POLICY_ID")!,
        backingScriptHash: ledger.get("BACKING_SCRIPT_HASH")!,
        msPerEpoch:        mspe,
      });
    },
  },
  {
    module: "ScheduleGen",
    title:  "vault.vault.spend",
    liveHashKey: "VAULT_SCHEDULE_HASH",
    params: (ledger, net, mspe) => {
      const absent = missingKeys(ledger, "LAMP_POLICY_ID", "SHARD_NFT_POLICY_ID");
      if (absent.length > 0) return absent;
      return scheduleVaultParams({
        lampPolicyId:  ledger.get("LAMP_POLICY_ID")!,
        lampAssetName: lampAssetName(net),
        shardPolicyId: ledger.get("SHARD_NFT_POLICY_ID")!,
        msPerEpoch:    mspe,
      });
    },
  },
  {
    module: "UMKeeper",
    title:  "um_datum.um_datum_validator.spend",
    liveHashKey: "UM_DATUM_HASH",
    params: (ledger, _net, mspe) => {
      const absent = missingKeys(ledger, "UM_NFT_POLICY_ID");
      if (absent.length > 0) return absent;
      return umDatumParams({
        msPerEpoch: mspe,
        umPolicy:   ledger.get("UM_NFT_POLICY_ID")!,
        umName:     "554d44", // "UMD" — hằng giao thức, không phải env
      });
    },
  },
];

// ── Chạy ─────────────────────────────────────────────────────────────────────

interface Tally { match: number; drift: number; unmeasurable: number }

async function checkModule(
  spec: ModuleSpec, ledger: Ledger, net: Network, tally: Tally,
): Promise<void> {
  console.log(`▸ ${spec.module}  (${spec.title})`);

  const liveHash = ledger.get(spec.liveHashKey);
  if (liveHash === undefined || liveHash === "" || /^FILL_/.test(liveHash)) {
    tally.unmeasurable++;
    console.log(`  ⚠️  KHÔNG ĐO ĐƯỢC — sổ không có \`${spec.liveHashKey}\` (hoặc còn là giá trị giữ chỗ).`);
    console.log(`     Cổng này KHÔNG chạy cho module đó. Đừng đọc thành "sạch".\n`);
    return;
  }

  const mspe = msPerEpoch(net);
  const built = spec.params(ledger, net, mspe);
  if (Array.isArray(built)) {
    tally.unmeasurable++;
    console.log(`  ⚠️  KHÔNG ĐO ĐƯỢC — sổ thiếu ${built.length} tham số: ${built.join(", ")}`);
    console.log(`     Cổng này KHÔNG chạy cho module đó. Đừng đọc thành "sạch".\n`);
    return;
  }

  let blueprint;
  try {
    blueprint = await loadBlueprint(spec.module);
  } catch (e) {
    tally.unmeasurable++;
    console.log(`  ⚠️  KHÔNG ĐO ĐƯỢC — không đọc được \`${spec.module}/onchain/plutus.json\`.`);
    console.log(`     Chạy \`aiken build\` trong module đó trước. (${(e as Error).message})\n`);
    return;
  }

  const validator = findValidator(blueprint, spec.title);
  const rebuiltHash = validatorToScriptHash(appliedValidator(validator, built));

  if (rebuiltHash === liveHash) {
    tally.match++;
    console.log(`  ✓ KHỚP  ${liveHash}`);
    console.log(`     bytes đang sống = bytes mã hôm nay dựng ra, với tham số trong sổ.\n`);
    return;
  }

  tally.drift++;
  console.log(`  ❌ LỆCH`);
  console.log(`     sổ ghi đang sống : ${liveHash}`);
  console.log(`     mã hôm nay dựng  : ${rebuiltHash}`);

  // Chẩn đoán: có nhịp epoch nào GIẢI THÍCH được chỗ lệch không? Thu hẹp "lệch"
  // thành "lệch vì trục nào", để người đọc không phải tự đoán ba trục.
  const explainedBy: string[] = [];
  for (const [label, cadence] of KNOWN_EPOCH_CADENCES) {
    if (cadence === mspe) continue;
    const alt = spec.params(ledger, net, cadence);
    if (Array.isArray(alt)) continue;
    if (validatorToScriptHash(appliedValidator(validator, alt)) === liveHash) {
      explainedBy.push(label);
    }
  }

  if (explainedBy.length > 0) {
    console.log(`     ⟹ GIẢI THÍCH ĐƯỢC: bytes đang sống khớp khi dựng với nhịp epoch ${explainedBy.join(" / ")},`);
    console.log(`        không phải nhịp hiện hành (${mspe} ms). Cụm deploy TRƯỚC lần đổi nhịp.`);
  } else {
    console.log(`     ⟹ KHÔNG giải thích được bằng nhịp epoch. Lệch ở tham số khác, hoặc ở chính mã`);
    console.log(`        validator (đời thiết kế khác). Một lượt dựng lại là bắt buộc.`);
  }
  console.log();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const net = args.find((a) => !a.startsWith("--")) as Network | undefined;
  const flagAt = args.indexOf("--ledger");
  const ledgerArg = flagAt >= 0 ? args[flagAt + 1] : undefined;

  if (net === undefined || !NETWORKS.includes(net)) {
    console.error(`Dùng: npx tsx verify_deployed_generation.ts <${NETWORKS.join("|")}> [--ledger <đường>]`);
    process.exit(2);
  }

  const ledgerPath = ledgerArg ?? `scripts/state.${net}.sh`;
  let ledger: Ledger;
  try {
    ledger = await readLedger(ledgerPath);
  } catch (e) {
    // Sổ vắng là KHÔNG ĐO ĐƯỢC ở mức toàn lượt chạy — và nó phải đỏ, không im.
    console.error(`⚠️  KHÔNG ĐO ĐƯỢC — không đọc được sổ \`${ledgerPath}\`.`);
    console.error(`   Sổ bị .gitignore chặn nên nó KHÔNG đi theo \`git clone\`; xin bản chép.`);
    console.error(`   (${(e as Error).message})`);
    process.exit(1);
  }

  console.log(`\nĐỜI CỤM ĐANG SỐNG vs ĐỜI MÃ HÔM NAY — ${net}`);
  console.log(`sổ: ${ledgerPath}   ·   nhịp epoch hiện hành: ${msPerEpoch(net)} ms`);
  console.log(`${"─".repeat(78)}\n`);

  const tally: Tally = { match: 0, drift: 0, unmeasurable: 0 };
  for (const spec of MODULES) await checkModule(spec, ledger, net, tally);

  // ── Phạm vi: in ĐIỀU KIỆN đang có hiệu lực, và ĐẾM phần nằm ngoài ──────────
  //
  // Khai ra một chỗ bị loại thì trông như đã xử lý xong; một lời khai không thay
  // được một phép đếm. Nên ở đây đếm, không chỉ khai.
  const hashKeysInLedger = [...ledger.keys()].filter((k) => /_(HASH|SCRIPT_HASH)$/.test(k));
  const hashKeysCovered  = MODULES.map((m) => m.liveHashKey);
  const outOfScope       = hashKeysInLedger.filter((k) => !hashKeysCovered.includes(k));

  console.log(`${"─".repeat(78)}`);
  console.log(`KHỚP ${tally.match}  ·  LỆCH ${tally.drift}  ·  KHÔNG ĐO ĐƯỢC ${tally.unmeasurable}`);
  console.log();
  console.log(`PHẠM VI — cổng này nhìn vào ${hashKeysCovered.length} hash: ${hashKeysCovered.join(", ")}.`);
  console.log(`Sổ còn ${outOfScope.length} dòng hash NẰM NGOÀI phạm vi cổng này:`);
  console.log(`  ${outOfScope.join(", ") || "(không có)"}`);
  console.log(`Chúng KHÔNG được đối chiếu. "Sạch" ở trên chỉ nói về ${hashKeysCovered.length} hash kia.`);
  console.log();
  console.log(`Cổng so hash DỰNG LẠI với hash GHI TRONG SỔ — KHÔNG tra chuỗi.`);
  console.log(`Sổ ghi sai thì cổng im: nó mạnh đúng bằng độ đúng của sổ.`);
  console.log();

  if (tally.drift > 0 || tally.unmeasurable > 0) {
    console.log(`❌ KHÔNG deploy, và KHÔNG dựng giao dịch cho tới khi sạch.`);
    process.exit(1);
  }
  console.log(`✓ Ba module khớp đời. Vẫn phải đối chiếu địa chỉ trên chuỗi trước khi gửi tx.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
