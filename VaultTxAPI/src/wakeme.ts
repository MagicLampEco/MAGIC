// VaultTxAPI/src/wakeme.ts — két Wakeme ghim két InstantGen: `wakeme_vault_ref` của
// `/tx/instant-gen`, `/tx/refresh-checkpoint` và `/tx/consume` (Gen v2.0).
//
// ── VALIDATOR ĐỌC GÌ ────────────────────────────────────────────────────────────
// Két InstantGen v2.0 đọc `(owner_commit, L_lent)` từ ĐÚNG MỘT két Wakeme nằm trong REFERENCE
// INPUTS (apply-param #8 `wakeme_vault_hash`) ở hai chỗ: lượt làm mới checkpoint
// (`checkpoint.ak` ▸ `expected_checkpoint`) và nhánh sinh (`expected_checkpoint_for_gen`), cả
// hai qua Aiken `wakeme_lent.ak` ▸ `wakeme_read`. Gương TS là `@magiclamp/instantgen-sdk` ▸
// `explainWakemeVault` / `readWakemeVault` — tệp này gọi đúng hàm đó. 0 két ⟹ `L_lent = 0`,
// hợp lệ; ≥ 2 két ⟹ tx thất bại. Két đã nối link (`wakeme_link` khác "") mà lượt này làm mới
// checkpoint thì validator ĐÒI két (trừ RefreshCheckpoint, nơi thiếu két ⟹ gỡ link).
//
// ── NGUỒN CỦA KÉT: APP GỬI, HOẶC DỊCH VỤ TỰ ĐỊNH VỊ ──────────────────────────────
// App gửi `wakeme_vault_ref` ⟹ dùng đúng tham chiếu đó (ưu tiên). Vắng ⟹ nếu két IG đã nối
// link, dịch vụ tìm két bằng NFT định danh: két Wakeme của một DID mang đúng một NFT
// `(policy = wakeme_vault_hash, name = owner_commit)` (`wakeme_lent.ak` vế (b)), và
// `owner_commit` chính là `wakeme_link` của két IG. Tra theo ĐƠN VỊ TÀI SẢN (`ChainReader` ▸
// `utxosByUnit`) chứ không quét địa chỉ script: chi phí theo MỘT két, không theo số két của
// cả hệ. Chỉ giữ UTxO có payment credential = Script(wakeme_vault_hash) — validator LỌC
// reference input theo đúng điều đó (vế 1), nên NFT nằm ở chỗ khác không phải két.
//   0 két   ⟹ chạy như không có két (`L_lent = 0`), `summary.wakeme.reason =
//              "wakeme_vault_not_found"` — trừ khi validator đòi két (người gọi quyết, xem
//              `service.ts`);
//   ≥ 2 két ⟹ 409 `WAKEME_VAULT_AMBIGUOUS` (validator fail khi có hai két, và dịch vụ không
//              chọn hộ).
// Két IG chưa nối link (`wakeme_link` rỗng) thì không có `owner_commit` để tra ⟹ không định vị,
// `summary.wakeme.reason = "vault_not_linked"` (`L_lent = 0`). Nguồn + luật "khi nào bắt buộc":
// `service.ts` ▸ `wakemeSource`.
//
// ── KIỂM FAIL-CLOSED TRƯỚC KHI DỰNG ─────────────────────────────────────────────
//   mạng chưa có két Wakeme      ⟹ 501 `WAKEME_VAULT_UNAVAILABLE` (không đệm một hash giả)
//   UTxO không có / đã bị tiêu   ⟹ 404 `WAKEME_VAULT_NOT_FOUND` / 409 `WAKEME_VAULT_SPENT`
//   không nằm ở script két        ⟹ 409 `WAKEME_VAULT_SCRIPT_MISMATCH`
//   datum/NFT không đọc được      ⟹ 422 `WAKEME_VAULT_UNREADABLE`
// Các ca trên mà dựng tiếp thì validator từ chối cả tx (vế FAIL của `wakeme_read`).
//
// Ba ca validator CHO QUA với `L_lent = 0` thì KHÔNG từ chối — tx vẫn hợp lệ — nhưng phản hồi
// NÓI RA `counted: false` + `reason`, để app không hiện "đã tính LAMP cho mượn" cho một lượt
// mà chuỗi tính bằng 0 (thứ tự đúng thứ tự vế của validator):
//   `not_pinned_to_this_vault` — két chưa ghim vault này (kèm `seen_pin`). Từ 2026-10-02 đây
//        KHÔNG còn là lỗi: chủ két IG nối link trước, két Wakeme ghim sau (gỡ khoá lẫn nhau);
//   `pinned_in_current_period` — két đã ĐỔI ghim sang vault này trong chính kỳ đang sinh
//        (ghim từ genesis, chưa đổi lần nào, thì tính ngay — vế (d) ngoại lệ genesis);
//   `lamp_short_of_datum`      — value thiếu LAMP so với datum.

import { CML, Constr, Data, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import {
  explainWakemeVault, type WakemeNotCountedReason as ReadReason, type WakemeRead,
} from "@magiclamp/instantgen-sdk";
import {
  msPerEpoch, posixMsToEpoch, wakemeVaultHash, windowOriginMs, type Network,
} from "@magiclamp/protocol-utils";

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

/**
 * Lý do `counted: false`. Ba lý do đầu là nhánh validator trả `L_lent = 0` mà KHÔNG từ chối
 * tx (gương `explainWakemeVault`); lý do cuối là dịch vụ không tìm thấy két để đưa vào.
 */
export type WakemeNotCountedReason = ReadReason | "wakeme_vault_not_found" | "vault_not_linked";

/** Mục `summary.wakeme`. */
export interface WakemeSummary {
  /** Tham chiếu két đã đưa vào tx. Vắng khi `reason = "wakeme_vault_not_found"`. */
  ref?: string;
  /** `"located"` khi dịch vụ tự định vị két (app không gửi `wakeme_vault_ref`). */
  source?: "located";
  /** `L_lent` validator sẽ tính, oildrop, chuỗi chữ số. `"0"` khi `counted` là false. */
  lent_lamp: string;
  /** Két có được tính vào lượng sinh lượt này không. */
  counted: boolean;
  reason?: WakemeNotCountedReason;
  /** Chỉ khi `reason = "not_pinned_to_this_vault"`: ghim thấy được (`null` = chưa ghim). */
  seen_pin?: SeenPin;
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

/** Ghim `gen_vault` đọc từ datum[11], dạng người đọc được. */
type SeenPin = { hash: string; name: string } | null | "undecodable";

/**
 * Đọc + kiểm két Wakeme do app chỉ đích danh (hoặc dịch vụ vừa định vị). NÉM có mã ở mọi vế
 * validator sẽ từ chối; trả `counted: false` + `reason` ở ba vế validator cho qua với
 * `L_lent = 0`. `L_lent` và lý do lấy từ `explainWakemeVault` — CÙNG hàm bộ dựng SDK gọi
 * (`instant.ts` ▸ `readWakeme`, `MagicSDK` ▸ `readWakemeForVault`), nên con số ở đây trùng bit
 * với thứ đi vào trần `cap_nanogic` / `max_m` của lượt làm mới.
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
  const epoch = posixMsToEpoch(own.tipPosixMs, own.network);
  let explained: ReturnType<typeof explainWakemeVault>;
  try {
    explained = explainWakemeVault(utxo, {
      wakemeVaultHash: scriptHash, ownScriptHash: own.vaultScriptHash, ownVaultName: vaultName,
      currentPeriod: epoch, msPerEpoch: msPerEpoch(own.network), windowOriginMs: windowOriginMs(own.network),
      lampPolicyId: own.lampPolicyId, lampAssetName: own.lampAssetNameHex,
    });
  } catch (e) {
    // Script đã kiểm ở trên; vế còn lại của `explainWakemeVault` là hình dạng datum/NFT.
    throw new CodedApiError(422, "WAKEME_VAULT_UNREADABLE",
      `két Wakeme ${key.slice(0, 16)}… không đạt luật đọc L_lent: ${e instanceof Error ? e.message : String(e)}`,
      { wakeme_vault_ref: key });
  }

  const { read, reason } = explained;
  return {
    utxo,
    scriptHash,
    read,
    summary: {
      ref: key,
      lent_lamp: read.lent.toString(),
      counted: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      ...(reason === "not_pinned_to_this_vault" ? { seen_pin: seenPin(fields[11]!) } : {}),
    },
  };
}

/**
 * Định vị két Wakeme của `ownerCommit` (= `wakeme_link` của két IG) bằng NFT định danh.
 * `undefined` ⟹ không có két nào; ≥ 2 két ⟹ 409 `WAKEME_VAULT_AMBIGUOUS`. Chỉ ĐỊNH VỊ — đọc +
 * kiểm vẫn đi qua `resolveWakemeVault` với tham chiếu trả về.
 */
export async function locateWakemeVault(
  chain: ChainReader, ownerCommit: string, network: Network,
): Promise<OutRefLike | undefined> {
  if (!/^[0-9a-f]{64}$/.test(ownerCommit)) {
    throw new Error(`[bất biến nội bộ] wakeme_link "${ownerCommit}" không phải 32 byte hex.`);
  }
  const scriptHash = wakemeScriptHashOrThrow(network);
  const unit = scriptHash + ownerCommit;
  const hits = (await chain.utxosByUnit(unit)).filter(u => {
    const pc = getAddressDetails(u.address).paymentCredential;
    return pc?.type === "Script" && pc.hash === scriptHash;
  });
  if (hits.length === 0) return undefined;
  if (hits.length > 1) {
    throw new CodedApiError(409, "WAKEME_VAULT_AMBIGUOUS",
      `Có ${hits.length} UTxO ở script két Wakeme mang NFT ${ownerCommit.slice(0, 16)}… — validator từ ` +
        `chối khi có hai két; gửi "wakeme_vault_ref" để chỉ đích danh.`,
      { wakeme_link: ownerCommit, candidates: hits.map(refStr) });
  }
  return { txHash: hits[0]!.txHash, outputIndex: hits[0]!.outputIndex };
}

/** Mục `summary.wakeme` khi dịch vụ tìm mà không thấy két nào. */
export function wakemeNotFoundSummary(): WakemeSummary {
  return { lent_lamp: "0", counted: false, reason: "wakeme_vault_not_found" };
}

/** Mục `summary.wakeme` khi két IG chưa nối link (`wakeme_link` rỗng) và app không gửi tham
 *  chiếu: không có `owner_commit` để định vị ⟹ không két nào vào tx ⟹ `L_lent = 0`. */
export function wakemeNotLinkedSummary(): WakemeSummary {
  return { lent_lamp: "0", counted: false, reason: "vault_not_linked" };
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
  if (typeof f[2] !== "bigint" || typeof f[3] !== "bigint" || typeof f[7] !== "bigint" || typeof f[12] !== "bigint") {
    bad("trường 2/3/7/12 không phải số nguyên");
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
