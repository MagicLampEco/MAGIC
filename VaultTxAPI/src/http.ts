// VaultTxAPI/src/http.ts — bộ định tuyến THUẦN: (method, url, headers, body) → (mã, thân bài).
//
// Tách khỏi `server.ts` để phép kiểm gọi thẳng vào đây, không phải mở cổng mạng.
//
// ── ĐÚNG TÁM ĐƯỜNG DỰNG (`buildRequest.ts` ▸ `BUILD_ROUTE_OF_PATH`), KHÔNG THÊM ──────
//   POST /tx/instant-gen       { owner, [owner_witness], [change_address | fee_payer], m, [wakeme_vault_ref] }
//   POST /tx/refresh-checkpoint { owner, [owner_witness], [change_address | fee_payer], [wakeme_vault_ref] }
//   POST /tx/schedule-commit   { owner, …, schedule_length, lamp_per_epoch }
//   POST /tx/schedule-fire     { owner, …, schedule_id }
//   POST /tx/consume           { owner, …, op_type, op_count, [engage_ref], [wakeme_vault_ref] }
//   POST /tx/open-thread       { owner, [owner_witness], [change_address] }
//                              (`fee_payer` một mình ⟹ 422; `funding` ⟹ 501 — xem `service.ts`)
//   POST /tx/bind-did          { owner, [owner_witness], [change_address], did_commit, [engage_ref] }
//                              (`fee_payer` ⟹ 501; thread đã gắn DID ⟹ 409 `DID_ALREADY_BOUND`)
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
// `/tx/instant-gen` nhận `m` (nanogic) từ Gen v2.0: chủ chọn lượng sinh, validator chỉ ép
// TRẦN (IG-8 cap_nanogic, IG-9 cap LAMP, IG-11 GB_available, IG-12 phần GB mỗi két). Dịch vụ
// tính `max_m` trên đúng các UTxO beacon/shard sẽ giao xuống bộ dựng và bác TRƯỚC khi dựng:
// `m` sai hình dạng ⟹ 400 `INSTANT_GEN_M_INVALID`; `m > max_m` ⟹ 422 `INSTANT_GEN_M_ABOVE_MAX`
// kèm `details.max_m` — câu bác đó nói được người dùng phải chọn lại bao nhiêu.
//
// Số tiền trong thân bài là CHUỖI chữ số, không phải số JSON — lý do đo được ở khối đầu
// `buildRequest.ts`, nơi đọc thân bài của tám đường dựng (dùng chung với `/tx/quote`).

import {
  BadRequestError, ConfigMissingError, TxApiError, UnauthorizedError, newReferenceCode,
} from "./errors.js";
import { toSubmitBody, type VaultTxService } from "./service.js";
import { BUILD_ROUTE_OF_PATH, buildResultBody, parseBuildRequest, reqString, runBuild } from "./buildRequest.js";
import { CodedApiError } from "./errors.js";
import type { BuildInfo } from "./buildInfo.js";
import { stripBasePath } from "./basePath.js";
import type { FeeProxy } from "./feeProxy.js";
import { sponsorRoute, type SponsorTxService } from "./sponsor.js";
import { quoteFee } from "./feeQuote.js";
import {
  OwnerAuthError, WindowOriginError, msPerEpoch, windowOf, windowOriginMs, windowStartMs, type Network,
} from "@magiclamp/protocol-utils";
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
  /** Thẻ bài VAI `sponsor` — thẻ DUY NHẤT mở `SPONSOR_ROLE_PATHS`, và KHÔNG mở route nào khác.
   *  Vắng/rỗng ⟹ các đường đó trả 501 `CONFIG_MISSING`, kể cả trên loopback (`requireRole`). */
  sponsorToken?: string;
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
  /** Đồng hồ máy chủ (POSIX ms) cho khối `epoch` của `/health`. Vắng ⟹ `Date.now`. Chỉ để phép kiểm
   *  cố định mốc; dịch vụ thật không truyền. */
  now?: () => number;
  /** Hành trình tài trợ consume đầu (`/tx/sponsor/t1-open` … `t4-first-consume`). Vắng ⟹ 501
   *  `SPONSOR_UNAVAILABLE` (trừ `/tx/sponsor/plan` — thuần, không cần cấu hình). */
  sponsor?: SponsorTxService;
}

/**
 * Khối `epoch` của `/health`: GỐC KỲ giao thức mà app đọc, khỏi gõ cứng hằng theo mạng.
 *
 * Cùng nguồn với bộ dựng tx: `windowOriginMs`/`msPerEpoch` của `@magiclamp/protocol-utils` — chính
 * hai hàm mà `genV2.ts` ▸ `instantVaultParamsOf` và `wakeme.ts` dùng để apply-param validator.
 * Kỳ = `⌊(t − O) / P⌋`, KHÔNG phải lưới Unix `⌊t / P⌋` (lệch ~3.800 kỳ trên Preprod).
 *
 * Mạng chưa có gốc (Preview, `WIN-PREVIEW`) ⟹ `epoch: null` + lý do tường minh, KHÔNG đệm 0:
 * `/health` vẫn 200 vì đây là trạng thái cấu hình của mạng, không phải sự cố.
 * Số lớn là CHUỖI chữ số (như mọi số tiền của API); `current` là chỉ số kỳ nhỏ nên là số JSON.
 * `end_ms` là mốc kết thúc ĐỘC QUYỀN = `start_ms` của kỳ kế.
 */
export function epochHealthFields(network: string, nowMs: number): Record<string, unknown> {
  try {
    const o = windowOriginMs(network as Network);
    const p = msPerEpoch(network as Network);
    const t = BigInt(Math.trunc(nowMs));
    const current = windowOf(t, p, o);
    return {
      epoch: {
        origin_ms: o.toString(),
        ms_per_epoch: p.toString(),
        current: Number(current),
        start_ms: windowStartMs(current, p, o).toString(),
        end_ms: windowStartMs(current + 1n, p, o).toString(),
      },
    };
  } catch (e) {
    if (e instanceof WindowOriginError) {
      return { epoch: null, epoch_unavailable_reason: "WINDOW_ORIGIN_UNAVAILABLE" };
    }
    throw e;
  }
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
        // Nhãn chữ GIỮ NGUYÊN văn (app cũ còn dò mẫu `LAMP <hex>` trong nó). Trường máy đọc là `lamp`.
        deployment_source: deps.deploymentSource,
        // Tài sản LAMP mà bản deploy này nướng vào mọi két — cùng nguồn với bộ dựng
        // (`deployment.lampPolicyId`/`lampAssetNameHex`), không gõ tay. App so `policy_id` với
        // policy LAMP mà Wakeme phát trước khi mở Sinh MAGIC.
        lamp: { policy_id: deps.service.lampAsset.policyId, asset_name_hex: deps.service.lampAsset.assetNameHex },
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
        // Gốc kỳ giao thức — app tính kỳ từ đây, không từ lưới Unix `t/P`.
        ...epochHealthFields(deps.network, (deps.now ?? Date.now)()),
        ...(deps.build?.reason === undefined ? {} : { commit_unavailable_reason: deps.build.reason }),
      },
    };
  }

  try {
    requireRole(req, deps, path);

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
    if (path.startsWith("/tx/sponsor/")) {
      return { status: 200, body: await sponsorRoute(path, body, deps.sponsor) };
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
    // Mạng chưa có gốc cửa sổ (`WIN-PREVIEW`): giao thức không tính được epoch ở đây — đó là
    // trạng thái cấu hình của mạng, không phải lỗi nội bộ. Giữ nguyên mã gốc ở `details`.
    if (e instanceof WindowOriginError) {
      return {
        status: 501,
        body: err("WINDOW_ORIGIN_UNAVAILABLE",
          "Mạng này chưa có gốc cửa sổ epoch (window_origin_ms); dịch vụ không tính được epoch giao thức.",
          { cause_code: e.code }),
      };
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

/**
 * Đường đòi vai `sponsor`. Chỉ T2: nó là bước chi CARP của bên tài trợ, và khoá mềm `fund:<unit>` mà
 * nó giữ chặn được mọi T2 khác trên cùng quỹ — để thẻ thường gọi được nó là để bất kỳ ai cầm thẻ app
 * giữ quỹ của bên tài trợ (mỗi lượt dựng giữ khoá tới hết TTL, lặp vô hạn). Route tài trợ khác giữ thẻ thường.
 */
export const SPONSOR_ROLE_PATHS: ReadonlySet<string> = new Set(["/tx/sponsor/t2-fund"]);

/**
 * Vai của người gọi theo đường.
 *   · đường vai `sponsor`: thẻ vai sponsor ⟹ qua · thẻ thường (hoặc không thẻ khi dịch vụ chạy không thẻ
 *     trên loopback) ⟹ 403 `SPONSOR_ROLE_REQUIRED` — đã nhận ra người gọi, vai không đủ · thẻ lạ ⟹ 401.
 *     Dịch vụ chưa có thẻ vai sponsor ⟹ 501 `CONFIG_MISSING`: không có "chế độ không thẻ" cho bước chi tiền.
 *   · đường khác: thẻ thường như cũ. Thẻ vai sponsor ở đó KHÔNG được nhận (401) — vai hẹp, không phải vai trên.
 */
function requireRole(req: HttpRequest, deps: RouterDeps, path: string): void {
  if (!SPONSOR_ROLE_PATHS.has(path)) {
    requireToken(req, deps.token);
    return;
  }
  const sponsorToken = deps.sponsorToken ?? "";
  if (sponsorToken === "") {
    throw new ConfigMissingError(
      `Đường "${path}" chỉ mở bằng thẻ bài vai sponsor, mà dịch vụ chưa được cấu hình thẻ đó.`,
      { missing: ["sponsor_role_token"], route: path });
  }
  const presented = bearerOf(req);
  if (presented !== undefined && timingSafeEqual(presented, sponsorToken)) return;
  if (deps.token === "" || (presented !== undefined && timingSafeEqual(presented, deps.token))) {
    throw new CodedApiError(403, "SPONSOR_ROLE_REQUIRED",
      `Đường "${path}" chỉ nhận thẻ bài vai sponsor (bên vận hành tài trợ); thẻ bài thường không mở được nó.`,
      { route: path });
  }
  throw new UnauthorizedError();
}

function bearerOf(req: HttpRequest): string | undefined {
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
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

