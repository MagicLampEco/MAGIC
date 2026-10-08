// VaultTxAPI/tests/moduleContract.test.ts — ghim HỢP ĐỒNG MODULE (`contract/`) vào mã.
//
// Bốn việc, mỗi việc một khối:
//   1. Hợp đồng tự nhất quán: openapi.json chỉ dùng từ khoá bộ kiểm hiểu, mọi $ref sống, phiên bản ba tệp trùng nhau.
//   2. Vector: mỗi mẫu HỢP LỆ khớp lược đồ, mỗi mẫu KHÔNG HỢP LỆ bị bác (kèm lý do), và mọi khoá `required` gỡ đi
//      từng khoá một đều bị bác (bài này sinh ca từ lược đồ, không phụ thuộc vào vector viết tay).
//   3. Router THẬT (`http.ts` ▸ `handle`) trả lời khớp lược đồ — lời đáp không viết tay; thêm khoá lạ vẫn khớp
//      (luật tương thích: `contract/compatibility.md`), kể cả ca `reservation_id`.
//   4. Bảng mã lỗi, hai chiều: mỗi mã trong bảng còn được `src/` phát ra; mỗi mã `src/` phát ra (quét chỗ ném +
//      bảng ánh xạ mã) có hàng đúng trạng thái, trừ danh sách loại trừ có lý do (khối 5); lời đáp lỗi thật khớp bảng.
//
// Lời đáp của `/tx/quote` trên mã thật được kiểm bằng móc trong `feeQuote.test.ts` (`bodyOf`); lời đáp của BẢY route
// `/tx/sponsor/*` (tx dựng trên script thật) bằng móc trong `sponsorEmulator.test.ts` (`post`: lời đáp 200 và phong bì
// lỗi khớp openapi.json, mã lỗi có hàng trong bảng với đúng trạng thái VÀ đúng route). Hai khung đó nặng, không dựng lại ở đây.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FundingError, type FundingErrorCode, type OwnerAuthErrorCode } from "@magiclamp/protocol-utils";

import { PAIRS_ERROR_CODE_OF_PRICE } from "../src/consumeLine.js";
import { ownerApiErrorOf } from "../src/errors.js";
import { fundingApiErrorOf } from "../src/funding.js";
import { handle } from "../src/http.js";
import { ISSUED_ROUTES } from "../src/locks.js";
import { SPONSOR_ERROR_STATUS } from "../src/sponsor.js";
import { OWNER_PKH } from "./fixtures/preview.js";
import {
  allOperations, checkRequest, checkResponse, errorCodes, expectMatchesContract, fmt, loadVectors, openapi,
  operationOf, requestSchemaFor, responseSchemaFor, type VectorFile,
} from "./support/contract.js";
import { consumeBody, consumeHarness, FEE_PAYER } from "./support/contractHarness.js";
import { assertSchemaSupported, resolveRef, validate, type Schema } from "./support/schemaSubset.js";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const EXPECTED_OPERATIONS = [
  "GET /health", "POST /fee/utxo", "POST /tx/consume", "POST /fee/sign", "POST /tx/submit",
  "GET /tx/status/{tx_hash}", "POST /tx/quote", "POST /tx/sponsor/first-consume", "POST /tx/sponsor/plan",
  "POST /tx/sponsor/open-vault", "POST /tx/sponsor/bind-did", "POST /tx/sponsor/open-fund",
  "POST /tx/sponsor/fund-vault", "POST /tx/sponsor/draw-magic", "POST /tx/sponsor/claim",
];

const VECTORS = loadVectors();

// ── Công cụ sinh ca từ lược đồ ───────────────────────────────────────────────────────────────

/** Mọi đường tới một khoá `required` CÓ MẶT trong `value`, đi theo lược đồ (qua $ref, properties, items). */
function requiredKeyPaths(value: unknown, schema: unknown, path: Array<string | number> = []): Array<Array<string | number>> {
  if (!isRecord(schema)) return [];
  if (typeof schema.$ref === "string") return requiredKeyPaths(value, resolveRef(schema.$ref, openapi), path);
  const out: Array<Array<string | number>> = [];
  if (isRecord(value)) {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required as string[]) if (Object.prototype.hasOwnProperty.call(value, k)) out.push([...path, k]);
    }
    if (isRecord(schema.properties)) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, k)) out.push(...requiredKeyPaths(value[k], sub, [...path, k]));
      }
    }
  } else if (Array.isArray(value) && schema.items !== undefined) {
    value.slice(0, 2).forEach((el, i) => out.push(...requiredKeyPaths(el, schema.items, [...path, i])));
  }
  return out;
}

function withoutPath(value: unknown, path: Array<string | number>): unknown {
  const copy = clone(value) as Record<string | number, unknown>;
  let cur: Record<string | number, unknown> = copy;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
  delete cur[path[path.length - 1]!];
  return copy;
}

/** Thêm một khoá lạ vào MỌI đối tượng CÓ KHAI `properties` (đúng việc một bản phát hành thêm khoá làm).
 *  Đối tượng dạng bản đồ (`additionalProperties` có lược đồ, như `assets`) không nhận khoá lạ: khoá của nó là DỮ LIỆU. */
function withUnknownKeys(value: unknown, schema: unknown, key = "added_in_a_later_minor"): unknown {
  let s = schema;
  while (isRecord(s) && typeof s.$ref === "string") s = resolveRef(s.$ref, openapi);
  if (Array.isArray(value)) return value.map(v => withUnknownKeys(v, isRecord(s) ? s.items : undefined, key));
  if (!isRecord(value)) return value;
  const props = isRecord(s) && isRecord(s.properties) ? s.properties : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = withUnknownKeys(v, props?.[k] ?? (isRecord(s) ? s.additionalProperties : undefined), key);
  }
  if (props !== undefined) out[key] = "x";
  return out;
}

// ── 1. Hợp đồng tự nhất quán ─────────────────────────────────────────────────────────────────

describe("hợp đồng module: tự nhất quán", () => {
  it("OpenAPI 3.1 có đúng mười lăm operation (chín của bước 1, cộng sáu route tài trợ)", () => {
    expect(openapi.openapi).toMatch(/^3\.1\./);
    expect(allOperations().sort()).toEqual([...EXPECTED_OPERATIONS].sort());
  });

  it("mọi lược đồ (kể cả qua $ref) chỉ dùng từ khoá bộ kiểm hiểu", () => {
    for (const [name, schema] of Object.entries(openapi.components?.schemas ?? {})) {
      expect(() => assertSchemaSupported(schema, openapi, `#/components/schemas/${name}`), name).not.toThrow();
    }
    for (const op of allOperations()) {
      expect(() => assertSchemaSupported(responseSchemaFor(op, 200), openapi, `${op} response`), op).not.toThrow();
      if (op.startsWith("POST ")) expect(() => assertSchemaSupported(requestSchemaFor(op), openapi, `${op} request`), op).not.toThrow();
    }
  });

  it("mọi operation có lời đáp 200 và lời đáp lỗi trỏ về phong bì chung", () => {
    for (const op of allOperations()) {
      const o = operationOf(op);
      expect(Object.keys(o.responses).sort(), op).toEqual(["200", "default"]);
      expect(o.responses.default, op).toEqual({ $ref: "#/components/responses/Error" });
    }
  });

  it("phiên bản hợp đồng: openapi.json, error-codes.json và mọi tệp vector là MỘT số", () => {
    expect(errorCodes.contract_version).toBe(openapi.info.version);
    for (const f of VECTORS) expect(f.contract_version, f.file).toBe(openapi.info.version);
  });

  it("mọi operation có một tệp vector với ít nhất một mẫu hợp lệ và một mẫu bị bác", () => {
    const covered = new Set(VECTORS.map(f => f.operation).filter((o): o is string => o !== undefined));
    expect([...covered].sort()).toEqual([...EXPECTED_OPERATIONS].sort());
    for (const f of VECTORS) {
      expect(f.responses.valid.length, `${f.file} valid`).toBeGreaterThan(0);
      expect(f.responses.invalid.length, `${f.file} invalid`).toBeGreaterThan(0);
    }
  });

  it("mọi operation tồn tại ở router thật: đúng method thì không 404, không 405", async () => {
    const h = consumeHarness();
    for (const op of allOperations()) {
      const [method, path] = op.split(" ") as [string, string];
      const url = path.replace("{tx_hash}", "ab".repeat(32));
      const r = await h.call(method, url, method === "POST" ? {} : undefined);
      expect([404, 405], `${op} ⟹ ${r.status} ${JSON.stringify(r.body)}`).not.toContain(r.status);
    }
  });
});

// ── 2. Vector ────────────────────────────────────────────────────────────────────────────────

function schemaOfVector(f: VectorFile, status: number): Schema {
  return responseSchemaFor(f.operation, status, f.schema);
}

describe.each(VECTORS.map(f => [f.file, f] as const))("vector %s", (_name, f) => {
  it("mỗi mẫu HỢP LỆ khớp lược đồ", () => {
    for (const v of f.responses.valid) {
      const viol = validate(v.body, schemaOfVector(f, v.status), openapi);
      expect(viol.length, `${f.file} ▸ ${v.name} (HTTP ${v.status}): ${fmt(viol)}`).toBe(0);
    }
  });

  it("mỗi mẫu KHÔNG HỢP LỆ bị bác, và nói vì sao", () => {
    for (const v of f.responses.invalid) {
      expect(typeof v.why === "string" && v.why.length > 10, `${f.file} ▸ ${v.name} thiếu lý do (why)`).toBe(true);
      const viol = validate(v.body, schemaOfVector(f, v.status), openapi);
      expect(viol.length, `${f.file} ▸ ${v.name} KHÔNG bị bác — lược đồ quá lỏng hoặc mẫu sai`).toBeGreaterThan(0);
    }
  });

  it("tên mẫu không trùng nhau; status là số nguyên HTTP; mẫu 2xx của tệp có operation là thân thành công", () => {
    const names = [...f.responses.valid, ...f.responses.invalid].map(v => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of [...f.responses.valid, ...f.responses.invalid]) {
      expect(Number.isInteger(v.status) && v.status >= 200 && v.status <= 599, `${f.file} ▸ ${v.name}: status ${String(v.status)}`).toBe(true);
    }
  });

  if (f.requests !== undefined) {
    const op = f.operation!;
    it("mỗi thân yêu cầu HỢP LỆ khớp lược đồ yêu cầu", () => {
      for (const v of f.requests!.valid) {
        const viol = checkRequest(op, v.body);
        expect(viol.length, `${f.file} ▸ request ${v.name}: ${fmt(viol)}`).toBe(0);
      }
    });
    it("mỗi thân yêu cầu KHÔNG HỢP LỆ bị bác, và nói vì sao", () => {
      for (const v of f.requests!.invalid) {
        expect(typeof v.why === "string" && v.why.length > 10, `${f.file} ▸ request ${v.name} thiếu lý do`).toBe(true);
        expect(checkRequest(op, v.body).length, `${f.file} ▸ request ${v.name} KHÔNG bị bác`).toBeGreaterThan(0);
      }
    });
  }
});

describe("vector: ca sinh từ lược đồ", () => {
  it("gỡ TỪNG khoá `required` khỏi mỗi mẫu hợp lệ 2xx ⟹ mẫu bị bác", () => {
    let probed = 0;
    for (const f of VECTORS) {
      for (const v of f.responses.valid.filter(x => x.status >= 200 && x.status < 300)) {
        const schema = schemaOfVector(f, v.status);
        for (const path of requiredKeyPaths(v.body, schema)) {
          const viol = validate(withoutPath(v.body, path), schema, openapi);
          expect(viol.length, `${f.file} ▸ ${v.name}: gỡ ${path.join(".")} mà lược đồ vẫn nhận`).toBeGreaterThan(0);
          probed++;
        }
      }
    }
    expect(probed).toBeGreaterThan(100); // chống bài rỗng: có hàng trăm khoá bắt buộc được thử
  });

  it("thêm khoá lạ vào MỌI đối tượng của mỗi mẫu hợp lệ ⟹ vẫn hợp lệ (cộng thêm không phá)", () => {
    for (const f of VECTORS) {
      for (const v of f.responses.valid) {
        const viol = validate(withUnknownKeys(v.body, schemaOfVector(f, v.status)), schemaOfVector(f, v.status), openapi);
        expect(viol.length, `${f.file} ▸ ${v.name}: ${fmt(viol)}`).toBe(0);
      }
    }
  });

  it("`reservation_id` là một ca vector, cả hai chiều", () => {
    const f = VECTORS.find(x => x.operation === "POST /fee/utxo")!;
    const add = f.responses.valid.find(v => v.name === "additive-key-inside-fee-payer");
    expect(add, "thiếu ca khoá cộng thêm trong fee_payer").toBeDefined();
    expect((add!.note ?? "")).toContain("reservation_id");
    const missing = f.responses.invalid.find(v => v.name === "reservation-id-missing");
    expect(missing, "thiếu ca reservation_id vắng").toBeDefined();
    expect(f.responses.invalid.some(v => v.name === "reservation-id-uppercase")).toBe(true);
    expect(f.responses.invalid.some(v => v.name === "reservation-id-31-hex")).toBe(true);
  });

  it("mọi số tiền trong lược đồ là chuỗi chữ số: lược đồ không có thuộc tính tiền kiểu number", () => {
    const moneyKey = /(lovelace|nanogic|oildrop|nanothread)/;
    const offenders: string[] = [];
    const walk = (schema: unknown, at: string, seen: Set<string>): void => {
      if (!isRecord(schema)) return;
      if (typeof schema.$ref === "string") {
        if (seen.has(schema.$ref)) return;
        seen.add(schema.$ref);
        return walk(resolveRef(schema.$ref, openapi), at, seen);
      }
      if (isRecord(schema.properties)) {
        for (const [k, sub] of Object.entries(schema.properties)) {
          const types = isRecord(sub) && sub.type !== undefined ? ([] as unknown[]).concat(sub.type) : [];
          if (moneyKey.test(k) && !k.endsWith("_ada") && !k.endsWith("_lamp") && !k.endsWith("_magic")
            && (types.includes("number") || types.includes("integer"))) offenders.push(`${at}.${k}`);
          walk(sub, `${at}.${k}`, new Set(seen));
        }
      }
      if (schema.items !== undefined) walk(schema.items, `${at}[]`, new Set(seen));
      if (isRecord(schema.additionalProperties)) walk(schema.additionalProperties, `${at}.*`, new Set(seen));
    };
    for (const op of allOperations()) {
      walk(responseSchemaFor(op, 200), `${op} response`, new Set());
      if (op.startsWith("POST ")) walk(requestSchemaFor(op), `${op} request`, new Set());
    }
    expect(offenders).toEqual([]);
  });
});

// ── 3. Router thật khớp hợp đồng ────────────────────────────────────────────────────────────

describe("router thật khớp hợp đồng", () => {
  async function journey() {
    const h = consumeHarness();
    const health = await h.call("GET", "/health");
    const utxo = await h.call("POST", "/fee/utxo", { route: "consume" });
    const fp = (utxo.body as { fee_payer: unknown }).fee_payer;
    const consume = await h.call("POST", "/tx/consume", consumeBody(fp));
    const cb = consume.body as { tx_cbor: string; tx_hash: string };
    const sign = await h.call("POST", "/fee/sign", { tx_cbor: cb.tx_cbor });
    const statusBefore = await h.call("GET", `/tx/status/${cb.tx_hash}`);
    const submit = await h.call("POST", "/tx/submit", { tx_cbor: cb.tx_cbor, witness_cbor: h.witnessCbor });
    const statusUnknown = await h.call("GET", `/tx/status/${"ab".repeat(32)}`);
    const plan = await handle({
      method: "POST", url: "/tx/sponsor/plan", headers: {},
      body: { owner: { type: "key", hash: OWNER_PKH }, sponsor_pkh: "5b".repeat(28) },
    }, h.router);
    return { h, health, utxo, fp, consume, sign, statusBefore, submit, statusUnknown, plan };
  }

  const OPS: Array<[string, (j: Awaited<ReturnType<typeof journey>>) => { status: number; body: unknown }]> = [
    ["GET /health", j => j.health],
    ["POST /fee/utxo", j => j.utxo],
    ["POST /tx/consume", j => j.consume],
    ["POST /fee/sign", j => j.sign],
    ["POST /tx/submit", j => j.submit],
    ["GET /tx/status/{tx_hash}", j => j.statusBefore],
    ["GET /tx/status/{tx_hash}", j => j.statusUnknown],
    ["POST /tx/sponsor/plan", j => j.plan],
  ];

  it("mỗi lời đáp 200 của hành trình consume khớp lược đồ operation của nó", async () => {
    const j = await journey();
    for (const [op, pick] of OPS) {
      const r = pick(j);
      expect(r.status, `${op} ⟹ ${JSON.stringify(r.body)}`).toBe(200);
      expectMatchesContract(op, r.status, r.body);
    }
  });

  it("mỗi lời đáp THẬT bị bác khi gỡ từng khoá `required` của nó", async () => {
    const j = await journey();
    let probed = 0;
    for (const [op, pick] of OPS) {
      const r = pick(j);
      for (const path of requiredKeyPaths(r.body, responseSchemaFor(op, 200))) {
        const viol = checkResponse(op, r.status, withoutPath(r.body, path));
        expect(viol.length, `${op}: gỡ ${path.join(".")} mà lược đồ vẫn nhận`).toBeGreaterThan(0);
        probed++;
      }
    }
    expect(probed).toBeGreaterThan(40);
  });

  it("thêm khoá lạ vào mọi đối tượng của lời đáp THẬT ⟹ vẫn khớp (cộng thêm không phá)", async () => {
    const j = await journey();
    for (const [op, pick] of OPS) {
      const r = pick(j);
      expectMatchesContract(op, r.status, withUnknownKeys(r.body, responseSchemaFor(op, r.status)));
    }
  });

  it("`/fee/utxo`: reservation_id có thật, đúng dạng; lời đáp MỞ (khoá lạ vẫn khớp) còn yêu cầu ĐÓNG ở fee_payer", async () => {
    const h = consumeHarness();
    const utxo = await h.call("POST", "/fee/utxo", { route: "consume" });
    const fp = (utxo.body as { fee_payer: { reservation_id: string } }).fee_payer;
    expect(fp.reservation_id).toMatch(/^[0-9a-f]{32}$/);
    const withExtra = { ...fp, lease_epoch: 318 };
    // Lời đáp MỞ: bộ đọc lời đáp `/fee/utxo` KHÔNG được bác khoá lạ được thêm theo luật tương thích.
    expectMatchesContract("POST /fee/utxo", 200, { ...(utxo.body as object), fee_payer: withExtra });
    // Yêu cầu ĐÓNG: lược đồ yêu cầu bác khoá lạ ở fee_payer…
    expect(checkRequest("POST /tx/consume", consumeBody(withExtra)).length).toBeGreaterThan(0);
    // …và router THẬT làm đúng như lược đồ khai: 400 FEE_PAYER_SHAPE, `details.extra_fields` nêu khoá lạ.
    const r = await h.call("POST", "/tx/consume", consumeBody(withExtra));
    expect(r.status).toBe(400);
    const e = (r.body as { error: { code: string; details: { extra_fields?: string[] } } }).error;
    expect(e.code).toBe("FEE_PAYER_SHAPE");
    expect(e.details.extra_fields).toEqual(["lease_epoch"]);
    // Khoá có thật được chuyển NGUYÊN khối thì qua: đó là lý do người đọc không chọn lại từng khoá.
    // (cùng khung `h`: lượt giữ UTxO phí do chính `h` phát)
    expect((await h.call("POST", "/tx/consume", consumeBody(fp))).status).toBe(200);
  });

  it("`pairs` đóng: phần tử có khoá lạ bị bác ở lược đồ yêu cầu VÀ ở router thật (400 CONSUME_PAIRS_SHAPE)", async () => {
    const body = { owner: { type: "key", hash: OWNER_PKH }, fee_payer: FEE_PAYER, pairs: [{ op_type: 1, op_count: "2", note: "x" }] };
    expect(checkRequest("POST /tx/consume", body).length).toBeGreaterThan(0);
    const r = await consumeHarness().call("POST", "/tx/consume", body);
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe("CONSUME_PAIRS_SHAPE");
  });

  it("`owner` đóng: khoá lạ bị bác ở lược đồ yêu cầu VÀ ở router thật (400 OWNER_CREDENTIAL_SHAPE, details.extra_fields)", async () => {
    const rest = { op_type: 1, op_count: "2", fee_payer: FEE_PAYER };
    const body = { ...rest, owner: { type: "key", hash: OWNER_PKH, label: "x" } };
    expect(checkRequest("POST /tx/consume", body).length).toBeGreaterThan(0);
    const r = await consumeHarness().call("POST", "/tx/consume", body);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    const e = (r.body as { error: { code: string; details: { extra_fields?: string[] } } }).error;
    expect(e.code).toBe("OWNER_CREDENTIAL_SHAPE");
    expect(e.details.extra_fields).toEqual(["label"]);
    // CẶP: cùng thân, owner đúng hình (khoá hoặc did) thì lược đồ nhận.
    expect(checkRequest("POST /tx/consume", { ...rest, owner: { type: "key", hash: OWNER_PKH } })).toEqual([]);
    expect(checkRequest("POST /tx/consume", { ...rest, owner: { type: "did", did: "did:prism:abc123" } })).toEqual([]);
    expect(checkRequest("POST /tx/consume",
      { ...rest, owner: { type: "did", did: "did:prism:abc123", device_key_hash: "d1".repeat(28) } })).toEqual([]);
  });

  it("`/tx/quote` đóng: khoá lạ ⟹ 400 FEE_QUOTE_SHAPE; route ngoài enum ⟹ 400 FEE_QUOTE_ROUTE_UNKNOWN; cả hai bị lược đồ bác", async () => {
    const h = consumeHarness();
    const extra = { route: "consume", params: {}, source: "app" };
    expect(checkRequest("POST /tx/quote", extra).length).toBeGreaterThan(0);
    const a = await h.call("POST", "/tx/quote", extra);
    expect(a.status, JSON.stringify(a.body)).toBe(400);
    const ea = (a.body as { error: { code: string; details: { extra_fields?: string[] } } }).error;
    expect(ea.code).toBe("FEE_QUOTE_SHAPE");
    expect(ea.details.extra_fields).toEqual(["source"]);
    const unknown = { route: "withdraw-lamp", params: {} };
    expect(checkRequest("POST /tx/quote", unknown).length).toBeGreaterThan(0);
    const b = await h.call("POST", "/tx/quote", unknown);
    expect(b.status, JSON.stringify(b.body)).toBe(400);
    expect((b.body as { error: { code: string } }).error.code).toBe("FEE_QUOTE_ROUTE_UNKNOWN");
    // CẶP: tám route của enum, `params: {}`, đều qua lược đồ — enum không hẹp hơn tập route router nhận.
    const routes = ["create-vault", "instant-gen", "refresh-checkpoint", "schedule-commit", "schedule-fire", "consume",
      "open-thread", "bind-did"];
    expect([...routes].sort()).toEqual([...ISSUED_ROUTES].sort());
    for (const route of routes) expect(checkRequest("POST /tx/quote", { route, params: {} }), route).toEqual([]);
  });

  it("thân yêu cầu mà các bài dùng khớp lược đồ yêu cầu", async () => {
    const j = await journey();
    expect(checkRequest("POST /fee/utxo", { route: "consume" })).toEqual([]);
    expect(checkRequest("POST /tx/consume", consumeBody(j.fp))).toEqual([]);
    expect(checkRequest("POST /tx/consume", consumeBody(FEE_PAYER))).toEqual([]);
    const cb = j.consume.body as { tx_cbor: string };
    expect(checkRequest("POST /fee/sign", { tx_cbor: cb.tx_cbor })).toEqual([]);
    expect(checkRequest("POST /tx/submit", { tx_cbor: cb.tx_cbor, witness_cbor: j.h.witnessCbor })).toEqual([]);
    expect(checkRequest("POST /tx/sponsor/plan", { owner: { type: "key", hash: OWNER_PKH }, sponsor_pkh: "5b".repeat(28) })).toEqual([]);
  });
});

// ── 4. Bảng mã lỗi ───────────────────────────────────────────────────────────────────────────

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const SRC_TEXT = srcFiles(SRC_DIR).map(p => readFileSync(p, "utf8")).join("\n");

describe("bảng mã lỗi", () => {
  const rows = errorCodes.codes;
  const byCode = new Map(rows.map(r => [r.code, r]));

  it("mã duy nhất, đúng dạng UPPER_SNAKE, trạng thái 4xx/5xx, route nằm trong hợp đồng", () => {
    expect(byCode.size).toBe(rows.length);
    const paths = new Set(Object.keys(openapi.paths));
    for (const r of rows) {
      expect(r.code, r.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(r.status.length, r.code).toBeGreaterThan(0);
      for (const s of r.status) expect(s >= 400 && s <= 599, `${r.code} ${s}`).toBe(true);
      expect(r.meaning.length, r.code).toBeGreaterThan(5);
      for (const route of r.routes) expect(route === "*" || paths.has(route), `${r.code} route ${route}`).toBe(true);
    }
  });

  it("mỗi mã trong bảng còn được `src/` phát ra (mã bị xoá khỏi mã nguồn thì bảng phải đổi theo)", () => {
    // Phát ra = chỗ ném có mã chữ trong `src/`, hoặc bảng ánh xạ mã của lớp lỗi bộ dựng (`scanEmittedCodes`):
    // `FUNDING_SCRIPT_MISMATCH` chỉ có trong ProtocolUtils, `fundingApiErrorOf` chuyển nguyên mã.
    const emitted = scanEmittedCodes().emitted;
    const missing = rows.filter(r => !emitted.has(r.code)).map(r => r.code);
    expect(missing).toEqual([]);
  });

  it("mỗi vector lỗi mang mã trong bảng thì dùng đúng trạng thái đã khai; mã ngoài bảng chỉ là ca 'mã lạ' có chủ ý", () => {
    const UNKNOWN_ON_PURPOSE = new Set(["SOME_FUTURE_CODE", "A_CODE_FROM_A_LATER_RELEASE"]);
    for (const f of VECTORS) {
      for (const v of f.responses.valid.filter(x => x.status >= 400)) {
        const code = (v.body as { error?: { code?: string } }).error?.code;
        if (code === undefined) continue;
        const row = byCode.get(code);
        if (row === undefined) {
          expect(UNKNOWN_ON_PURPOSE.has(code), `${f.file} ▸ ${v.name}: mã ${code} không có trong bảng`).toBe(true);
          continue;
        }
        expect(row.status, `${f.file} ▸ ${v.name}: ${code} trả ${v.status}`).toContain(v.status);
        if (f.operation !== undefined) {
          const path = f.operation.split(" ")[1]!;
          expect(row.routes.includes("*") || row.routes.includes(path), `${f.file} ▸ ${v.name}: ${code} không khai route ${path}`).toBe(true);
        }
      }
    }
  });

  it("lời đáp lỗi THẬT của router khớp phong bì, mang mã trong bảng, đúng trạng thái đã khai", async () => {
    const h = consumeHarness();
    const bad = consumeHarness({ token: "x" });
    const cases: Array<[string, { status: number; body: unknown }]> = [
      ["unauthorized", await bad.call("POST", "/fee/utxo", { route: "consume" })],
      ["bad hash", await h.call("GET", "/tx/status/zz")],
      ["wrong method", await h.call("GET", "/tx/consume")],
      ["no route", await h.call("POST", "/tx/nope", {})],
      ["no proxy", await consumeHarness({ noProxy: true }).call("POST", "/fee/utxo", { route: "consume" })],
      ["upstream down", await consumeHarness({ utxoReply: "throw" }).call("POST", "/fee/utxo", { route: "consume" })],
      ["upstream refuses", await consumeHarness({ utxoReply: { status: 429, body: { error: { code: "RATE", message: "slow down" } } } })
        .call("POST", "/fee/utxo", { route: "consume" })],
      ["bad reservation id", await h.call("POST", "/tx/consume", consumeBody({ ...FEE_PAYER, reservation_id: "XYZ" }))],
      ["no such vault", await h.call("POST", "/tx/consume", consumeBody(FEE_PAYER, { owner_pkh: "11".repeat(28) }))],
    ];
    for (const [label, r] of cases) {
      expect(r.status, label).toBeGreaterThanOrEqual(400);
      expectMatchesContract("POST /fee/utxo", r.status, r.body); // lược đồ lỗi chung, không phụ thuộc route
      const code = (r.body as { error: { code: string } }).error.code;
      const row = byCode.get(code);
      expect(row, `${label}: mã ${code} không có trong bảng`).toBeDefined();
      expect(row!.status, `${label}: ${code} trả ${r.status}`).toContain(r.status);
    }
  });
});

// ── 5. Mã → bảng: mỗi mã `src/` phát ra trên route của hợp đồng có hàng trong bảng, đúng trạng thái ──────
//
// Chiều ngược của bài "mỗi mã trong bảng còn có mặt trong `src/`". Quét chỗ ném có mã CHỮ (literal), cộng
// các bảng ánh xạ mã của lớp lỗi bộ dựng. Chỗ ném mà mã là BIỂU THỨC phải nằm trong `KNOWN_INDIRECT`:
// thêm một chỗ ném gián tiếp mới mà không khai ⟹ bài đỏ, vì máy quét không thấy được mã nó phát.

const SRC_FILES = srcFiles(SRC_DIR).map(p => ({ file: p.slice(SRC_DIR.length + 1), text: readFileSync(p, "utf8") }));

/** Mã mà trạng thái HTTP là trạng thái của bên trên (Feecover) chuyển nguyên: không so trạng thái. */
const RELAYED_STATUS = new Set(["FEE_PROXY_REJECTED"]);

/** Chỗ ném có mã là biểu thức (`tệp|biểu thức`) — mỗi chỗ được phủ bằng một nguồn khác ở dưới. */
const KNOWN_INDIRECT = new Set([
  "errors.ts|code",                    // CodedApiError ▸ super(httpStatus, code, …): lớp nền
  "errors.ts|e.code",                  // ownerApiErrorOf ⟹ OWNER_AUTH_CODES
  "funding.ts|e.code",                 // fundingApiErrorOf ⟹ FUNDING_CODES
  "sponsor.ts|e.code",                 // sponsorApiErrorOf ⟹ SPONSOR_ERROR_STATUS
  "consumeLine.ts|code",               // assertConsumePairs ⟹ PAIRS_ERROR_CODE_OF_PRICE
  "txBuilder.ts|e.code",               // BurnEntriesOverCapError ⟹ CONSUME_TOO_MANY_BATCHES
  "buildRequest.ts|code",              // reqAmountCoded(…, "CODE") ⟹ mẫu phụ
  "feePayer.ts|c.shape",               // bộ mã { shape: "CODE" } ⟹ mẫu phụ
  "feePayer.ts|c.invalid",             // bộ mã { invalid: "CODE" } ⟹ mẫu phụ
  "sponsor.ts|`${prefix}_NOT_FOUND`",  // uniqueByUnit(…, "PREFIX") ⟹ mẫu phụ
  "sponsor.ts|`${prefix}_AMBIGUOUS`",
]);

const OWNER_AUTH_CODES: Record<OwnerAuthErrorCode, true> = {
  OWNER_HASH_INVALID: true, OWNER_CREDENTIAL_SHAPE: true, OWNER_AUTH_MISMATCH: true,
  OWNER_SCRIPT_WITNESS_UNAVAILABLE: true, OWNER_STAKE_NOT_REGISTERED: true, OWNER_WITHDRAW_RETURNED_NOTHING: true,
};
const FUNDING_CODES: Record<FundingErrorCode, true> = {
  FUNDING_SHAPE: true, FUNDING_SCRIPT_MISMATCH: true, FUNDING_INSUFFICIENT: true,
  FUNDING_WITNESS_MISMATCH: true, FUNDING_FEE_PAYER_INVALID: true,
};

/** Mã SDK mà dịch vụ chặn trước bằng một bước kiểm khác: nằm trong `SPONSOR_ERROR_STATUS` (để ánh xạ lỗi của bộ dựng) nhưng KHÔNG với tới qua HTTP. */
const UNREACHABLE_VIA_HTTP = (guard: string) => `không với tới qua HTTP — bước kiểm trước chặn: ${guard}`;
/** Mã `src/` phát ra mà KHÔNG có hàng trong bảng, mỗi mã một lý do. Lập bằng cách quét hàm bao quanh chỗ ném. */
const NOT_ON_CONTRACT_ROUTES: Readonly<Record<string, string>> = {
  OWNER_TX_IN_FLIGHT: "đã nghỉ 2026-10-03: lớp OwnerTxInFlightError giữ lại cho app đời cũ, không chỗ nào khởi tạo",
  FEE_PAYER_UNSUPPORTED: "chỉ /tx/create-vault (ngoài openapi.json); /tx/quote chỉ chèn fee_payer ở dạng đường dựng nhận",
  FUNDING_COLLATERAL_INVALID: "chỉ đường did_payment của /tx/create-vault; trên /tx/quote 400 FEE_QUOTE_SELF_FUNDED chặn trước",
  // Ba mã của bộ dựng SDK (`MagicSDK/src/sponsorJourney.ts`) qua SPONSOR_ERROR_STATUS. Dịch vụ đã kiểm điều đó ở bước TRƯỚC
  // khi gọi bộ dựng, nên không route nào trả được chúng; gỡ khỏi bảng chứ không khai một route không có thật.
  SPONSOR_DID_COMMIT_LENGTH: UNREACHABLE_VIA_HTTP(
    "open-vault bác did_commit sai độ dài bằng 400 DID_COMMIT_INVALID (parseSponsorRequest) trước T1; fund-vault bác thread có did_commit " +
    "không đúng 32 byte hex bằng 422 SPONSOR_THREAD_DID_INVALID (fundVault) trước T2"),
  SPONSOR_ANCHOR_REF_WRONG: UNREACHABLE_VIA_HTTP(
    "fundVault tự tìm UTxO anchor bằng uniqueByUnit(anchorPolicy + did_commit) rồi mới đưa cho T2, nên chính sách và tên anchor luôn khớp"),
  SPONSOR_FUND_NOT_PINNED: UNREACHABLE_VIA_HTTP(
    "fundVault đưa cho T2 đúng đơn vị quỹ đã qua resolveSponsorFund trong tập ghim (assertFundPinnedInputs, SPONSOR_FUND_NOT_ALLOWED)"),
};

type Emitted = Map<string, { statuses: Set<number>; relayed: boolean; files: Set<string> }>;

function scanEmittedCodes(): { emitted: Emitted; indirect: string[]; errWithoutStatus: string[] } {
  const emitted: Emitted = new Map();
  const indirect: string[] = [];
  const errWithoutStatus: string[] = [];
  const add = (code: string, status: number | "relayed", file: string): void => {
    const e = emitted.get(code) ?? { statuses: new Set<number>(), relayed: false, files: new Set<string>() };
    if (status === "relayed") e.relayed = true; else e.statuses.add(status);
    e.files.add(file);
    emitted.set(code, e);
  };
  const THROW = /(?:new\s+(?:CodedApiError|TxApiError)|\bsuper)\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,/g;
  const LIT_CODE = /^"([A-Z][A-Z0-9_]*)"$/;
  const TERN_CODE = /^[^?]+\?\s*"([A-Z][A-Z0-9_]*)"\s*:\s*"([A-Z][A-Z0-9_]*)"$/;
  const LIT_STATUS = /^(\d{3})$/;
  const TERN_STATUS = /^[^?]+\?\s*(\d{3})\s*:\s*(\d{3})$/;
  for (const { file, text } of SRC_FILES) {
    for (const m of text.matchAll(THROW)) {
      const sExpr = m[1]!, cExpr = m[2]!;
      const lc = LIT_CODE.exec(cExpr), tc = TERN_CODE.exec(cExpr);
      const codes = lc !== null ? [lc[1]!] : tc !== null ? [tc[1]!, tc[2]!] : undefined;
      if (codes === undefined) { indirect.push(`${file}|${cExpr}`); continue; }
      if (codes.length === 1 && RELAYED_STATUS.has(codes[0]!)) { add(codes[0]!, "relayed", file); continue; }
      const ls = LIT_STATUS.exec(sExpr), ts = TERN_STATUS.exec(sExpr);
      const statuses = ls !== null ? [Number(ls[1])] : ts !== null ? [Number(ts[1]), Number(ts[2])] : undefined;
      if (statuses === undefined) { indirect.push(`${file}|status ${sExpr}`); continue; }
      if (codes.length === 2 && statuses.length === 2) codes.forEach((c, i) => add(c, statuses[i]!, file));
      else for (const c of codes) for (const s of statuses) add(c, s, file);
    }
    const withStatus = [...text.matchAll(/status:\s*(\d{3}),\s*body:\s*err\(\s*"([A-Z][A-Z0-9_]*)"/g)];
    for (const m of withStatus) add(m[2]!, Number(m[1]), file);
    if ([...text.matchAll(/\berr\(\s*"[A-Z]/g)].length !== withStatus.length) errWithoutStatus.push(file);
    for (const m of text.matchAll(/status:\s*(\d{3}),\s*body:\s*\{\s*error:\s*\{\s*code:\s*"([A-Z][A-Z0-9_]*)"/g)) {
      add(m[2]!, Number(m[1]), file);
    }
    for (const m of text.matchAll(/reqAmountCoded\([^;]*?"([A-Z][A-Z0-9_]*)"\s*\)/g)) add(m[1]!, 400, file);
    for (const m of text.matchAll(/\b(?:shape|invalid):\s*"([A-Z][A-Z0-9_]*)"/g)) add(m[1]!, 400, file);
    for (const m of text.matchAll(/this\.uniqueByUnit\([^;]*?"([A-Z][A-Z0-9_]*)"/g)) {
      add(`${m[1]!}_NOT_FOUND`, 404, file);
      add(`${m[1]!}_AMBIGUOUS`, 409, file);
    }
  }
  // Bảng ánh xạ mã của lớp lỗi bộ dựng.
  for (const code of Object.keys(OWNER_AUTH_CODES)) add(code, ownerApiErrorOf({ code, message: "x" }).httpStatus, "errors.ts");
  for (const code of Object.keys(FUNDING_CODES) as FundingErrorCode[]) {
    add(code, fundingApiErrorOf(new FundingError(code, "x")).httpStatus, "funding.ts");
  }
  for (const [code, status] of Object.entries(SPONSOR_ERROR_STATUS)) if (status !== "internal") add(code, status, "sponsor.ts");
  for (const code of Object.values(PAIRS_ERROR_CODE_OF_PRICE)) add(code, 400, "consumeLine.ts");
  const tb = SRC_FILES.find(f => f.file === "txBuilder.ts")!.text;
  const burn = /BurnEntriesOverCapError\)\s*\{\s*return new CodedApiError\((\d{3}),\s*e\.code/.exec(tb);
  if (burn === null) throw new Error("txBuilder.ts: không còn thấy nhánh BurnEntriesOverCapError ⟹ cập nhật máy quét");
  add("CONSUME_TOO_MANY_BATCHES", Number(burn[1]), "txBuilder.ts");
  return { emitted, indirect, errWithoutStatus };
}

describe("bảng mã lỗi: chiều mã → bảng", () => {
  const byCode = new Map(errorCodes.codes.map(r => [r.code, r]));
  const scan = scanEmittedCodes();

  it("không có chỗ ném gián tiếp chưa khai; mọi `err(\"CODE\"` đi kèm status; mỗi mục KNOWN_INDIRECT còn sống", () => {
    expect(scan.indirect.filter(x => !KNOWN_INDIRECT.has(x))).toEqual([]);
    expect(scan.errWithoutStatus).toEqual([]);
    expect([...KNOWN_INDIRECT].filter(x => !scan.indirect.includes(x))).toEqual([]);
  });

  it("mỗi mã phát ra có hàng trong bảng với đúng trạng thái, hoặc nằm trong danh sách loại trừ", () => {
    expect(scan.emitted.size).toBeGreaterThan(150); // chống bài rỗng: máy quét còn thấy mã
    const problems: string[] = [];
    for (const [code, e] of scan.emitted) {
      if (NOT_ON_CONTRACT_ROUTES[code] !== undefined) continue;
      const row = byCode.get(code);
      if (row === undefined) { problems.push(`${code} (${[...e.files].join(",")}) không có trong bảng`); continue; }
      for (const s of e.statuses) if (!e.relayed && !row.status.includes(s)) problems.push(`${code} phát ${s}, bảng khai ${row.status.join("/")}`);
    }
    expect(problems).toEqual([]);
  });

  it("mỗi mã loại trừ còn được phát, vắng trong bảng, có lý do; mã tài trợ loại trừ chỉ có mặt ở bảng SPONSOR_ERROR_STATUS", () => {
    // Một mã tài trợ loại trừ là mã mà KHÔNG route nào ném: chuỗi chữ của nó xuất hiện đúng một lần trong `src/`, là khoá
    // (không nháy) của bảng `SPONSOR_ERROR_STATUS`; không có chỗ ném nào mang nháy quanh mã. Xuất hiện thêm ở chỗ ném ⟹
    // route đó trả được nó ⟹ phải vào bảng, không được ở lại danh sách loại trừ.
    const sponsorText = SRC_FILES.find(f => f.file === "sponsor.ts")!.text;
    const tableAt = sponsorText.indexOf("SPONSOR_ERROR_STATUS");
    expect(tableAt, "không còn thấy bảng SPONSOR_ERROR_STATUS").toBeGreaterThanOrEqual(0);
    for (const [code, why] of Object.entries(NOT_ON_CONTRACT_ROUTES)) {
      expect(scan.emitted.has(code), `${code} không còn được phát ⟹ gỡ khỏi danh sách loại trừ`).toBe(true);
      expect(byCode.has(code), `${code} có trong bảng ⟹ gỡ khỏi danh sách loại trừ`).toBe(false);
      expect(why.length, code).toBeGreaterThan(10);
      if (code.startsWith("SPONSOR_")) {
        const quoted = SRC_FILES.filter(f => f.text.includes(`"${code}"`)).map(f => f.file);
        expect(quoted, `${code} có chỗ ném mang mã chữ ⟹ một route trả được nó ⟹ đưa vào bảng`).toEqual([]);
        const keyed = SRC_FILES.flatMap(f => [...f.text.matchAll(new RegExp(`^\\s*${code}:\\s*\\d{3},`, "gm"))].map(() => f.file));
        expect(keyed, `${code} phải là khoá của SPONSOR_ERROR_STATUS và chỉ ở đó`).toEqual(["sponsor.ts"]);
      }
    }
    expect(SRC_TEXT.includes("new OwnerTxInFlightError(")).toBe(false);
  });
});
