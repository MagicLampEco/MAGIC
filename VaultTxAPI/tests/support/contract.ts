// VaultTxAPI/tests/support/contract.ts — nạp hợp đồng module (`contract/*`) cho các bài kiểm.
//
// Một nguồn: `contract/openapi.json` (lược đồ), `contract/error-codes.json` (bảng mã lỗi), `contract/vectors/*.json`
// (mẫu hợp lệ + không hợp lệ). Tệp này chỉ ĐỌC chúng và so khớp bằng `schemaSubset.ts`; không chép lược đồ nào.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validate, type Document, type Schema, type Violation } from "./schemaSubset.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_DIR = join(HERE, "..", "..", "contract");

export interface OpenApiDoc extends Document {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, OperationObject>>;
}

export interface OperationObject {
  operationId: string;
  requestBody?: { content: { "application/json": { schema: Schema } } };
  responses: Record<string, { $ref?: string; content?: { "application/json": { schema: Schema } } }>;
}

export interface ErrorCodeRow { code: string; status: number[]; routes: string[]; meaning: string }
export interface ErrorCodeTable { contract_version: string; codes: ErrorCodeRow[] }

export interface ResponseVector { name: string; status: number; body: unknown; note?: string; why?: string }
export interface RequestVector { name: string; body: unknown; why?: string }
export interface VectorFile {
  file: string;
  contract_version: string;
  operation?: string;
  schema?: string;
  requests?: { valid: RequestVector[]; invalid: RequestVector[] };
  responses: { valid: ResponseVector[]; invalid: ResponseVector[] };
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

export const openapi = readJson<OpenApiDoc>(join(CONTRACT_DIR, "openapi.json"));
export const errorCodes = readJson<ErrorCodeTable>(join(CONTRACT_DIR, "error-codes.json"));

export function loadVectors(): VectorFile[] {
  const dir = join(CONTRACT_DIR, "vectors");
  return readdirSync(dir).filter(f => f.endsWith(".json")).sort()
    .map(f => ({ file: f, ...readJson<Omit<VectorFile, "file">>(join(dir, f)) }));
}

/** Tách `"POST /tx/consume"` thành cặp (method thường, path mẫu). */
export function splitOperation(op: string): { method: string; path: string } {
  const m = /^([A-Z]+) (\/\S*)$/.exec(op);
  if (m === null) throw new Error(`operation "${op}" không có dạng "<METHOD> <path>".`);
  return { method: m[1]!.toLowerCase(), path: m[2]! };
}

export function operationOf(op: string): OperationObject {
  const { method, path } = splitOperation(op);
  const hit = openapi.paths[path]?.[method];
  if (hit === undefined) throw new Error(`hợp đồng không có operation "${op}".`);
  return hit;
}

/** Mọi operation của hợp đồng, theo khoá "METHOD /path". */
export function allOperations(): string[] {
  const out: string[] = [];
  for (const [path, ops] of Object.entries(openapi.paths)) {
    for (const method of Object.keys(ops)) out.push(`${method.toUpperCase()} ${path}`);
  }
  return out;
}

const errorSchema = (): Schema => ({ $ref: "#/components/schemas/ErrorResponse" });

/** Lược đồ lời đáp: 2xx ⟹ lược đồ 200 của operation; ngoài 2xx ⟹ phong bì lỗi chung. */
export function responseSchemaFor(op: string | undefined, status: number, fallbackSchemaName?: string): Schema {
  if (status < 200 || status > 299) return errorSchema();
  if (op === undefined) {
    if (fallbackSchemaName === undefined) throw new Error("tệp vector không khai operation lẫn schema.");
    return { $ref: `#/components/schemas/${fallbackSchemaName}` };
  }
  const ok = operationOf(op).responses["200"]?.content?.["application/json"]?.schema;
  if (ok === undefined) throw new Error(`operation "${op}" không có lược đồ lời đáp 200.`);
  return ok;
}

export function requestSchemaFor(op: string): Schema {
  const s = operationOf(op).requestBody?.content["application/json"].schema;
  if (s === undefined) throw new Error(`operation "${op}" không có requestBody.`);
  return s;
}

export const checkResponse = (op: string, status: number, body: unknown): Violation[] =>
  validate(body, responseSchemaFor(op, status), openapi);

export const checkRequest = (op: string, body: unknown): Violation[] =>
  validate(body, requestSchemaFor(op), openapi);

/** Kiểm một lời đáp THẬT của router: ném kèm danh sách vi phạm nếu lệch hợp đồng. */
export function expectMatchesContract(op: string, status: number, body: unknown): void {
  const v = checkResponse(op, status, body);
  if (v.length > 0) {
    throw new Error(`lời đáp ${op} (HTTP ${status}) lệch hợp đồng:\n` + v.map(x => `  ${x.path}: ${x.message}`).join("\n"));
  }
}

export const fmt = (v: Violation[]): string => v.map(x => `${x.path}: ${x.message}`).join("; ");

/** Gỡ tệp mà `contract/` thật sự nằm (dùng cho bài chứng minh tệp có mặt). */
export const contractFile = (name: string): string => {
  const p = join(CONTRACT_DIR, name);
  if (!existsSync(p)) throw new Error(`thiếu ${p}`);
  return p;
};

/**
 * Kiểm một lời đáp LỖI thật của router với BẢNG mã lỗi: mã có hàng, trạng thái nằm trong `status` của hàng, và
 * route của lời gọi nằm trong `routes` của hàng (hoặc hàng khai `*`). Lời đáp 2xx bỏ qua.
 */
export function expectErrorInTable(op: string, status: number, body: unknown): void {
  if (status < 400) return;
  const path = splitOperation(op).path;
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  const row = errorCodes.codes.find(r => r.code === code);
  if (row === undefined) throw new Error(`lời đáp ${op} (HTTP ${status}) mang mã "${String(code)}" không có trong error-codes.json`);
  if (!row.status.includes(status)) {
    throw new Error(`lời đáp ${op}: ${row.code} trả ${status}, bảng khai ${row.status.join("/")}`);
  }
  if (!row.routes.includes("*") && !row.routes.includes(path)) {
    throw new Error(`lời đáp ${op}: ${row.code} không khai route ${path} trong error-codes.json (khai: ${row.routes.join(", ")})`);
  }
}
