// scripts/applyParams.ts — CỔNG apply-param theo TÊN, đọc thẳng từ blueprint.
//
// VÌ SAO CÓ FILE NÀY
// `applyParamsToScript` của Lucid KHÔNG kiểm arity. Truyền thiếu (hoặc thừa,
// hoặc sai thứ tự) tham số vẫn trả về một CBOR "trông hợp lệ" và một script
// hash 28 byte trông hợp lệ — không ngoại lệ nào được ném. Ledger sau đó nhét
// (datum, redeemer, script_context) vào các slot còn trống ⇒ sai kiểu ⇒ MỌI tx
// spend fail vĩnh viễn. UTxO đã tạo ở địa chỉ đó không ai cứu được: LAMP kẹt.
//
// Cách chặn duy nhất bền vững là KHÔNG để script deploy tự khai danh sách tham
// số. Blueprint `plutus.json` do `aiken build` sinh ra đã mang sẵn
// `validators[].parameters[].title` theo ĐÚNG thứ tự khai báo trong
// `validator foo(...)`. Ta đọc danh sách đó và bắt caller cung cấp một BẢN ĐỒ
// TÊN → GIÁ TRỊ. Đổi chữ ký validator ⇒ script gãy ồn ào ngay, thay vì sinh
// hash sai im lặng.
//
// Ràng buộc được cưỡng chế ở đây:
//   1. blueprint có tên mà caller không đưa  → ném lỗi (THIẾU)
//   2. caller đưa tên blueprint không có     → ném lỗi (THỪA / gõ nhầm)
//   3. số lượng lệch                          → ném lỗi
//   4. thứ tự khai của caller khác blueprint  → ném lỗi (giữ script đọc được
//      như bản sao của chữ ký validator)
// Thông điệp lỗi in CẢ HAI danh sách để thấy ngay lệch chỗ nào.

import {
  applyParamsToScript, validatorToScriptHash,
  type Data, type Validator,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";

// ── Kiểu của blueprint (CIP-57) ──────────────────────────────────
export interface BlueprintParameter {
  title?:  string;
  schema?: unknown;
}

export interface BlueprintValidator {
  title:        string;
  compiledCode: string;
  hash:         string;
  parameters?:  BlueprintParameter[];
}

export interface Blueprint {
  /** Tên thư mục module, ví dụ "InstantGen" — chỉ dùng cho thông điệp lỗi. */
  moduleName: string;
  /** Đường dẫn hiển thị của plutus.json — chỉ dùng cho thông điệp lỗi. */
  path:       string;
  validators: BlueprintValidator[];
}

/** Bản đồ TÊN THAM SỐ (đúng như blueprint) → giá trị Plutus Data. */
export type ParamMap = Record<string, Data>;

// ── Nạp blueprint ────────────────────────────────────────────────

/**
 * Đọc `<Module>/onchain/plutus.json`.
 *
 * `moduleName` là tên thư mục module ở gốc repo ("InstantGen", "ScheduleGen",
 * "UMKeeper", "ConsumeMAGIC", ...). Chưa build thì báo lỗi RÕ, không đoán.
 */
export async function loadBlueprint(moduleName: string): Promise<Blueprint> {
  const rel = `../${moduleName}/onchain/plutus.json`;
  const url = new URL(rel, import.meta.url);
  let raw: string;
  try {
    raw = await readFile(url, "utf8");
  } catch (e: unknown) {
    throw new Error(
      `Không đọc được blueprint ${moduleName}/onchain/plutus.json.\n` +
      `  → Chạy \`aiken build\` ở ${moduleName}/onchain trước.\n` +
      `  (đường dẫn thử: ${url.pathname})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    throw new Error(
      `${moduleName}/onchain/plutus.json không phải JSON hợp lệ — build lại bằng ` +
      `\`aiken build\` ở ${moduleName}/onchain.`,
    );
  }
  const bp = parsed as { validators?: BlueprintValidator[] };
  if (!Array.isArray(bp.validators)) {
    throw new Error(
      `${moduleName}/onchain/plutus.json thiếu mảng "validators" — build lại bằng ` +
      `\`aiken build\` ở ${moduleName}/onchain.`,
    );
  }
  return {
    moduleName,
    path:       `${moduleName}/onchain/plutus.json`,
    validators: bp.validators,
  };
}

/** Tìm validator theo title đầy đủ ("vault.vault.spend"). Không thấy → liệt kê hết. */
export function findValidator(bp: Blueprint, title: string): BlueprintValidator {
  const v = bp.validators.find((x) => x.title === title);
  if (!v) {
    throw new Error(
      `Không thấy validator "${title}" trong ${bp.path}.\n` +
      `  Hiện có: ${bp.validators.map((x) => x.title).join(", ")}\n` +
      `  → Sai tên, hoặc blueprint cũ: chạy lại \`aiken build\` ở ${bp.moduleName}/onchain.`,
    );
  }
  return v;
}

// ── Cổng kiểm tên + thứ tự ───────────────────────────────────────

/** Danh sách tên tham số theo ĐÚNG thứ tự khai báo trong validator. */
export function paramTitles(v: BlueprintValidator): string[] {
  const params = v.parameters ?? [];
  return params.map((p, i) => {
    if (typeof p.title !== "string" || p.title.length === 0) {
      throw new Error(
        `Tham số #${i + 1} của validator "${v.title}" không có "title" trong blueprint — ` +
        `không thể đối chiếu theo tên. Build lại bằng aiken ≥ 1.1.0.`,
      );
    }
    return p.title;
  });
}

/**
 * Dựng danh sách tham số theo ĐÚNG thứ tự blueprint từ bản đồ tên → giá trị.
 * Lệch tên / lệch số lượng / lệch thứ tự đều ném lỗi có in cả hai danh sách.
 */
export function orderedParams(v: BlueprintValidator, byName: ParamMap): Data[] {
  const expected = paramTitles(v);
  const given    = Object.keys(byName);

  const missing = expected.filter((n) => !(n in byName));
  const extra   = given.filter((n) => !expected.includes(n));
  const orderMismatch =
    missing.length === 0 && extra.length === 0 &&
    given.join("\u0000") !== expected.join("\u0000");

  if (missing.length > 0 || extra.length > 0 || orderMismatch) {
    throw new Error(formatMismatch(v, expected, given, missing, extra, orderMismatch));
  }

  return expected.map((n) => {
    const value = byName[n];
    if (value === undefined || value === null) {
      throw new Error(
        `Tham số "${n}" của validator "${v.title}" có giá trị ${String(value)} — ` +
        `apply-param không nhận undefined/null. Nạp đủ env trước khi deploy.`,
      );
    }
    return value;
  });
}

function formatMismatch(
  v: BlueprintValidator,
  expected: string[],
  given: string[],
  missing: string[],
  extra: string[],
  orderMismatch: boolean,
): string {
  const lines: string[] = [];
  lines.push(`APPLY-PARAM LỆCH — validator "${v.title}"`);
  lines.push(``);
  lines.push(`  blueprint đòi (${expected.length}, đúng thứ tự khai báo):`);
  expected.forEach((n, i) => lines.push(`    ${String(i + 1).padStart(2)}. ${n}`));
  lines.push(`  script cung cấp (${given.length}, theo thứ tự khai trong code):`);
  if (given.length === 0) lines.push(`    (rỗng)`);
  given.forEach((n, i) => lines.push(`    ${String(i + 1).padStart(2)}. ${n}`));
  lines.push(``);
  if (missing.length > 0) {
    lines.push(`  ❌ THIẾU (blueprint có, script không đưa): ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    lines.push(`  ❌ THỪA / gõ nhầm (script đưa, blueprint không có): ${extra.join(", ")}`);
  }
  if (orderMismatch) {
    lines.push(`  ❌ SAI THỨ TỰ — đủ tên nhưng khai không cùng trật tự blueprint.`);
  }
  if (expected.length !== given.length) {
    lines.push(`  ❌ SỐ LƯỢNG: blueprint ${expected.length} ≠ script ${given.length}`);
  }
  lines.push(``);
  lines.push(
    `  Ghi nhớ: applyParamsToScript KHÔNG kiểm arity. Truyền thiếu vẫn ra hash ` +
    `trông hợp lệ, và mọi tx spend về sau fail vĩnh viễn. Sửa bản đồ tham số cho ` +
    `khớp chữ ký validator rồi chạy lại.`,
  );
  return lines.join("\n");
}

// ── Apply ────────────────────────────────────────────────────────

/** CBOR đã apply params (theo tên). */
export function applyByName(v: BlueprintValidator, byName: ParamMap): string {
  return applyParamsToScript(v.compiledCode, orderedParams(v, byName));
}

/** Validator PlutusV3 đã apply params (theo tên). */
export function appliedValidator(v: BlueprintValidator, byName: ParamMap): Validator {
  return { type: "PlutusV3", script: applyByName(v, byName) };
}

/** { script, hash } của validator đã apply params (theo tên). */
export function appliedScript(
  v: BlueprintValidator,
  byName: ParamMap,
): { script: Validator; hash: string } {
  const script = appliedValidator(v, byName);
  return { script, hash: validatorToScriptHash(script) };
}
