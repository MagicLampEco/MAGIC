// VaultTxAPI/tests/support/schemaSubset.ts — bộ kiểm lược đồ NHỎ cho hợp đồng module (`contract/openapi.json`).
//
// Kho không có ajv, và gói này không thêm dependency. Bộ kiểm chỉ hiểu đúng tập từ khoá mà hợp đồng dùng:
//
//   $ref (nội bộ `#/components/schemas/…`) · type (chuỗi hoặc mảng) · required · properties ·
//   additionalProperties (boolean hoặc lược đồ) · enum · const · pattern · items · oneOf
//
// Từ khoá NGOÀI tập đó ⟹ NÉM (`SchemaUnsupportedError`), không lặng lẽ bỏ qua: một bộ kiểm lờ `minLength`
// làm hợp đồng trông chặt hơn mức nó ép được. Từ khoá chú thích (`description`, `title`, `example(s)`, `$comment`,
// `default`, mọi `x-*`) được phép và không có nghĩa kiểm.
//
// `additionalProperties` vắng = cho phép (đúng JSON Schema). Hợp đồng LỜI ĐÁP dựa vào đó: khoá lạ được THÊM theo
// luật tương thích (`contract/compatibility.md`) KHÔNG làm lời đáp sai.

const ANNOTATION = new Set(["description", "title", "example", "examples", "$comment", "default"]);
const KEYWORDS = new Set([
  "$ref", "type", "required", "properties", "additionalProperties", "enum", "const", "pattern", "items", "oneOf",
]);

export class SchemaUnsupportedError extends Error {}

export type Schema = Record<string, unknown>;

export interface Violation {
  /** Đường tới chỗ sai, dạng `$.fee_payer.utxo` / `$.items[2]`. */
  path: string;
  message: string;
}

export interface Document {
  components?: { schemas?: Record<string, Schema> };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Ném nếu `schema` (và mọi lược đồ con, kể cả qua `$ref` đã resolve) dùng từ khoá ngoài tập hỗ trợ. */
export function assertSchemaSupported(schema: unknown, doc: Document, at = "#", seen = new Set<string>()): void {
  if (typeof schema === "boolean") return;
  if (!isRecord(schema)) throw new SchemaUnsupportedError(`${at}: lược đồ phải là đối tượng.`);
  for (const k of Object.keys(schema)) {
    if (KEYWORDS.has(k) || ANNOTATION.has(k) || k.startsWith("x-")) continue;
    throw new SchemaUnsupportedError(`${at}: từ khoá "${k}" nằm ngoài tập bộ kiểm hỗ trợ.`);
  }
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return;
    seen.add(schema.$ref);
    assertSchemaSupported(resolveRef(schema.$ref, doc), doc, schema.$ref, seen);
  }
  if (isRecord(schema.properties)) {
    for (const [k, v] of Object.entries(schema.properties)) assertSchemaSupported(v, doc, `${at}.properties.${k}`, seen);
  }
  if (isRecord(schema.additionalProperties)) assertSchemaSupported(schema.additionalProperties, doc, `${at}.additionalProperties`, seen);
  if (schema.items !== undefined) assertSchemaSupported(schema.items, doc, `${at}.items`, seen);
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((s, i) => assertSchemaSupported(s, doc, `${at}.oneOf[${i}]`, seen));
}

export function resolveRef(ref: string, doc: Document): Schema {
  const m = /^#\/components\/schemas\/([A-Za-z0-9_.-]+)$/.exec(ref);
  if (m === null) throw new SchemaUnsupportedError(`$ref "${ref}" không phải tham chiếu nội bộ #/components/schemas/<tên>.`);
  const hit = doc.components?.schemas?.[m[1]!];
  if (hit === undefined) throw new SchemaUnsupportedError(`$ref "${ref}" không trỏ tới lược đồ nào.`);
  return hit;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case "null": return v === null;
    case "boolean": return typeof v === "boolean";
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return typeof v === "number" && Number.isSafeInteger(v);
    case "array": return Array.isArray(v);
    case "object": return isRecord(v);
    default: throw new SchemaUnsupportedError(`type "${t}" không hợp lệ.`);
  }
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Trả mọi vi phạm của `value` với `schema`. Rỗng ⟹ khớp. */
export function validate(value: unknown, schema: unknown, doc: Document, path = "$"): Violation[] {
  if (schema === true) return [];
  if (schema === false) return [{ path, message: "lược đồ `false` không nhận giá trị nào." }];
  if (!isRecord(schema)) throw new SchemaUnsupportedError(`${path}: lược đồ phải là đối tượng.`);
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k) && !ANNOTATION.has(k) && !k.startsWith("x-")) {
      throw new SchemaUnsupportedError(`${path}: từ khoá "${k}" nằm ngoài tập bộ kiểm hỗ trợ.`);
    }
  }
  const out: Violation[] = [];

  if (typeof schema.$ref === "string") out.push(...validate(value, resolveRef(schema.$ref, doc), doc, path));

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    if (!types.some(t => matchesType(value, t))) {
      out.push({ path, message: `kiểu phải là ${types.join(" | ")}, nhận ${typeOf(value)}.` });
      return out; // các từ khoá sau giả định đúng kiểu
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    out.push({ path, message: `phải bằng ${JSON.stringify(schema.const)}.` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(e => deepEqual(e, value))) {
    out.push({ path, message: `ngoài tập cho phép ${JSON.stringify(schema.enum)}.` });
  }
  if (typeof schema.pattern === "string" && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    out.push({ path, message: `không khớp mẫu ${schema.pattern}.` });
  }

  if (isRecord(value)) {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) out.push({ path: `${path}.${k}`, message: "thiếu khoá bắt buộc." });
      }
    }
    const props = isRecord(schema.properties) ? schema.properties : {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        out.push(...validate(v, props[k], doc, `${path}.${k}`));
      } else if (schema.additionalProperties === false) {
        out.push({ path: `${path}.${k}`, message: "khoá không được khai trong lược đồ đóng." });
      } else if (isRecord(schema.additionalProperties)) {
        out.push(...validate(v, schema.additionalProperties, doc, `${path}.${k}`));
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((v, i) => out.push(...validate(v, schema.items, doc, `${path}[${i}]`)));
  }

  if (Array.isArray(schema.oneOf)) {
    const hits = schema.oneOf.filter(s => validate(value, s, doc, path).length === 0).length;
    if (hits !== 1) out.push({ path, message: `phải khớp đúng MỘT lược đồ trong oneOf, khớp ${hits}.` });
  }

  return out;
}
