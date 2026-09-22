/**
 * gen_vault_tx_api_deployment.ts — SINH khối `VAULT_TX_API_DEPLOYMENT` từ sổ trạng thái
 * của lần deploy, thay vì chép tay từ `DEPLOYED.md`.
 *
 *   npx tsx scripts/gen_vault_tx_api_deployment.ts Preprod
 *   npx tsx scripts/gen_vault_tx_api_deployment.ts Preprod --vault Instant
 *
 * ── Vì sao tệp này tồn tại ──────────────────────────────────────────────────────
 * `VaultTxAPI/README.md` cảnh báo rằng mọi địa chỉ trong khối ấy là **bản chép** của
 * một lần deploy, và một bản chép hết đúng thì dịch vụ trả `VAULT_NOT_FOUND` mãi mãi,
 * im lặng, trông y hệt "chủ này chưa có vault". Chép tay từ sổ deploy là đúng cái bản
 * sao sẽ chết mà không ai được báo.
 *
 * Nên đây là mức 2 của §"Một nguồn, nhiều con trỏ": **SINH từ nguồn**, không gõ tay.
 * Nguồn là `scripts/state.<NET>.sh` — chính tệp mà các bước deploy ghi ra và keeper
 * đọc vào. Cụm dựng lại thì chạy lại tệp này, không phải chép lại.
 *
 * Tệp này KHÔNG gọi mạng và KHÔNG đọc bí mật nào. Nó đọc một sổ trạng thái, đổi vài
 * script hash thành địa chỉ, rồi in JSON ra stdout.
 *
 * ── Ba chỗ dễ hiểu sai, ghi ngay đây ────────────────────────────────────────────
 * 1. `UM_DATUM_HASH` trong sổ trạng thái **là script hash của UM**, không phải một
 *    datum hash. Tên đặt lệch từ trước; `scripts/verify_per_network.ts` đọc nó vào
 *    biến `UM_SCRIPT_HASH`. Không đổi tên ở đây: cái tên ấy nằm trong nhiều tệp và
 *    trong sổ trạng thái của mọi mạng, nên đổi nó trước khi đổi mọi con trỏ là để
 *    một cổng máy chết im lặng.
 * 2. Mục `instant` là **TUỲ CHỌN** với `VaultTxAPI`. Vắng nó thì `/tx/instant-gen`
 *    đóng — đó là một trạng thái đã được thiết kế, không phải một lỗi. Tệp này chỉ
 *    phát mục ấy khi có ĐỦ bốn trường, và nói rõ thiếu trường nào khi không đủ.
 *    Phát một mục khai thiếu là mở một cửa rồi để nó chết trên chuỗi.
 * 3. `source` là **bắt buộc** và `/health` in lại nguyên văn. Nó được sinh kèm mốc
 *    sửa của sổ trạng thái và commit đang đứng — để vài tháng nữa còn trả lời được
 *    câu *"khối này chép lúc nào"*.
 */
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialToAddress, scriptHashToCredential } from "@lucid-evolution/lucid";
import { lampAssetName, type Network } from "@magiclamp/protocol-utils";
// `ASSET_NAMES` là NGUỒN của vế tên tài sản. Hai trường được đọc ở đây (`um_nft`,
// `backing`) là hằng chuỗi thường; hai trường còn lại của bảng đó là getter đòi biến
// môi trường, nên đừng duyệt cả bảng — chỉ đọc đúng hai trường cần.
import { ASSET_NAMES } from "./config.js";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

type StateBook = Record<string, string>;

/** Đọc sổ trạng thái bằng PHÂN TÍCH, không bằng `source`.
 *
 *  Cố ý không nhờ shell: `source` chạy mọi thứ trong tệp, và một sổ trạng thái là
 *  thứ được ghi bởi nhiều bước deploy khác nhau. Đọc bằng regex thì tệp chỉ là dữ
 *  liệu, và hỏng thì hỏng ở đây chứ không hỏng ở một chỗ nào đó về sau. */
function readStateBook(network: Network): { book: StateBook; path: string; mtime: string } {
  const path = join(SCRIPTS_DIR, `state.${network}.sh`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `✗ Không đọc được ${path}.\n` +
      `  Tệp này bị .gitignore chặn nên nó KHÔNG đi theo \`git clone\` — một máy mới sẽ ` +
      `không có nó dù kho đã đủ mã.`,
    );
  }
  const book: StateBook = {};
  for (const line of raw.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    // Bỏ chú thích đuôi dòng chỉ khi giá trị KHÔNG được bọc nháy — giá trị có nháy
    // thì dấu `#` bên trong là một phần của nó.
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "");
    v = v.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1").trim();
    if (v !== "") book[m[1]] = v;
  }
  return { book, path, mtime: statSync(path).mtime.toISOString().slice(0, 19) + "Z" };
}

/** Lấy một khoá, NÉM và nêu đúng tên khoá khi vắng.
 *
 *  Không có giá trị mặc định nào ở đây, kể cả chuỗi rỗng: mọi trường trong khối này
 *  là một địa chỉ hoặc một định danh tài sản, và một giá trị đệm sẽ đi tiếp vào một
 *  phép tra UTxO ở nơi khác, nơi nó không còn tự khai được là thiếu. */
function need(book: StateBook, key: string, dungLamGi: string): string {
  const v = book[key];
  if (!v) {
    throw new Error(
      `✗ Sổ trạng thái thiếu \`${key}\` (cần cho: ${dungLamGi}).\n` +
      `  Chạy lại bước deploy ghi ra khoá đó, hoặc bổ sung tay vào sổ rồi chạy lại.`,
    );
  }
  return v;
}

/** Ném khi chuỗi không phải hex chẵn ký tự.
 *
 *  Chốt này nhỏ nhưng nó canh đúng ca đã xảy ra một lần ngay trong tệp này: một giá
 *  trị ĐÃ là hex bị mã hoá thêm một lượt nữa. Kết quả vẫn là hex hợp lệ, vẫn chẵn ký
 *  tự, nên mọi phép kiểm hình dạng đều qua — thứ duy nhất bắt được là so với giá trị
 *  mong đợi. Nên hàm này nhận thêm tham số `chờ` khi chỗ gọi biết trước đáp án. */
function assertHex(v: string, ten: string, cho?: string): string {
  if (!/^([0-9a-f]{2})*$/.test(v)) {
    throw new Error(`✗ ${ten} = "${v}" không phải hex chẵn ký tự.`);
  }
  if (cho !== undefined && v !== cho) {
    throw new Error(`✗ ${ten} = "${v}" nhưng chờ "${cho}".`);
  }
  return v;
}

function hashToAddress(scriptHash: string, network: Network): string {
  if (!/^[0-9a-f]{56}$/.test(scriptHash)) {
    throw new Error(`✗ "${scriptHash}" không phải script hash 28 byte dạng hex.`);
  }
  return credentialToAddress(network, scriptHashToCredential(scriptHash));
}

function gitSha(): string {
  try {
    return execFileSync("git", ["-C", SCRIPTS_DIR, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // Không có git ⟹ khai là KHÔNG ĐO ĐƯỢC, đừng khai là một commit nào đó.
    return "khong-doc-duoc-commit";
  }
}

function main(): void {
  const network = (process.argv[2] ?? "") as Network;
  if (network !== "Preview" && network !== "Preprod" && network !== "Mainnet") {
    throw new Error(`✗ Tham số 1 phải là Preview | Preprod | Mainnet (nhận: "${process.argv[2] ?? ""}").`);
  }
  const vaultKindIdx = process.argv.indexOf("--vault");
  const vaultKind = vaultKindIdx > 0 ? process.argv[vaultKindIdx + 1] : "Instant";
  if (vaultKind !== "Instant" && vaultKind !== "Schedule") {
    throw new Error(`✗ --vault phải là Instant hoặc Schedule (nhận: "${vaultKind}").`);
  }

  const { book, path, mtime } = readStateBook(network);

  // `ref_script_utxos.vault` chỉ có MỘT ô, nên khối này phục vụ MỘT loại vault mỗi
  // lượt. Sinh hai khối cho hai loại thay vì cố nhét cả hai vào một.
  const refVaultKey = vaultKind === "Instant" ? "REF_VAULT_INSTANT_UTXO" : "REF_VAULT_SCHEDULE_UTXO";
  const vaultAddrKey = vaultKind === "Instant" ? "VAULT_INSTANT_ADDR" : "VAULT_SCHEDULE_ADDR";

  const deployment: Record<string, unknown> = {
    source: `${network} · ${vaultKind} · sinh từ ${path.replace(/^.*\/MAGIC\//, "")} (sửa lần cuối ${mtime}) tại commit ${gitSha()}`,
    lamp: {
      policy_id: need(book, "LAMP_POLICY_ID", "định danh LAMP, vế policy"),
      // Tên tài sản KHÔNG lấy từ sổ: nó là apply-param #2 suy theo MẠNG, và
      // `ProtocolUtils` là nguồn của nó. Lấy từ sổ là mở đường cho một sổ Preprod cũ
      // mang tên của mạng khác.
      //
      // 🔴 `lampAssetName()` trả về **HEX rồi**, không phải chuỗi utf8 — bản đầu của
      // dòng này bọc thêm một lượt `Buffer.from(…, "utf8").toString("hex")` và cho ra
      // `37343463343134643530`, tức hex của chuỗi `"744c414d50"`. Cổng tên tài sản của
      // `VaultTxAPI` sẽ bắt được (nó giải hex rồi so với tên theo mạng), nhưng nó bắt
      // ở lượt khởi động dịch vụ chứ không ở đây — và câu lỗi lúc đó nói về mạng.
      asset_name_hex: assertHex(lampAssetName(network), "lamp.asset_name_hex"),
    },
    vaults: [
      { vault_type: vaultKind, address: need(book, vaultAddrKey, `địa chỉ vault ${vaultKind}`) },
    ],
    shard_address: hashToAddress(need(book, "SHARD_HASH", "địa chỉ cụm shard"), network),
    ref_script_utxos: {
      vault: need(book, refVaultKey, `script tham chiếu của vault ${vaultKind}`),
      shard: need(book, "REF_SHARD_UTXO", "script tham chiếu của shard"),
      consume: need(book, "REF_CONSUME_UTXO", "script tham chiếu của ConsumeMAGIC"),
    },
    consume: {
      engage_address: need(book, "CONSUME_ADDRESS", "địa chỉ luồng Engage"),
      engage_nft_unit: need(book, "ENGAGE_NFT_UNIT", "NFT định danh luồng Engage"),
      price_beacon_address: hashToAddress(need(book, "PRICE_PARAM_HASH", "địa chỉ beacon PriceParam"), network),
      price_beacon_nft_unit: need(book, "PRICE_NFT_UNIT", "NFT định danh beacon PriceParam"),
    },
  };

  // ── Mục `instant`: phát TRỌN hoặc không phát ──────────────────────────────────
  //
  // Sổ trạng thái chỉ ghi vế **policy** của hai NFT này; vế **tên tài sản** nằm ở
  // `scripts/config.ts` ▸ `ASSET_NAMES` — đó là nguồn của nó, và hai vế phải ghép ở
  // đây chứ không được đoán. Định danh một tài sản là CẶP `(policy id, tên)`; vế tên
  // KHÔNG BAO GIỜ suy ra được từ vế policy.
  //
  // 🔴 Đáng nói về policy của backing beacon: trên Preprod nó là
  // `28e916b0…`, tức **chính sách chữ-ký-đơn suy từ khoá ví deploy** — của chính đội,
  // không phải hàng nhái. Nhưng cùng policy ấy đang mang 27 dòng tài sản mang tên của
  // hệ, gồm một dòng hiện ra chữ `tLAMP` (`scripts/DEPLOYED.md` ▸ *"Kiểm kê dưới
  // policy 28e916b0…"*). Nên nó an toàn ĐÚNG CHỪNG NÀO bên tiêu thụ còn tra theo cặp.
  // `VaultTxAPI` có tra theo cặp (`unit()` ghép cả hai vế), và đó là lý do khối này
  // phát ra `*_nft_unit` chứ không phát ra hai trường rời.
  const thieu: string[] = [];
  if (!book.UM_DATUM_HASH) thieu.push("UM_DATUM_HASH (script hash của UM — tên đặt lệch, xem đầu tệp)");
  if (!book.UM_NFT_POLICY_ID) thieu.push("UM_NFT_POLICY_ID");
  if (!book.BACKING_SCRIPT_HASH) thieu.push("BACKING_SCRIPT_HASH");
  if (!book.BACKING_NFT_POLICY_ID) thieu.push("BACKING_NFT_POLICY_ID");

  if (thieu.length === 0) {
    deployment.instant = {
      um_datum_address: hashToAddress(book.UM_DATUM_HASH, network),
      um_nft_unit: assertHex(book.UM_NFT_POLICY_ID, "UM_NFT_POLICY_ID") + assertHex(ASSET_NAMES.um_nft, "ASSET_NAMES.um_nft"),
      backing_beacon_address: hashToAddress(book.BACKING_SCRIPT_HASH, network),
      backing_beacon_nft_unit: assertHex(book.BACKING_NFT_POLICY_ID, "BACKING_NFT_POLICY_ID") + assertHex(ASSET_NAMES.backing, "ASSET_NAMES.backing"),
    };
  } else {
    process.stderr.write(
      `⚠ Mục \`instant\` KHÔNG được phát ⟹ \`/tx/instant-gen\` sẽ ĐÓNG.\n` +
      `  Đây là một trạng thái đã thiết kế (mục này tuỳ chọn), không phải lỗi — nhưng\n` +
      `  nó có nghĩa là màn GenMAGIC của bên tiêu thụ vẫn chưa dùng được.\n` +
      `  Thiếu, đúng tên khoá trong sổ trạng thái:\n` +
      thieu.map((t) => `    · ${t}\n`).join(""),
    );
  }

  process.stdout.write(JSON.stringify(deployment, null, 2) + "\n");
}

try {
  main();
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
