// VaultTxAPI/tests/fixtures/consume.ts — vế THREAD Engage của một tx tiêu MAGIC, ghép vào `TxSpec`.
//
// `/tx/consume` đọc lại MỌI tx tiêu từ CBOR (`consumeLine.ts` ▸ `checkConsumeTx`): thread là input,
// đúng một redeemer Spend `Consume`/`ConsumeMany` ở chỉ số của nó, `price_ref` trong reference input,
// một output ở địa chỉ engage bảo toàn value, datum thread tăng `consumed_count` + `consumed_nanogic`.
// Bản ghi CBOR cũ chỉ có vế KÉT, nên phép đọc lại đỏ ở mọi bài dương. Vá ở FIXTURE, không thu hẹp
// phép đọc lại: tóm tắt suy TỪ `tx_cbor` (README §2), và một đường không được đọc lại là đường mà
// bộ dựng nói gì cũng qua.
//
// Lượng két đốt (`required`) KHÔNG suy ở đây: bên gọi dựng datum két ra với `consumed_credit` tăng
// đúng con số đó, và truyền cùng con số vào `requiredNanogic`. Hai chỗ khai một số là cố ý — ca âm
// "lệch Σburns" chỉ cần đổi một trong hai.

import { Constr, Data, type UTxO } from "@lucid-evolution/lucid";
import { encodeConsumeManyRedeemer } from "@magiclamp/consumemagic";
import { decodeEngageDatum, encodeEngageDatum } from "@magiclamp/sdk";

import type { TxOutputSpec, TxSpec } from "./tx.js";

export interface OutRef { txHash: string; outputIndex: number }

/** Tham chiếu beacon giá mặc định — chỉ cần có mặt trong `reference_inputs`. */
export const PRICE_REF: OutRef = { txHash: "9e".repeat(32), outputIndex: 0 };

export interface ConsumeLegSpec {
  thread: UTxO;
  /** Két đang tiêu — redeemer trỏ `vault_ref` vào đây. */
  vaultRef: OutRef;
  pairs: { opType: number; opCount: bigint }[];
  /** `consumed_nanogic` của thread tăng bấy nhiêu (phải bằng lượng két đốt). */
  requiredNanogic: bigint;
  priceRef?: OutRef;
  /** Mặc định: một cặp ⟹ `Consume`, nhiều cặp ⟹ `ConsumeMany` (đúng quyết định của dịch vụ). */
  redeemer?: "Consume" | "ConsumeMany";
}

const refData = (r: OutRef) => ({ transaction_id: r.txHash, output_index: BigInt(r.outputIndex) });

/** CBOR redeemer của lượt tiêu. */
export function consumeRedeemerHex(leg: Pick<ConsumeLegSpec, "pairs" | "vaultRef" | "priceRef" | "redeemer">): string {
  const price = leg.priceRef ?? PRICE_REF;
  const kind = leg.redeemer ?? (leg.pairs.length === 1 ? "Consume" : "ConsumeMany");
  if (kind === "ConsumeMany") {
    return encodeConsumeManyRedeemer({
      pairs: leg.pairs.map(p => ({ op_type: BigInt(p.opType), op_count: p.opCount })),
      price_ref: refData(price), vault_ref: refData(leg.vaultRef),
    });
  }
  const p = leg.pairs[0]!;
  const ref = (r: OutRef) => new Constr(0, [r.txHash, BigInt(r.outputIndex)]);
  return Data.to(new Constr(0, [BigInt(p.opType), p.opCount, ref(price), ref(leg.vaultRef)]));
}

/** Datum thread SAU lượt tiêu: `consumed_count` + Σop_count, `consumed_nanogic` + required. */
export function threadDatumAfter(thread: UTxO, countDelta: bigint, nanogicDelta: bigint): string {
  const d = decodeEngageDatum(thread.datum!);
  return encodeEngageDatum({
    ...d, consumed_count: d.consumed_count + countDelta, consumed_nanogic: d.consumed_nanogic + nanogicDelta,
  } as Parameters<typeof encodeEngageDatum>[0]);
}

const cmpRef = (a: OutRef, b: OutRef) =>
  a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : a.outputIndex - b.outputIndex;

/**
 * Ghép vế thread vào một `TxSpec` có sẵn vế két. Redeemer Spend sẵn có (theo chỉ số ĐÃ SẮP) được
 * dời chỉ số theo input mới, để ghép không làm lệch redeemer của input khác.
 */
export function withConsumeLeg(spec: TxSpec, leg: ConsumeLegSpec): TxSpec {
  const oldInputs = spec.inputs ?? [{ txHash: "00".repeat(32), outputIndex: 0 }];
  const threadRef = { txHash: leg.thread.txHash, outputIndex: leg.thread.outputIndex };
  const inputs = [...oldInputs, threadRef];
  const oldSorted = [...oldInputs].sort(cmpRef);
  const newSorted = [...inputs].sort(cmpRef);
  const at = (r: OutRef) => newSorted.findIndex(x => cmpRef(x, r) === 0);
  const moved = (spec.spendRedeemers ?? []).map(r => ({ index: at(oldSorted[r.index]!), dataHex: r.dataHex }));
  const count = leg.pairs.reduce((t, p) => t + p.opCount, 0n);
  const threadOut: TxOutputSpec = {
    address: leg.thread.address,
    assets: { ...leg.thread.assets },
    inlineDatumHex: threadDatumAfter(leg.thread, count, leg.requiredNanogic),
  };
  return {
    ...spec,
    inputs,
    outputs: [...spec.outputs, threadOut],
    referenceInputs: [...(spec.referenceInputs ?? []), leg.priceRef ?? PRICE_REF],
    spendRedeemers: [...moved, { index: at(threadRef), dataHex: consumeRedeemerHex(leg) }],
  };
}
