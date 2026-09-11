// VaultReadAPI/src/http.ts — bộ định tuyến THUẦN: (method, url, headers) → (mã, thân bài).
//
// Tách khỏi `server.ts` để phép kiểm gọi thẳng vào đây, không phải mở cổng mạng. Ba
// tiêu chí nghiệm thu đều là "ba ca ra ba MÃ khác nhau", nên mã HTTP phải kiểm được
// mà không cần socket.
//
// ── ĐỌC-THÔI, KHÔNG NGOẠI LỆ ────────────────────────────────────────────────────
// Chỉ `GET`. Không nhận khoá riêng, không dựng giao dịch, không ghi gì. Mọi method
// khác trả 405 ngay ở đây, trước khi chạm tới bất cứ đường đọc nào.

import { VaultReadError, BadRequestError, UnauthorizedError } from "./errors.js";
import { VaultReadService, toJsonBody } from "./service.js";
import type { VaultScope } from "./config.js";

export interface HttpRequest {
  method: string;
  /** Đường + truy vấn, ví dụ "/vault/by-owner/abc…?vault_type=Schedule". */
  url: string;
  headers: Record<string, string | undefined>;
}

export interface HttpResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface RouterDeps {
  service: VaultReadService;
  scopes: VaultScope[];
  network: string;
  chainLabel: string;
  /** Thẻ bài chia sẻ. Chuỗi rỗng ⇒ không kiểm (chỉ hợp lệ khi bind loopback — `config.ts` ép). */
  token: string;
}

const BY_OWNER = /^\/vault\/by-owner\/([^/?#]+)$/;

export async function handle(req: HttpRequest, deps: RouterDeps): Promise<HttpResponse> {
  if (req.method !== "GET") {
    return { status: 405, body: { error: { code: "METHOD_NOT_ALLOWED", message: "Mặt tiền này ĐỌC-THÔI: chỉ nhận GET.", details: {} } } };
  }

  const u = new URL(req.url, "http://placeholder.invalid");
  const path = u.pathname;

  if (path === "/health") {
    // `/health` KHÔNG chạm chuỗi và KHÔNG đòi thẻ bài — nó là thứ bộ giám sát gọi.
    // Nó in lại NGUYÊN VĂN nhãn nguồn của từng địa chỉ vault, vì đó là thứ duy nhất
    // trả lời được câu "địa chỉ này chép từ đâu, bao giờ".
    return {
      status: 200,
      body: {
        ok: true,
        network: deps.network,
        chain: deps.chainLabel,
        vault_scopes: deps.scopes.map(s => ({
          vault_type: s.vaultType,
          address: s.address,
          script_hash: s.scriptHash,
          source: s.source,
        })),
      },
    };
  }

  try {
    requireToken(req, deps.token);

    const m = BY_OWNER.exec(path);
    if (m === null) {
      return { status: 404, body: { error: { code: "NOT_FOUND", message: `Không có đường "${path}".`, details: {} } } };
    }

    const ownerPkh = decodeURIComponent(m[1]!).toLowerCase();
    const vaultType = u.searchParams.get("vault_type") ?? undefined;
    const atEpochRaw = u.searchParams.get("at_epoch");
    let atEpoch: bigint | undefined;
    if (atEpochRaw !== null) {
      if (!/^\d+$/.test(atEpochRaw)) {
        throw new BadRequestError("at_epoch phải là số nguyên không âm dạng thập phân.", { at_epoch: atEpochRaw });
      }
      atEpoch = BigInt(atEpochRaw);
    }

    const outcome = await deps.service.read({ ownerPkh, vaultType, atEpoch });
    return { status: 200, body: toJsonBody(outcome) };
  } catch (e) {
    if (e instanceof VaultReadError) {
      return { status: e.httpStatus, body: e.toBody() };
    }
    // Lỗi ngoài dự kiến: KHÔNG in traceback, KHÔNG in đường dẫn nội bộ, KHÔNG in tên
    // biến môi trường. Người gọi nhận một câu trung tính; nguyên nhân đi vào nhật ký
    // của chính sidecar, nơi người vận hành tra được.
    return {
      status: 500,
      body: { error: { code: "INTERNAL", message: "Lỗi nội bộ của mặt tiền đọc vault.", details: {} } },
    };
  }
}

function requireToken(req: HttpRequest, token: string): void {
  if (token === "") return;
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) throw new UnauthorizedError();
  const given = auth.slice("Bearer ".length);
  if (!timingSafeEqual(given, token)) throw new UnauthorizedError();
}

/** So sánh không rò thời gian. Độ dài vẫn rò — chấp nhận được với thẻ bài độ dài cố định. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
