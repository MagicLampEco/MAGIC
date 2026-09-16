// VaultTxAPI/tests/fixtures/tx.ts — dựng CBOR giao dịch THẬT, không cần mạng, không cần khoá.
//
// ── VÌ SAO DỰNG BẰNG CML CHỨ KHÔNG DÁN MỘT CHUỖI HEX ──────────────────────────
// Phép kiểm về `summary` phải chứng minh rằng con số đi RA được lấy TỪ byte đi VÀO. Một
// chuỗi hex dán sẵn chứng minh được điều đó đúng một lần, cho đúng một bộ số; sửa số là
// phải đi sinh lại chuỗi bằng tay ở đâu đó, và cái "đâu đó" ấy không nằm trong kho.
//
// Dựng tại chỗ bằng CML thì mỗi ca kiểm tự chọn số của nó, và ca ĐỘT BIẾN — hai giao dịch
// khác nhau ĐÚNG MỘT trường trong datum — trở thành ba dòng thay vì một chuyến đi vòng.
//
// Giao dịch dựng ra ở đây CHƯA KÝ và cố ý không hợp lệ để nộp lên chuỗi (không có
// redeemer, không có script data hash). Nó hợp lệ đúng ở mức phép kiểm cần: một
// `Transaction` giải mã lại được, có phí, có output mang datum inline.

import { CML, assetsToValue } from "@lucid-evolution/lucid";

export interface TxOutputSpec {
  address: string;
  /** `unit` → số lượng; `lovelace` là một unit như mọi unit khác. */
  assets: Record<string, bigint>;
  /** Datum inline dạng CBOR hex, hoặc bỏ trống cho output không datum. */
  inlineDatumHex?: string;
}

export interface TxSpec {
  inputs?: { txHash: string; outputIndex: number }[];
  outputs: TxOutputSpec[];
  feeLovelace: bigint;
}

/** CBOR hex của một giao dịch CHƯA KÝ (bộ chứng ký rỗng). */
export function buildTxCbor(spec: TxSpec): string {
  const inputs = CML.TransactionInputList.new();
  for (const i of spec.inputs ?? [{ txHash: "00".repeat(32), outputIndex: 0 }]) {
    inputs.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(i.txHash), BigInt(i.outputIndex)));
  }

  const outputs = CML.TransactionOutputList.new();
  for (const o of spec.outputs) {
    const datum = o.inlineDatumHex === undefined
      ? undefined
      : CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(o.inlineDatumHex));
    outputs.add(CML.TransactionOutput.new(
      CML.Address.from_bech32(o.address),
      assetsToValue(o.assets),
      datum,
    ));
  }

  const body = CML.TransactionBody.new(inputs, outputs, spec.feeLovelace);
  return CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true, undefined).to_cbor_hex();
}

/**
 * Bộ chứng ký mang MỘT chữ ký vkey giả.
 *
 * Byte ở đây là hằng, không sinh từ khoá nào — gói này không có đường tạo khoá và phép
 * kiểm cũng không được có. Cái đang kiểm là đường GHÉP chứng ký và phép đối chiếu hash
 * thân giao dịch, không phải phép kiểm chữ ký (việc đó của chuỗi).
 */
export function fakeWitnessSetCbor(): string {
  const vkeys = CML.VkeywitnessList.new();
  vkeys.add(CML.Vkeywitness.new(
    CML.PublicKey.from_bytes(new Uint8Array(32).fill(0xab)),
    CML.Ed25519Signature.from_raw_bytes(new Uint8Array(64).fill(0xcd)),
  ));
  const ws = CML.TransactionWitnessSet.new();
  ws.set_vkeywitnesses(vkeys);
  return ws.to_cbor_hex();
}

/** Bộ chứng ký RỖNG — ca mà `/tx/submit` phải từ chối ở 400, không đẩy lên chuỗi. */
export function emptyWitnessSetCbor(): string {
  return CML.TransactionWitnessSet.new().to_cbor_hex();
}
