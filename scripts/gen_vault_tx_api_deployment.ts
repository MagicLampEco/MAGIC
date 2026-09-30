/**
 * gen_vault_tx_api_deployment.ts — SINH khối `VAULT_TX_API_DEPLOYMENT` từ sổ trạng thái
 * của lần deploy, thay vì chép tay từ `DEPLOYED.md`.
 *
 *   npx tsx scripts/gen_vault_tx_api_deployment.ts Preprod
 *   npx tsx scripts/gen_vault_tx_api_deployment.ts Preprod --vault Schedule
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
 * 1. Khối `gen_v2` + `ref_script_utxos.gb_shard` (và `commit` với két Schedule) là
 *    **BẮT BUỘC** ở bộ sinh này, dù `VaultTxAPI` coi chúng là tuỳ chọn. Hai phía không
 *    lệch nhau: dịch vụ để tuỳ chọn để một cấu hình tay có thể đóng hẳn các đường Gen
 *    v2.0 (501), còn bộ sinh phục vụ MỘT cụm Gen v2.0 đã deploy — cụm đó không sinh,
 *    không làm mới checkpoint, không tiêu sang epoch mới được nếu thiếu chúng. Sổ thiếu
 *    khoá nào ⟹ NÉM và kể ĐỦ mọi khoá thiếu (`GEN_V2_STATE_KEYS`), không phát một khối
 *    khai thiếu, không đệm.
 *    Mục `instant` cũ (datum UM + beacon backing) đã chết cùng Gen v2.0: `VaultTxAPI`
 *    TỪ CHỐI khởi động khi thấy nó, nên bộ sinh không bao giờ phát nó nữa — kể cả khi
 *    sổ còn khoá `UM_*` / `BACKING_*` của một đời cũ.
 * 2. Mọi policy NFT của `GenBeacons` (RHO · GBB · GBS‖id · VRG) BẰNG hash script của
 *    chính validator đó — mint gộp trong validator, và `GenBeacons/offchain/src/scripts.ts`
 *    ▸ `findValidator` kiểm điều đó trên blueprint chứ không giả định. Nên sổ chỉ giữ
 *    HASH; `rate_nft_policy` / `greenback_beacon_nft_policy` suy từ đúng hash ấy, không
 *    có khoá sổ riêng — hai khoá cho một sự thật là hai chỗ để lệch nhau.
 * 3. `source` là **bắt buộc** và `/health` in lại nguyên văn. Nó được sinh kèm mốc
 *    sửa của sổ trạng thái và commit đang đứng — để vài tháng nữa còn trả lời được
 *    câu *"khối này chép lúc nào"*.
 *
 * Tệp xuất `buildDeployment` (hàm thuần: sổ vào, khối ra) để bộ ca
 * `test_gen_vault_tx_api_deployment.ts` kiểm được mà không đụng sổ thật; `main` chỉ chạy
 * khi tệp được gọi trực tiếp.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialToAddress, scriptHashToCredential } from "@lucid-evolution/lucid";
import { lampAssetName, type Network } from "@magiclamp/protocol-utils";
import { consumeKey, type ConsumeKeyName } from "./consumeBook.js";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

export type StateBook = Record<string, string>;
export type VaultKind = "Instant" | "Schedule";

/**
 * Khoá sổ trạng thái mà khối `gen_v2` + ref-script `gb_shard` đòi — kèm NGHĨA, vì đây là
 * danh sách người deploy cụm Gen v2.0 phải ghi vào `state.<NET>.sh`. Câu lỗi khi thiếu in
 * lại đúng bảng này, nên nó là nguồn duy nhất của danh sách.
 *
 * Đặt tên theo quy ước sẵn có của sổ: `<X>_HASH` cho script hash (như `SHARD_HASH`,
 * `PRICE_PARAM_HASH_*`), `REF_<X>_UTXO` cho UTxO mang script tham chiếu CIP-33.
 */
export const GEN_V2_STATE_KEYS = {
  RATE_PARAM_HASH:
    "script hash validator `rate_param` (GenBeacons) — địa chỉ beacon ρ, và cũng là policy NFT \"RHO\"",
  GREENBACK_BEACON_HASH:
    "script hash validator `greenback_beacon` (GenBeacons) — địa chỉ beacon GreenBack, và cũng là policy NFT \"GBB\"",
  GB_SHARD_HASH:
    "script hash validator `gb_shard` (GenBeacons) — địa chỉ 16 shard GB, và cũng là policy NFT \"GBS\"‖id",
  GB_SHARD_CAP_NANOGIC:
    "apply-param `gb_shard_cap_nanogic` đã nướng vào `gb_shard` (chuỗi chữ số nanogic > 0)",
  VAULT_REGISTRY_HASH:
    "script hash validator `vault_registry` (GenBeacons) — địa chỉ sổ két, và cũng là policy NFT \"VRG\"",
  REF_GB_SHARD_UTXO:
    "UTxO `<tx>#<ix>` mang script tham chiếu của `gb_shard` (nhánh sinh tiêu shard GB)",
} as const;

/** Chỉ két Schedule: nhánh ký của két uỷ cho validator withdraw-zero `commit`. */
export const SCHEDULE_ONLY_STATE_KEYS = {
  REF_COMMIT_SCHEDULE_UTXO:
    "UTxO `<tx>#<ix>` mang script tham chiếu của validator withdraw-zero `commit` (ScheduleGen v2.0)",
} as const;

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

/** Script hash (28 byte hex) ⟹ địa chỉ `Script(h)` không stake credential. `ten` là tên khoá
 *  sổ, để câu lỗi trỏ được về đúng dòng cần sửa. */
function hashToAddress(scriptHash: string, network: Network, ten: string): string {
  if (!/^[0-9a-f]{56}$/.test(scriptHash)) {
    throw new Error(`✗ ${ten} = "${scriptHash}" không phải script hash 28 byte dạng hex thường.`);
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

export interface GenMeta {
  /** Đường sổ trạng thái, tương đối gốc kho — chỉ để khai trong `source`. */
  sourcePath: string;
  mtime: string;
  sha: string;
  /** `LAMP_REHEARSAL_ACK` của lượt sinh (lời khai ý định, KHÔNG lấy từ sổ). */
  rehearsalAck?: string;
}

/**
 * Hàm thuần: sổ trạng thái ⟹ khối `VAULT_TX_API_DEPLOYMENT` (đối tượng, chưa stringify)
 * cộng các dòng cảnh báo. Không đọc tệp, không đọc môi trường, không gọi mạng.
 */
export function buildDeployment(
  book: StateBook,
  network: Network,
  vaultKind: VaultKind,
  meta: GenMeta,
): { deployment: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];

  // ── Khoá Gen v2.0: kiểm TRỌN trước, ném MỘT lần với mọi khoá thiếu ────────────
  // Kể đủ một lượt thay vì ném ở khoá đầu tiên: đây là khoá MỚI, người deploy cụm v2
  // sẽ thiếu cả loạt, và ném từng cái một là bắt họ chạy lại sáu lần.
  const requiredGenKeys: Record<string, string> = {
    ...GEN_V2_STATE_KEYS,
    ...(vaultKind === "Schedule" ? SCHEDULE_ONLY_STATE_KEYS : {}),
  };
  const missingGen = Object.entries(requiredGenKeys).filter(([k]) => !book[k]);
  if (missingGen.length > 0) {
    throw new Error(
      `✗ Sổ trạng thái thiếu ${missingGen.length} khoá Gen v2.0 (vault ${vaultKind}) — KHÔNG phát khối nào:\n` +
      missingGen.map(([k, nghia]) => `    · ${k} — ${nghia}\n`).join("") +
      `  Ghi các khoá đó sau khi deploy GenBeacons (+ công bố ref-script) rồi chạy lại.`,
    );
  }

  // `ref_script_utxos.vault` chỉ có MỘT ô, nên khối này phục vụ MỘT loại vault mỗi
  // lượt. Sinh hai khối cho hai loại thay vì cố nhét cả hai vào một.
  const refVaultKey = vaultKind === "Instant" ? "REF_VAULT_INSTANT_UTXO" : "REF_VAULT_SCHEDULE_UTXO";
  const vaultAddrKey = vaultKind === "Instant" ? "VAULT_INSTANT_ADDR" : "VAULT_SCHEDULE_ADDR";
  // Bộ khoá consume của ĐÚNG loại vault này (scripts/consumeBook.ts). Bản trước đọc khoá
  // không hậu tố: trên sổ Preprod dựng lại 2026-09-23 bộ đó là của ScheduleGen, nên
  // `--vault Instant` (mặc định) ghép vault InstantGen với consume của ScheduleGen, và
  // `VaultTxAPI` dựng ra tx tiêu chết ở phase-1 mà khối này không có dấu hiệu gì sai.
  const ck = (name: ConsumeKeyName) =>
    consumeKey(name, vaultKind === "Instant" ? "instant" : "schedule");

  const rehearsalAck = meta.rehearsalAck;
  const deployment: Record<string, unknown> = {
    // Cụm TẬP DƯỢT phải tự khai ở chỗ `/health` in ra: định danh của nó chỉ được chia sẻ
    // kèm nhãn đó, và bên gọi không đọc `lamp.rehearsal_ack` trong khối triển khai.
    source: `${rehearsalAck === undefined ? "" : `TẬP DƯỢT (LAMP ${rehearsalAck.slice(0, 8)}…, bỏ khi có policy LAMP cuối) · `}${network} · ${vaultKind} · Gen v2.0 · sinh từ ${meta.sourcePath} (sửa lần cuối ${meta.mtime}) tại commit ${meta.sha}`,
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
      // Xác nhận lối mở TẬP DƯỢT (`config.ts` ▸ `REHEARSAL_LAMP_POLICIES`). Lấy từ MÔI
      // TRƯỜNG của lượt sinh, KHÔNG từ sổ: nó là lời khai ý định, và `state_book_guard.sh`
      // cấm nó nằm trong sổ. Vắng biến ⟹ không phát trường ⟹ `VaultTxAPI` chặn mọi đời
      // đã bị thay lúc khởi động. Có biến mà khác policy ⟹ `VaultTxAPI` cũng chặn — tệp
      // này không kiểm hộ, để chỉ MỘT cổng quyết.
      ...(rehearsalAck === undefined ? {} : { rehearsal_ack: rehearsalAck }),
    },
    vaults: [
      { vault_type: vaultKind, address: need(book, vaultAddrKey, `địa chỉ vault ${vaultKind}`) },
    ],
    shard_address: hashToAddress(need(book, "SHARD_HASH", "địa chỉ cụm shard"), network, "SHARD_HASH"),
    ref_script_utxos: {
      vault: need(book, refVaultKey, `script tham chiếu của vault ${vaultKind}`),
      shard: need(book, "REF_SHARD_UTXO", "script tham chiếu của shard"),
      consume: need(book, ck("REF_CONSUME_UTXO"), "script tham chiếu của ConsumeMAGIC"),
      // `commit` chỉ phát cho két Schedule: đường duy nhất dùng nó là `/tx/schedule-commit`,
      // chạy trên két Schedule. Khối Instant không mang nó ⟹ đường đó trả 501 — đúng, vì
      // khối này không khai két Schedule nào.
      ...(vaultKind === "Schedule" ? { commit: book.REF_COMMIT_SCHEDULE_UTXO } : {}),
      gb_shard: book.REF_GB_SHARD_UTXO,
    },
    // Tên trường theo `VaultTxAPI/src/config.ts` ▸ `parseDeployment` (khối `gen_v2`). Policy
    // NFT = hash script (đầu tệp, mục 2). Tệp này chỉ kiểm HÌNH DẠNG hash để ra được địa chỉ;
    // cổng giá trị (tiền tố mạng, cap là chữ số > 0, out-ref) là việc của `parseDeployment`
    // — một cổng quyết, không hai.
    gen_v2: {
      rate_beacon_address: hashToAddress(book.RATE_PARAM_HASH, network, "RATE_PARAM_HASH"),
      rate_nft_policy: book.RATE_PARAM_HASH,
      greenback_beacon_address: hashToAddress(book.GREENBACK_BEACON_HASH, network, "GREENBACK_BEACON_HASH"),
      greenback_beacon_nft_policy: book.GREENBACK_BEACON_HASH,
      gb_shard_address: hashToAddress(book.GB_SHARD_HASH, network, "GB_SHARD_HASH"),
      gb_shard_cap_nanogic: book.GB_SHARD_CAP_NANOGIC,
      vault_registry_address: hashToAddress(book.VAULT_REGISTRY_HASH, network, "VAULT_REGISTRY_HASH"),
    },
    consume: {
      engage_address: need(book, ck("CONSUME_ADDRESS"), "địa chỉ luồng Engage"),
      // KHÔNG phát `engage_nft_unit`: dịch vụ chọn thread theo CHỦ (policy = script hash
      // consume, suy từ `engage_address`), và cấu hình còn khoá đó thì dịch vụ từ chối khởi
      // động — một thread cố định chỉ phục vụ được đúng một chủ vì `consume.ak` ép chủ
      // thread == chủ vault.
      price_beacon_address: hashToAddress(need(book, ck("PRICE_PARAM_HASH"), "địa chỉ beacon PriceParam"), network, ck("PRICE_PARAM_HASH")),
      price_beacon_nft_unit: need(book, ck("PRICE_NFT_UNIT"), "NFT định danh beacon PriceParam"),
      // Apply-param #5 của đúng bản `consume` ở trên — dịch vụ dùng nó để từ chối sớm
      // (CONSUME-011) lượt dựng mà validator sẽ bác vì beacon giá trễ.
      max_price_stale: need(book, ck("MAX_PRICE_STALE"), "số epoch beacon giá được phép trễ (apply-param #5 của consume)"),
    },
  };

  // 🪦 KHÔNG còn mục `instant`. `VaultTxAPI` từ chối khởi động khi thấy khoá đó (UM đã ra
  // khỏi công thức sinh, beacon backing thay bằng GreenBack + shard GB). Khoá `UM_*` /
  // `BACKING_*` còn trong sổ của một đời cũ thì bị bỏ qua — chúng không mô tả gì của cụm v2.

  // ── Mục `did_stake`: tham số theo mạng của nhân chứng chủ `Script(h)` ─────────────
  //
  // `anchor_nft_policy` là policy NFT anchor DID của PhoenixKey trên mạng này — apply-param
  // của `did_stake`, nên nó là một dữ kiện deploy và nằm trong sổ trạng thái như mọi dữ kiện
  // deploy khác (khoá `ANCHOR_NFT_POLICY`). Vắng ⟹ không phát mục; `VaultTxAPI` trả 501
  // `OWNER_SCRIPT_WITNESS_UNAVAILABLE` cho chủ script, chủ khoá không bị ảnh hưởng.
  const anchorPolicy = book.ANCHOR_NFT_POLICY;
  if (anchorPolicy !== undefined && anchorPolicy !== "") {
    if (!/^[0-9a-f]{56}$/.test(anchorPolicy)) {
      throw new Error(`✗ ANCHOR_NFT_POLICY trong sổ trạng thái phải là 56 hex thường (nhận ${anchorPolicy.length} ký tự).`);
    }
    deployment.did_stake = { anchor_nft_policy: anchorPolicy };
  } else {
    warnings.push(
      `⚠ Mục \`did_stake\` KHÔNG được phát (sổ trạng thái thiếu ANCHOR_NFT_POLICY) ⟹ mọi yêu cầu\n` +
      `  có chủ script (ví PhoenixKey) nhận 501 OWNER_SCRIPT_WITNESS_UNAVAILABLE. Chủ khoá không bị ảnh hưởng.\n`,
    );
  }

  return { deployment, warnings };
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
  const rehearsalAck = process.env.LAMP_REHEARSAL_ACK;
  const { deployment, warnings } = buildDeployment(book, network, vaultKind, {
    sourcePath: path.replace(/^.*\/MAGIC\//, ""),
    mtime,
    sha: gitSha(),
    ...(rehearsalAck === undefined ? {} : { rehearsalAck }),
  });
  for (const w of warnings) process.stderr.write(w);
  process.stdout.write(JSON.stringify(deployment, null, 2) + "\n");
}

// `main` chỉ chạy khi tệp được gọi trực tiếp (`npx tsx gen_vault_tx_api_deployment.ts …`),
// không chạy khi bộ ca import `buildDeployment`.
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
