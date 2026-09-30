// VaultTxAPI/src/http.ts — bộ định tuyến THUẦN: (method, url, headers, body) → (mã, thân bài).
//
// Tách khỏi `server.ts` để phép kiểm gọi thẳng vào đây, không phải mở cổng mạng.
//
// ── ĐÚNG NĂM ĐƯỜNG DỰNG, KHÔNG THÊM ────────────────────────────────────────────
//   POST /tx/instant-gen       { owner, [owner_witness], [change_address | fee_payer], [wakeme_vault_ref] }
//   POST /tx/schedule-commit   { owner, …, schedule_length, lamp_per_epoch }
//   POST /tx/schedule-fire     { owner, …, schedule_id }
//   POST /tx/consume           { owner, …, op_type, op_count, [engage_ref] }
//   POST /tx/open-thread       { owner, [owner_witness], [change_address] }
//                              (`fee_payer` một mình ⟹ 422; `funding` ⟹ 501 — xem `service.ts`)
//   POST /tx/create-vault      { kind, owner, [owner_witness], lamp_amount, change_address | funding, [profile] }
//   POST /tx/submit            { tx_cbor, witness_cbor }
//   POST /tx/quote             { route, params, [owner_fee_addresses] } (báo giá phí — `feeQuote.ts`;
//                              không dựng tx nào để ký, không giữ chỗ; hỏi Feecover `/v1/fee-sources`)
//   POST /fee/utxo             { route }       [X-Feecover-Token]  (proxy Feecover — `feeProxy.ts`)
//   POST /fee/sign             { tx_cbor }     [X-Feecover-Token]
//
// `owner = { type: "key" | "script", hash }`; `owner_pkh` còn nhận làm bí danh của
// `{ type: "key" }` — xem `owner.ts`. Cùng có mà lệch ⟹ 400 `OWNER_ALIAS_MISMATCH`.
//   GET  /health               (không thẻ bài, không chạm chuỗi)
//
// `/tx/instant-gen` KHÔNG nhận `amount`, và đó là chủ ý. Lượng cấp là
// `min(vế thưởng, cap_surplus, cap_pp)` do validator tính từ trạng thái vault cộng
// hai reference input. Nhận một con số ở đây là dựng một cái nút hứa thứ nó không
// quyết được, rồi để chuỗi bác — người dùng đọc câu bác đó không ra được việc phải làm.
//
// Số tiền trong thân bài là CHUỖI chữ số, không phải số JSON — lý do đo được ở khối đầu
// `buildRequest.ts`, nơi đọc thân bài của sáu đường dựng (dùng chung với `/tx/quote`).

import {
  BadRequestError, TxApiError, UnauthorizedError, newReferenceCode,
} from "./errors.js";
import { toSubmitBody, type VaultTxService } from "./service.js";
import { BUILD_ROUTE_OF_PATH, buildResultBody, parseBuildRequest, reqString, runBuild } from "./buildRequest.js";
import { CodedApiError } from "./errors.js";
import type { BuildInfo } from "./buildInfo.js";
import { stripBasePath } from "./basePath.js";
import type { FeeProxy } from "./feeProxy.js";
import { quoteFee } from "./feeQuote.js";
import { OwnerAuthError } from "@magiclamp/protocol-utils";
import { ownerApiErrorOf } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Đường + truy vấn, ví dụ "/tx/consume". */
  url: string;
  headers: Record<string, string | undefined>;
  /** Thân bài đã phân tích. `undefined` với GET. */
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface RouterDeps {
  service: VaultTxService;
  /** Nhãn nguồn của khối cấu hình triển khai — `/health` in lại nguyên văn. */
  deploymentSource: string;
  vaultScopes: { vaultType: string; address: string; scriptHash: string }[];
  network: string;
  chainLabel: string;
  changeAddressStrategy: string;
  /** Thẻ bài chia sẻ. Chuỗi rỗng ⇒ không kiểm (chỉ hợp lệ khi bind loopback — `config.ts` ép). */
  token: string;
  /** Nơi ghi nguyên nhân gốc của lỗi ngoài dự kiến, kèm mã tham chiếu đã trả ra ngoài.
   *  Không có nó thì "mã tham chiếu" chỉ là một câu chung chung mặc đồng phục. */
  logInternal: (referenceCode: string, cause: unknown) => void;
  /** Proxy Feecover. Vắng ⟹ `/fee/utxo` + `/fee/sign` trả 501 `FEE_PROXY_UNAVAILABLE`. */
  feeProxy?: FeeProxy;
  /** Commit của mã đang chạy, đo lúc khởi động (`buildInfo.ts`). Vắng ⟹ `/health` khai
   *  `commit_source: "not_measured"` thay vì im lặng. */
  build?: BuildInfo;
  /** Tiền tố đường khi đứng sau proxy định tuyến theo đường (`basePath.ts`). Vắng/`""` ⟹ không có. */
  basePath?: string;
}

export async function handle(req: HttpRequest, deps: RouterDeps): Promise<HttpResponse> {
  const u = new URL(req.url, "http://placeholder.invalid");
  const path = stripBasePath(u.pathname, deps.basePath ?? "");

  if (path === "/health") {
    if (req.method !== "GET") return methodNotAllowed("GET");
    // Không thẻ bài, không chạm chuỗi — đây là thứ bộ giám sát gọi. In lại NGUYÊN VĂN
    // nhãn nguồn của khối triển khai: đó là thứ duy nhất trả lời được câu "mấy địa chỉ
    // này chép từ đâu, bao giờ".
    return {
      status: 200,
      body: {
        ok: true,
        network: deps.network,
        chain: deps.chainLabel,
        deployment_source: deps.deploymentSource,
        change_address_strategy: deps.changeAddressStrategy,
        vault_scopes: deps.vaultScopes.map(s => ({
          vault_type: s.vaultType, address: s.address, script_hash: s.scriptHash,
        })),
        // Nói thẳng ở chỗ máy đọc được, không chỉ ở README.
        holds_signing_material: false,
        // Chỉ trạng thái, không bao giờ token hay băm của nó.
        feecover: deps.feeProxy === undefined ? "absent" : "configured",
        // Bên gọi so commit này với commit họ dựa vào, khỏi phải hỏi người vận hành.
        commit: deps.build?.commit ?? null,
        commit_dirty: deps.build?.dirty ?? null,
        commit_source: deps.build?.source ?? "not_measured",
        // Bên gọi qua proxy đối chiếu được tiền tố mình dùng với tiền tố dịch vụ đang cắt.
        base_path: deps.basePath ?? "",
        ...(deps.build?.reason === undefined ? {} : { commit_unavailable_reason: deps.build.reason }),
      },
    };
  }

  try {
    requireToken(req, deps.token);

    if (path === "/fee/utxo" || path === "/fee/sign") {
      if (req.method !== "POST") return methodNotAllowed("POST");
      if (deps.feeProxy === undefined) {
        throw new CodedApiError(501, "FEE_PROXY_UNAVAILABLE",
          `Proxy phí Feecover chưa được cấu hình ở dịch vụ này (bản deploy thiếu khối "feecover").`);
      }
      const body = asObject(req.body);
      const callerToken = req.headers["x-feecover-token"] ?? req.headers["X-Feecover-Token"];
      const out = path === "/fee/utxo"
        ? await deps.feeProxy.utxo(body.route, callerToken)
        : await deps.feeProxy.sign(body.tx_cbor, callerToken);
      return { status: 200, body: out };
    }

    if (!path.startsWith("/tx/")) {
      return { status: 404, body: err("NOT_FOUND", `Không có đường "${path}".`) };
    }
    if (req.method !== "POST") return methodNotAllowed("POST");

    const body = asObject(req.body);

    if (path === "/tx/submit") {
      const out = await deps.service.submit({
        txCbor: reqString(body, "tx_cbor"),
        witnessCbor: reqString(body, "witness_cbor"),
      });
      return { status: 200, body: toSubmitBody(out) };
    }
    if (path === "/tx/quote") {
      const out = await quoteFee(body, { service: deps.service, feeProxy: deps.feeProxy });
      return { status: 200, body: out as unknown as Record<string, unknown> };
    }
    const route = BUILD_ROUTE_OF_PATH[path];
    if (route === undefined) {
      return { status: 404, body: err("NOT_FOUND", `Không có đường "${path}".`) };
    }
    const built = await runBuild(deps.service, parseBuildRequest(route, body));
    return { status: 200, body: buildResultBody(built) };
  } catch (e) {
    if (e instanceof TxApiError) return { status: e.httpStatus, body: e.toBody() };
    // Lỗi quyền chủ lọt tới đây (không qua tầng dịch vụ) vẫn giữ NGUYÊN mã.
    if (e instanceof OwnerAuthError) {
      const a = ownerApiErrorOf(e);
      return { status: a.httpStatus, body: a.toBody() };
    }
    // Ngoài dự kiến: KHÔNG traceback, KHÔNG đường dẫn nội bộ, KHÔNG tên biến môi trường.
    // Người gọi nhận một MÃ THAM CHIẾU tra ngược được ở nhật ký của chính dịch vụ.
    const ref = newReferenceCode();
    deps.logInternal(ref, e);
    return {
      status: 500,
      body: err("INTERNAL", "Lỗi nội bộ của dịch vụ dựng giao dịch.", { reference_code: ref }),
    };
  }
}

// ── phụ trợ ────────────────────────────────────────────────────────────────────

function methodNotAllowed(expected: string): HttpResponse {
  return { status: 405, body: err("METHOD_NOT_ALLOWED", `Đường này chỉ nhận ${expected}.`) };
}

function err(code: string, message: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return { error: { code, message, details } };
}

function requireToken(req: HttpRequest, token: string): void {
  if (token === "") return;
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) throw new UnauthorizedError();
  if (!timingSafeEqual(auth.slice("Bearer ".length), token)) throw new UnauthorizedError();
}

/** So sánh không rò thời gian. Độ dài vẫn rò — chấp nhận được với thẻ bài độ dài cố định. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Thân bài phải là một đối tượng JSON.");
  }
  return body as Record<string, unknown>;
}

