// VaultReadAPI/src/chain.ts — cổng ra chuỗi. Một giao diện HẸP, hai hiện thực.
//
// ── VÌ SAO KHÔNG DÙNG `Blockfrost` CỦA LUCID ────────────────────────────────────
// `@lucid-evolution/provider` có sẵn `getUtxos`, và gói này vẫn dùng `Data` của
// lucid để giải mã datum. Nhưng đường LẤY UTxO thì không dùng, vì một dòng:
//
//   node_modules/@lucid-evolution/provider/dist/index.js:169
//     throw new Error("Could not fetch UTxOs from Blockfrost. Try again.");
//
// Nó nuốt mã HTTP và nguyên nhân gốc. Với một gói mà toàn bộ giá trị là PHÂN BIỆT
// ĐƯỢC các kiểu hỏng, một câu lỗi chung chung đúng bằng không có. Ta vẫn KHÔNG chép
// lại cách đọc datum — thứ bị cấm chép — vì giải mã vẫn đi qua `VaultDatumSchema`
// của MagicSDK; chỗ tự viết chỉ là lấy danh sách UTxO thô.
//
// ── HAI ĐỒNG HỒ ─────────────────────────────────────────────────────────────────
// `/blocks/latest` trả `time` theo GIÂY POSIX. Epoch của giao thức thì tính từ
// MILI-giây (`posixMsToEpoch`, ProtocolUtils). Nhân nhầm hệ số ở đúng chỗ này là
// lỗi "slot đọc thành POSIX-ms" — nên phép nhân nằm ở MỘT dòng, có tên, và có một
// phép kiểm tỉnh táo ngay dưới nó.

import { ChainUnavailableError } from "./errors.js";

/** Một UTxO như gói này cần — cố ý hẹp hơn `UTxO` của lucid. */
export interface ChainUtxo {
  txHash: string;
  outputIndex: number;
  /** unit (policyId + assetNameHex, hoặc "lovelace") → số lượng. */
  assets: Record<string, bigint>;
  /** Datum inline dạng hex, hoặc null khi output không có datum inline. */
  inlineDatumHex: string | null;
}

export interface ChainTip {
  blockHeight: number;
  blockHash: string;
  /** POSIX **mili-giây**. Tên trường mang đơn vị vì đây là chỗ đơn vị hay lệch. */
  blockTimePosixMs: bigint;
}

export interface ChainReader {
  /** Tên để ghi nhật ký / `/health`. KHÔNG được mang khoá hay URL đầy đủ. */
  readonly label: string;
  /**
   * Mọi UTxO chưa tiêu tại một địa chỉ.
   *
   * Hợp đồng NGHIÊM: trả mảng RỖNG chỉ khi chuỗi thật sự trả lời rằng ở đó không
   * có gì. Mọi kiểu không-đọc-được PHẢI ném `ChainUnavailableError`. Hiện thực nào
   * trả `[]` khi hỏng là dựng lại đúng con số 0 đang sai.
   */
  utxosAt(address: string): Promise<ChainUtxo[]>;
  /** Đỉnh chuỗi — dùng để suy epoch giao thức của lượt đọc. */
  tip(): Promise<ChainTip>;
}

/** Mốc tỉnh táo: 2020-01-01T00:00:00Z tính bằng giây. Thời gian khối nhỏ hơn mốc này
 *  gần như chắc chắn là ta đang đọc nhầm trường (slot, chiều cao khối, ms-đọc-thành-giây). */
const SANE_MIN_BLOCK_TIME_SECONDS = 1_577_836_800n;

export interface BlockfrostReaderOptions {
  /** Gốc API, ví dụ "https://cardano-preview.blockfrost.io/api/v0". */
  baseUrl: string;
  /** Khoá dự án. CHỈ nhận GIÁ TRỊ — gói này không bao giờ nhận đường dẫn tới kho khoá,
   *  không mở tệp nào để tìm nó, và không in nó ra ở bất cứ nhánh nào. */
  projectId: string;
  /** Trần thời gian mỗi lần gọi (ms). Hết giờ ⇒ `CHAIN_UNAVAILABLE`, không ⇒ rỗng. */
  timeoutMs?: number;
}

export class BlockfrostChainReader implements ChainReader {
  readonly label: string;
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(opts: BlockfrostReaderOptions) {
    if (!opts.projectId) {
      throw new Error("[chain] thiếu projectId — sidecar phải fail-closed, không chạy không khoá.");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.projectId = opts.projectId;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    // Nhãn mang HOST, không mang khoá và không mang đường dẫn đầy đủ.
    this.label = `blockfrost:${new URL(this.baseUrl).host}`;
  }

  private async getJson(path: string): Promise<{ status: number; body: unknown }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: { project_id: this.projectId },
        signal: ac.signal,
      });
      let body: unknown = null;
      const text = await res.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          // Nút trả về thứ không phải JSON (trang lỗi của proxy, HTML của cổng sai…).
          // Đó là "không đọc được", không phải "rỗng".
          throw new ChainUnavailableError(
            `Nút chuỗi trả về nội dung không phải JSON (HTTP ${res.status}).`,
            { transport: "http", node_http_status: res.status, node: this.label },
          );
        }
      }
      return { status: res.status, body };
    } catch (e) {
      if (e instanceof ChainUnavailableError) throw e;
      // Từ chối kết nối, DNS hỏng, TLS hỏng, quá hạn — tất cả rơi vào đây.
      const kind = (e as { name?: string }).name === "AbortError" ? "timeout" : "transport";
      throw new ChainUnavailableError(
        `Không nối được tới nút chuỗi (${kind}).`,
        { transport: kind, node: this.label, timeout_ms: this.timeoutMs },
        e,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async utxosAt(address: string): Promise<ChainUtxo[]> {
    const out: ChainUtxo[] = [];
    const pageSize = 100;
    for (let page = 1; ; page++) {
      const { status, body } = await this.getJson(
        `/addresses/${address}/utxos?page=${page}&count=${pageSize}`,
      );

      if (status === 404) {
        // Blockfrost trả 404 cho địa chỉ CHƯA TỪNG xuất hiện trên chuỗi. Đó là một
        // câu trả lời thật: ở đó không có UTxO nào. Đây là ca DUY NHẤT được phép
        // biến một mã lỗi thành mảng rỗng.
        return out;
      }
      if (status !== 200) {
        throw new ChainUnavailableError(
          `Nút chuỗi trả HTTP ${status} khi đọc UTxO của địa chỉ.`,
          { transport: "http", node_http_status: status, node: this.label },
        );
      }
      if (!Array.isArray(body)) {
        throw new ChainUnavailableError(
          "Nút chuỗi trả về hình dạng lạ cho danh sách UTxO (mong đợi một mảng).",
          { transport: "http", node_http_status: status, node: this.label },
        );
      }

      for (const raw of body) out.push(toChainUtxo(raw));
      if (body.length < pageSize) return out;
    }
  }

  async tip(): Promise<ChainTip> {
    const { status, body } = await this.getJson("/blocks/latest");
    if (status !== 200 || body === null || typeof body !== "object") {
      throw new ChainUnavailableError(
        `Nút chuỗi trả HTTP ${status} khi đọc đỉnh chuỗi.`,
        { transport: "http", node_http_status: status, node: this.label },
      );
    }
    const b = body as { time?: unknown; height?: unknown; hash?: unknown };
    if (typeof b.time !== "number" || typeof b.hash !== "string") {
      throw new ChainUnavailableError(
        "Đỉnh chuỗi thiếu `time`/`hash` — không suy được epoch giao thức.",
        { transport: "http", node_http_status: status, node: this.label },
      );
    }
    const seconds = BigInt(b.time);
    if (seconds < SANE_MIN_BLOCK_TIME_SECONDS) {
      // Đây là cái bẫy đơn vị, viết ra thành một nhánh chứ không thành một chú thích.
      throw new ChainUnavailableError(
        `Thời gian khối ${seconds} nhỏ hơn mốc tỉnh táo — nhiều khả năng đang đọc nhầm ` +
        `trường (slot hay chiều cao khối) thay vì GIÂY POSIX. Từ chối suy epoch từ nó.`,
        { transport: "http", node_block_time: String(seconds), node: this.label },
      );
    }
    return {
      blockHeight: typeof b.height === "number" ? b.height : -1,
      blockHash: b.hash,
      blockTimePosixMs: seconds * 1000n,   // GIÂY → MILI-GIÂY. Đúng một chỗ trong gói này.
    };
  }
}

/** Chuyển một mục UTxO của Blockfrost sang hình dạng hẹp của gói này. */
function toChainUtxo(raw: unknown): ChainUtxo {
  const u = raw as {
    tx_hash?: unknown;
    output_index?: unknown;
    inline_datum?: unknown;
    amount?: unknown;
  };
  if (typeof u.tx_hash !== "string" || typeof u.output_index !== "number") {
    // Hình dạng lạ → NÉM. Không đệm, không bỏ qua: một UTxO đọc hỏng mà bị bỏ im lặng
    // là một vault biến mất khỏi câu trả lời.
    throw new ChainUnavailableError(
      "Mục UTxO của nút chuỗi thiếu `tx_hash`/`output_index`.",
      { transport: "http" },
    );
  }
  const assets: Record<string, bigint> = {};
  if (Array.isArray(u.amount)) {
    for (const a of u.amount as { unit?: unknown; quantity?: unknown }[]) {
      if (typeof a.unit !== "string" || typeof a.quantity !== "string") {
        throw new ChainUnavailableError(
          "Mục tài sản của nút chuỗi thiếu `unit`/`quantity`.",
          { transport: "http" },
        );
      }
      assets[a.unit] = (assets[a.unit] ?? 0n) + BigInt(a.quantity);
    }
  }
  return {
    txHash: u.tx_hash,
    outputIndex: u.output_index,
    assets,
    inlineDatumHex: typeof u.inline_datum === "string" ? u.inline_datum : null,
  };
}

/**
 * Hiện thực dùng dữ liệu ĐÃ GHI LẠI — để phép kiểm chạy được mà không cần mạng và
 * không cần khoá.
 *
 * Nó KHÔNG phải bản giả lập lỏng tay: `utxosAt` cho một địa chỉ không có trong bảng
 * trả `[]` (đúng ngữ nghĩa "không có gì ở đó"), còn `failWith` bật lên thì MỌI lời gọi
 * ném `ChainUnavailableError` — đó là cách bài kiểm dựng được ca thứ ba mà không phải
 * thật sự chặn mạng.
 */
export class RecordedChainReader implements ChainReader {
  readonly label = "recorded";
  constructor(
    private readonly utxosByAddress: Record<string, ChainUtxo[]>,
    private readonly recordedTip: ChainTip,
    private readonly failWith?: ChainUnavailableError,
  ) {}

  async utxosAt(address: string): Promise<ChainUtxo[]> {
    if (this.failWith) throw this.failWith;
    return this.utxosByAddress[address] ?? [];
  }

  async tip(): Promise<ChainTip> {
    if (this.failWith) throw this.failWith;
    return this.recordedTip;
  }
}
