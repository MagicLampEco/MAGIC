// src/consume.ts — ConsumeMAGIC v2 ENGAGEMENT tx-builder (CONTRACT §B3, §D).
//
// Dựng 1 tx CO-SPEND 2 validator để tiêu MAGIC dạng kế toán (KHÔNG mint, KHÔNG
// transfer MAGIC):
//   - Engage UTxO (consume.ak)  spend bằng Consume { op_type, op_count, price_ref,
//     vault_ref } → ghi state per-app (consumed_count += op_count, last_epoch).
//   - Vault UTxO (generator vault, module khác) spend bằng BurnBatch → GIẢM
//     current_amount (nơi DUY NHẤT giảm MAGIC). consume.ak ép Σburns == required.
//   - PriceParam beacon đọc dạng REFERENCE input (readFrom — KHÔNG tiêu).
//
// Builder KHÔNG tự dựng redeemer BurnBatch của vault (constr index khác nhau per
// vault: Instant=2/Snapshot=1/Vacuum=4/Schedule=2) → caller truyền CBOR hex sẵn để
// tránh coupling type cross-module. Builder chỉ chịu trách nhiệm phần Engage + ghép.
//
// VALIDITY RANGE: dựng cửa sổ CHẶT ≤ 1 epoch (lower = đầu epoch, upper = +1ms) khớp
// ràng buộc đã vá ở util.get_epoch (chống under-state epoch bằng validity-range).
// epoch tham chiếu on-chain lấy từ UPPER bound.

import {
  Data, toUnit,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator,
} from "@lucid-evolution/lucid";
import { msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import { pricePerOp, type BasePriceTable } from "@magiclamp/consumemagic-pricing";
import {
  ConsumeRedeemerSchema,
  encodeEngageDatum, decodeEngageDatum, decodePriceParam,
  type EngageDatumT, type PriceParamT, type ConsumeRedeemerT,
  type OutputReferenceT,
} from "./types.js";

// ── Params ────────────────────────────────────────────────────────────────────

export interface ConsumeParams {
  /** Lucid instance (Preview). */
  lucid: LucidEvolution;
  /** Engage UTxO (state per-app) — spent bằng Consume. */
  engageUtxo: UTxO;
  /** Vault UTxO (generator vault) — spent bằng BurnBatch (redeemer do caller dựng). */
  vaultUtxo: UTxO;
  /** PriceParam beacon UTxO — đọc REFERENCE (không tiêu). Phải mang price NFT. */
  priceBeaconUtxo: UTxO;
  /** Compiled consume validator (đã apply 8 param: price_nft_*, engage_nft_*,
   *  vault_script_hash, burn_batch_constr, max_price_stale, ms_per_epoch). */
  consumeScript: Validator;
  /** Compiled vault validator (module khác) — cần để spend vault input. */
  vaultScript: Validator;
  /** op_type (1=ảnh, 2=CID) — phải có trong PriceParam.op_prices. */
  opType: number;
  /** op_count ≥ 1. */
  opCount: bigint;
  /** Redeemer BurnBatch của vault, dạng CBOR hex (caller dựng theo type vault đó).
   *  consume.ak đọc redeemer này qua tx.redeemers; Σburns PHẢI == required. */
  vaultBurnRedeemerCbor: string;
  /** Engage NFT unit (policyId+nameHex) — bảo toàn trên output Engage. */
  engageNftUnit: string;
  /** Network (chọn ms_per_epoch cho validity-range — PHẢI khớp validator param). */
  network: Network;
  /** Tip POSIX ms hiện tại (đầu vào để tính epoch + validity-range). */
  tipPosixMs: bigint;
  /** TEST: override base-price table khi tính required (mặc định MVP). */
  basePriceTable?: BasePriceTable;
}

export interface ConsumeResult {
  tx: TxSignBuilder;
  /** required (nanogic) = price(op_type) × op_count — phải == Σburns vault. */
  requiredNanogic: bigint;
  /** epoch tham chiếu (từ upper bound) dùng để ghi last_epoch. */
  currentEpoch: bigint;
  /** EngageDatum mới (output). */
  newEngageDatum: EngageDatumT;
  summary: string;
}

// ── ref → OutputReferenceT (CBOR datum) ───────────────────────────────────────

function utxoToRef(u: UTxO): OutputReferenceT {
  return { transaction_id: u.txHash, output_index: BigInt(u.outputIndex) };
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Dựng tx tiêu MAGIC. KHÔNG mint. Caller sign + submit (signAndSubmit).
 *
 * Bất biến builder bám validator (consume.ak):
 *  - required = pricePerOp(op_type, demand_mult) × op_count  (đọc TỪ beacon, không
 *    tin client) — caller phải đảm bảo vaultBurnRedeemerCbor có Σburns == required.
 *  - Engage output: value bảo toàn TUYỆT ĐỐI (copy y nguyên engageUtxo.assets),
 *    consumed_count += op_count, last_epoch = currentEpoch, did_commit immutable.
 *  - validity-range cửa sổ ≤ 1 epoch; epoch ref = upper bound.
 */
export async function buildConsumeTx(params: ConsumeParams): Promise<ConsumeResult> {
  const {
    lucid, engageUtxo, vaultUtxo, priceBeaconUtxo,
    consumeScript, vaultScript, opType, opCount,
    vaultBurnRedeemerCbor, engageNftUnit, network, tipPosixMs, basePriceTable,
  } = params;

  if (opCount < 1n) throw new Error("CONSUME-001: op_count phải ≥ 1");

  // ── đọc PriceParam beacon (datum CBOR → struct) ─────────────────────────────
  if (!priceBeaconUtxo.datum) {
    throw new Error("CONSUME-002: beacon UTxO thiếu inline datum PriceParam");
  }
  const pp: PriceParamT = decodePriceParam(priceBeaconUtxo.datum);

  // ── required (giá có thẩm quyền từ beacon) ──────────────────────────────────
  const unit = pricePerOp(opType, pp.demand_mult, basePriceTable);
  const requiredNanogic = unit * opCount;
  if (requiredNanogic <= 0n) {
    throw new Error(`CONSUME-003: required=${requiredNanogic} (op_type ngoài bảng hoặc giá 0)`);
  }

  // ── epoch tham chiếu = từ UPPER bound (khớp util.get_epoch vá) ───────────────
  const mspe = msPerEpoch(network);
  const currentEpoch = tipPosixMs / mspe;
  // cửa sổ CHẶT: lower = đầu epoch hiện tại; upper = lower + 1ms (cùng epoch sau floor)
  const lowerMs = currentEpoch * mspe;
  const upperMs = lowerMs + 1n;

  // ── stale guard offchain (mirror C-CM-5; fail sớm trước khi submit) ──────────
  if (currentEpoch < pp.epoch) {
    throw new Error(`CONSUME-004: beacon epoch ${pp.epoch} > current ${currentEpoch} (tương lai)`);
  }

  // ── EngageDatum cũ → mới ────────────────────────────────────────────────────
  if (!engageUtxo.datum) throw new Error("CONSUME-005: engage UTxO thiếu inline datum");
  const oldDatum: EngageDatumT = decodeEngageDatum(engageUtxo.datum);
  const newEngageDatum: EngageDatumT = {
    owner: oldDatum.owner,
    consumed_count: oldDatum.consumed_count + opCount,
    last_epoch: currentEpoch,
    did_commit: oldDatum.did_commit, // IMMUTABLE
  };

  // ── Consume redeemer (Engage input) ─────────────────────────────────────────
  const consumeRedeemerVal: ConsumeRedeemerT = {
    op_type: BigInt(opType),
    op_count: opCount,
    price_ref: utxoToRef(priceBeaconUtxo),
    vault_ref: utxoToRef(vaultUtxo),
  };
  const consumeRedeemer = Data.to(
    consumeRedeemerVal,
    ConsumeRedeemerSchema as unknown as ConsumeRedeemerT,
  );

  // ── Engage output: VALUE BẢO TOÀN tuyệt đối (copy y nguyên assets input) ─────
  // (ép có engage NFT — defensive; engageUtxo.assets đã chứa nó nếu hợp lệ.)
  if ((engageUtxo.assets[engageNftUnit] ?? 0n) !== 1n) {
    throw new Error("CONSUME-006: engage UTxO không mang đúng 1 thread NFT");
  }
  const engageOutAssets = { ...engageUtxo.assets };

  const engageAddress = engageUtxo.address;

  const txBuilder = lucid
    .newTx()
    // Engage input (Consume) + vault input (BurnBatch CBOR caller cung cấp)
    .collectFrom([engageUtxo], consumeRedeemer)
    .collectFrom([vaultUtxo], vaultBurnRedeemerCbor)
    .attach.SpendingValidator(consumeScript)
    .attach.SpendingValidator(vaultScript)
    // PriceParam beacon = reference input (KHÔNG tiêu)
    .readFrom([priceBeaconUtxo])
    // Engage continuing output (value preserved, state +op_count)
    .pay.ToAddressWithData(
      engageAddress,
      { kind: "inline", value: encodeEngageDatum(newEngageDatum) },
      engageOutAssets,
    )
    .validFrom(Number(lowerMs))
    .validTo(Number(upperMs));

  const tx = await txBuilder.complete();

  const summary =
    `consume op_type=${opType} ×${opCount} | required=${requiredNanogic} ng | ` +
    `epoch=${currentEpoch} | consumed ${oldDatum.consumed_count}→${newEngageDatum.consumed_count}`;

  return { tx, requiredNanogic, currentEpoch, newEngageDatum, summary };
}

// ── Submit helper ─────────────────────────────────────────────────────────────

/** Sign (ví user) + submit. Trả tx hash. */
export async function signAndSubmit(tx: TxSignBuilder): Promise<string> {
  const signed = await tx.sign.withWallet().complete();
  return signed.submit();
}

export { toUnit };
