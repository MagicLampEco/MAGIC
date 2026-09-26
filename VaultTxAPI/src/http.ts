// VaultTxAPI/src/http.ts — bộ định tuyến THUẦN: (method, url, headers, body) → (mã, thân bài).
//
// Tách khỏi `server.ts` để phép kiểm gọi thẳng vào đây, không phải mở cổng mạng.
//
// ── ĐÚNG NĂM ĐƯỜNG DỰNG, KHÔNG THÊM ────────────────────────────────────────────
//   POST /tx/instant-gen       { owner, [owner_witness], [change_address] }
//   POST /tx/schedule-commit   { owner, …, schedule_length, lamp_per_epoch }
//   POST /tx/schedule-fire     { owner, …, schedule_id }
//   POST /tx/consume           { owner, …, op_type, op_count }
//   POST /tx/create-vault      { kind, owner, [owner_witness], lamp_amount, change_address | funding, [profile] }
//   POST /tx/submit            { tx_cbor, witness_cbor }
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
// ── VÌ SAO SỐ TIỀN PHẢI GỬI LÊN DƯỚI DẠNG CHUỖI ────────────────────────────────
// `lamp_per_epoch` tính bằng oildrop, và trần LAMP là 36×10^15 oildrop trong khi 2^53
// ≈ 9,007×10^15. Một literal số JSON ở đó KHÔNG lỗi khi vượt ngưỡng — nó LÀM TRÒN, và
// con số đã tròn vẫn dựng ra một giao dịch hợp lệ khoá nhầm số LAMP. Nên bộ định tuyến
// TỪ CHỐI số JSON cho mọi trường tiền và đếm, và nói rõ vì sao trong thông báo lỗi.
// `op_type` thì nhận số nguyên: nó là một nhãn nhỏ (1 = ảnh, 2 = CID), không phải tiền.

import {
  BadRequestError, TxApiError, UnauthorizedError, newReferenceCode,
} from "./errors.js";
import { toBuildBody, toCreateVaultBody, toSubmitBody, type OwnerRequest, type VaultTxService } from "./service.js";
import { parseOwnerFields, parseOwnerWitness } from "./owner.js";
import { parseFunding } from "./funding.js";
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
}

export async function handle(req: HttpRequest, deps: RouterDeps): Promise<HttpResponse> {
  const u = new URL(req.url, "http://placeholder.invalid");
  const path = u.pathname;

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
      },
    };
  }

  try {
    requireToken(req, deps.token);

    if (!path.startsWith("/tx/")) {
      return { status: 404, body: err("NOT_FOUND", `Không có đường "${path}".`) };
    }
    if (req.method !== "POST") return methodNotAllowed("POST");

    const body = asObject(req.body);

    switch (path) {
      case "/tx/instant-gen": {
        const out = await deps.service.instantGen(ownerReq(body));
        return { status: 200, body: toBuildBody(out) };
      }
      case "/tx/schedule-commit": {
        const out = await deps.service.scheduleCommit({
          ...ownerReq(body),
          scheduleLength: reqBigint(body, "schedule_length"),
          lampPerEpoch: reqBigint(body, "lamp_per_epoch"),
        });
        return { status: 200, body: toBuildBody(out) };
      }
      case "/tx/schedule-fire": {
        const out = await deps.service.scheduleFire({
          ...ownerReq(body),
          scheduleId: reqHex(body, "schedule_id"),
        });
        return { status: 200, body: toBuildBody(out) };
      }
      case "/tx/consume": {
        const out = await deps.service.consume({
          ...ownerReq(body),
          opType: reqSmallInt(body, "op_type"),
          opCount: reqBigint(body, "op_count"),
        });
        return { status: 200, body: toBuildBody(out) };
      }
      case "/tx/create-vault": {
        const kind = body.kind;
        if (kind !== "instant" && kind !== "schedule") {
          throw new BadRequestError(`"kind" phải là "instant" hoặc "schedule".`);
        }
        const profile = body.profile;
        if (profile !== undefined && profile !== "Ember" && profile !== "Flame" && profile !== "Lantern") {
          throw new BadRequestError(`"profile" phải là "Ember" | "Flame" | "Lantern" (bỏ trống = "Flame").`);
        }
        // `change_address` và `funding` loại trừ nhau — tầng dịch vụ quyết (400 có mã), không
        // phải ở đây, để lời gọi thẳng vào dịch vụ cũng bị kiểm.
        const out = await deps.service.createVault({
          ...ownerReq(body),
          kind,
          lampAmount: reqBigint(body, "lamp_amount"),
          profile,
          funding: parseFunding(body),
        });
        return { status: 200, body: toCreateVaultBody(out) };
      }
      case "/tx/submit": {
        const out = await deps.service.submit({
          txCbor: reqString(body, "tx_cbor"),
          witnessCbor: reqString(body, "witness_cbor"),
        });
        return { status: 200, body: toSubmitBody(out) };
      }
      default:
        return { status: 404, body: err("NOT_FOUND", `Không có đường "${path}".`) };
    }
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

/** Chủ + nhân chứng + địa chỉ đổi tiền thừa (tuỳ chọn) — phần chung của mọi đường có chủ. */
function ownerReq(body: Record<string, unknown>): OwnerRequest {
  const changeAddress = body.change_address;
  if (changeAddress !== undefined && (typeof changeAddress !== "string" || changeAddress === "")) {
    throw new BadRequestError(`"change_address" phải là chuỗi địa chỉ bech32 khác rỗng.`);
  }
  return {
    owner: parseOwnerFields(body),
    ownerWitness: parseOwnerWitness(body),
    changeAddress: changeAddress as string | undefined,
  };
}

function reqString(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  if (typeof v !== "string" || v === "") throw new BadRequestError(`Thiếu trường "${name}" (chuỗi khác rỗng).`);
  return v;
}

function reqHex(body: Record<string, unknown>, name: string): string {
  const v = reqString(body, name);
  if (!/^[0-9a-f]+$/.test(v) || v.length % 2 !== 0) {
    throw new BadRequestError(`"${name}" phải là hex thường, số ký tự CHẴN.`);
  }
  return v;
}

/**
 * Số nguyên lớn, BẮT BUỘC gửi dưới dạng CHUỖI thập phân.
 *
 * Số JSON bị từ chối có chủ đích: xem khối đầu tệp. Thông báo lỗi nói lý do, vì người
 * gặp nó sẽ nghĩ dịch vụ đang khó tính vô cớ.
 */
function reqBigint(body: Record<string, unknown>, name: string): bigint {
  const v = body[name];
  if (typeof v === "number") {
    throw new BadRequestError(
      `"${name}" phải là CHUỖI chữ số, không phải số JSON. Số JSON là số dấu-phẩy-động: ` +
      `một giá trị oildrop có thật vượt được 2^53 và lúc vượt thì nó không lỗi, nó làm tròn.`,
      { received_type: "number" },
    );
  }
  if (typeof v !== "string" || !/^\d+$/.test(v)) {
    throw new BadRequestError(`"${name}" phải là chuỗi chữ số thập phân không âm.`);
  }
  const n = BigInt(v);
  if (n <= 0n) throw new BadRequestError(`"${name}" phải > 0.`);
  return n;
}

/** Nhãn nhỏ (ví dụ `op_type`): số nguyên JSON là đúng kiểu ở đây. */
function reqSmallInt(body: Record<string, unknown>, name: string): number {
  const v = body[name];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1_000_000) {
    throw new BadRequestError(`"${name}" phải là số nguyên trong [0, 1000000].`);
  }
  return v;
}
