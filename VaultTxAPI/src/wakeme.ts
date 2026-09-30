// VaultTxAPI/src/wakeme.ts — két Wakeme ghim két InstantGen: `wakeme_vault_ref` của `/tx/instant-gen`.
//
// ── VALIDATOR ĐỌC GÌ ────────────────────────────────────────────────────────────
// Nhánh sinh của vault InstantGen cộng `L_lent` từ ĐÚNG MỘT két Wakeme nằm trong REFERENCE
// INPUTS (apply-param #8 `wakeme_vault_hash`, gương TS `@magiclamp/instantgen-sdk` ▸
// `readLentLamp` ↔ Aiken `wakeme_lent.ak` ▸ `lent_lamp`). 0 két ⟹ `L_lent = 0`, hợp lệ;
// ≥ 2 két ⟹ tx thất bại. Nên trường này TUỲ CHỌN, và vắng nó thì đường dựng y như cũ.
//
// ── VÌ SAO KHÔNG TỰ QUÉT ĐỊA CHỈ KÉT ────────────────────────────────────────────
// Không có chỉ mục "két nào ghim vault này": ghim nằm ở datum[11] của từng két, và mọi két
// của mọi người đứng chung một script. Quét trọn địa chỉ đó mỗi lượt dựng là chi phí tăng
// theo số két của CẢ HỆ, trả cho một câu hỏi của MỘT chủ — không mở rộng được. App biết két
// của chính người dùng (nó vừa ghim), nên nó gửi tham chiếu; dịch vụ kiểm chứ không đi tìm.
//
// ── KIỂM FAIL-CLOSED TRƯỚC KHI DỰNG ─────────────────────────────────────────────
//   mạng chưa có két Wakeme      ⟹ 501 `WAKEME_VAULT_UNAVAILABLE` (không đệm một hash giả)
//   UTxO không có / đã bị tiêu   ⟹ 404 `WAKEME_VAULT_NOT_FOUND` / 409 `WAKEME_VAULT_SPENT`
//   không nằm ở script két        ⟹ 409 `WAKEME_VAULT_SCRIPT_MISMATCH`
//   datum/NFT không đọc được      ⟹ 422 `WAKEME_VAULT_UNREADABLE`
//   ghim vault khác / không ghim  ⟹ 409 `WAKEME_VAULT_PIN_MISMATCH` (kèm ghim thấy được)
// Ba ca trên mà dựng tiếp thì validator từ chối cả tx (vế FAIL của `lent_lamp`).
//
// Hai ca validator CHO QUA với `L_lent = 0` — ghim trong chính kỳ đang sinh
// (`gen_pin_period >= epoch`), hoặc value thiếu LAMP so với datum — thì KHÔNG từ chối: tx
// vẫn hợp lệ. Nhưng phản hồi NÓI RA `counted: false` + `reason`, để app không hiện "đã tính
// LAMP cho mượn" cho một lượt mà chuỗi tính bằng 0.

import { CML, Constr, Data, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import { readWakemeVault, type WakemeRead } from "@magiclamp/instantgen-sdk";
import { posixMsToEpoch, wakemeVaultHash, type Network } from "@magiclamp/protocol-utils";

import type { ChainReader } from "./chain.js";
import { CodedApiError, TxApiError } from "./errors.js";
import { OUTREF, inputRefsOf, refStr, type OutRefLike } from "./feePayer.js";

/** `wakeme_vault_ref` ở thân bài: tuỳ chọn, `"<tx_hash 64 hex>#<index>"`. Sai ⟹ 400 `WAKEME_VAULT_REF_SHAPE`. */
export function parseWakemeVaultRef(v: unknown): OutRefLike | undefined {
  if (v === undefined) return undefined;
  const m = typeof v === "string" ? OUTREF.exec(v) : null;
  if (m === null) {
    throw new CodedApiError(400, "WAKEME_VAULT_REF_SHAPE",
      `"wakeme_vault_ref" phải là chuỗi "<tx_hash 64 hex>#<index>".`);
  }
  return { txHash: m[1]!, outputIndex: Number(m[2]) };
}

/** Script hash két Wakeme của mạng. Mạng chưa có két ⟹ 501, không trả giá trị đệm. */
export function wakemeScriptHashOrThrow(network: Network): string {
  try {
    return wakemeVaultHash(network);
  } catch (e) {
    throw new CodedApiError(501, "WAKEME_VAULT_UNAVAILABLE",
      `"wakeme_vault_ref" không dùng được trên ${network}: kho chưa có script hash két Wakeme cho mạng này.`,
      { network, cause: e instanceof Error ? e.message : String(e) });
  }
}

/** Lý do `counted: false`. Cả hai là nhánh validator trả `L_lent = 0` mà KHÔNG từ chối tx. */
export type WakemeNotCountedReason = "pinned_in_current_period" | "lamp_short_of_datum";

/** Mục `summary.wakeme` — chỉ có khi yêu cầu kèm `wakeme_vault_ref`. */
export interface WakemeSummary {
  ref: string;
  /** `L_lent` validator sẽ tính, oildrop, chuỗi chữ số. `"0"` khi `counted` là false. */
  lent_lamp: string;
  /** Két có được tính vào lượng sinh lượt này không (ghim đã qua kỳ, value đỡ được datum). */
  counted: boolean;
  reason?: WakemeNotCountedReason;
}

export interface ResolvedWakeme {
  utxo: UTxO;
  scriptHash: string;
  summary: WakemeSummary;
  /** `(owner_commit, L_lent)` — CÙNG phép đọc mà `instantGenLimits` / bộ dựng dùng (Gen v2.0). */
  read: WakemeRead;
}

export interface WakemeOwnVault {
  /** UTxO vault InstantGen đang bị tiêu (mang NFT vault-id). */
  vaultUtxo: UTxO;
  /** Script hash vault = policy NFT vault-id (INV-VAULT-IDENTITY). */
  vaultScriptHash: string;
  network: Network;
  /** Đỉnh chuỗi mà bộ dựng dùng — CÙNG giá trị, nên cùng epoch với `buildInstantGenTx`. */
  tipPosixMs: bigint;
  lampPolicyId: string;
  lampAssetNameHex: string;
}

/** Ghim `gen_vault` đọc từ datum[11], dạng người đọc được — để câu 409 nói ra ghim THẤY. */
type SeenPin = { hash: string; name: string } | null | "undecodable";

/**
 * Đọc + kiểm két Wakeme do app chỉ đích danh. NÉM có mã ở mọi vế validator sẽ từ chối;
 * trả `counted: false` + `reason` ở hai vế validator cho qua với `L_lent = 0`.
 * `L_lent` lấy từ `readLentLamp` — CÙNG hàm bộ dựng gọi, nên con số ở đây trùng bit với
 * thứ đi vào `claimed_amount`.
 */
export async function resolveWakemeVault(
  chain: ChainReader, ref: OutRefLike, own: WakemeOwnVault,
): Promise<ResolvedWakeme> {
  const key = refStr(ref);
  const scriptHash = wakemeScriptHashOrThrow(own.network);
  const utxo = await readRef(chain, ref, key);

  const pc = getAddressDetails(utxo.address).paymentCredential;
  if (pc?.type !== "Script" || pc.hash !== scriptHash) {
    throw new CodedApiError(409, "WAKEME_VAULT_SCRIPT_MISMATCH",
      `"wakeme_vault_ref" ${key.slice(0, 16)}… không nằm ở script két Wakeme ${scriptHash.slice(0, 12)}….`,
      { wakeme_vault_ref: key, expected_script_hash: scriptHash,
        seen_payment_credential: pc === undefined ? null : { type: pc.type, hash: pc.hash } });
  }

  const fields = datumFields(utxo, key);
  const vaultName = singleVaultIdName(own.vaultUtxo, own.vaultScriptHash);
  const expectedPin = new Constr(0, [new Constr(0, [own.vaultScriptHash, vaultName])]);
  if (Data.to(fields[11]!) !== Data.to(expectedPin)) {
    throw new CodedApiError(409, "WAKEME_VAULT_PIN_MISMATCH",
      `két Wakeme ${key.slice(0, 16)}… không ghim vault này.`,
      { wakeme_vault_ref: key,
        expected_pin: { hash: own.vaultScriptHash, name: vaultName },
        seen_pin: seenPin(fields[11]!) });
  }

  const epoch = posixMsToEpoch(own.tipPosixMs, own.network);
  let read: WakemeRead;
  try {
    read = readWakemeVault(utxo, {
      wakemeVaultHash: scriptHash, ownScriptHash: own.vaultScriptHash, ownVaultName: vaultName,
      currentPeriod: epoch, lampPolicyId: own.lampPolicyId, lampAssetName: own.lampAssetNameHex,
    });
  } catch (e) {
    // Script và ghim đã kiểm ở trên; vế còn lại của `readLentLamp` là hình dạng datum/NFT.
    throw new CodedApiError(422, "WAKEME_VAULT_UNREADABLE",
      `két Wakeme ${key.slice(0, 16)}… không đạt luật đọc L_lent: ${e instanceof Error ? e.message : String(e)}`,
      { wakeme_vault_ref: key });
  }

  const lent = read.lent;
  // Suy LÝ DO từ cùng các trường `readWakemeVault` đọc, rồi đối chiếu với con số của nó: hai
  // đường lệch nhau là lỗi của gói này, không phải của két — NÉM, không chọn một bên.
  const conditional = fields[3] as bigint;
  const owned = fields[7] as bigint;
  const pinPeriod = fields[12] as bigint;
  const held = utxo.assets[own.lampPolicyId + own.lampAssetNameHex] ?? 0n;
  const reason: WakemeNotCountedReason | undefined =
    pinPeriod >= epoch ? "pinned_in_current_period"
    : held < conditional + owned ? "lamp_short_of_datum"
    : undefined;
  const expected = reason === undefined ? conditional + owned : 0n;
  if (expected !== lent) {
    throw new Error(
      `[bất biến nội bộ] L_lent của readLentLamp (${lent}) lệch phép suy lý do (${expected}) ở két ${key}.`);
  }

  return {
    utxo,
    scriptHash,
    read,
    summary: {
      ref: key,
      lent_lamp: lent.toString(),
      counted: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

/**
 * Đọc lại `tx_cbor` vừa dựng: két PHẢI nằm trong `reference_inputs` và KHÔNG nằm trong
 * `inputs` (tiêu két là việc của validator két, không phải của lượt sinh). Lệch ⟹ 422.
 */
export function checkWakemeRefInTx(txCbor: string, ref: OutRefLike): void {
  const key = refStr(ref);
  const same = (r: OutRefLike) => r.txHash === ref.txHash && r.outputIndex === ref.outputIndex;
  if (inputRefsOf(txCbor).some(same)) {
    throw new CodedApiError(422, "WAKEME_VAULT_TX_MISMATCH",
      `giao dịch vừa dựng TIÊU két Wakeme ${key.slice(0, 16)}… thay vì đọc nó làm reference input.`,
      { wakeme_vault_ref: key });
  }
  if (!referenceInputRefsOf(txCbor).some(same)) {
    throw new CodedApiError(422, "WAKEME_VAULT_TX_MISMATCH",
      `giao dịch vừa dựng không có két Wakeme ${key.slice(0, 16)}… trong reference_inputs.`,
      { wakeme_vault_ref: key });
  }
}

/** `reference_inputs` của thân giao dịch. Vắng trường ⟹ danh sách rỗng (đúng nghĩa CBOR). */
export function referenceInputRefsOf(txCbor: string): OutRefLike[] {
  const ins = CML.Transaction.from_cbor_hex(txCbor).body().reference_inputs();
  const out: OutRefLike[] = [];
  if (ins === undefined) return out;
  for (let i = 0; i < ins.len(); i++) {
    out.push({ txHash: ins.get(i).transaction_id().to_hex(), outputIndex: Number(ins.get(i).index()) });
  }
  return out;
}

async function readRef(chain: ChainReader, ref: OutRefLike, key: string): Promise<UTxO> {
  try {
    const [u] = await chain.utxosByOutRef([ref]);
    if (u === undefined) throw new Error(`[bất biến nội bộ] utxosByOutRef trả rỗng cho ${key}.`);
    return u;
  } catch (e) {
    // Hai mã của bộ đọc chuỗi nói về đúng UTxO này — đổi sang mã nêu TÊN trường, để app biết
    // tham chiếu nào sai. Mọi lỗi khác (nút chuỗi chết…) đi nguyên.
    if (e instanceof TxApiError && e.code === "UTXO_NOT_FOUND") {
      throw new CodedApiError(404, "WAKEME_VAULT_NOT_FOUND",
        `"wakeme_vault_ref" ${key.slice(0, 16)}… không có trên chuỗi.`, { ...e.details, wakeme_vault_ref: key });
    }
    if (e instanceof TxApiError && e.code === "UTXO_SPENT") {
      throw new CodedApiError(409, "WAKEME_VAULT_SPENT",
        `"wakeme_vault_ref" ${key.slice(0, 16)}… đã bị tiêu — két đã chuyển sang UTxO khác.`,
        { ...e.details, wakeme_vault_ref: key });
    }
    throw e;
  }
}

/** Datum inline Constr 0 ≥ 13 trường, và các trường số/bytes mà luật đọc dùng đúng kiểu. */
function datumFields(utxo: UTxO, key: string): Data[] {
  const bad = (why: string): never => {
    throw new CodedApiError(422, "WAKEME_VAULT_UNREADABLE",
      `datum két Wakeme ${key.slice(0, 16)}… không đọc được: ${why}.`, { wakeme_vault_ref: key });
  };
  if (typeof utxo.datum !== "string" || utxo.datum === "" || utxo.datumHash) bad("không phải datum inline");
  let d: Data;
  try { d = Data.from(utxo.datum!); } catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
  if (!(d instanceof Constr) || d.index !== 0 || d.fields.length < 13) bad("không phải Constr 0 ≥ 13 trường");
  const f = (d as Constr<Data>).fields;
  if (typeof f[3] !== "bigint" || typeof f[7] !== "bigint" || typeof f[12] !== "bigint") {
    bad("trường 3/7/12 không phải số nguyên");
  }
  return f;
}

function seenPin(v: Data): SeenPin {
  if (v instanceof Constr && v.index === 1 && v.fields.length === 0) return null;
  if (v instanceof Constr && v.index === 0 && v.fields.length === 1) {
    const p = v.fields[0];
    if (p instanceof Constr && p.index === 0 && p.fields.length === 2 &&
        typeof p.fields[0] === "string" && typeof p.fields[1] === "string") {
      return { hash: p.fields[0], name: p.fields[1] };
    }
  }
  return "undecodable";
}

/** Tên NFT vault-id DUY NHẤT dưới policy = script hash vault. Không đúng một ⟹ NÉM (lỗi dựng). */
function singleVaultIdName(vaultUtxo: UTxO, vaultScriptHash: string): string {
  const ids = Object.entries(vaultUtxo.assets).filter(([u]) => u !== "lovelace" && u.slice(0, 56) === vaultScriptHash);
  if (ids.length !== 1 || ids[0]![1] !== 1n) {
    throw new Error(`[bất biến nội bộ] vault ${refStr(vaultUtxo)} không mang đúng một NFT vault-id dưới ${vaultScriptHash}.`);
  }
  return ids[0]![0].slice(56);
}
