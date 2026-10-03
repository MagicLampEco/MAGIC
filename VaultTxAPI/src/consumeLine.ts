// VaultTxAPI/src/consumeLine.ts — MỘT lượt tiêu của `/tx/consume`: một cặp (`Consume`, constr 0)
// hoặc nhiều cặp (`ConsumeMany`, constr 3), và phép ĐỌC LẠI giao dịch vừa dựng cho lượt đó.
//
// ══ HAI DẠNG YÊU CẦU, LOẠI TRỪ NHAU ════════════════════════════════════════════
//   { op_type, op_count }                 — dạng cũ, một loại nghiệp vụ
//   { pairs: [{ op_type, op_count }, …] } — nhiều loại nghiệp vụ trong MỘT giao dịch
// Gửi cả hai ⟹ 400 `CONSUME_PAIRS_CONFLICT`. Không đoán bên nào thắng: một app gửi cả hai là app
// đang hiểu sai hợp đồng, và chọn hộ nó một bên là để nó trả tiền cho thứ nó không định mua.
//
// ══ `pairs` ĐÚNG MỘT PHẦN TỬ ⟹ `Consume` ĐƠN (quyết 2026-10-03) ═════════════════
// Cùng một lượt tiêu, hai redeemer cho ĐÚNG cùng kế toán: `required` một cặp sàn một lần ở cả
// hai quy tắc, `consumed_count` tăng `op_count` ở cả hai. Khác ở chi phí: `Consume` không có
// danh sách để duyệt (`valid_pairs` + `required_for_pairs` + `sum_pair_counts`) và redeemer ngắn
// hơn — số đo ở `tests/consumeManyEmulator.test.ts`. Bên gọi không phải rẽ nhánh: bản tóm tắt
// luôn in `consume.pairs` dạng danh sách, và `consume.redeemer` nói dạng nào đã lên chuỗi.
//
// ══ MÃ LỖI ═════════════════════════════════════════════════════════════════════
// Luật hình dạng của `pairs` có MỘT nguồn: `assertValidPairs` (gương `pricing.valid_pairs`). Ở
// đây chỉ ánh xạ mã `PRICE-020..024` của nó sang mã API có tên — để một `pairs` sai ra 400, không
// ra 500 hay 422 `TX_BUILD_REJECTED` sau khi đã đọc chuỗi.

import { CML, valueToAssets } from "@lucid-evolution/lucid";
import { assertValidPairs, decodeConsumeLineRedeemer, decodeEngageDatum, type ConsumeLineRedeemerT } from "@magiclamp/sdk";
import { sameOwner } from "@magiclamp/protocol-utils";

import { engageOwnerOf, spendRedeemersOf, type EngageThread } from "./engage.js";
import { BadRequestError, CodedApiError } from "./errors.js";
import { refStr } from "./feePayer.js";
import { nanogicToMagic, raw } from "./units.js";

/** Một cặp (loại nghiệp vụ, số lượng) của yêu cầu. `opCount` BigInt — số lượng là đại lượng đếm. */
export interface ConsumePair {
  opType: number;
  opCount: bigint;
}

/** Lượt tiêu mà dịch vụ giao cho bộ dựng. */
export type ConsumeLine =
  | { kind: "single"; opType: number; opCount: bigint }
  | { kind: "many"; pairs: ReadonlyArray<ConsumePair> };

/** Mã `PRICE-02x` của `assertValidPairs` → mã API. Danh sách ĐÓNG: mã khác đi tiếp nguyên. */
export const PAIRS_ERROR_CODE_OF_PRICE: Readonly<Record<string, string>> = {
  "PRICE-020": "CONSUME_PAIRS_EMPTY",
  "PRICE-021": "CONSUME_PAIRS_TOO_MANY",
  "PRICE-022": "CONSUME_PAIR_COUNT_INVALID",
  "PRICE-023": "CONSUME_PAIRS_NOT_INCREASING",
  "PRICE-024": "CONSUME_PAIR_TYPE_INVALID",
};

/**
 * `assertValidPairs` với lỗi có mã API. Lỗi không mang tiền tố `PRICE-020..024` là lỗi lập trình
 * (ví dụ thư viện đổi câu) ⟹ ném NGUYÊN, để nó ra 500 có mã tham chiếu thay vì một 400 bịa mã.
 */
export function assertConsumePairs(pairs: ReadonlyArray<ConsumePair>): void {
  try {
    assertValidPairs(pairs);
  } catch (e) {
    const m = e instanceof Error ? /^(PRICE-02[0-4]):/.exec(e.message) : null;
    const code = m === null ? undefined : PAIRS_ERROR_CODE_OF_PRICE[m[1]!];
    if (code === undefined) throw e;
    throw new CodedApiError(400, code, `"pairs" không hợp lệ: ${(e as Error).message}`, { price_code: m![1] });
  }
}

/**
 * Yêu cầu → lượt tiêu. Kiểm ở tầng DỊCH VỤ (không chỉ ở bộ đọc HTTP), để lời gọi thẳng vào dịch
 * vụ và `/tx/quote` cũng bị kiểm.
 *   · `pairs` cùng `op_type`/`op_count` ⟹ 400 `CONSUME_PAIRS_CONFLICT`;
 *   · `pairs` sai luật ⟹ 400 theo `PAIRS_ERROR_CODE_OF_PRICE`;
 *   · `pairs` một phần tử ⟹ `single` (khối đầu tệp);
 *   · không có cả hai ⟹ 400.
 */
export function consumeLineOf(req: { opType?: number; opCount?: bigint; pairs?: ReadonlyArray<ConsumePair> }): ConsumeLine {
  if (req.pairs !== undefined) {
    if (req.opType !== undefined || req.opCount !== undefined) throw pairsConflict();
    assertConsumePairs(req.pairs);
    if (req.pairs.length === 1) return { kind: "single", opType: req.pairs[0]!.opType, opCount: req.pairs[0]!.opCount };
    return { kind: "many", pairs: req.pairs.map(p => ({ opType: p.opType, opCount: p.opCount })) };
  }
  if (req.opType === undefined || req.opCount === undefined) {
    throw new BadRequestError(`/tx/consume cần "op_type" + "op_count", hoặc "pairs".`);
  }
  return { kind: "single", opType: req.opType, opCount: req.opCount };
}

export function pairsConflict(): CodedApiError {
  return new CodedApiError(400, "CONSUME_PAIRS_CONFLICT",
    `"pairs" và "op_type"/"op_count" không đi cùng nhau: gửi MỘT trong hai dạng.`);
}

/** Lượt tiêu dạng danh sách — một cặp cũng là danh sách một phần tử. */
export function pairsOfLine(line: ConsumeLine): ConsumePair[] {
  return line.kind === "single" ? [{ opType: line.opType, opCount: line.opCount }] : [...line.pairs];
}

// ── đọc lại giao dịch vừa dựng ─────────────────────────────────────────────────

/** Phần `consume` của bản tóm tắt — đọc lại TỪ CBOR, không chép từ yêu cầu. */
export interface ConsumeSummary {
  /** Redeemer trên thread Engage, đọc từ CBOR. */
  redeemer: "Consume" | "ConsumeMany";
  /** Các cặp trong redeemer; `Consume` đơn ra danh sách một phần tử. */
  pairs: { op_type: number; op_count: string }[];
  /** `consumed_nanogic` của thread TĂNG bao nhiêu (= Σburns phía két, đã đối chiếu). */
  required_nanogic: string;
  required_magic: string;
  /** Thread bị tiêu (`<tx_hash>#<i>`). */
  engage_input_ref: string;
}

/**
 * Đọc lại tx tiêu vừa dựng, KHÔNG tin lời khai của bộ dựng:
 *   (1) thread đã chọn là input, và đúng MỘT redeemer Spend ở chỉ số của nó;
 *   (2) redeemer đó là `Consume`/`ConsumeMany` ĐÚNG dạng + ĐÚNG các cặp của lượt tiêu đã yêu cầu,
 *       `vault_ref` = két đang tiêu, `price_ref` nằm trong `reference_inputs`;
 *   (3) đúng MỘT output ở `engageAddress`, mang NFT thread, value BẰNG TUYỆT ĐỐI value đầu vào;
 *   (4) datum output: chủ giữ nguyên, `consumed_count` tăng đúng Σ op_count, `consumed_nanogic`
 *       tăng `required` > 0, và `required` == `burnedNanogic` — lượng két đốt, đọc từ datum két
 *       trong CÙNG CBOR (`summary.magic.burned_nanogic`). Hai trục là hai validator khác nhau;
 *       `consume.ak` đòi Σburns == required (DẤU BẰNG), nên lệch ở đây là tx chắc chắn bị từ chối.
 * Lệch ⟹ 422 `CONSUME_TX_MISMATCH`.
 */
export function checkConsumeTx(txCbor: string, ctx: {
  engageAddress: string;
  thread: EngageThread;
  vaultInputRef: { txHash: string; outputIndex: number };
  line: ConsumeLine;
  burnedNanogic: bigint;
}): ConsumeSummary {
  const fail = (m: string, d: Record<string, unknown> = {}) =>
    new CodedApiError(422, "CONSUME_TX_MISMATCH", `giao dịch tiêu MAGIC vừa dựng lệch: ${m}`, d);
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(txCbor);
  } catch (e) {
    throw fail(`CBOR không giải mã được: ${(e as Error).message}`);
  }
  const body = tx.body();
  const threadRef = refStr(ctx.thread.utxo);
  const inDatumHex = ctx.thread.utxo.datum;
  if (typeof inDatumHex !== "string" || inDatumHex === "") {
    throw new Error(`[bất biến nội bộ] thread ${threadRef} không mang datum inline.`);
  }
  const inDatum = decodeEngageDatum(inDatumHex);

  // (1) input + redeemer
  const ins = body.inputs();
  const inputs: string[] = [];
  for (let i = 0; i < ins.len(); i++) inputs.push(`${ins.get(i).transaction_id().to_hex()}#${ins.get(i).index()}`);
  if (!inputs.includes(threadRef)) throw fail(`thread ${threadRef} không phải input của giao dịch`, { inputs });
  const sorted = [...inputs].sort(compareRef);
  const threadIdx = sorted.indexOf(threadRef);
  const spends = spendRedeemersOf(tx).filter(s => s.index === threadIdx);
  if (spends.length !== 1) {
    throw fail(`thread cần đúng MỘT redeemer Spend, có ${spends.length}`, { input_index: threadIdx });
  }
  let rd: ConsumeLineRedeemerT;
  try {
    rd = decodeConsumeLineRedeemer(spends[0]!.data);
  } catch (e) {
    throw fail(`redeemer của thread không phải Consume/ConsumeMany: ${(e as Error).message.slice(0, 200)}`);
  }

  // (2) redeemer khớp lượt tiêu đã yêu cầu
  const wantKind = ctx.line.kind === "single" ? "single" : "many";
  const got: ConsumePair[] = rd.kind === "single"
    ? [{ opType: Number(rd.op_type), opCount: rd.op_count }]
    : rd.pairs.map(p => ({ opType: Number(p.op_type), opCount: p.op_count }));
  const want = pairsOfLine(ctx.line);
  const samePairs = got.length === want.length
    && got.every((p, i) => p.opType === want[i]!.opType && p.opCount === want[i]!.opCount);
  if (rd.kind !== wantKind || !samePairs) {
    throw fail(`redeemer của thread không mang đúng lượt tiêu đã yêu cầu`, {
      want: { kind: wantKind, pairs: want.map(pairView) }, got: { kind: rd.kind, pairs: got.map(pairView) },
    });
  }
  const vaultRef = `${rd.vault_ref.transaction_id}#${rd.vault_ref.output_index}`;
  if (vaultRef !== refStr(ctx.vaultInputRef)) {
    throw fail(`redeemer trỏ két ${vaultRef}, két đang tiêu là ${refStr(ctx.vaultInputRef)}`);
  }
  const priceRef = `${rd.price_ref.transaction_id}#${rd.price_ref.output_index}`;
  const refIns = body.reference_inputs();
  const refs: string[] = [];
  for (let i = 0; refIns !== undefined && i < refIns.len(); i++) {
    refs.push(`${refIns.get(i).transaction_id().to_hex()}#${refIns.get(i).index()}`);
  }
  if (!refs.includes(priceRef)) throw fail(`price_ref ${priceRef} không nằm trong reference_inputs`, { reference_inputs: refs });

  // (3) đúng một output ở địa chỉ engage, mang NFT, value bảo toàn tuyệt đối
  const ol = body.outputs();
  const atEngage: number[] = [];
  for (let i = 0; i < ol.len(); i++) {
    if (ol.get(i).address().to_bech32(undefined) === ctx.engageAddress) atEngage.push(i);
  }
  if (atEngage.length !== 1) throw fail(`có ${atEngage.length} output ở địa chỉ engage, phải đúng 1`, { outputs: atEngage });
  const idx = atEngage[0]!;
  const out = ol.get(idx);
  const a = valueToAssets(out.amount());
  const inA = ctx.thread.utxo.assets;
  if ((a[ctx.thread.nftUnit] ?? 0n) !== 1n) throw fail(`output ở địa chỉ engage không mang NFT thread`, { output_index: idx });
  const differs = [...new Set([...Object.keys(a), ...Object.keys(inA)])].filter(u => (a[u] ?? 0n) !== (inA[u] ?? 0n));
  if (differs.length > 0) throw fail(`value của output thread khác value của thread đầu vào`, { output_index: idx, units: differs });

  // (4) datum output
  const datumHex = out.datum()?.as_datum()?.to_cbor_hex();
  if (datumHex === undefined) throw fail(`output thread không mang datum inline`, { output_index: idx });
  let d: ReturnType<typeof decodeEngageDatum>;
  try {
    d = decodeEngageDatum(datumHex);
    if (!sameOwner(engageOwnerOf(d.owner), engageOwnerOf(inDatum.owner))) throw new Error("chủ thread đổi");
  } catch (e) {
    throw fail(`datum thread ra không đọc được / đổi chủ: ${(e as Error).message.slice(0, 200)}`);
  }
  const countDelta = d.consumed_count - inDatum.consumed_count;
  const wantCount = want.reduce((t, p) => t + p.opCount, 0n);
  if (countDelta !== wantCount) {
    throw fail(`consumed_count tăng ${countDelta}, lượt tiêu đòi ${wantCount}`);
  }
  const required = d.consumed_nanogic - inDatum.consumed_nanogic;
  if (required <= 0n || required !== ctx.burnedNanogic) {
    throw fail(`consumed_nanogic của thread tăng ${required}, két đốt ${ctx.burnedNanogic} — validator đòi Σburns == required`, {
      required_nanogic: required.toString(), burned_nanogic: ctx.burnedNanogic.toString(),
    });
  }

  return {
    redeemer: rd.kind === "single" ? "Consume" : "ConsumeMany",
    pairs: got.map(pairView),
    required_nanogic: raw(required),
    required_magic: nanogicToMagic(required),
    engage_input_ref: threadRef,
  };
}

function pairView(p: ConsumePair): { op_type: number; op_count: string } {
  return { op_type: p.opType, op_count: p.opCount.toString() };
}

/** Thứ tự input của ledger: `tx_hash` rồi chỉ số. */
function compareRef(a: string, b: string): number {
  const [ha, ia] = a.split("#");
  const [hb, ib] = b.split("#");
  return ha! < hb! ? -1 : ha! > hb! ? 1 : Number(ia) - Number(ib);
}
