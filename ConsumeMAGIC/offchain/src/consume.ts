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
// Builder KHÔNG tự dựng redeemer BurnBatch NI datum output của vault (constr index +
// schema khác nhau per vault: Instant=2/Snapshot=1/Vacuum=4/Schedule=2) → caller truyền
// CBOR hex sẵn (redeemer + datum output) để tránh coupling type cross-module. Builder
// chịu trách nhiệm phần Engage + GHÉP cả hai continuing output (vault + engage).
//
// VALIDITY RANGE: cửa sổ = TRỌN epoch hiện tại [epochStart, epochEnd-1] — PHẢI chứa
// `now` (ledger từ chối nếu now > validTo) NHƯNG vẫn ≤ 1 epoch cho cả hai validator:
//   vault.ak get_current_epoch: epoch = lower/mspe (đầu epoch → currentEpoch, ≤ now).
//   consume.ak util.get_epoch:  epoch = upper/mspe floor (cuối epoch → currentEpoch, ≥ now).
// (Bản cũ dùng [epochStart, epochStart+1ms] → validTo ở QUÁ KHỨ so với now giữa epoch →
//  ledger reject OutsideValidityInterval. Đã vá.)

import {
  Data, toUnit,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator, type Assets,
} from "@lucid-evolution/lucid";
import { msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import { Q } from "@magiclamp/consumemagic-pricing";
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
  /** Datum output tiếp-nối của vault, dạng CBOR hex (caller dựng theo schema vault đó).
   *  validate_burn_batch (vault.ak) BẮT BUỘC 1 vault output mang datum này (InstantGen
   *  A02: magic_batches sau burn+prune, consumed_credit += required, last_updated_epoch,
   *  attribution +1) + value preserved. THIẾU field này ⟹ vault reject. */
  vaultOutDatumCbor: string;
  /** Value output của vault — mặc định copy y nguyên vaultUtxo.assets (LAMP+ADA preserved;
   *  BurnBatch KHÔNG đụng LAMP, C-BURN-NO-LAMP). Chỉ override khi caller có lý do rõ. */
  vaultOutAssets?: Assets;
  /** Owner pkh (hex) — addSignerKey cho ràng buộc owner-sig của BurnBatch (vault.ak). */
  ownerSignerKeyHash?: string;
  /** Collateral UTxO thuần ADA (tránh CollateralContainsNonADA khi ví có UTxO token). */
  collateralUtxo?: UTxO;
  /** Engage NFT unit (policyId+nameHex) — bảo toàn trên output Engage. */
  engageNftUnit: string;
  /** Network (chọn ms_per_epoch cho validity-range — PHẢI khớp validator param). */
  network: Network;
  /** Tip POSIX ms hiện tại (đầu vào để tính epoch + validity-range). */
  tipPosixMs: bigint;
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

// ── required (giá CÓ THẨM QUYỀN, đọc TỪ beacon datum) ─────────────────────────

/**
 * required = ⌊ base_price × demand_mult × op_count / Q ⌋  (nanogic).
 *
 * FIX #3 (P8 fold-floor) + FIX #4 (price authority):
 *  - base_price đọc TỪ pp.op_prices (beacon datum) THEO op_type — KHÔNG hardcode bảng
 *    MVP. PostPrice đổi base_price ⇒ off-chain tự theo, không lệch on-chain.
 *  - FOLD-FLOOR-ONCE: base×demand×count rồi ÷Q một lần — KHỚP byte-perfect
 *    onchain pricing.required_for. Floor-before-multiply = under-charge ⇒ tx reject.
 *  - op_type vắng trong beacon ⇒ THROW (không im lặng fallback trên đường tiền).
 *
 * @throws CONSUME-007 nếu op_type không có trong pp.op_prices.
 */
export function requiredFromBeacon(
  pp: PriceParamT,
  opType: number,
  opCount: bigint,
): bigint {
  const row = pp.op_prices.find((p) => Number(p.op_type) === opType);
  if (row === undefined) {
    throw new Error(
      `CONSUME-007: op_type ${opType} không có trong beacon PriceParam.op_prices ` +
        `(giá có thẩm quyền phải đến từ beacon, không fallback MVP trên đường tiền)`,
    );
  }
  const count = opCount > 0n ? opCount : 0n;
  return (row.base_price * pp.demand_mult * count) / Q;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Dựng tx tiêu MAGIC. KHÔNG mint. Caller sign + submit (signAndSubmit).
 *
 * Bất biến builder bám validator (consume.ak):
 *  - required = ⌊base_price×demand_mult×op_count/Q⌋ (fold-floor-once, base_price ĐỌC
 *    TỪ beacon datum theo op_type — P8 khớp on-chain) — caller phải đảm bảo
 *    vaultBurnRedeemerCbor có Σburns == required.
 *  - Engage output: value bảo toàn TUYỆT ĐỐI (copy y nguyên engageUtxo.assets),
 *    consumed_count += op_count, last_epoch = currentEpoch, did_commit immutable.
 *  - validity-range cửa sổ ≤ 1 epoch; epoch ref = upper bound.
 */
export async function buildConsumeTx(params: ConsumeParams): Promise<ConsumeResult> {
  const {
    lucid, engageUtxo, vaultUtxo, priceBeaconUtxo,
    consumeScript, vaultScript, opType, opCount,
    vaultBurnRedeemerCbor, vaultOutDatumCbor, vaultOutAssets,
    ownerSignerKeyHash, collateralUtxo,
    engageNftUnit, network, tipPosixMs,
  } = params;

  if (opCount < 1n) throw new Error("CONSUME-001: op_count phải ≥ 1");

  // ── đọc PriceParam beacon (datum CBOR → struct) ─────────────────────────────
  if (!priceBeaconUtxo.datum) {
    throw new Error("CONSUME-002: beacon UTxO thiếu inline datum PriceParam");
  }
  const pp: PriceParamT = decodePriceParam(priceBeaconUtxo.datum);

  // ── required (giá có thẩm quyền từ beacon, fold-floor-once — P8) ─────────────
  const requiredNanogic = requiredFromBeacon(pp, opType, opCount);
  if (requiredNanogic <= 0n) {
    throw new Error(`CONSUME-003: required=${requiredNanogic} (op_count<1 hoặc base_price 0)`);
  }

  // ── epoch tham chiếu = từ UPPER bound (khớp util.get_epoch vá) ───────────────
  const mspe = msPerEpoch(network);
  const currentEpoch = tipPosixMs / mspe;
  // cửa sổ CHẶT: lower = đầu epoch hiện tại; upper = lower + 1ms (cùng epoch sau floor)
  const lowerMs = currentEpoch * mspe;              // đầu epoch → floor = currentEpoch, ≤ now
  const upperMs = (currentEpoch + 1n) * mspe - 1n;  // cuối epoch → floor = currentEpoch, ≥ now

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

  let txBuilder = lucid
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
    // Vault continuing output (datum A02 do caller dựng + value preserved) — BẮT BUỘC bởi
    // validate_burn_batch (vault.ak); thiếu ⟹ vault reject. LAMP+ADA giữ nguyên.
    .pay.ToAddressWithData(
      vaultUtxo.address,
      { kind: "inline", value: vaultOutDatumCbor },
      vaultOutAssets ?? { ...vaultUtxo.assets },
    )
    .validFrom(Number(lowerMs))
    .validTo(Number(upperMs));

  // BurnBatch đòi owner ký (vault.ak) — thêm signer key nếu caller cung cấp.
  if (ownerSignerKeyHash) txBuilder = txBuilder.addSignerKey(ownerSignerKeyHash);

  // Collateral thuần ADA (tránh CollateralContainsNonADA khi ví có UTxO token).
  const tx = collateralUtxo
    ? await txBuilder.complete({ presetWalletInputs: [collateralUtxo] })
    : await txBuilder.complete();

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
