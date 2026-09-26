// VaultTxAPI/src/feeProxy.ts — proxy tới dịch vụ ký trả phí Feecover.
//
// ── VÌ SAO CÓ PROXY ───────────────────────────────────────────────────────────
// Feecover ký phần ví trả phí của một giao dịch, theo MỤC ĐÍCH, và nhận ra ứng dụng gọi bằng
// token. Token nằm trong app di động là token công khai: ai mở gói app ra cũng xin được phí
// dưới tên ứng dụng đó. Nên token của ứng dụng `magic` chỉ nằm ở dịch vụ này (biến môi trường
// `FEECOVER_APP_TOKEN`, dạng GIÁ TRỊ), và app đi qua hai đường:
//
//   POST /fee/utxo {route}      → xin một UTxO ví trả phí cho route dựng tx sắp gọi
//   POST /fee/sign {tx_cbor}    → xin chữ ký ví trả phí cho một tx CHÍNH dịch vụ này đã phát
//
// ── APP KHÔNG CHỌN ĐƯỢC MỤC ĐÍCH, KHÔNG CHỌN ĐƯỢC MÃ GHI SỔ ─────────────────
// `/fee/sign` chỉ nhận CBOR. Route (⟹ mục đích) và mã ghi sổ (`ref`) lấy từ sổ phát-hành
// (`locks.ts` ▸ `IssuedTxRegistry`), nơi route dựng tx đã ghi lúc phát. Một tx không có trong
// sổ thì proxy KHÔNG gọi Feecover: proxy không phải cổng ký cho CBOR bất kỳ.
//
// ── NHIỀU ỨNG DỤNG, MỖI ỨNG DỤNG ĐÚNG TOKEN CỦA MÌNH ────────────────────────
// Không gửi `X-Feecover-Token` ⟹ ứng dụng mặc định `magic`, token của dịch vụ. Gửi ⟹ dịch vụ
// băm SHA-256, tra ra ứng dụng khai `token_sha256` đó, dùng bảng mục đích của ứng dụng đó và
// chuyển tiếp ĐÚNG token người gọi gửi — không lưu, không in. Mục đích mang tiền tố `<app>_`
// chỉ đi với đúng ứng dụng `<app>`; ứng dụng khác `magic` chỉ dùng mục đích tiền tố tên mình.
// Feecover tự ép luật "mục đích thuộc ứng dụng của token" (403); proxy ép lại ở phía mình để
// một bảng cấu hình gõ nhầm bị chặn ở đây với một câu trỏ đúng vào cấu hình.
//
// ── TOKEN KHÔNG ĐI RA NGOÀI ──────────────────────────────────────────────────
// Không thông điệp lỗi, chi tiết lỗi hay dòng nhật ký nào ở tệp này nhắc tới token hay băm của
// nó. Lỗi mạng chỉ báo TÊN lỗi, không báo câu lỗi của thư viện.

import { createHash } from "node:crypto";

import type { FeecoverAppSettings, FeecoverSettings } from "./config.js";
import { FEECOVER_DEFAULT_APP } from "./config.js";
import { BadRequestError, CodedApiError } from "./errors.js";
import type { IssuedRoute, IssuedTxRegistry } from "./locks.js";
import { ISSUED_ROUTES } from "./locks.js";
import { txBodyHash } from "./summary.js";

/** Tập con của `fetch` mà proxy dùng — tiêm được để phép kiểm chạy bộ giả, không gọi mạng. */
export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}) => Promise<{ status: number; text(): Promise<string> }>;

export interface FeeProxyDeps {
  settings: FeecoverSettings;
  /** Token ứng dụng mặc định. Vắng ⟹ người gọi không gửi token nhận 401. */
  magicToken?: string;
  issued: IssuedTxRegistry;
  fetch: FetchLike;
  now?: () => number;
}

/** Route mà mã ghi sổ Feecover là tên NFT, không phải hash thân tx. */
const NFT_REF_ROUTES: ReadonlySet<IssuedRoute> = new Set<IssuedRoute>(["create-vault", "open-thread"]);

interface ResolvedApp { name: string; app: FeecoverAppSettings; token: string }

export class FeeProxy {
  private readonly now: () => number;

  constructor(private readonly deps: FeeProxyDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** `POST /fee/utxo {route}` — trả đúng hình dạng trường `fee_payer` của các route dựng. */
  async utxo(route: unknown, callerToken: string | undefined): Promise<Record<string, unknown>> {
    const caller = this.resolveApp(callerToken);
    if (typeof route !== "string" || route === "") {
      throw new BadRequestError(`"route" phải là tên route dựng tx (ví dụ "consume").`);
    }
    const purpose = this.purposeFor(caller, route);
    const json = await this.call("GET", `/v1/utxo?purpose=${encodeURIComponent(purpose)}`, caller.token);

    const o = asRecord(json);
    const u = o === undefined ? undefined : asRecord(o.utxo);
    const address = o?.address;
    const reservedUntil = o?.reserved_until;
    const reservedMs = typeof reservedUntil === "string" ? Date.parse(reservedUntil) : NaN;
    if (
      o === undefined || u === undefined
      || typeof address !== "string" || !/^addr(_test)?1[0-9a-z]+$/.test(address)
      || typeof u.txHash !== "string" || !/^[0-9a-f]{64}$/.test(u.txHash)
      || typeof u.outputIndex !== "number" || !Number.isSafeInteger(u.outputIndex) || u.outputIndex < 0
      || !isLovelace(u.lovelace)
      || !Number.isFinite(reservedMs)
    ) {
      throw upstreamError("Feecover trả lời /v1/utxo sai hình dạng.");
    }
    const utxoRef = `${u.txHash}#${u.outputIndex}`;
    // Sổ phát-hành nhớ giờ giữ chỗ: tx tiêu UTxO này chỉ xin ký được tới mốc đó.
    this.deps.issued.noteFeeReservation(utxoRef, reservedMs);
    return {
      fee_payer: { utxo: utxoRef, address },
      reserved_until: reservedUntil,
      purpose,
    };
  }

  /** `POST /fee/sign {tx_cbor}` — chỉ cho tx dịch vụ này đã phát, có ví trả phí, còn hạn ký. */
  async sign(txCbor: unknown, callerToken: string | undefined): Promise<Record<string, unknown>> {
    const caller = this.resolveApp(callerToken);
    if (typeof txCbor !== "string" || !/^[0-9a-f]+$/.test(txCbor) || txCbor.length % 2 !== 0) {
      throw new BadRequestError(`"tx_cbor" phải là CBOR hex thường của giao dịch.`);
    }
    let hash: string;
    try {
      hash = txBodyHash(txCbor);
    } catch {
      throw new BadRequestError(`"tx_cbor" không giải mã được thành một giao dịch.`);
    }

    const entry = this.deps.issued.lookup(hash, this.now());
    if (entry === null || entry.signableUntilMs <= this.now()) {
      throw new CodedApiError(403, "FEE_PROXY_TX_NOT_ISSUED",
        `Giao dịch ${hash} không do dịch vụ này phát, hoặc đã quá hạn xin ký (hết giờ giữ UTxO phí ` +
        `hoặc hết hạn sổ). Dựng lại giao dịch.`, { tx_hash: hash });
    }
    if (entry.feePayerUtxo === undefined) {
      throw new CodedApiError(400, "FEE_PROXY_NO_FEE_PAYER",
        `Giao dịch ${hash} không dùng ví trả phí ("fee_payer" / "funding.fee_payer") — không có gì để ` +
        `Feecover ký.`, { tx_hash: hash, route: entry.route });
    }
    const purpose = this.purposeFor(caller, entry.route);
    let ref: string;
    if (entry.feeRef !== undefined) {
      ref = entry.feeRef;
    } else if (NFT_REF_ROUTES.has(entry.route)) {
      // Sổ ghi thiếu mã NFT cho một route cần nó: lỗi của chính dịch vụ, không phải của app.
      throw new Error(`Sổ phát-hành thiếu mã ghi sổ NFT cho tx ${hash} (route ${entry.route}).`);
    } else {
      ref = hash;
    }

    const json = await this.call("POST", "/v1/sign", caller.token,
      JSON.stringify({ tx_cbor_hex: txCbor, purpose, ref }));
    const o = asRecord(json);
    if (
      o === undefined
      || typeof o.txHash !== "string" || !/^[0-9a-f]{64}$/.test(o.txHash)
      || typeof o.witnessSet !== "string" || !/^[0-9a-f]+$/.test(o.witnessSet) || o.witnessSet.length % 2 !== 0
      || !isLovelace(o.netLovelace) || !isLovelace(o.feeLovelace)
    ) {
      throw upstreamError("Feecover trả lời /v1/sign sai hình dạng.");
    }
    if (o.txHash !== hash) {
      throw new CodedApiError(502, "FEE_PROXY_UPSTREAM_MISMATCH",
        `Feecover ký một giao dịch khác (${o.txHash}) với giao dịch đã gửi (${hash}). Không ghép chữ ký này.`,
        { tx_hash: hash, upstream_tx_hash: o.txHash });
    }
    return {
      tx_hash: hash,
      witness_set: o.witnessSet,
      net_lovelace: String(o.netLovelace),
      fee_lovelace: String(o.feeLovelace),
    };
  }

  // ── ứng dụng + mục đích ─────────────────────────────────────────────────────

  private resolveApp(callerToken: string | undefined): ResolvedApp {
    const apps = this.deps.settings.apps;
    if (callerToken === undefined) {
      const app = apps.get(FEECOVER_DEFAULT_APP);
      if (app !== undefined && this.deps.magicToken !== undefined) {
        return { name: FEECOVER_DEFAULT_APP, app, token: this.deps.magicToken };
      }
    } else {
      const h = createHash("sha256").update(callerToken, "utf8").digest("hex");
      for (const [name, app] of apps) {
        if (app.tokenSha256 !== undefined && app.tokenSha256 === h) return { name, app, token: callerToken };
      }
    }
    throw new CodedApiError(401, "FEE_PROXY_APP_UNKNOWN",
      callerToken === undefined
        ? `Proxy phí không có ứng dụng mặc định. Gửi token ứng dụng ở tiêu đề "X-Feecover-Token".`
        : `Token ở "X-Feecover-Token" không khớp ứng dụng nào đã cấu hình.`);
  }

  private purposeFor(caller: ResolvedApp, route: string): string {
    const purpose = (ISSUED_ROUTES as readonly string[]).includes(route)
      ? caller.app.purposes.get(route as IssuedRoute)
      : undefined;
    if (purpose === undefined) {
      throw new CodedApiError(400, "FEE_PROXY_PURPOSE_UNMAPPED",
        `Ứng dụng "${caller.name}" chưa có mục đích Feecover cho route "${route}".`,
        { app: caller.name, route });
    }
    for (const other of this.deps.settings.apps.keys()) {
      if (other !== caller.name && purpose.startsWith(`${other}_`)) {
        throw appPurposeError(caller.name, route, purpose, `mục đích thuộc ứng dụng "${other}"`);
      }
    }
    if (caller.name !== FEECOVER_DEFAULT_APP && !purpose.startsWith(`${caller.name}_`)) {
      throw appPurposeError(caller.name, route, purpose, `mục đích của "${caller.name}" phải bắt đầu "${caller.name}_"`);
    }
    return purpose;
  }

  // ── gọi mạng ────────────────────────────────────────────────────────────────

  private async call(method: "GET" | "POST", path: string, token: string, body?: string): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.deps.settings.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await this.deps.fetch(`${this.deps.settings.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        signal: ctl.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      // Chỉ TÊN lỗi: câu lỗi của thư viện mạng không phải thứ proxy kiểm soát được nội dung.
      throw upstreamError(ctl.signal.aborted
        ? `Feecover không trả lời trong ${this.deps.settings.timeoutMs} ms.`
        : `Không gọi được Feecover (${e instanceof Error ? e.name : "lỗi mạng"}).`);
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (status === 200) return json;
    if (status >= 400 && status < 500) {
      // Chuyển NGUYÊN mã trạng thái + `rule`/`message`/`reasons` — câu của Feecover nói được
      // người dùng phải làm gì (L14 cửa sổ Catalyst, 429 hết suất giữ chỗ…).
      const o = asRecord(json);
      const details: Record<string, unknown> = { upstream_status: status };
      if (typeof o?.rule === "string") details.rule = o.rule;
      if (typeof o?.message === "string") details.message = o.message;
      if (Array.isArray(o?.reasons) && o.reasons.every(r => typeof r === "string")) details.reasons = o.reasons;
      throw new CodedApiError(status, "FEE_PROXY_REJECTED",
        typeof details.message === "string"
          ? `Feecover từ chối (${status}): ${details.message}`
          : `Feecover từ chối (${status}).`,
        details);
    }
    throw upstreamError(`Feecover trả mã ${status}.`, { upstream_status: status });
  }
}

function appPurposeError(app: string, route: string, purpose: string, why: string): CodedApiError {
  return new CodedApiError(403, "FEE_PROXY_APP_PURPOSE",
    `Ứng dụng "${app}" không được xin phí dưới mục đích "${purpose}" (route "${route}"): ${why}.`,
    { app, route, purpose });
}

function upstreamError(message: string, details: Record<string, unknown> = {}): CodedApiError {
  return new CodedApiError(502, "FEE_PROXY_UPSTREAM", message, details);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

/** Lovelace từ Feecover: chuỗi chữ số (có thể âm với `netLovelace`) hoặc số nguyên an toàn. */
function isLovelace(v: unknown): boolean {
  return (typeof v === "string" && /^-?[0-9]+$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v));
}
