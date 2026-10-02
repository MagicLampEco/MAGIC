/**
 * gen_vault_read_api_config.ts — SINH hai biến cấu hình của `VaultReadAPI`
 * (`VAULT_READ_API_VAULTS` và `VAULT_READ_API_CONSUME_SCOPES`) từ sổ trạng thái của lần
 * deploy, thay vì chép tay địa chỉ.
 *
 *   npx tsx scripts/gen_vault_read_api_config.ts Preprod
 *   npx tsx scripts/gen_vault_read_api_config.ts Preprod --vaults instant,schedule,prepaid
 *
 * stdout: đúng HAI dòng `TÊN='<json>'` (nháy đơn kiểu shell), nạp được bằng
 * `set -a; . <tệp>; set +a`. stderr: loại két bị bỏ và vì sao — luôn in, kể cả khi rỗng.
 *
 * ── Vì sao tệp này tồn tại ──────────────────────────────────────────────────────
 * `VaultReadAPI/src/config.ts` gọi mỗi địa chỉ vault / consume là một BẢN CHÉP của một lần
 * deploy, và một bản chép hết đúng thì mặt tiền trả `{vaults: []}` hoặc chỉ mục thread rỗng
 * mãi mãi — im lặng, giống hệt "chủ này chưa có vault". Sổ trạng thái đã giữ các địa chỉ đó;
 * chép tay từ sổ là tạo đúng cái bản sao sẽ chết sau lượt đúc lại kế tiếp. Đây là mức 2 của
 * §"Một nguồn, nhiều con trỏ": SINH từ nguồn. Cụm dựng lại thì chạy lại tệp này.
 *
 * Cùng khuôn với `gen_vault_tx_api_deployment.ts` và dùng lại hàm đọc sổ của nó (không chép
 * thân hàm). Tệp riêng chứ không gộp vào tệp kia, vì hai bộ sinh khác nhau ở đơn vị phát:
 * khối VaultTxAPI là MỘT loại két mỗi lượt (`ref_script_utxos.vault` chỉ có một ô), còn
 * cấu hình VaultReadAPI là MỌI loại két trong một lượt. Gộp lại thì `--vault` và `--vaults`
 * cùng sống trong một `main` với hai nghĩa khác nhau.
 *
 * Tệp này KHÔNG gọi mạng và KHÔNG đọc bí mật nào.
 *
 * ── Ba chỗ dễ hiểu sai ──────────────────────────────────────────────────────────
 * 1. **Két Prepaid chỉ vào `VAULT_READ_API_CONSUME_SCOPES`, KHÔNG vào `VAULT_READ_API_VAULTS`.**
 *    `VaultReadAPI` chỉ giải mã được datum Instant/Schedule và từ chối khởi động khi gặp
 *    loại khác (`config.ts` ▸ `VAULT_KINDS`). Tập loại két đọc được lấy THẲNG từ hằng đó, không
 *    chép: ngày dịch vụ đọc được Prepaid, bộ sinh tự phát mục vault Prepaid mà không sửa gì ở
 *    đây. Bỏ mục vault của một loại đã chọn thì in ra stderr, không bỏ im lặng.
 * 2. **Cổng cuối là CHÍNH bộ nạp của dịch vụ.** Hai mảng sinh ra được đi qua `parseScopes` /
 *    `parseConsumeScopes` của `VaultReadAPI` trước khi in — không phải một bản chép lại luật
 *    của chúng. Dịch vụ từ chối thì bộ sinh từ chối, cùng câu lỗi.
 * 3. **Hash và địa chỉ trong sổ phải khớp nhau.** Sổ giữ cả `VAULT_<K>_HASH` lẫn
 *    `VAULT_<K>_ADDR`, cả `CONSUME_SCRIPT_HASH_<K>` lẫn `CONSUME_ADDRESS_<K>`. Bộ sinh phát
 *    địa chỉ và ĐỐI CHIẾU nó với `Script(hash)` — lệch là sổ đang giữ hai đời của cùng một
 *    validator, và dịch vụ sẽ đọc ở một địa chỉ mà validator đang chạy không còn ở đó.
 *
 * Tệp xuất `buildReadApiConfig` (hàm thuần: sổ vào, cấu hình ra) cho bộ ca
 * `test_gen_vault_read_api_config.ts`; `main` chỉ chạy khi tệp được gọi trực tiếp.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Network } from "@magiclamp/protocol-utils";
import { consumeKey, vaultHashKey, vaultDeployStep, type VaultKind as BookVaultKind } from "./consumeBook.js";
import {
  gitSha, hashToAddress, readStateBook, sourceLine,
  type GenMeta, type StateBook,
} from "./gen_vault_tx_api_deployment.js";
import { VAULT_KINDS, parseConsumeScopes, parseScopes } from "../VaultReadAPI/src/config.js";

/** Mọi loại két có bản `consume` riêng — thứ tự = thứ tự phát. Tên tiếng Anh thường, đúng
 *  quy ước của `consumeBook.ts` (hậu tố khoá sổ là chính tên này viết hoa). */
export const ALL_KINDS: readonly BookVaultKind[] = ["instant", "schedule", "prepaid"];

/** Tên loại két ở phía dịch vụ (`vault_type`, `VAULT_KINDS`). */
const DISPLAY: Record<BookVaultKind, "Instant" | "Schedule" | "Prepaid"> = {
  instant: "Instant", schedule: "Schedule", prepaid: "Prepaid",
};

/** Dịch vụ có đọc được vault loại này không — hỏi CHÍNH `VAULT_KINDS`, không chép tập đó. */
function readApiReadsVault(kind: BookVaultKind): boolean {
  return (VAULT_KINDS as readonly string[]).includes(DISPLAY[kind]);
}

/** Khoá sổ mà một loại két cần, kèm nghĩa — câu lỗi khi thiếu in lại đúng bảng này. */
export function requiredKeys(kind: BookVaultKind): Record<string, string> {
  const K = DISPLAY[kind];
  const consumeStep = kind === "prepaid" ? "bước 09 với VAULT_KIND=prepaid" : `bước 09 với VAULT_KIND=${kind}`;
  const keys: Record<string, string> = {
    [consumeKey("CONSUME_SCRIPT_HASH", kind)]: `script hash bản \`consume\` apply bằng hash két ${K} (${consumeStep})`,
    [consumeKey("CONSUME_ADDRESS", kind)]: `địa chỉ bản \`consume\` đó — chỉ mục thread theo dõi nó (${consumeStep})`,
  };
  if (readApiReadsVault(kind)) {
    keys[vaultHashKey(kind)] = `script hash két ${K} (${vaultDeployStep(kind)})`;
    keys[`VAULT_${kind.toUpperCase()}_ADDR`] = `địa chỉ két ${K} (${vaultDeployStep(kind)})`;
  }
  return keys;
}

/** `--vaults a,b` ⟹ tập loại két. Không có cờ ⟹ `undefined` (mặc định: mọi loại có khoá). */
export function parseVaultsArg(raw: string | undefined): BookVaultKind[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0) {
    throw new Error(`✗ --vaults cần ít nhất một loại trong ${ALL_KINDS.join(",")} (nhận: "${raw}").`);
  }
  const out: BookVaultKind[] = [];
  for (const p of parts) {
    if (!(ALL_KINDS as readonly string[]).includes(p)) {
      throw new Error(`✗ --vaults: "${p}" không phải loại két. Nhận: ${ALL_KINDS.join(", ")} (viết thường).`);
    }
    if (out.includes(p as BookVaultKind)) throw new Error(`✗ --vaults: "${p}" lặp hai lần.`);
    out.push(p as BookVaultKind);
  }
  return out;
}

export interface ReadApiConfig {
  vaults: { vault_type: string; address: string; source: string }[];
  consumeScopes: { address: string; source: string }[];
  /** Dòng stderr: loại bị bỏ và vì sao. */
  notes: string[];
}

/**
 * Hàm thuần: sổ trạng thái ⟹ hai mảng cấu hình của `VaultReadAPI`. Không đọc tệp, không đọc
 * môi trường, không gọi mạng.
 *
 * `selected` vắng ⟹ mọi loại mà sổ có ÍT NHẤT MỘT khoá; loại không có khoá nào bị bỏ kèm một
 * dòng ghi chú. Loại có MỘT PHẦN khoá thì NÉM — đó là sổ dở dang, không phải "chưa deploy".
 * `selected` có mặt ⟹ thiếu khoá nào của loại đã chọn là NÉM.
 */
export function buildReadApiConfig(
  book: StateBook,
  network: Network,
  selected: BookVaultKind[] | undefined,
  meta: GenMeta,
): ReadApiConfig {
  const notes: string[] = [];
  const kinds: BookVaultKind[] = [];
  const missingAll: string[] = [];

  if (selected !== undefined) {
    for (const kind of ALL_KINDS) {
      if (!selected.includes(kind)) notes.push(`  · ${kind}: bỏ — không có trong --vaults.`);
    }
  }
  for (const kind of selected ?? ALL_KINDS) {
    const req = requiredKeys(kind);
    const missing = Object.entries(req).filter(([k]) => !book[k]);
    const nothing = missing.length === Object.keys(req).length;
    if (selected === undefined && nothing) {
      notes.push(`  · ${kind}: bỏ — sổ không có khoá nào của loại này (${Object.keys(req).join(", ")}).`);
      continue;
    }
    if (missing.length > 0) {
      missingAll.push(
        `  [${kind}] thiếu ${missing.length}/${Object.keys(req).length} khoá:\n` +
        missing.map(([k, nghia]) => `    · ${k} — ${nghia}\n`).join(""),
      );
      continue;
    }
    kinds.push(kind);
  }
  if (missingAll.length > 0) {
    throw new Error(
      `✗ Sổ trạng thái thiếu khoá — KHÔNG phát cấu hình nào:\n${missingAll.join("")}` +
      `  Chạy lại bước deploy ghi ra các khoá đó rồi chạy lại.` +
      (selected === undefined ? "" : ` Hoặc bỏ loại đó khỏi --vaults.`),
    );
  }

  const vaults: ReadApiConfig["vaults"] = [];
  const consumeScopes: ReadApiConfig["consumeScopes"] = [];
  for (const kind of kinds) {
    const K = DISPLAY[kind];
    const src = sourceLine(network, K, meta);
    if (readApiReadsVault(kind)) {
      vaults.push({
        vault_type: K,
        address: matchedAddress(book, network, vaultHashKey(kind), `VAULT_${kind.toUpperCase()}_ADDR`),
        source: src,
      });
    } else {
      notes.push(
        `  · ${kind}: chỉ phát mục consume, KHÔNG phát mục vault — VaultReadAPI chưa đọc được datum két ` +
        `${K} (\`VaultReadAPI/src/config.ts\` ▸ VAULT_KINDS = [${VAULT_KINDS.join(", ")}]).`,
      );
    }
    consumeScopes.push({
      address: matchedAddress(book, network, consumeKey("CONSUME_SCRIPT_HASH", kind), consumeKey("CONSUME_ADDRESS", kind)),
      source: `consume của két ${K} · ${src}`,
    });
  }

  if (vaults.length === 0) {
    // `loadConfig` từ chối mảng rỗng; nói ở đây bằng tên khoá sổ thay vì để dịch vụ nói bằng tên biến.
    throw new Error(
      `✗ Không phát được mục vault nào cho VAULT_READ_API_VAULTS (loại đã chọn: ${kinds.join(", ") || "không có"}). ` +
      `Cần ít nhất một két Instant hoặc Schedule trong sổ.`,
    );
  }

  // Cổng cuối = chính bộ nạp của dịch vụ (đầu tệp, mục 2). Ném thì ném nguyên câu của nó.
  parseScopes(JSON.stringify(vaults), network);
  parseConsumeScopes(JSON.stringify(consumeScopes), network);

  return { vaults, consumeScopes, notes };
}

/** Lấy địa chỉ từ sổ và đối chiếu với `Script(hash)` (đầu tệp, mục 3). */
function matchedAddress(book: StateBook, network: Network, hashKey: string, addrKey: string): string {
  const fromHash = hashToAddress(book[hashKey]!, network, hashKey);
  if (fromHash !== book[addrKey]) {
    throw new Error(
      `✗ ${addrKey} = ${book[addrKey]} nhưng Script(${hashKey}) trên ${network} = ${fromHash}.\n` +
      `  Sổ đang giữ hai đời khác nhau của cùng một validator — chạy lại bước deploy, đừng sửa tay một khoá.`,
    );
  }
  return fromHash;
}

/** `TÊN='json'` — nháy đơn shell, `'` trong giá trị thoát thành `'\''`. */
export function shellLine(name: string, value: unknown): string {
  return `${name}='${JSON.stringify(value).replace(/'/g, `'\\''`)}'`;
}

function main(): void {
  const network = (process.argv[2] ?? "") as Network;
  if (network !== "Preview" && network !== "Preprod" && network !== "Mainnet") {
    throw new Error(`✗ Tham số 1 phải là Preview | Preprod | Mainnet (nhận: "${process.argv[2] ?? ""}").`);
  }
  const i = process.argv.indexOf("--vaults");
  // `--vaults` có mặt mà thiếu giá trị ⟹ `""` ⟹ ném, không lùi về mặc định.
  const selected = parseVaultsArg(i > 0 ? (process.argv[i + 1] ?? "") : undefined);

  const { book, path, mtime } = readStateBook(network);
  const rehearsalAck = process.env.LAMP_REHEARSAL_ACK;
  const meta: GenMeta = {
    sourcePath: path.replace(/^.*\/MAGIC\//, ""),
    mtime,
    sha: gitSha(),
    ...(rehearsalAck === undefined ? {} : { rehearsalAck }),
  };
  const cfg = buildReadApiConfig(book, network, selected, meta);
  process.stderr.write(
    `Loại bị bỏ / phát thiếu: ${cfg.notes.length === 0 ? "không có" : `\n${cfg.notes.join("\n")}`}\n`,
  );
  process.stdout.write(shellLine("VAULT_READ_API_VAULTS", cfg.vaults) + "\n");
  process.stdout.write(shellLine("VAULT_READ_API_CONSUME_SCOPES", cfg.consumeScopes) + "\n");
}

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
