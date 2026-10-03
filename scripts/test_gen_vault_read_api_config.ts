// scripts/test_gen_vault_read_api_config.ts — bộ ca cho `gen_vault_read_api_config.ts`.
// Không gọi mạng, không đọc sổ thật: sổ trạng thái ở đây là sổ GIẢ, dựng trong bộ nhớ và
// trong một thư mục nháp của bài (`mkdtemp`).
// Chạy từ scripts/:  npx tsx test_gen_vault_read_api_config.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Trọng tài là CHÍNH bộ nạp của dịch vụ (`VaultReadAPI/src/config.ts` ▸ `loadConfig`): đầu ra
// của bộ sinh, đúng dạng chữ nó in ra stdout, được nạp lại như một môi trường tiến trình.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialToAddress, scriptHashToCredential } from "@lucid-evolution/lucid";
import {
  buildReadApiConfig, parseVaultsArg, requiredKeys, shellLine,
} from "./gen_vault_read_api_config.js";
import type { GenMeta, StateBook } from "./gen_vault_tx_api_deployment.js";
import { consumeKey } from "./consumeBook.js";
import { loadConfig } from "../VaultReadAPI/src/config.js";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

let sai = 0;
function ca(ten: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${ten}`); }
  catch (e) { sai++; console.log(`  ✗ ${ten}\n      ${(e as Error).message.split("\n")[0]}`); }
}
function bang<T>(thuc: T, cho: T, nhan: string) {
  if (thuc !== cho) throw new Error(`${nhan}: nhận ${String(thuc)}, chờ ${String(cho)}`);
}
function phaiNem(fn: () => void, chua: string[]): string {
  try { fn(); } catch (e) {
    const m = (e as Error).message;
    for (const c of chua) {
      if (!m.includes(c)) throw new Error(`ném nhưng câu lỗi thiếu "${c}": ${m.split("\n")[0]}`);
    }
    return m;
  }
  throw new Error("KHÔNG ném");
}

const NET = "Preprod" as const;
// Hash giả: 56 hex thường, mỗi vai một giá trị riêng để phép so không trùng nhầm.
const h = (b: string) => b.repeat(28);
const addr = (hash: string) => credentialToAddress(NET, scriptHashToCredential(hash));
const META: GenMeta = { sourcePath: "scripts/state.Preprod.sh", mtime: "2026-10-03T00:00:00Z", sha: "abc1234" };

const HASH = {
  VAULT_INSTANT_HASH: h("b1"), VAULT_SCHEDULE_HASH: h("b2"), VAULT_PREPAID_HASH: h("b3"),
  CONSUME_SCRIPT_HASH_INSTANT: h("c1"), CONSUME_SCRIPT_HASH_SCHEDULE: h("c2"), CONSUME_SCRIPT_HASH_PREPAID: h("c3"),
} as const;

function fullBook(): StateBook {
  return {
    ...HASH,
    VAULT_INSTANT_ADDR: addr(HASH.VAULT_INSTANT_HASH),
    VAULT_SCHEDULE_ADDR: addr(HASH.VAULT_SCHEDULE_HASH),
    VAULT_PREPAID_ADDR: addr(HASH.VAULT_PREPAID_HASH),
    CONSUME_ADDRESS_INSTANT: addr(HASH.CONSUME_SCRIPT_HASH_INSTANT),
    CONSUME_ADDRESS_SCHEDULE: addr(HASH.CONSUME_SCRIPT_HASH_SCHEDULE),
    CONSUME_ADDRESS_PREPAID: addr(HASH.CONSUME_SCRIPT_HASH_PREPAID),
    // Khoá không liên quan, để chắc bộ sinh không phát thứ nó không hỏi.
    LAMP_POLICY_ID: h("a1"),
  };
}

/** Bóc `TÊN='json'` về giá trị — đảo đúng `shellLine` (thoát `'\''`). */
function parseShellLines(out: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of out.split("\n").filter((l) => l !== "")) {
    const m = /^([A-Z_]+)='(.*)'$/s.exec(line);
    if (!m) throw new Error(`dòng stdout không đúng dạng TÊN='…': ${line.slice(0, 60)}`);
    env[m[1]] = m[2].replace(/'\\''/g, "'");
  }
  return env;
}

function loadFrom(out: string) {
  return loadConfig({
    ...parseShellLines(out),
    VAULT_READ_API_NETWORK: NET,
    BLOCKFROST_PROJECT_ID: "test-placeholder-not-a-key",
  });
}

console.log("─ vòng tròn: sổ ⟹ bộ sinh ⟹ loadConfig của VaultReadAPI");

ca("mặc định, sổ đủ 3 loại: loadConfig qua; 3 mục vault + 3 mục consume", () => {
  const cfg = buildReadApiConfig(fullBook(), NET, undefined, META);
  const out = shellLine("VAULT_READ_API_VAULTS", cfg.vaults) + "\n" +
    shellLine("VAULT_READ_API_CONSUME_SCOPES", cfg.consumeScopes) + "\n";
  const c = loadFrom(out);
  bang(c.scopes.length, 3, "số mục vault");
  bang(c.consumeScopes.length, 3, "số mục consume");
  // Hash SUY TỪ địa chỉ (phía dịch vụ) phải khớp hash ghi trong sổ — đúng thứ tự phát.
  bang(c.scopes[0].vaultType, "Instant", "vault[0].type");
  bang(c.scopes[0].scriptHash, HASH.VAULT_INSTANT_HASH, "vault[0].hash");
  bang(c.scopes[1].vaultType, "Schedule", "vault[1].type");
  bang(c.scopes[1].scriptHash, HASH.VAULT_SCHEDULE_HASH, "vault[1].hash");
  bang(c.scopes[2].vaultType, "Prepaid", "vault[2].type");
  bang(c.scopes[2].scriptHash, HASH.VAULT_PREPAID_HASH, "vault[2].hash");
  bang(c.consumeScopes[0].scriptHash, HASH.CONSUME_SCRIPT_HASH_INSTANT, "consume[0].hash");
  bang(c.consumeScopes[1].scriptHash, HASH.CONSUME_SCRIPT_HASH_SCHEDULE, "consume[1].hash");
  bang(c.consumeScopes[2].scriptHash, HASH.CONSUME_SCRIPT_HASH_PREPAID, "consume[2].hash");
  // `source` mang mạng + loại + sha + mốc sổ.
  for (const s of [...c.scopes.map((x) => x.source), ...c.consumeScopes.map((x) => x.source)]) {
    for (const want of ["Preprod", "abc1234", "2026-10-03T00:00:00Z", "scripts/state.Preprod.sh"]) {
      if (!s.includes(want)) throw new Error(`source thiếu "${want}": ${s}`);
    }
  }
  if (!c.consumeScopes[2].source.includes("Prepaid")) throw new Error("source consume Prepaid không nêu loại");
});

// Đảo dấu 2026-10-03: `VAULT_KINDS` có `Prepaid` (VaultReadAPI đọc được datum két Prepaid
// qua `prepaidView.ts`) ⟹ bộ sinh phát mục vault Prepaid, và KHÔNG còn ghi chú "chỉ phát
// mục consume". Ca cũ ("Prepaid KHÔNG vào mục vault") ghim đúng hành vi đã bị lật này.
ca("Prepaid VÀO mục vault (VAULT_KINDS có Prepaid), và không còn ghi chú bỏ mục vault", () => {
  const cfg = buildReadApiConfig(fullBook(), NET, undefined, META);
  const p = cfg.vaults.filter((v) => v.vault_type === "Prepaid");
  bang(p.length, 1, "số mục vault Prepaid");
  bang(p[0].address, addr(HASH.VAULT_PREPAID_HASH), "địa chỉ két Prepaid");
  if (cfg.notes.some((n) => n.includes("KHÔNG phát mục vault"))) {
    throw new Error(`còn ghi chú bỏ mục vault: ${JSON.stringify(cfg.notes)}`);
  }
});

ca("mặc định, sổ không có khoá Prepaid nào: bỏ Prepaid kèm ghi chú, phần còn lại qua loadConfig", () => {
  const book = fullBook();
  delete book.CONSUME_SCRIPT_HASH_PREPAID; delete book.CONSUME_ADDRESS_PREPAID;
  delete book.VAULT_PREPAID_HASH; delete book.VAULT_PREPAID_ADDR;
  const cfg = buildReadApiConfig(book, NET, undefined, META);
  bang(cfg.consumeScopes.length, 2, "số mục consume");
  bang(cfg.vaults.length, 2, "số mục vault");
  if (!cfg.notes.some((n) => n.includes("prepaid: bỏ"))) throw new Error(`thiếu ghi chú bỏ: ${JSON.stringify(cfg.notes)}`);
});

ca("--vaults schedule: chỉ Schedule, Instant/Prepaid không xuất hiện", () => {
  const cfg = buildReadApiConfig(fullBook(), NET, ["schedule"], META);
  bang(cfg.vaults.length, 1, "số mục vault");
  bang(cfg.vaults[0].vault_type, "Schedule", "loại");
  bang(cfg.consumeScopes.length, 1, "số mục consume");
  // Loại bỏ vì cờ cũng phải được kể ra, không chỉ loại bỏ vì sổ thiếu.
  for (const k of ["instant", "prepaid"]) {
    if (!cfg.notes.some((n) => n.includes(`${k}: bỏ — không có trong --vaults`))) {
      throw new Error(`thiếu ghi chú bỏ ${k}: ${JSON.stringify(cfg.notes)}`);
    }
  }
});

console.log("─ ca âm: sổ thiếu / lệch ⟹ NÉM, nêu đúng tên khoá");

for (const kind of ["instant", "schedule", "prepaid"] as const) {
  for (const key of Object.keys(requiredKeys(kind))) {
    ca(`--vaults ${kind}, sổ thiếu ${key} ⟹ ném nêu ${key}`, () => {
      const book = fullBook();
      delete book[key];
      phaiNem(() => buildReadApiConfig(book, NET, [kind], META), [key, "KHÔNG phát"]);
    });
  }
}

ca("mặc định, sổ có MỘT PHẦN khoá Instant ⟹ ném (sổ dở dang ≠ chưa deploy)", () => {
  const book = fullBook();
  delete book.CONSUME_ADDRESS_INSTANT;
  phaiNem(() => buildReadApiConfig(book, NET, undefined, META), ["CONSUME_ADDRESS_INSTANT"]);
});

ca("địa chỉ vault lệch Script(hash) ⟹ ném nêu cả hai khoá", () => {
  const book = fullBook();
  book.VAULT_SCHEDULE_ADDR = addr(h("d9"));
  phaiNem(() => buildReadApiConfig(book, NET, undefined, META), ["VAULT_SCHEDULE_ADDR", "VAULT_SCHEDULE_HASH"]);
});

ca("địa chỉ consume lệch Script(hash) ⟹ ném nêu cả hai khoá", () => {
  const book = fullBook();
  book[consumeKey("CONSUME_ADDRESS", "prepaid")] = addr(h("d8"));
  phaiNem(() => buildReadApiConfig(book, NET, undefined, META), ["CONSUME_ADDRESS_PREPAID", "CONSUME_SCRIPT_HASH_PREPAID"]);
});

// Đảo dấu 2026-10-03: trước đây mảng vault rỗng ⟹ ném; nay Prepaid có mục vault riêng.
ca("chỉ có Prepaid ⟹ một mục vault Prepaid + một mục consume, qua loadConfig", () => {
  const cfg = buildReadApiConfig(fullBook(), NET, ["prepaid"], META);
  const c = loadFrom(shellLine("VAULT_READ_API_VAULTS", cfg.vaults) + "\n" +
    shellLine("VAULT_READ_API_CONSUME_SCOPES", cfg.consumeScopes) + "\n");
  bang(c.scopes.map((x) => x.vaultType).join(","), "Prepaid", "loại vault");
  bang(c.scopes[0].scriptHash, HASH.VAULT_PREPAID_HASH, "hash két Prepaid");
  bang(c.consumeScopes.length, 1, "số mục consume");
});

ca("hai loại trỏ CÙNG một consume ⟹ ném bằng câu của parseConsumeScopes", () => {
  const book = fullBook();
  book.CONSUME_SCRIPT_HASH_SCHEDULE = HASH.CONSUME_SCRIPT_HASH_INSTANT;
  book.CONSUME_ADDRESS_SCHEDULE = book.CONSUME_ADDRESS_INSTANT;
  phaiNem(() => buildReadApiConfig(book, NET, undefined, META), ["trùng script hash"]);
});

ca("--vaults: giá trị lạ / rỗng / lặp ⟹ ném", () => {
  phaiNem(() => parseVaultsArg("Instant"), ["không phải loại két"]);
  phaiNem(() => parseVaultsArg(""), ["ít nhất một"]);
  phaiNem(() => parseVaultsArg("schedule,schedule"), ["lặp"]);
  bang(parseVaultsArg(undefined), undefined, "không cờ");
  bang(parseVaultsArg("instant, prepaid")!.join(","), "instant,prepaid", "tách dấu phẩy");
});

ca("shellLine thoát nháy đơn và đảo lại được", () => {
  const v = [{ source: "it's" }];
  bang(parseShellLines(shellLine("X_Y", v) + "\n").X_Y, JSON.stringify(v), "đảo");
});

console.log("─ đường CLI thật: sổ giả trên đĩa qua STATE_BOOK_PATH");

ca("CLI mặc định: stdout đúng 2 dòng nạp được, đủ 3 mục vault; stderr không kể bỏ mục vault", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-vra-book-"));
  const path = join(dir, `state.${NET}.sh`);
  writeFileSync(path, Object.entries(fullBook()).map(([k, v]) => `export ${k}=${v}`).join("\n") + "\n");
  const p = spawnSync("npx", ["tsx", join(SCRIPTS_DIR, "gen_vault_read_api_config.ts"), NET], {
    cwd: SCRIPTS_DIR,
    env: { ...process.env, STATE_BOOK_PATH: path },
    encoding: "utf8",
  });
  bang(p.status, 0, `mã thoát (stderr: ${p.stderr})`);
  const r = p.stdout;
  bang(r.trimEnd().split("\n").length, 2, "số dòng stdout");
  if (p.stderr.includes("KHÔNG phát mục vault")) {
    throw new Error(`stderr còn kể bỏ mục vault Prepaid: ${p.stderr}`);
  }
  const c = loadFrom(r);
  bang(c.scopes.length, 3, "số mục vault");
  bang(c.consumeScopes.length, 3, "số mục consume");
  // Sổ giả nằm ngoài kho ⟹ đường không bị rút gọn; source phải nêu đúng đường đó.
  if (!c.scopes[0].source.includes(path)) throw new Error(`source không nêu đường sổ: ${c.scopes[0].source}`);
});

ca("CLI, sổ thiếu khoá ⟹ mã thoát 1, stderr nêu tên khoá", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-vra-book-"));
  const path = join(dir, `state.${NET}.sh`);
  const book = fullBook();
  delete book.VAULT_INSTANT_ADDR;
  writeFileSync(path, Object.entries(book).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  try {
    execFileSync("npx", ["tsx", join(SCRIPTS_DIR, "gen_vault_read_api_config.ts"), NET, "--vaults", "instant,schedule"], {
      cwd: SCRIPTS_DIR, env: { ...process.env, STATE_BOOK_PATH: path }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    bang(err.status, 1, "mã thoát");
    if (!String(err.stderr).includes("VAULT_INSTANT_ADDR")) throw new Error(`stderr không nêu khoá: ${err.stderr}`);
    return;
  }
  throw new Error("CLI KHÔNG thoát lỗi");
});

console.log(sai === 0 ? "=== ĐẠT ===" : `=== HỎNG: ${sai} ca sai ===`);
if (sai > 0) process.exit(1);
