// src/postPrice.ts — Nợ #7: dựng tx PostPrice cho beacon PriceParam.
//
// VÌ SAO PHẢI CÓ RIÊNG MỘT ĐƯỜNG NÀY. Beacon giá hết hạn sau `max_price_stale`
// epoch; hết hạn thì MỌI tx consume bị từ chối. Trước file này, đường phục hồi
// duy nhất là chạy lại bước deploy 09 — mà 09 đúc price NFT **one-shot mới** ⟹
// `price_nft_policy` đổi ⟹ script hash `consume` đổi ⟹ ĐỊA CHỈ đổi ⟹ mọi Engage
// UTxO đang sống thành mồ côi và toàn bộ kế toán tiêu dùng về 0. Nghĩa là hạ tầng
// dùng-một-lần. `buildPostPriceTx` spend beacon tại chỗ, giữ nguyên NFT, nên
// `consume` không đổi hash và thread Engage sống tiếp.
//
// Bám `onchain/validators/price_param.ak` — mỗi `expect` bên đó có đúng một cổng
// bên này, kèm mã lỗi, để lỗi lộ ra ở máy người dựng tx chứ không lộ ra dưới dạng
// một tx bị ledger từ chối với thông báo không đọc được.
//
// P8: `assertValidPriceParam` (gói pricing) là bản song sinh của `pricing.valid_param`.
// KHÔNG viết lại luật hợp lệ ở đây — gọi lại đúng hàm đó.

import {
  Data,
  validatorToScriptHash,
  type LucidEvolution,
  type UTxO,
  type TxSignBuilder,
  type Validator,
  type Assets,
} from "@lucid-evolution/lucid";
import { msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import { assertValidPriceParam } from "@magiclamp/consumemagic-pricing";
import {
  encodePriceParam,
  decodePriceParam,
  type PriceParamT,
  type OpPriceT,
} from "./types.js";

// ── Params ────────────────────────────────────────────────────────────────────

export interface PostPriceParams {
  lucid: LucidEvolution;
  /** Beacon UTxO đang sống — SPEND (không phải reference input như ở buildConsumeTx). */
  priceBeaconUtxo: UTxO;
  /** `price_param` đã apply đủ 5 param: committee, threshold, price_nft_policy,
   *  price_nft_name, ms_per_epoch. */
  priceParamScript: Validator;
  /** Ref-script CIP-33 của `price_param` nếu đã công bố; có thì KHÔNG attach CBOR. */
  priceParamRefUtxo?: UTxO;
  /** Unit (policy+name hex) của price NFT — phải khớp apply-param của validator. */
  priceNftUnit: string;
  /** Bảng giá mới. `m_min`/`m_max`/`epoch` KHÔNG nhận ở đây:
   *  m_min/m_max bị validator ghim vào hằng compile-time nên builder copy từ datum cũ;
   *  epoch do builder tính từ `tipPosixMs` (xem `newEpoch`). */
  newOpPrices: ReadonlyArray<OpPriceT>;
  /** demand_mult mới (Q-format, Q = 1e9). */
  newDemandMult: bigint;
  /** Key hash của những thành viên committee sẽ ký tx này. PHẢI phân biệt đôi một
   *  và đủ `threshold` — mirror `util.all_distinct` + `count_sigs >= threshold`. */
  committeeSignerKeyHashes: ReadonlyArray<string>;
  /** `threshold` đã apply vào validator. Builder KHÔNG đoán được từ script bytes. */
  threshold: number;
  network: Network;
  /** Thời điểm chóp chuỗi (POSIX ms). Quyết định epoch tham chiếu VÀ trần epoch. */
  tipPosixMs: bigint;
  /** Nạp thêm lovelace cho beacon (min-UTxO tăng khi protocol param đổi). Mặc định 0. */
  topUpLovelace?: bigint;
  /** Collateral thuần ADA — tránh CollateralContainsNonADA khi ví có token. */
  collateralUtxo?: UTxO;
  /** Ghi đè epoch của datum mới. Chỉ dùng cho test biên; mặc định = epoch hiện tại. */
  overrideEpoch?: bigint;
}

export interface PostPriceResult {
  tx: TxSignBuilder;
  /** Datum sẽ nằm ở beacon sau khi tx vào chuỗi. */
  newDatum: PriceParamT;
  oldDatum: PriceParamT;
  currentEpoch: bigint;
  summary: string;
}

// ── Redeemer ──────────────────────────────────────────────────────────────────

/**
 * `PriceParamRedeemer = PostPrice` — enum một variant, không field ⟹ Constr(0, [])
 * ⟹ `d87980`, đúng bytes mà `Data.void()` sinh ra. Dùng `Data.void()` vì đó là
 * đường đã chạy thật trên chuỗi (`scripts/deploy/09_deploy_consume.ts:237`), còn
 * `Data.to("PostPrice", PriceParamRedeemerSchema)` chưa từng có nơi gọi nào trong
 * kho. Có test ghim hai vế cho cùng một chuỗi hex.
 */
export const postPriceRedeemerCbor = (): string => Data.void();

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Dựng tx PostPrice. Caller sign (đủ `threshold` khoá) + submit.
 *
 * Cổng bên này ↔ `expect` bên `price_param.ak`:
 *   POSTPRICE-001 threshold > 0                    ↔ `expect threshold > 0`
 *   POSTPRICE-002 committee ký phân biệt đôi một   ↔ `util.all_distinct`
 *   POSTPRICE-003 đủ ngưỡng chữ ký                 ↔ `count_sigs >= threshold`
 *   POSTPRICE-004 beacon mang đúng 1 price NFT     ↔ `nft_in == 1`
 *   POSTPRICE-005 epoch đơn điệu tăng              ↔ `out_datum.epoch > datum.epoch`
 *   POSTPRICE-006 epoch ≤ epoch thời-gian-thật     ↔ `out_datum.epoch <= get_epoch(...)`
 *   POSTPRICE-007 datum mới hợp lệ                 ↔ `pricing.valid_param(out_datum)`
 *   POSTPRICE-008 m_min/m_max giữ nguyên           ↔ `valid_param` ghim hằng
 *   POSTPRICE-009 top-up không âm                  ↔ `lovelace_out >= lovelace_in`
 *
 * Phần non-ADA của value được BẢO TOÀN bằng cách copy y nguyên `priceBeaconUtxo.assets`
 * (`assets.without_lovelace(out) == without_lovelace(in)`) — builder không có đường
 * thêm/bớt token, kể cả vô ý.
 */
export async function buildPostPriceTx(
  params: PostPriceParams,
): Promise<PostPriceResult> {
  const {
    lucid, priceBeaconUtxo, priceParamScript, priceParamRefUtxo,
    priceNftUnit, newOpPrices, newDemandMult,
    committeeSignerKeyHashes, threshold, network, tipPosixMs,
    topUpLovelace = 0n, collateralUtxo, overrideEpoch,
  } = params;

  // ── Ngưỡng chữ ký ───────────────────────────────────────────────────────────
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new Error(
      `POSTPRICE-001: threshold phải là số nguyên > 0 (nhận ${threshold}). ` +
        `price_param.ak: \`expect threshold > 0\` — threshold = 0 nghĩa là ai cũng post được giá.`,
    );
  }
  const signers = committeeSignerKeyHashes.map((k) => k.toLowerCase());
  if (new Set(signers).size !== signers.length) {
    throw new Error(
      `POSTPRICE-002: danh sách khoá ký có phần tử trùng. price_param.ak đếm PHẦN TỬ ` +
        `committee, không đếm NGƯỜI — trùng khoá là một người ký đếm thành nhiều.`,
    );
  }
  if (signers.length < threshold) {
    throw new Error(
      `POSTPRICE-003: cần ≥ ${threshold} khoá committee, nhận ${signers.length}.`,
    );
  }

  // ── Beacon phải mang đúng 1 price NFT ───────────────────────────────────────
  const nftIn = priceBeaconUtxo.assets[priceNftUnit] ?? 0n;
  if (nftIn !== 1n) {
    throw new Error(
      `POSTPRICE-004: UTxO đưa vào mang ${nftIn} price NFT (${priceNftUnit}), phải đúng 1. ` +
        `Không có NFT thì đây không phải beacon — datum giả mạo được.`,
    );
  }

  if (!priceBeaconUtxo.datum) {
    throw new Error("POSTPRICE-010: beacon UTxO không có inline datum để đọc PriceParam.");
  }
  const oldDatum = decodePriceParam(priceBeaconUtxo.datum);

  // ── Epoch: đơn điệu tăng VÀ ≤ epoch thời-gian-thật ──────────────────────────
  const mspe = msPerEpoch(network);
  const currentEpoch = tipPosixMs / mspe;
  const newEpoch = overrideEpoch ?? currentEpoch;

  if (newEpoch <= oldDatum.epoch) {
    throw new Error(
      `POSTPRICE-005: epoch mới ${newEpoch} phải > epoch cũ ${oldDatum.epoch}. ` +
        `Trong cùng một epoch KHÔNG post lại giá được — đó là chốt chống rollback, không phải lỗi.`,
    );
  }
  if (newEpoch > currentEpoch) {
    throw new Error(
      `POSTPRICE-006: epoch mới ${newEpoch} > epoch hiện tại ${currentEpoch}. ` +
        `Post epoch tương lai là khoá vĩnh viễn: stale-check của consume không bao giờ thoả ` +
        `và epoch KHÔNG hạ xuống được.`,
    );
  }

  // ── Datum mới ───────────────────────────────────────────────────────────────
  // m_min/m_max copy từ datum cũ: validator ghim chúng vào hằng compile-time, nên
  // đây là hai trường builder KHÔNG được nhận từ caller.
  const newDatum: PriceParamT = {
    op_prices: newOpPrices.map((r) => ({ op_type: r.op_type, base_price: r.base_price })),
    demand_mult: newDemandMult,
    m_min: oldDatum.m_min,
    m_max: oldDatum.m_max,
    epoch: newEpoch,
  };

  if (newDatum.m_min !== oldDatum.m_min || newDatum.m_max !== oldDatum.m_max) {
    throw new Error("POSTPRICE-008: m_min/m_max không được đổi qua PostPrice.");
  }

  // P8 — cùng luật với `pricing.valid_param`. Ném ở đây thay vì để validator từ chối.
  try {
    assertValidPriceParam({
      op_prices: newDatum.op_prices.map((r) => ({
        op_type: r.op_type,
        base_price: r.base_price,
      })),
      demand_mult: newDatum.demand_mult,
      m_min: newDatum.m_min,
      m_max: newDatum.m_max,
      epoch: newDatum.epoch,
    });
  } catch (e) {
    throw new Error(`POSTPRICE-007: datum mới không hợp lệ — ${(e as Error).message}`);
  }

  if (topUpLovelace < 0n) {
    throw new Error(
      `POSTPRICE-009: topUpLovelace âm (${topUpLovelace}) — price_param.ak ép ` +
        `\`lovelace_out >= lovelace_in\`, rút ADA khỏi beacon là bào mòn nó tới dưới min-UTxO.`,
    );
  }

  // ── Value output: non-ADA copy y nguyên, ADA chỉ được cộng ──────────────────
  const outAssets: Assets = { ...priceBeaconUtxo.assets };
  if (topUpLovelace > 0n) {
    outAssets.lovelace = (outAssets.lovelace ?? 0n) + topUpLovelace;
  }

  // ── Validity range: TRỌN epoch hiện tại, hai biên Finite ────────────────────
  // `util.get_epoch` đòi cả hai biên Finite, hi - lo ≤ mspe, và ⌊lo/mspe⌋ == ⌊hi/mspe⌋.
  const lowerMs = currentEpoch * mspe;
  const upperMs = (currentEpoch + 1n) * mspe - 1n;

  // Địa chỉ giữ NGUYÊN chuỗi của input: `beacon_out.address == beacon_in.address` so
  // địa chỉ ĐẦY ĐỦ, gồm cả stake credential. Dựng lại địa chỉ từ script hash sẽ mất
  // phần stake và validator từ chối.
  const beaconAddress = priceBeaconUtxo.address;

  let txBuilder = lucid.newTx().collectFrom([priceBeaconUtxo], postPriceRedeemerCbor());

  if (priceParamRefUtxo) {
    txBuilder = txBuilder.readFrom([priceParamRefUtxo]);
  } else {
    txBuilder = txBuilder.attach.SpendingValidator(priceParamScript);
  }

  txBuilder = txBuilder
    .pay.ToAddressWithData(
      beaconAddress,
      { kind: "inline", value: encodePriceParam(newDatum) },
      outAssets,
    )
    .validFrom(Number(lowerMs))
    .validTo(Number(upperMs));

  for (const k of signers) txBuilder = txBuilder.addSignerKey(k);

  const tx = collateralUtxo
    ? await txBuilder.complete({ presetWalletInputs: [collateralUtxo] })
    : await txBuilder.complete();

  const summary =
    `post-price epoch ${oldDatum.epoch}→${newEpoch} | demand ${oldDatum.demand_mult}→${newDemandMult} | ` +
    `${newDatum.op_prices.length} op | ký ${signers.length}/${threshold} | ` +
    `script ${validatorToScriptHash(priceParamScript).slice(0, 12)}…`;

  return { tx, newDatum, oldDatum, currentEpoch, summary };
}
