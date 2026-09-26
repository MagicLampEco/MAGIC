// VaultTxAPI/src/chain.ts — cổng ra chuỗi. Một giao diện HẸP, hai hiện thực.
//
// ── BÍ MẬT ─────────────────────────────────────────────────────────────────────
// Hiện thực Blockfrost nhận GIÁ TRỊ khoá dự án qua tham số dựng. Nó không mở tệp nào
// để tìm khoá, không nhận đường dẫn tới kho khoá, và `label` mang HOST chứ không mang
// khoá hay URL đầy đủ. Không có khoá ký ở đây — dịch vụ này không ký gì.
//
// ── HỢP ĐỒNG NGHIÊM VỀ "RỖNG" ──────────────────────────────────────────────────
// `[]` chỉ được trả khi chuỗi THẬT SỰ trả lời rằng ở đó không có gì. Mọi kiểu
// không-đọc-được PHẢI ném `ChainUnavailableError`. Hiện thực nào trả `[]` khi hỏng là
// biến một lần gọi gãy thành "chủ này chưa có vault", rồi app hiện một màn hình mời
// người dùng tạo vault thứ hai.
//
// ── HAI ĐỒNG HỒ ────────────────────────────────────────────────────────────────
// `/blocks/latest` trả `time` theo GIÂY POSIX; epoch giao thức tính từ MILI-giây
// (`posixMsToEpoch` của ProtocolUtils, và nó KHÔNG trừ genesis nên epoch giao thức
// không bao giờ bằng epoch Cardano). Phép nhân 1000 nằm ở ĐÚNG MỘT dòng, có tên, và
// có một phép kiểm tỉnh táo ngay dưới nó.

import { applyDoubleCborEncoding, scriptFromNative, type Script, type UTxO } from "@lucid-evolution/lucid";

import { ChainUnavailableError, SubmitRejectedError } from "./errors.js";
import type { RewardAccountState } from "@magiclamp/protocol-utils";

export interface ChainTip {
  blockHeight: number;
  blockHash: string;
  /** POSIX **mili-giây**. Tên trường mang đơn vị vì đây là chỗ đơn vị hay lệch. */
  blockTimePosixMs: bigint;
}

export interface OutRef {
  txHash: string;
  outputIndex: number;
}

export interface ChainReader {
  /** Nhãn để ghi nhật ký / `/health`. KHÔNG mang khoá, KHÔNG mang URL đầy đủ. */
  readonly label: string;
  utxosAt(address: string): Promise<UTxO[]>;
  /** UTxO theo tham chiếu — dùng cho script tham chiếu CIP-33, nên hiện thực PHẢI
   *  điền `scriptRef`; thiếu nó thì `readFrom` của lucid không có gì để đọc và builder
   *  quay về `attach`, tức vượt trần 16 384 byte. */
  utxosByOutRef(refs: OutRef[]): Promise<UTxO[]>;
  tip(): Promise<ChainTip>;
  /** Nộp một giao dịch ĐÃ KÝ (CBOR hex). Trả tx hash của chuỗi. */
  submitTx(signedCborHex: string): Promise<string>;
  /** Tài khoản thưởng của một địa chỉ `stake…` — cho nhân chứng chủ script (`did_stake`):
   *  ledger đòi mục rút bằng ĐÚNG số dư, và từ chối mọi mục rút của tài khoản chưa đăng ký.
   *  Đọc không được thì NÉM; không bao giờ trả một trạng thái đoán. */
  rewardAccount(rewardAddress: string): Promise<RewardAccountState>;
}

/** Mốc tỉnh táo: 2020-01-01T00:00:00Z tính bằng giây. Nhỏ hơn mốc này gần như chắc chắn
 *  là đang đọc nhầm trường (slot, chiều cao khối, ms-đọc-thành-giây). */
const SANE_MIN_BLOCK_TIME_SECONDS = 1_577_836_800n;

export interface BlockfrostReaderOptions {
  /** Gốc API, ví dụ "https://cardano-preview.blockfrost.io/api/v0". */
  baseUrl: string;
  /** Khoá dự án — CHỈ nhận GIÁ TRỊ. */
  projectId: string;
  timeoutMs?: number;
}

export class BlockfrostChainReader implements ChainReader {
  readonly label: string;
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly timeoutMs: number;

  constructor(opts: BlockfrostReaderOptions) {
    if (!opts.projectId) {
      throw new Error("[chain] thiếu projectId — dịch vụ phải fail-closed, không chạy không khoá.");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.projectId = opts.projectId;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
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
          throw new ChainUnavailableError(
            `Nút chuỗi trả về nội dung không phải JSON (HTTP ${res.status}).`,
            { transport: "http", node_http_status: res.status, node: this.label },
          );
        }
      }
      return { status: res.status, body };
    } catch (e) {
      if (e instanceof ChainUnavailableError) throw e;
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

  /**
   * Blockfrost `/accounts/{stake_address}`:
   *   404            ⟹ tài khoản CHƯA TỪNG xuất hiện ⟹ chưa đăng ký (câu trả lời thật).
   *   200 `active`   ⟹ đang đăng ký; `withdrawable_amount` là số dư rút được (chuỗi lovelace).
   * Hình dạng khác ⟹ `CHAIN_UNAVAILABLE`, không đệm `0`: một số dư đệm sai là một giao dịch
   * ledger từ chối sau khi người dùng đã ký.
   */
  async rewardAccount(rewardAddress: string): Promise<RewardAccountState> {
    const { status, body } = await this.getJson(`/accounts/${encodeURIComponent(rewardAddress)}`);
    if (status === 404) return { registered: false, withdrawableLovelace: 0n };
    const b = body as { active?: unknown; withdrawable_amount?: unknown } | null;
    if (
      status !== 200 || b === null || typeof b !== "object" ||
      typeof b.active !== "boolean" ||
      typeof b.withdrawable_amount !== "string" || !/^\d+$/.test(b.withdrawable_amount)
    ) {
      throw new ChainUnavailableError(
        `Nút chuỗi trả HTTP ${status} / hình dạng lạ khi đọc tài khoản thưởng.`,
        { transport: "http", node_http_status: status, node: this.label },
      );
    }
    return { registered: b.active, withdrawableLovelace: BigInt(b.withdrawable_amount) };
  }

  async utxosAt(address: string): Promise<UTxO[]> {
    const out: UTxO[] = [];
    const pageSize = 100;
    for (let page = 1; ; page++) {
      const { status, body } = await this.getJson(`/addresses/${address}/utxos?page=${page}&count=${pageSize}`);
      if (status === 404) {
        // Blockfrost trả 404 cho địa chỉ CHƯA TỪNG xuất hiện trên chuỗi. Đó là một câu
        // trả lời thật. Đây là ca DUY NHẤT được phép biến một mã lỗi thành mảng rỗng.
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
      for (const raw of body) out.push(await this.toUtxo(raw, address));
      if (body.length < pageSize) return out;
    }
  }

  async utxosByOutRef(refs: OutRef[]): Promise<UTxO[]> {
    const out: UTxO[] = [];
    for (const ref of refs) {
      const { status, body } = await this.getJson(`/txs/${ref.txHash}/utxos`);
      if (status !== 200 || body === null || typeof body !== "object") {
        throw new ChainUnavailableError(
          `Nút chuỗi trả HTTP ${status} khi đọc giao dịch ${ref.txHash.slice(0, 12)}… của một UTxO tham chiếu.`,
          { transport: "http", node_http_status: status, node: this.label, out_ref: `${ref.txHash}#${ref.outputIndex}` },
        );
      }
      const outputs = (body as { outputs?: unknown }).outputs;
      if (!Array.isArray(outputs)) {
        throw new ChainUnavailableError(
          "Giao dịch trả về không có mảng `outputs`.",
          { transport: "http", node: this.label, out_ref: `${ref.txHash}#${ref.outputIndex}` },
        );
      }
      const hit = (outputs as { output_index?: unknown }[]).find(o => o.output_index === ref.outputIndex);
      if (hit === undefined) {
        // Đây KHÔNG phải "không có gì ở đó" — cấu hình đang trỏ vào một output không tồn
        // tại. Trả rỗng ở đây là để builder lặng lẽ rơi về `attach` rồi vượt trần 16 KB.
        throw new ChainUnavailableError(
          `Giao dịch ${ref.txHash.slice(0, 12)}… không có output #${ref.outputIndex} — ` +
          `cấu hình ref_script_utxos đang trỏ vào một chỗ không tồn tại.`,
          { transport: "http", node: this.label, out_ref: `${ref.txHash}#${ref.outputIndex}` },
        );
      }
      const address = (hit as { address?: unknown }).address;
      if (typeof address !== "string") {
        throw new ChainUnavailableError("Output của giao dịch thiếu `address`.", { transport: "http", node: this.label });
      }
      const utxo = await this.toUtxo({ ...hit, tx_hash: ref.txHash }, address);
      if (utxo.scriptRef === undefined || utxo.scriptRef === null) {
        throw new ChainUnavailableError(
          `UTxO ${ref.txHash.slice(0, 12)}…#${ref.outputIndex} KHÔNG mang script tham chiếu. ` +
          `Không có nó thì builder phải đính kèm validator vào tx, và cặp vault+shard đo thật ` +
          `trên Preview là 17 303 byte > trần 16 384 ⟹ không tx nào dựng nổi.`,
          { out_ref: `${ref.txHash}#${ref.outputIndex}`, node: this.label },
        );
      }
      out.push(utxo);
    }
    return out;
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
      throw new ChainUnavailableError(
        `Thời gian khối ${seconds} nhỏ hơn mốc tỉnh táo — nhiều khả năng đang đọc nhầm trường ` +
        `(slot hay chiều cao khối) thay vì GIÂY POSIX. Từ chối suy epoch từ nó.`,
        { transport: "http", node_block_time: String(seconds), node: this.label },
      );
    }
    return {
      blockHeight: typeof b.height === "number" ? b.height : -1,
      blockHash: b.hash,
      blockTimePosixMs: seconds * 1000n,   // GIÂY → MILI-GIÂY. Đúng một chỗ trong gói này.
    };
  }

  async submitTx(signedCborHex: string): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/tx/submit`, {
        method: "POST",
        headers: { project_id: this.projectId, "content-type": "application/cbor" },
        body: Buffer.from(signedCborHex, "hex"),
        signal: ac.signal,
      });
      const text = (await res.text()).trim();
      if (res.status !== 200) {
        // Câu của nút chuỗi là thứ NÓI ĐƯỢC người dùng phải làm gì ("giá trị đã bị tiêu",
        // "ngoài khoảng hiệu lực"). Thay nó bằng "có lỗi xảy ra" là vứt đúng phần dùng được.
        throw new SubmitRejectedError(
          `Nút chuỗi từ chối giao dịch (HTTP ${res.status}).`,
          { node_http_status: res.status, node_message: truncate(text, 800), node: this.label },
        );
      }
      // Thân bài 200 là tx hash, có nút bọc trong dấu nháy JSON.
      const hash = text.replace(/^"|"$/g, "");
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new SubmitRejectedError(
          "Nút chuỗi trả HTTP 200 nhưng thân bài không phải một tx hash 64 hex.",
          { node_message: truncate(text, 200), node: this.label },
        );
      }
      return hash;
    } catch (e) {
      if (e instanceof SubmitRejectedError) throw e;
      const kind = (e as { name?: string }).name === "AbortError" ? "timeout" : "transport";
      throw new ChainUnavailableError(
        `Không nối được tới nút chuỗi khi nộp giao dịch (${kind}).`,
        { transport: kind, node: this.label, timeout_ms: this.timeoutMs },
        e,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Một mục UTxO của Blockfrost → `UTxO` của lucid. Hình dạng lạ thì NÉM. */
  private async toUtxo(raw: unknown, address: string): Promise<UTxO> {
    const u = raw as {
      tx_hash?: unknown; output_index?: unknown; inline_datum?: unknown;
      data_hash?: unknown; amount?: unknown; reference_script_hash?: unknown;
    };
    if (typeof u.tx_hash !== "string" || typeof u.output_index !== "number") {
      throw new ChainUnavailableError(
        "Mục UTxO của nút chuỗi thiếu `tx_hash`/`output_index`.",
        { transport: "http", node: this.label },
      );
    }
    const assets: Record<string, bigint> = {};
    if (Array.isArray(u.amount)) {
      for (const a of u.amount as { unit?: unknown; quantity?: unknown }[]) {
        if (typeof a.unit !== "string" || typeof a.quantity !== "string") {
          throw new ChainUnavailableError(
            "Mục tài sản của nút chuỗi thiếu `unit`/`quantity`.",
            { transport: "http", node: this.label },
          );
        }
        assets[a.unit] = (assets[a.unit] ?? 0n) + BigInt(a.quantity);
      }
    }
    const utxo: UTxO = {
      txHash: u.tx_hash,
      outputIndex: u.output_index,
      address,
      assets,
      datumHash: typeof u.inline_datum === "string" ? undefined : (typeof u.data_hash === "string" ? u.data_hash : undefined),
      datum: typeof u.inline_datum === "string" ? u.inline_datum : undefined,
    };
    if (typeof u.reference_script_hash === "string") {
      utxo.scriptRef = await this.scriptByHash(u.reference_script_hash);
    }
    return utxo;
  }

  /** Script theo hash — lấy từ chuỗi, không từ một bản chép trong cấu hình. */
  private async scriptByHash(hash: string): Promise<Script> {
    const meta = await this.getJson(`/scripts/${hash}`);
    if (meta.status !== 200 || meta.body === null || typeof meta.body !== "object") {
      throw new ChainUnavailableError(
        `Nút chuỗi trả HTTP ${meta.status} khi đọc siêu dữ liệu của script ${hash.slice(0, 12)}….`,
        { transport: "http", node_http_status: meta.status, node: this.label },
      );
    }
    const type = (meta.body as { type?: unknown }).type;
    if (type === "timelock") {
      const j = await this.getJson(`/scripts/${hash}/json`);
      const native = (j.body as { json?: unknown } | null)?.json;
      if (j.status !== 200 || native === undefined) {
        throw new ChainUnavailableError(
          `Không đọc được script native ${hash.slice(0, 12)}….`,
          { transport: "http", node_http_status: j.status, node: this.label },
        );
      }
      return scriptFromNative(native as never);
    }
    const c = await this.getJson(`/scripts/${hash}/cbor`);
    const cbor = (c.body as { cbor?: unknown } | null)?.cbor;
    if (c.status !== 200 || typeof cbor !== "string") {
      throw new ChainUnavailableError(
        `Không đọc được CBOR của script ${hash.slice(0, 12)}….`,
        { transport: "http", node_http_status: c.status, node: this.label },
      );
    }
    const script = applyDoubleCborEncoding(cbor);
    switch (type) {
      case "plutusV1": return { type: "PlutusV1", script };
      case "plutusV2": return { type: "PlutusV2", script };
      case "plutusV3": return { type: "PlutusV3", script };
      default:
        throw new ChainUnavailableError(
          `Nút chuỗi khai script ${hash.slice(0, 12)}… thuộc loại "${String(type)}" — không nhận.`,
          { transport: "http", node: this.label },
        );
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Hiện thực dùng dữ liệu ĐÃ GHI LẠI — để phép kiểm chạy được mà không cần mạng và
 * không cần khoá.
 *
 * Không phải bản giả lập lỏng tay: địa chỉ không có trong bảng trả `[]` (đúng ngữ nghĩa
 * "không có gì ở đó"), còn `failWith` bật lên thì MỌI lời gọi ném — đó là cách phép kiểm
 * dựng được ca "chuỗi chết" mà không phải thật sự chặn mạng.
 */
export class RecordedChainReader implements ChainReader {
  readonly label = "recorded";
  submitted: string[] = [];

  constructor(
    private readonly utxosByAddress: Record<string, UTxO[]>,
    private readonly recordedTip: ChainTip,
    private readonly refUtxos: UTxO[] = [],
    private readonly failWith?: ChainUnavailableError,
    private readonly submitResult?: string,
  ) {}

  async utxosAt(address: string): Promise<UTxO[]> {
    if (this.failWith) throw this.failWith;
    return this.utxosByAddress[address] ?? [];
  }

  async utxosByOutRef(refs: OutRef[]): Promise<UTxO[]> {
    if (this.failWith) throw this.failWith;
    return refs.map(r => {
      const hit = this.refUtxos.find(u => u.txHash === r.txHash && u.outputIndex === r.outputIndex);
      if (hit === undefined) {
        throw new ChainUnavailableError(
          `Bản ghi không có UTxO ${r.txHash.slice(0, 12)}…#${r.outputIndex}.`,
          { out_ref: `${r.txHash}#${r.outputIndex}`, node: this.label },
        );
      }
      return hit;
    });
  }

  async tip(): Promise<ChainTip> {
    if (this.failWith) throw this.failWith;
    return this.recordedTip;
  }

  async submitTx(signedCborHex: string): Promise<string> {
    if (this.failWith) throw this.failWith;
    this.submitted.push(signedCborHex);
    if (this.submitResult === undefined) {
      throw new SubmitRejectedError("Bản ghi không khai kết quả nộp.", { node: this.label });
    }
    return this.submitResult;
  }

  /** Tài khoản thưởng ghi sẵn. Không khai ⟹ NÉM, không đoán "chưa đăng ký". */
  rewardAccounts: Record<string, RewardAccountState> = {};
  async rewardAccount(rewardAddress: string): Promise<RewardAccountState> {
    if (this.failWith) throw this.failWith;
    const hit = this.rewardAccounts[rewardAddress];
    if (hit === undefined) {
      throw new ChainUnavailableError(`Bản ghi không có tài khoản thưởng ${rewardAddress}.`, { node: this.label });
    }
    return hit;
  }
}
