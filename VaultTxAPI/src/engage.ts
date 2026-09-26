// VaultTxAPI/src/engage.ts — chọn thread Engage theo TỪNG chủ, lúc chạy.
//
// ── VÌ SAO KHÔNG CÒN MỘT NFT THREAD CỐ ĐỊNH TRONG CẤU HÌNH ──────────────────────
// `consume.ak` ép chủ thread == chủ vault (CONSUME-010). Một `engage_nft_unit` cố định ghim
// dịch vụ vào ĐÚNG MỘT thread ⟹ chỉ đúng một người tiêu được MAGIC qua dịch vụ, mọi người
// khác nhận một giao dịch chắc chắn bị chuỗi từ chối. Thread nay nhận diện bằng:
//
//   · nằm ở `engage_address` (địa chỉ script `consume`);
//   · mang ĐÚNG MỘT tài sản dưới policy = script hash `consume`, số lượng 1
//     (`ConsumeMAGIC/offchain/src/engageId.ts` ▸ `engageNftUnit`);
//   · datum inline giải được bằng `decodeEngageDatum` (nghiêm: sai số trường ⟹ ném);
//   · trường 0 (`owner`, Credential) == chủ yêu cầu — so CẢ tag lẫn hash (`sameOwner`).
//
// ── BỎ QUA vs NÉM ─────────────────────────────────────────────────────────────
// Tra theo chủ: UTxO không mang NFT hay datum hỏng thì BỎ QUA — địa chỉ script là nơi ai cũng
// gửi tới được, một UTxO rác không được chặn người khác tiêu. Nhưng khi người gọi CHỈ ĐÍCH
// DANH một UTxO (`engage_ref`) thì datum hỏng là câu trả lời về đúng thứ họ hỏi ⟹ 422, không
// lặng lẽ rơi về tra theo chủ.

import { CML, valueToAssets, type UTxO } from "@lucid-evolution/lucid";
import { decodeEngageDatum } from "@magiclamp/sdk";
import { sameOwner, type OwnerRef } from "@magiclamp/protocol-utils";

import type { ChainReader } from "./chain.js";
import { CodedApiError } from "./errors.js";
import { OUTREF, refStr, type OutRefLike } from "./feePayer.js";
import { vaultIdUnitOf } from "./vaultLookup.js";

export interface EngageThread {
  utxo: UTxO;
  /** policy (= script hash consume) + tên. */
  nftUnit: string;
  owner: OwnerRef;
}

/** `engage_ref` ở thân bài: tuỳ chọn, `"<tx_hash 64 hex>#<index>"`. Sai ⟹ 400 `ENGAGE_REF_SHAPE`. */
export function parseEngageRef(v: unknown): OutRefLike | undefined {
  if (v === undefined) return undefined;
  const m = typeof v === "string" ? OUTREF.exec(v) : null;
  if (m === null) {
    throw new CodedApiError(400, "ENGAGE_REF_SHAPE", `"engage_ref" phải là chuỗi "<tx_hash 64 hex>#<index>".`);
  }
  return { txHash: m[1]!, outputIndex: Number(m[2]!) };
}

/** Chủ trong datum Engage (`{VerificationKey:[h]} | {Script:[h]}`) → `OwnerRef`. Hình dạng lạ ⟹ ném. */
export function engageOwnerOf(o: unknown): OwnerRef {
  if (o !== null && typeof o === "object") {
    const r = o as Record<string, unknown>;
    const pick = (k: string) => (Array.isArray(r[k]) && (r[k] as unknown[]).length === 1 ? (r[k] as unknown[])[0] : undefined);
    const vk = pick("VerificationKey");
    const sc = pick("Script");
    if (typeof vk === "string" && sc === undefined) return { type: "key", hash: vk.toLowerCase() };
    if (typeof sc === "string" && vk === undefined) return { type: "script", hash: sc.toLowerCase() };
  }
  throw new Error("trường owner của datum Engage không phải Credential");
}

type Classified =
  | { kind: "thread"; thread: EngageThread }
  | { kind: "no_nft" }
  | { kind: "bad_datum"; nftUnit: string; reason: string };

function classify(u: UTxO, engageScriptHash: string): Classified {
  const nftUnit = vaultIdUnitOf(u, engageScriptHash);
  if (nftUnit === null) return { kind: "no_nft" };
  if (typeof u.datum !== "string" || u.datum === "") return { kind: "bad_datum", nftUnit, reason: "không có datum inline" };
  try {
    const d = decodeEngageDatum(u.datum);
    return { kind: "thread", thread: { utxo: u, nftUnit, owner: engageOwnerOf(d.owner) } };
  } catch (e) {
    return { kind: "bad_datum", nftUnit, reason: (e as Error).message.slice(0, 200) };
  }
}

/** Mọi thread hợp lệ của `owner` ở `engageAddress` (UTxO rác bị bỏ qua — xem khối đầu tệp). */
export function threadsOf(utxos: UTxO[], engageScriptHash: string, owner: OwnerRef): EngageThread[] {
  const out: EngageThread[] = [];
  for (const u of utxos) {
    const c = classify(u, engageScriptHash);
    if (c.kind === "thread" && sameOwner(c.thread.owner, owner)) out.push(c.thread);
  }
  return out;
}

/**
 * ĐÚNG MỘT thread của `owner` để làm input `consume`, hoặc ném có mã:
 *   0 ⟹ 404 `ENGAGE_THREAD_NOT_FOUND` (chỉ tới `POST /tx/open-thread`);
 *   >1 mà không có `engageRef` ⟹ 409 `ENGAGE_THREAD_AMBIGUOUS`;
 *   `engageRef` không ở `engageAddress` / không mang NFT dưới policy / khác chủ ⟹ 400 `ENGAGE_REF_MISMATCH`;
 *   `engageRef` mang NFT nhưng datum không giải được ⟹ 422 `ENGAGE_THREAD_DATUM_UNDECODABLE`.
 */
export async function pickEngageThread(
  chain: ChainReader, engageAddress: string, engageScriptHash: string, owner: OwnerRef, engageRef?: OutRefLike,
): Promise<EngageThread> {
  const utxos = await chain.utxosAt(engageAddress);
  const who = `${owner.type}:${owner.hash.slice(0, 12)}…`;

  if (engageRef !== undefined) {
    const key = refStr(engageRef);
    const u = utxos.find(x => x.txHash === engageRef.txHash && x.outputIndex === engageRef.outputIndex);
    if (u === undefined) {
      throw new CodedApiError(400, "ENGAGE_REF_MISMATCH",
        `"engage_ref" ${key.slice(0, 16)}… không phải một UTxO chưa tiêu ở địa chỉ engage.`, { engage_ref: key });
    }
    const c = classify(u, engageScriptHash);
    if (c.kind === "no_nft") {
      throw new CodedApiError(400, "ENGAGE_REF_MISMATCH",
        `"engage_ref" không mang đúng một NFT thread dưới policy consume ${engageScriptHash.slice(0, 12)}….`,
        { engage_ref: key, policy: engageScriptHash });
    }
    if (c.kind === "bad_datum") {
      throw new CodedApiError(422, "ENGAGE_THREAD_DATUM_UNDECODABLE",
        `datum của thread ${key.slice(0, 16)}… không giải được thành EngageDatum: ${c.reason}`,
        { engage_ref: key, nft_unit: c.nftUnit });
    }
    if (!sameOwner(c.thread.owner, owner)) {
      throw new CodedApiError(400, "ENGAGE_REF_MISMATCH",
        `"engage_ref" là thread của chủ khác (${c.thread.owner.type}:${c.thread.owner.hash.slice(0, 12)}…), không phải ${who}.`,
        { engage_ref: key });
    }
    return c.thread;
  }

  const mine = threadsOf(utxos, engageScriptHash, owner);
  if (mine.length === 0) {
    throw new CodedApiError(404, "ENGAGE_THREAD_NOT_FOUND",
      `Chủ ${who} chưa có thread Engage ở địa chỉ engage. Mở thread trước bằng POST /tx/open-thread, ` +
      `rồi gọi lại /tx/consume.`,
      { owner: { type: owner.type, hash: owner.hash }, engage_address: engageAddress });
  }
  if (mine.length > 1) {
    throw new CodedApiError(409, "ENGAGE_THREAD_AMBIGUOUS",
      `Chủ ${who} có ${mine.length} thread Engage; không chọn đại một cái. Gửi "engage_ref" để chỉ đích danh.`,
      { candidates: mine.map(t => refStr(t.utxo)) });
  }
  return mine[0]!;
}

// ── đọc lại CBOR của giao dịch mở thread ──────────────────────────────────────

export interface OpenThreadSummary {
  requested_intent: "open_thread";
  network: string;
  fee_lovelace: string;
  engage: {
    nft_unit: string;
    address: string;
    output_index: number;
    lovelace: string;
    owner: OwnerRef;
    consumed_count: string;
    last_epoch: string;
    consumed_nanogic: string;
    did_commit: string;
  };
  required_signers: string[];
}

/**
 * Đọc lại giao dịch mở thread vừa dựng, KHÔNG tin lời khai của bộ dựng:
 *   · đúng MỘT tài sản đúc dưới policy consume, số lượng +1, không đốt gì dưới policy đó,
 *     và đó đúng là NFT bộ dựng khai;
 *   · đúng MỘT output ở `engageAddress` mang NFT đó;
 *   · datum inline của output ấy giải được, trường 0 == chủ yêu cầu, các trường còn lại = khởi đầu
 *     (`consumed_count` 0, `last_epoch` 0, `did_commit` rỗng, `consumed_nanogic` 0).
 * Lệch ⟹ 422 `OPEN_THREAD_TX_MISMATCH`.
 */
export function checkOpenThreadTx(txCbor: string, ctx: {
  engageAddress: string; engageScriptHash: string; declaredUnit: string; owner: OwnerRef; network: string;
}): OpenThreadSummary {
  const fail = (m: string, d: Record<string, unknown> = {}) =>
    new CodedApiError(422, "OPEN_THREAD_TX_MISMATCH", `giao dịch mở thread vừa dựng lệch: ${m}`, d);
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(txCbor);
  } catch (e) {
    throw fail(`CBOR không giải mã được: ${(e as Error).message}`);
  }
  const body = tx.body();
  const pol = ctx.engageScriptHash;
  const under = (a: Record<string, bigint>) => Object.keys(a).filter(u => u !== "lovelace" && u.startsWith(pol));

  // (1) đúc
  const mint = body.mint();
  const minted = mint === undefined ? {} : valueToAssets(CML.Value.new(0n, mint.as_positive_multiasset()));
  const burned = mint === undefined ? {} : valueToAssets(CML.Value.new(0n, mint.as_negative_multiasset()));
  const mintedUnits = under(minted);
  if (mintedUnits.length !== 1 || minted[mintedUnits[0]!] !== 1n) {
    throw fail(`phải đúc ĐÚNG MỘT NFT dưới policy consume, số lượng 1`, { minted_under_policy: mintedUnits });
  }
  if (under(burned).length > 0) throw fail(`giao dịch đốt tài sản dưới policy consume`);
  const unit = mintedUnits[0]!;
  if (unit !== ctx.declaredUnit) {
    throw fail(`NFT đúc trong CBOR (${unit}) khác NFT bộ dựng khai (${ctx.declaredUnit})`);
  }

  // (2) output mang NFT
  const ol = body.outputs();
  const carriers: number[] = [];
  for (let i = 0; i < ol.len(); i++) {
    if ((valueToAssets(ol.get(i).amount())[unit] ?? 0n) !== 0n) carriers.push(i);
  }
  if (carriers.length !== 1) throw fail(`NFT thread nằm ở ${carriers.length} output, phải đúng 1`, { outputs: carriers });
  const idx = carriers[0]!;
  const out = ol.get(idx);
  const addr = out.address().to_bech32(undefined);
  if (addr !== ctx.engageAddress) throw fail(`output mang NFT thread không ở địa chỉ engage`, { output_index: idx });
  const a = valueToAssets(out.amount());
  if ((a[unit] ?? 0n) !== 1n) throw fail(`output thread mang ${a[unit]} NFT, phải đúng 1`);

  // (3) datum genesis
  const datumHex = out.datum()?.as_datum()?.to_cbor_hex();
  if (datumHex === undefined) throw fail(`output thread không mang datum inline`, { output_index: idx });
  let d: ReturnType<typeof decodeEngageDatum>;
  let owner: OwnerRef;
  try {
    d = decodeEngageDatum(datumHex);
    owner = engageOwnerOf(d.owner);
  } catch (e) {
    throw fail(`datum thread không giải được thành EngageDatum: ${(e as Error).message.slice(0, 200)}`);
  }
  if (!sameOwner(owner, ctx.owner)) {
    throw fail(`chủ trong datum thread (${owner.type}:${owner.hash}) khác chủ yêu cầu (${ctx.owner.type}:${ctx.owner.hash})`);
  }
  if (d.consumed_count !== 0n || d.last_epoch !== 0n || d.consumed_nanogic !== 0n || d.did_commit !== "") {
    throw fail(`datum thread không phải genesis sạch`, {
      consumed_count: d.consumed_count.toString(), last_epoch: d.last_epoch.toString(),
      consumed_nanogic: d.consumed_nanogic.toString(), did_commit: d.did_commit,
    });
  }

  const rs = body.required_signers();
  const signers: string[] = [];
  for (let i = 0; rs !== undefined && i < rs.len(); i++) signers.push(rs.get(i).to_hex());
  return {
    requested_intent: "open_thread",
    network: ctx.network,
    fee_lovelace: body.fee().toString(),
    engage: {
      nft_unit: unit, address: addr, output_index: idx, lovelace: (a.lovelace ?? 0n).toString(), owner,
      consumed_count: "0", last_epoch: "0", consumed_nanogic: "0", did_commit: "",
    },
    required_signers: signers,
  };
}
