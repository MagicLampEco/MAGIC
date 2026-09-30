// VaultReadAPI/src/http.ts — bộ định tuyến THUẦN: (method, url, headers) → (mã, thân bài).
//
// Tách khỏi `server.ts` để phép kiểm gọi thẳng vào đây, không phải mở cổng mạng. Ba
// tiêu chí nghiệm thu đều là "ba ca ra ba MÃ khác nhau", nên mã HTTP phải kiểm được
// mà không cần socket.
//
// ── ĐỌC-THÔI, KHÔNG NGOẠI LỆ ────────────────────────────────────────────────────
// Chỉ `GET`. Không nhận khoá riêng, không dựng giao dịch, không ghi gì. Mọi method
// khác trả 405 ngay ở đây, trước khi chạm tới bất cứ đường đọc nào.

import { VaultReadError, BadRequestError, ThreadIndexDisabledError, UnauthorizedError } from "./errors.js";
import { VaultReadService, toJsonBody } from "./service.js";
import type { VaultScope } from "./config.js";
import { freshnessToJson, threadToJson, type ThreadIndex } from "./threadIndex.js";
import { stripBasePath } from "./basePath.js";

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
  /** Chỉ mục DID ⟹ thread. Vắng ⟹ `/threads/*` trả 503 `THREAD_INDEX_DISABLED`. */
  threads?: ThreadIndex;
  /** Tiền tố đường khi đứng sau proxy định tuyến theo đường (`basePath.ts`). Vắng/`""` ⟹ không có. */
  basePath?: string;
}

const BY_OWNER = /^\/vault\/by-owner\/([^/?#]+)$/;
const THREADS_BY_DID = /^\/threads\/by-did\/([^/?#]+)$/;
const THREADS_BY_ASSET = /^\/threads\/by-asset\/([^/?#.]+)\.([^/?#.]+)$/;

/** `/threads/*` — mọi nhánh chỉ đọc Map trong bộ nhớ của `ThreadIndex`, không gọi chuỗi. */
function handleThreads(path: string, index: ThreadIndex | undefined): HttpResponse | null {
  if (!path.startsWith("/threads/")) return null;
  if (index === undefined) throw new ThreadIndexDisabledError();

  if (path === "/threads/status") return { status: 200, body: index.status() };

  const d = THREADS_BY_DID.exec(path);
  if (d !== null) {
    const r = index.byDid(decodeURIComponent(d[1]!));
    return {
      status: 200,
      body: {
        ...freshnessToJson(r.freshness),
        threads: r.threads.map(threadToJson),
        // Số UTxO mang NFT thread mà datum không đọc được, TOÀN chỉ mục — chúng không thể được
        // gán cho DID nào, nên khác 0 nghĩa là danh sách trên CÓ THỂ thiếu. Chi tiết: /threads/status.
        skipped_count: r.skippedCount,
      },
    };
  }

  const a = THREADS_BY_ASSET.exec(path);
  if (a !== null) {
    const r = index.byAsset(decodeURIComponent(a[1]!), decodeURIComponent(a[2]!));
    return { status: 200, body: { ...freshnessToJson(r.freshness), thread: threadToJson(r.thread) } };
  }
  return null;
}

export async function handle(req: HttpRequest, deps: RouterDeps): Promise<HttpResponse> {
  if (req.method !== "GET") {
    return { status: 405, body: { error: { code: "METHOD_NOT_ALLOWED", message: "Mặt tiền này ĐỌC-THÔI: chỉ nhận GET.", details: {} } } };
  }

  const u = new URL(req.url, "http://placeholder.invalid");
  const path = stripBasePath(u.pathname, deps.basePath ?? "");

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
        base_path: deps.basePath ?? "",
      },
    };
  }

  try {
    requireToken(req, deps.token);

    const t = handleThreads(path, deps.threads);
    if (t !== null) return t;

    const m = BY_OWNER.exec(path);
    if (m === null) {
      return { status: 404, body: { error: { code: "NOT_FOUND", message: `Không có đường "${path}".`, details: {} } } };
    }

    // Đoạn đường: `<56 hex>` (bí danh nhánh khoá) HOẶC `key:<56 hex>` / `script:<56 hex>`.
    // Không chữ hoa: hash là hex THƯỜNG, và một đường hai cách viết là hai khoá bộ đệm.
    const seg = decodeURIComponent(m[1]!);
    const typed = /^(key|script):(.*)$/.exec(seg);
    const ownerReq = typed === null
      ? { ownerPkh: seg }
      : { owner: { type: typed[1] as "key" | "script", hash: typed[2]! } };
    const vaultType = u.searchParams.get("vault_type") ?? undefined;
    const atEpochRaw = u.searchParams.get("at_epoch");
    let atEpoch: bigint | undefined;
    if (atEpochRaw !== null) {
      if (!/^\d+$/.test(atEpochRaw)) {
        throw new BadRequestError("at_epoch phải là số nguyên không âm dạng thập phân.", { at_epoch: atEpochRaw });
      }
      atEpoch = BigInt(atEpochRaw);
    }

    const outcome = await deps.service.read({ ...ownerReq, vaultType, atEpoch });
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
