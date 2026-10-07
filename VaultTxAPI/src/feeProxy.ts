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
// Và một đường KHÔNG mở cho app, chỉ báo giá (`feeQuote.ts`) gọi: `feeSources(route)` hỏi
// `GET /v1/fee-sources` của Feecover xem nguồn Feecover có nhận route đó lúc này không. Feecover
// không giữ chỗ UTxO cho câu hỏi này, nên hỏi mỗi lần báo giá được.
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
import { BadRequestError, CodedApiError, TxSupersededError } from "./errors.js";
import type { IssuedRoute, IssuedTxRegistry } from "./locks.js";
import { FEE_PURPOSE_ROUTES, FEE_SOURCES, expiredErrorFor, submissionStateOf, type FeePurposeRoute, type FeeSource } from "./locks.js";
import { txBodyHash } from "./summary.js";
import { feeReservationError } from "./validity.js";

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

/**
 * Hết giờ của câu hỏi `/v1/fee-sources`. Ngắn hơn hạn chót chung (`feecover.timeout_ms`, mặc định
 * 15 s) vì câu hỏi nằm trên đường báo giá — app đang chờ để hiện lựa chọn nguồn phí, và hết giờ
 * chỉ làm nguồn Feecover hiện "không có" (fail-closed), không làm hỏng báo giá. Lấy số NHỎ hơn
 * giữa hằng này và `feecover.timeout_ms`: bản deploy đặt ngắn hơn thì bản deploy thắng.
 */
export const FEE_SOURCES_TIMEOUT_MS = 3_000;

/** Vì sao KHÔNG có câu trả lời của Feecover cho `/v1/fee-sources`. Mỗi giá trị là một lý do máy đọc. */
export type FeeSourcesFailure =
  /** Bản deploy không khai ứng dụng mặc định `magic`. */
  | "no_default_app"
  /** Có ứng dụng `magic` nhưng proxy không cầm token của nó. */
  | "token_absent"
  /** Ứng dụng `magic` chưa có mục đích cho route. */
  | "purpose_unmapped"
  /** Mục đích của route mang tiền tố của ứng dụng khác. */
  | "purpose_foreign"
  /** Feecover không trả lời trong hạn (`FEE_SOURCES_TIMEOUT_MS`). */
  | "timeout"
  /** Lượt gọi ném trước khi có mã trạng thái (DNS, TCP, TLS…). */
  | "unreachable"
  /** Feecover trả mã khác 200. */
  | "http_status"
  /** 200 nhưng thân không đúng hợp đồng `{ purpose, feecover: { available, rule?, message? } }`. */
  | "bad_response";

/**
 * Kết quả `feeSources`. `answered: true` là câu Feecover trả lời, chuyển NGUYÊN; `answered: false`
 * là không hỏi được — người dùng kết quả PHẢI coi nguồn Feecover là không có (fail-closed).
 */
export type FeeSourcesAnswer =
  | { answered: true; purpose: string; available: boolean; rule?: string; message?: string; blocks: FeeSourceBlocks }
  | { answered: false; failure: FeeSourcesFailure; upstreamStatus?: number; rule?: string; message?: string };

/**
 * Ba khối của câu trả lời `/v1/fee-sources`, NGUYÊN như Feecover gửi (trường vắng giữ vắng). `feecover`
 * luôn là khối đã qua phép kiểm của `feeSources` (sai thì cả câu là `bad_response`). Hai khối kia kiểm
 * RIÊNG để bản Feecover trước nguồn sponsor (không trả hai khối đó) vẫn cho báo giá dùng được khối
 * `feecover`: `"absent"` = Feecover không gửi khối; `"bad"` = gửi mà sai hình dạng hoặc chứa token.
 */
export interface FeeSourceBlocks {
  feecover: Record<string, unknown>;
  sponsor: Record<string, unknown> | "absent" | "bad";
  owner_address: Record<string, unknown> | "absent" | "bad";
}

/** Lượt gọi Feecover chưa diễn giải: có mã trạng thái, hoặc hết giờ, hoặc không tới được. */
type Sent =
  | { kind: "status"; status: number; json: unknown }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "unreachable"; errorName: string };

/** Mã lỗi cấu hình của `resolveApp`/`purposeFor` → lý do `feeSources` không hỏi. Mã khác ⟹ ném nguyên. */
const FEE_SOURCES_FAILURE_OF_CODE: Readonly<Record<string, FeeSourcesFailure>> = {
  FEE_PROXY_APP_UNKNOWN: "no_default_app",
  FEE_PROXY_PURPOSE_UNMAPPED: "purpose_unmapped",
  FEE_PROXY_APP_PURPOSE: "purpose_foreign",
};

/** Route mà mã ghi sổ Feecover là tên NFT, không phải hash thân tx. `bind-did` cố ý VẮNG: nó không
 *  đúc NFT nào, nên mã ghi sổ của nó là hash thân tx (nó nhận ví trả phí từ 2026-10-04). Bốn route
 *  tài trợ cũng vắng vì cùng lý do: sổ ghi `feePayerUtxo`, không ghi `feeRef`. */
// Khoá là `string` vì sổ phát-hành còn ghi route tài trợ (`locks.ts` ▸ `SponsorRoute`), không chỉ `IssuedRoute`.
const NFT_REF_ROUTES: ReadonlySet<string> = new Set<IssuedRoute>(["create-vault", "open-thread"]);

interface ResolvedApp { name: string; app: FeecoverAppSettings; token: string }

export class FeeProxy {
  private readonly now: () => number;

  constructor(private readonly deps: FeeProxyDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** `POST /fee/utxo {route}` — trả đúng hình dạng trường `fee_payer` của các route dựng. */
  async utxo(route: unknown, callerToken: string | undefined, source?: unknown): Promise<Record<string, unknown>> {
    const caller = this.resolveApp(callerToken);
    if (typeof route !== "string" || route === "") {
      throw new BadRequestError(`"route" phải là tên route dựng tx (ví dụ "consume").`);
    }
    const wanted = parseFeeSource(source);
    const purpose = this.purposeFor(caller, route);
    // `source` vắng giữ vắng: bản Feecover trước nguồn sponsor không biết tham số này.
    const json = await this.call("GET",
      `/v1/utxo?purpose=${encodeURIComponent(purpose)}${wanted === undefined ? "" : `&source=${wanted}`}`, caller.token);

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
      || (o.source !== undefined && !(FEE_SOURCES as readonly unknown[]).includes(o.source))
    ) {
      throw upstreamError("Feecover trả lời /v1/utxo sai hình dạng.");
    }
    // Nguồn LẤY TỪ câu trả lời của Feecover, không từ yêu cầu: bản Feecover không biết `source` trả một
    // UTxO của ví Feecover mà không nói gì — xin sponsor mà nhận im lặng thì không giao UTxO đó.
    const confirmed = o.source as FeeSource | undefined;
    if (wanted === "sponsor" && confirmed === undefined) throw sourceNotConfirmed("/v1/utxo");
    // Feecover xác nhận một nguồn KHÁC nguồn đã xin (vắng = `feecover`) ⟹ 502, KHÔNG ghi lượt giữ: ghi
    // lượt giữ dưới nguồn Feecover chọn là giao cho app một UTxO mà app không xin (review #159 mục 1).
    if (confirmed !== undefined && confirmed !== (wanted ?? "feecover")) {
      throw sourceNotConfirmed("/v1/utxo", {}, wanted ?? "feecover", confirmed);
    }
    const utxoRef = `${u.txHash}#${u.outputIndex}`;
    // Sổ phát-hành nhớ giờ giữ chỗ: tx tiêu UTxO này chỉ xin ký được tới mốc đó.
    // Địa chỉ đi kèm để sổ nhận ra UTxO của Feecover cả khi lượt giữ đã bị quét (`feeReservationForBuild`).
    // Mã lượt giữ (`locks.ts` ▸ khối "MÃ LƯỢT GIỮ"): mới mỗi lượt, kể cả khi Feecover trả lại đúng UTxO cũ.
    // Nguồn ghi vào lượt giữ: `/fee/sign` với `source` khác nguồn này ⟹ 400 `FEE_PROXY_SOURCE_MISMATCH`.
    const reservationId = this.deps.issued.noteFeeReservation(utxoRef, reservedMs, address, undefined, confirmed ?? "feecover");
    return {
      fee_payer: { utxo: utxoRef, address, reservation_id: reservationId },
      reserved_until: reservedUntil,
      purpose,
      ...(confirmed === undefined ? {} : { source: confirmed }),
    };
  }

  /** `POST /fee/sign {tx_cbor}` — chỉ cho tx dịch vụ này đã phát, có ví trả phí, còn hạn ký. */
  async sign(txCbor: unknown, callerToken: string | undefined, source?: unknown): Promise<Record<string, unknown>> {
    const caller = this.resolveApp(callerToken);
    if (typeof txCbor !== "string" || !/^[0-9a-f]+$/.test(txCbor) || txCbor.length % 2 !== 0) {
      throw new BadRequestError(`"tx_cbor" phải là CBOR hex thường của giao dịch.`);
    }
    const wanted = parseFeeSource(source);
    let hash: string;
    try {
      hash = txBodyHash(txCbor);
    } catch {
      throw new BadRequestError(`"tx_cbor" không giải mã được thành một giao dịch.`);
    }

    const entry = this.deps.issued.lookup(hash, this.now());
    if (entry === null) {
      // Tx CHÍNH dịch vụ phát nhưng quá validTo + biên ⟹ 410 cùng khuôn `/tx/submit`
      // (`locks.ts` ▸ `expiredErrorFor`), không phải "không do dịch vụ phát".
      const expired = expiredErrorFor(this.deps.issued, hash, this.now());
      if (expired !== null) throw expired;
    }
    if (entry === null || entry.signableUntilMs <= this.now()) {
      throw new CodedApiError(403, "FEE_PROXY_TX_NOT_ISSUED",
        `Giao dịch ${hash} không do dịch vụ này phát, hoặc đã quá hạn xin ký (hết giờ giữ UTxO phí ` +
        `hoặc hết hạn sổ). Dựng lại giao dịch.`, { tx_hash: hash });
    }
    // Tx đã bị thay (một tx chung khoá đã NỘP sau khi nó được dựng — `locks.ts`): xin ký nó là giữ
    // thêm một UTxO phí cho một tx chắc chắn không lên chuỗi.
    if (entry.supersededBy !== undefined) {
      const submission = submissionStateOf(entry);
      throw new TxSupersededError(hash, { superseded_by: entry.supersededBy, previously_submitted: submission !== "none", submission });
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

    // Lượt giữ chỗ của UTxO phí tra LẠI ở lúc ký, không tin `signableUntilMs` chốt lúc ghi sổ: tx
    // dựng khi sổ không có lượt giữ (đã bị quét, hoặc tiến trình vừa khởi động lại) mang
    // `signableUntilMs = expiresAtMs`, và trước bản này đi thẳng tới Feecover. Vắng / đã qua / validTo
    // vượt lượt giữ ⟹ 409, Feecover KHÔNG bị gọi. Đặt sau cổng cấu hình (mục đích, mã ghi sổ) để
    // lỗi cấu hình vẫn ra đúng mã của nó.
    const problem = this.deps.issued.feeSignProblem(entry, this.now());
    if (problem !== null) {
      throw feeReservationError(problem.utxoRef, problem.reservation, problem.reservedUntilMs, { tx_hash: hash });
    }
    // Nguồn của lượt ký phải là nguồn Feecover xác nhận lúc phát UTxO (`/fee/utxo`): UTxO ví Feecover
    // không ký dưới ngân sách sponsor và ngược lại. `source` vắng = `feecover`, như ở Feecover.
    const held = this.deps.issued.feeReservationSourceOf(entry.feePayerUtxo) ?? "feecover";
    if ((wanted ?? "feecover") !== held) {
      throw new CodedApiError(400, "FEE_PROXY_SOURCE_MISMATCH",
        `"source" = "${wanted ?? "feecover"}" khác nguồn của lượt giữ UTxO phí ("${held}"). Gửi đúng "source" ` +
        `đã dùng ở /fee/utxo, hoặc xin lại UTxO và dựng lại giao dịch.`,
        { tx_hash: hash, source: wanted ?? "feecover", reserved_source: held });
    }

    const json = await this.call("POST", "/v1/sign", caller.token,
      JSON.stringify({ tx_cbor_hex: txCbor, purpose, ref, ...(wanted === undefined ? {} : { source: wanted }) }));
    const o = asRecord(json);
    if (
      o === undefined
      || typeof o.txHash !== "string" || !/^[0-9a-f]{64}$/.test(o.txHash)
      || typeof o.witnessSet !== "string" || !/^[0-9a-f]+$/.test(o.witnessSet) || o.witnessSet.length % 2 !== 0
      || !isLovelace(o.netLovelace) || !isLovelace(o.feeLovelace)
      // Cùng phép enum với `/v1/utxo` (review #159 mục 2): giá trị ngoài `FEE_SOURCES` là câu trả lời hỏng.
      || (o.source !== undefined && !(FEE_SOURCES as readonly unknown[]).includes(o.source))
    ) {
      throw upstreamError("Feecover trả lời /v1/sign sai hình dạng.");
    }
    // Bản Feecover trước nguồn sponsor không trả `source` và ký bằng ví Feecover: xin sponsor mà nhận im
    // lặng thì KHÔNG giao chữ ký đó như thể sponsor đã trả.
    if (wanted === "sponsor" && o.source === undefined) throw sourceNotConfirmed("/v1/sign", { tx_hash: hash });
    // Feecover ký dưới một nguồn KHÁC nguồn đã xin (= nguồn của lượt giữ, đã ép ở trên) ⟹ 502, KHÔNG giao
    // chữ ký: app tưởng tx được tài trợ mà bị trừ CARP, hoặc ngược lại (review #159 mục 1).
    if (o.source !== undefined && o.source !== held) {
      throw sourceNotConfirmed("/v1/sign", { tx_hash: hash }, held, o.source as FeeSource);
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
      // Giá trị Feecover trả — tới đây nó đã khớp nguồn đã xin. Vắng giữ vắng (bản Feecover cũ).
      ...(typeof o.source === "string" ? { source: o.source } : {}),
    };
  }

  /**
   * Hỏi Feecover nguồn Feecover có nhận `route` lúc này không, dưới ĐÚNG ứng dụng mà `/fee/*` sẽ
   * dùng: `callerToken` (tiêu đề `X-Feecover-Token` của `/tx/quote`) vắng ⟹ ứng dụng mặc định, có ⟹
   * ứng dụng khai `token_sha256` đó (review #159 mục 4). `GET /v1/fee-sources?purpose=<mục đích>`
   * với token của ứng dụng đó. Mục đích tra bằng cùng hai hàm `resolveApp` + `purposeFor` với
   * `/fee/utxo`, nên báo giá hỏi đúng mục đích mà đường thật sẽ xin. Feecover KHÔNG giữ chỗ UTxO
   * cho câu hỏi này.
   *
   * Token người gọi gửi mà không khớp ứng dụng nào ⟹ NÉM `401 FEE_PROXY_APP_UNKNOWN`, cùng mã với
   * `/fee/*`: đó là lỗi của người gọi, không phải câu trả lời "nguồn không có".
   *
   * KHÔNG ném với mọi lối hỏng lường trước được (cấu hình thiếu, mạng, hết giờ, mã ≠ 200, thân sai
   * hình dạng): trả `answered: false` kèm lý do có tên. Chỉ ném lỗi không lường trước — lỗi nội bộ,
   * không phải câu trả lời "không có".
   *
   * Token không đi vào kết quả: kết quả chỉ có các trường liệt kê ở `FeeSourcesAnswer`, và một câu
   * chữ của Feecover có chứa token thì cả câu trả lời bị coi là sai hình dạng.
   */
  async feeSources(route: IssuedRoute, ownerCommit?: string, callerToken?: string): Promise<FeeSourcesAnswer> {
    if (callerToken === undefined && this.deps.settings.apps.has(FEECOVER_DEFAULT_APP) && this.deps.magicToken === undefined) {
      return { answered: false, failure: "token_absent" };
    }
    let caller: ResolvedApp;
    let purpose: string;
    try {
      caller = this.resolveApp(callerToken);
      purpose = this.purposeFor(caller, route);
    } catch (e) {
      if (callerToken !== undefined && e instanceof CodedApiError && e.code === "FEE_PROXY_APP_UNKNOWN") throw e;
      const failure = e instanceof CodedApiError ? FEE_SOURCES_FAILURE_OF_CODE[e.code] : undefined;
      if (failure === undefined) throw e;
      return { answered: false, failure };
    }

    // `owner_commit` (tên anchor của DID chủ) ⟹ Feecover báo thêm suất sponsor còn lại của DID đó (`sponsor.did`).
    const query = `purpose=${encodeURIComponent(purpose)}${ownerCommit === undefined ? "" : `&owner_commit=${encodeURIComponent(ownerCommit)}`}`;
    const sent = await this.send("GET", `/v1/fee-sources?${query}`, caller.token,
      undefined, Math.min(this.deps.settings.timeoutMs, FEE_SOURCES_TIMEOUT_MS));
    if (sent.kind === "timeout") return { answered: false, failure: "timeout" };
    if (sent.kind === "unreachable") return { answered: false, failure: "unreachable" };

    const leaks = (v: unknown) => typeof v === "string" && v.includes(caller.token);
    const o = asRecord(sent.json);
    if (sent.status !== 200) {
      const out: FeeSourcesAnswer = { answered: false, failure: "http_status", upstreamStatus: sent.status };
      // 4xx: câu của Feecover nói được vì sao (401 token, 403 mục đích, 422 mục đích lạ) — chuyển
      // nguyên như `/fee/utxo`. 5xx: thân là lỗi hệ thống của Feecover, không chuyển.
      if (sent.status >= 400 && sent.status < 500) {
        if (typeof o?.rule === "string" && !leaks(o.rule)) out.rule = o.rule;
        if (typeof o?.message === "string" && !leaks(o.message)) out.message = o.message;
      }
      return out;
    }
    const fc = o === undefined ? undefined : asRecord(o.feecover);
    if (
      o === undefined || o.purpose !== purpose || fc === undefined
      || typeof fc.available !== "boolean"
      || (fc.rule !== undefined && typeof fc.rule !== "string")
      || (fc.message !== undefined && typeof fc.message !== "string")
      || leaks(fc.rule) || leaks(fc.message) || JSON.stringify(fc).includes(caller.token)
    ) {
      return { answered: false, failure: "bad_response" };
    }
    const side = (v: unknown): Record<string, unknown> | "absent" | "bad" => {
      if (v === undefined) return "absent";
      const b = asRecord(v);
      if (
        b === undefined || typeof b.available !== "boolean"
        || (b.rule !== undefined && typeof b.rule !== "string")
        || (b.message !== undefined && typeof b.message !== "string")
        || JSON.stringify(b).includes(caller.token)
      ) return "bad";
      return b;
    };
    return {
      answered: true, purpose, available: fc.available,
      ...(typeof fc.rule === "string" ? { rule: fc.rule } : {}),
      ...(typeof fc.message === "string" ? { message: fc.message } : {}),
      blocks: { feecover: fc, sponsor: side(o.sponsor), owner_address: side(o.owner_address) },
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
    const purpose = (FEE_PURPOSE_ROUTES as readonly string[]).includes(route)
      ? caller.app.purposes.get(route as FeePurposeRoute)
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
    const sent = await this.send(method, path, token, body, this.deps.settings.timeoutMs);
    if (sent.kind === "timeout") throw upstreamError(`Feecover không trả lời trong ${sent.timeoutMs} ms.`);
    // Chỉ TÊN lỗi: câu lỗi của thư viện mạng không phải thứ proxy kiểm soát được nội dung.
    if (sent.kind === "unreachable") throw upstreamError(`Không gọi được Feecover (${sent.errorName}).`);
    const { status, json } = sent;
    if (status === 200) return json;
    if (status >= 400 && status < 500) {
      // Câu của Feecover nói được người dùng phải làm gì (L14 cửa sổ Catalyst, 429 hết suất giữ
      // chỗ…) nên `rule`/`message`/`reasons` đi tiếp — trừ chuỗi nào chứa token của dịch vụ.
      const leaks = (v: string) => v.includes(token);
      const o = asRecord(json);
      const details: Record<string, unknown> = { upstream_status: status };
      if (typeof o?.rule === "string" && !leaks(o.rule)) details.rule = o.rule;
      if (typeof o?.message === "string" && !leaks(o.message)) details.message = o.message;
      if (Array.isArray(o?.reasons) && o.reasons.every(r => typeof r === "string" && !leaks(r))) details.reasons = o.reasons;
      // Chỉ các mã nói về YÊU CẦU của người dùng mới giữ nguyên (403 gồm luật L14 chặn ứng dụng theo
      // cửa sổ — một quyết định chính sách app phải thấy). 401/404 của Feecover nói về
      // quan hệ DỊCH VỤ ↔ Feecover (token dịch vụ hỏng, đường sai): chuyển
      // nguyên thì app đọc 401 thành "token CỦA APP sai" và đi sửa nhầm chỗ.
      if (!PASS_THROUGH_UPSTREAM_STATUS.has(status)) {
        throw upstreamError(`Feecover từ chối yêu cầu của dịch vụ (${status}) — lỗi cấu hình phía dịch vụ, không phải của app.`, details);
      }
      throw new CodedApiError(status, "FEE_PROXY_REJECTED",
        typeof details.message === "string"
          ? `Feecover từ chối (${status}): ${details.message}`
          : `Feecover từ chối (${status}).`,
        details);
    }
    throw upstreamError(`Feecover trả mã ${status}.`, { upstream_status: status });
  }

  /** Một lượt gọi Feecover, CHƯA diễn giải: mỗi đường tự quyết mã/thông điệp của mình. */
  private async send(method: "GET" | "POST", path: string, token: string, body: string | undefined, timeoutMs: number): Promise<Sent> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
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
      return ctl.signal.aborted
        ? { kind: "timeout", timeoutMs }
        : { kind: "unreachable", errorName: e instanceof Error ? e.name : "lỗi mạng" };
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { kind: "status", status, json };
  }
}

function appPurposeError(app: string, route: string, purpose: string, why: string): CodedApiError {
  return new CodedApiError(403, "FEE_PROXY_APP_PURPOSE",
    `Ứng dụng "${app}" không được xin phí dưới mục đích "${purpose}" (route "${route}"): ${why}.`,
    { app, route, purpose });
}

/** Mã 4xx của Feecover được chuyển nguyên cho app: chúng nói về chính giao dịch / lượt xin
 *  (thân yêu cầu hỏng, luật chặn ứng dụng, UTxO đang giữ cho bên khác, luật phí từ chối, hết suất). */
const PASS_THROUGH_UPSTREAM_STATUS: ReadonlySet<number> = new Set([400, 403, 409, 422, 429]);

/** `source` app gửi ở `/fee/utxo` / `/fee/sign`: vắng ⟹ `undefined` (= `feecover`, và KHÔNG chuyển tiếp);
 *  `feecover` | `sponsor` ⟹ chính nó; khác ⟹ 400, Feecover không bị gọi. */
export function parseFeeSource(v: unknown): FeeSource | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && (FEE_SOURCES as readonly string[]).includes(v)) return v as FeeSource;
  throw new CodedApiError(400, "FEE_PROXY_SOURCE_INVALID",
    `"source" phải là ${FEE_SOURCES.map(x => `"${x}"`).join(" hoặc ")} (vắng = "feecover"). Nguồn ` +
    `"owner_address" do ví của chủ tự trả — không qua proxy phí.`,
    { allowed: [...FEE_SOURCES] });
}

/** Feecover không xác nhận ĐÚNG nguồn đã xin. Hai ca: xin `sponsor` mà câu trả lời không kèm `source`
 *  (bản Feecover đang chạy không biết nguồn sponsor; `confirmed` vắng), hoặc câu trả lời kèm một
 *  `source` KHÁC nguồn đã xin (`confirmed` = giá trị đó). Cả hai: không dùng câu trả lời. */
function sourceNotConfirmed(
  path: string, details: Record<string, unknown> = {}, requested: FeeSource = "sponsor", confirmed?: FeeSource,
): CodedApiError {
  const why = confirmed === undefined
    ? `không xác nhận nguồn ("source" vắng) — bản Feecover đang chạy chưa hỗ trợ nguồn sponsor`
    : `xác nhận nguồn "${confirmed}", khác nguồn đã xin`;
  return new CodedApiError(502, "FEE_SOURCE_NOT_CONFIRMED",
    `Đã xin nguồn "${requested}" nhưng Feecover trả lời ${path} ${why}. Không dùng câu trả lời này; ` +
    `xin lại hoặc chọn nguồn khác.`,
    { ...details, source: requested, ...(confirmed === undefined ? {} : { confirmed_source: confirmed }) });
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
