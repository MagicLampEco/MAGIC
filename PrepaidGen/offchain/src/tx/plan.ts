// src/tx/plan.ts — kế hoạch giao dịch thuần dữ liệu + bước gắn vào TxBuilder.
//
// Mỗi nhánh PrepaidGen được dựng hai tầng:
//   1. `plan*` (thuần, không I/O): tính redeemer, datum đầu ra, value đầu ra, chữ
//      ký bắt buộc, kỳ — bằng đúng các hàm luật ở `../prepaid.ts`. Tầng API trả
//      được thẳng kế hoạch này cho ví mà không cần Lucid.
//   2. `applyPlan(tx, plan, ownerProof)`: gắn vào một `TxBuilder` có sẵn — là
//      "mảnh ghép", gộp được với mảnh của module khác (vd mint thread consume ở T1).

import type { Assets, TxBuilder, UTxO } from "@lucid-evolution/lucid";
import { applyOwnerAuth, resolveOwnerAuth, type OwnerAuth, type OwnerRef } from "../ownerAuth.js";
import type { ScriptHandle } from "./scripts.js";
import type { TxValidity } from "./window.js";

export interface SpendStep {
  utxo: UTxO;
  redeemerCbor: string;
  script: ScriptHandle;
}

export interface MintStep {
  script: ScriptHandle;
  assets: Assets;
  redeemerCbor: string;
}

export interface OutputStep {
  address: string;
  /** CBOR inline datum; `null` ⟹ output KHÔNG datum. */
  datumCbor: string | null;
  /**
   * Value đầu ra. `lovelace` có mặt = sàn tối thiểu (Lucid nâng lên min-ADA nếu
   * thiếu); vắng mặt = để Lucid tính min-ADA.
   */
  assets: Assets;
}

export interface TxPlan {
  /** UTxO thường (không script) phải tiêu — vd seed one-shot. */
  plainInputs: UTxO[];
  spends: SpendStep[];
  mints: MintStep[];
  outputs: OutputStep[];
  /** pkh bắt buộc ký, NGOÀI phần chứng minh quyền chủ. */
  signers: string[];
  /** Chủ phải chứng minh quyền (vault.owner); `null` ⟹ nhánh không cần chủ. */
  owner: OwnerRef | null;
  validity: TxValidity | null;
}

/**
 * Cách chứng minh quyền chủ cho mảnh này.
 *   · `attach`  — mảnh tự gắn: chủ khoá ⟹ `addSignerKey`; chủ script ⟹ `auth.attachWithdraw`
 *                 (bắt buộc truyền, bộ dựng không bịa nhân chứng stake-script).
 *   · `deferred` — người gọi gắn ĐÚNG MỘT LẦN cho cả giao dịch (T1: một mục rút
 *                 `did_stake` phủ cả cổng owner của két lẫn của thread). Mảnh trả lại
 *                 `owner` trong kế hoạch để người gọi biết phải chứng minh ai.
 */
export type OwnerProof =
  | { mode: "attach"; auth?: OwnerAuth<TxBuilder> }
  | { mode: "deferred" };

/** Gắn dấu vết dùng script: ref-script CIP-33 nếu có, không thì đính CBOR. */
function useScript(tx: TxBuilder, h: ScriptHandle, used: Set<string>): TxBuilder {
  if (used.has(h.hash)) return tx;
  used.add(h.hash);
  return h.refUtxo ? tx.readFrom([h.refUtxo]) : tx.attach.Script(h.script);
}

/** Gắn một kế hoạch vào `tx`. Chủ script mà không có `auth` ở chế độ `attach` ⟹ NÉM. */
export function applyPlan(tx: TxBuilder, plan: TxPlan, ownerProof: OwnerProof): TxBuilder {
  const used = new Set<string>();
  let t = tx;
  if (plan.plainInputs.length > 0) t = t.collectFrom(plan.plainInputs);
  for (const s of plan.spends) {
    t = t.collectFrom([s.utxo], s.redeemerCbor);
    t = useScript(t, s.script, used);
  }
  for (const m of plan.mints) {
    t = t.mintAssets(m.assets, m.redeemerCbor);
    t = useScript(t, m.script, used);
  }
  for (const o of plan.outputs) {
    t = o.datumCbor === null
      ? t.pay.ToAddress(o.address, o.assets)
      : t.pay.ToContract(o.address, { kind: "inline", value: o.datumCbor }, o.assets);
  }
  for (const pkh of plan.signers) t = t.addSignerKey(pkh);
  if (plan.validity !== null) {
    t = t.validFrom(Number(plan.validity.fromMs)).validTo(Number(plan.validity.toMs));
  }
  if (plan.owner !== null && ownerProof.mode === "attach") {
    t = applyOwnerAuth(t, resolveOwnerAuth(plan.owner, ownerProof.auth));
  }
  return t;
}
