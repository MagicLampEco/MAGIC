// scripts/farmers/src/engage.ts — thread Engage của nông dân: đọc kết quả bước đúc
// (`scripts/test/mint_engage_only.ts`) và tra outref SỐNG của thread trước mỗi lượt consume.
//
// `mint_engage_only.ts` KHÔNG in dòng RESULT. Thứ nó in mà máy đọc được:
//   `owner pkh:     <56 hex>` và `thread unit:   <unit>` (cả dry lẫn live, in TRƯỚC khi dựng);
//   `export ENGAGE_NFT_UNIT_<LOẠI>=<unit>` và `export ENGAGE_UTXO_<LOẠI>=<tx>#<i>` (chỉ live, sau
//   khi đọc lại được thread trên chuỗi).
// Thiếu một dòng cần có ⟹ `fail child-result-malformed`.
//
// Vì sao consume tra lại thread mỗi lượt chứ không dùng outref lúc đúc: mỗi tx consume
// tiêu-rồi-tạo-lại thread (`consume_only.ts` nói đúng câu đó khi ENGAGE_OUTREF đã chết).
// Tra: mọi UTxO tại địa chỉ ENTERPRISE của `consume` (policy thread = hash `consume`), giữ
// UTxO mang đúng 1 token dưới policy đó và có datum trường 0 = `VerificationKey(pkh nông dân)`
// (CBOR `d8799f581c<pkh>ff`). 0 ứng viên ⟹ thread chưa lên chuỗi; >1 ⟹ lỗi, không chọn hộ.

import { Data, type Network, type UTxO } from "@lucid-evolution/lucid";

import { scriptEnterpriseAddress } from "./chain.ts";
import { interpretChild, malformed, type ChildRun } from "./childResult.ts";
import { isKeyCredential } from "./owner.ts";
import type { GeneratorKind } from "./plan.ts";
import type { Mode, Outcome } from "./runner.ts";

export const ENGAGE_MINT_SCRIPT = "test/mint_engage_only.ts";
/** Dấu owner dạng Credential trong tệp đúc thread. Vắng ⟹ tệp con còn ghi owner ByteArray trần,
 *  và `pickEngageThread` sẽ không bao giờ nhận thread đó ⟹ không cho chạy. */
export const ENGAGE_MINT_CONTRACT_MARKER = "VerificationKey";
/** Dấu `consume_only.ts` nhận thread theo outref của chính ví ký. */
export const CONSUME_ENGAGE_MARKER = "ENGAGE_OUTREF";

const UNIT_RE = /^[0-9a-f]{56}[0-9a-f]{64}$/;

export function consumeAddressOf(network: Network, consumeHash: string): string {
  return scriptEnterpriseAddress(network, consumeHash);
}

/** Kết cục bước `engage_mint`: bộ đọc chung trước, rồi kiểm các dòng máy đọc + chủ thread. */
export function interpretEngageMint(run: ChildRun, mode: Mode, pkh: string, kind: GeneratorKind): Outcome {
  const base = interpretChild(run.status, `${run.stdout}\n${run.stderr}`, mode, run.timedOut);
  if (base.kind !== "built" && base.kind !== "confirmed") return base;
  const onChain = base.kind === "confirmed" ? ` (tx ${base.txHash} ĐÃ vào khối)` : "";
  const owner = /^owner pkh:\s+([0-9a-f]{56})\s*$/m.exec(run.stdout)?.[1];
  const unit = /^thread unit:\s+([0-9a-f]+)\s*$/m.exec(run.stdout)?.[1];
  if (owner === undefined) return malformed(`thiếu dòng "owner pkh:"${onChain}`);
  if (unit === undefined || !UNIT_RE.test(unit)) return malformed(`thiếu/sai dòng "thread unit:" (${unit ?? "vắng"})${onChain}`);
  if (owner !== pkh) return { kind: "error", reason: "child-owner-mismatch", detail: `thread đúc cho ${owner}, không phải nông dân ${pkh}${onChain}` };
  if (base.kind === "built") return { ...base, artifacts: { engage_nft: unit } };

  const K = kind.toUpperCase();
  const expUnit = new RegExp(`^export ENGAGE_NFT_UNIT_${K}=([0-9a-f]+)\\s*$`, "m").exec(run.stdout)?.[1];
  const expRef = new RegExp(`^export ENGAGE_UTXO_${K}=([0-9a-f]{64})#(0|[1-9][0-9]{0,5})\\s*$`, "m").exec(run.stdout);
  if (expUnit === undefined || expRef === null) return malformed(`thiếu dòng export ENGAGE_NFT_UNIT_${K}/ENGAGE_UTXO_${K}${onChain}`);
  if (expUnit !== unit) return malformed(`ENGAGE_NFT_UNIT_${K}=${expUnit} ≠ thread unit ${unit}${onChain}`);
  if (expRef[1] !== base.txHash) return malformed(`ENGAGE_UTXO_${K} ở tx ${expRef[1]}, không phải tx vừa gửi ${base.txHash}`);
  return { ...base, artifacts: { engage_nft: unit, engage_outref: `${expRef[1]}#${expRef[2]}` } };
}

/**
 * Chọn thread SỐNG của nông dân trong các UTxO tại địa chỉ `consume`. `knownUnit` (từ bước đúc)
 * có thì chỉ nhận đúng unit đó; unit đó có mặt mà chủ KHÁC ⟹ lỗi, không coi là "chưa có".
 */
export function pickEngageThread(
  utxos: readonly UTxO[],
  pkh: string,
  consumeHash: string,
  knownUnit: string | null,
): { ok: true; outRef: string; unit: string } | { ok: false; outcome: Outcome } {
  const hits: { u: UTxO; unit: string }[] = [];
  let undecodable = 0;
  let knownUnitOtherOwner: string | null = null;
  for (const u of utxos) {
    const units = Object.entries(u.assets).filter(([k]) => k !== "lovelace" && k.startsWith(consumeHash));
    if (units.length !== 1 || units[0]![1] !== 1n) continue;
    const unit = units[0]![0];
    if (knownUnit !== null && unit !== knownUnit) continue;
    let d: unknown;
    try {
      if (!u.datum) throw new Error("không có inline datum");
      d = Data.from(u.datum);
    } catch {
      undecodable++;
      continue;
    }
    const field0 = (d as { fields?: unknown[] }).fields?.[0];
    if (!isKeyCredential(field0, pkh)) {
      if (knownUnit !== null) knownUnitOtherOwner = `${u.txHash}#${u.outputIndex}`;
      continue;
    }
    hits.push({ u, unit });
  }
  if (knownUnitOtherOwner !== null && hits.length === 0) {
    return { ok: false, outcome: { kind: "error", reason: "engage-thread-owner-mismatch", detail: `thread ${knownUnit} ở ${knownUnitOtherOwner} không mang owner VerificationKey(${pkh})` } };
  }
  if (hits.length === 0) {
    const scope = knownUnit ? `thread ${knownUnit}` : `thread nào của VerificationKey(${pkh})`;
    return { ok: false, outcome: { kind: "prereq-missing", detail: `không thấy ${scope} tại địa chỉ consume ${consumeHash} (${utxos.length} UTxO, ${undecodable} datum không giải mã được)` } };
  }
  if (hits.length > 1) {
    const where = hits.map((h) => `${h.u.txHash}#${h.u.outputIndex}`).join(", ");
    return { ok: false, outcome: { kind: "error", reason: "engage-thread-ambiguous", detail: `${hits.length} thread của ${pkh}: ${where} — không chọn hộ` } };
  }
  const h = hits[0]!;
  return { ok: true, outRef: `${h.u.txHash}#${h.u.outputIndex}`, unit: h.unit };
}
