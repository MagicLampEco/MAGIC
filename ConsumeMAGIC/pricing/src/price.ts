// @magiclamp/consumemagic-pricing — Consume-side pricing (CONTRACT v1 §A)
//
// price(op_type, t) = base_price[op_type] × demand_mult(t) / Q          (Q = 1e9)
//
// demand_mult(t) = clamp( SMA_N(load_raw) , m_min , m_max )
//   — FIR filter (Simple Moving Average + clamp), REUSING the UMKeeper structure
//     (UMKeeper/offchain/src/math.ts: computeSMA + clampUM). NO PI controller.
//
// Why FIR (not PI), per CONTRACT §A 4 trục:
//   (1) eUTXO-optimal: no integral state variable on datum → fewer bytes.
//   (2) Unconditional BIBO stability: bounded input (clamped load_raw history) →
//       SMA is a convex combination → output bounded, no tuning of Kp/Ki.
//   (3) Anti-windup free: no integral term → cannot wind up.
//   (4) Protocol consistency: UMKeeper already runs this filter correctly.
//
// ALL arithmetic BigInt. No Number for nanogic / Q values. Pure functions.

import { Q, clamp } from "@magiclamp/protocol-utils";

// ── Q-format constants (scale 1e9) ────────────────────────────────────────────
// Q is re-exported so callers/tests reference a single source of truth.
export { Q };

/** Default demand-multiplier bounds (CONTRACT §A: m_min=0.5, m_max=2.0). */
export const M_MIN_Q = 500_000_000n; //  0.5 × Q
export const M_MAX_Q = 2_000_000_000n; // 2.0 × Q

/** Neutral demand multiplier = 1.0 (used when history is empty). */
export const M_NEUTRAL_Q = Q; // 1.0 × Q

/** FIR window length N — matches UMKeeper UM_WINDOW (6). Governance param. */
export const DEMAND_WINDOW = 6;

// ── op_type base-price table (MVP, CONTRACT §A) ───────────────────────────────
// Unit: nanogic (1 MAGIC = 1e9 nanogic). DAO-governable param on-chain (PriceParam).
export const OP_IMAGE = 1; // process 1 image      → 0.01  MAGIC
export const OP_CID = 2; //   anchor 1 CID         → 0.001 MAGIC
export const OP_RECOGNITION_STORAGE = 3; // one storage event  → 1 MAGIC
export const OP_RECOGNITION_COMPUTE = 4; // one compute event  → 1 MAGIC

/**
 * Một dòng giá — gương của `OpPrice` on-chain (`consume/types.ak`), BigInt cả ba
 * trường. `demand_mult` scale Q.
 */
export interface PriceRow {
  base_price: bigint;
  demand_mult: bigint;
}

/**
 * Bảng giá keyed by op_type → dòng giá.
 *
 * 🔴 ĐỔI HÌNH DẠNG 2026-09-25 (`CC-LOAD-COUNT-UNIT`): trước đây là
 * `Record<number, bigint>` (chỉ base_price) và `demand_mult` đi vào các hàm định giá
 * như một THAM SỐ RỜI. Hình dạng đó nay không dựng lại được, và đó là chủ ý: với hệ
 * số tách theo `op_type`, một tham số `demandMultQ` rời cho phép người gọi ghép một
 * hệ số của mã này với bảng giá của mã kia, im lặng, và ra một con số hợp lệ. Kiểu dữ
 * liệu là chỗ rẻ nhất để đóng đường đó — người gọi cũ sẽ vỡ ở tầng kiểu, không vỡ ở
 * tầng số tiền.
 */
export type PriceTable = Readonly<Record<number, PriceRow>>;

/**
 * MVP base-price table — **KHÔNG phải nguồn có thẩm quyền, và KHÔNG nằm trên đường tiền.**
 *
 * Đường tiền đọc `pp.op_prices` của beacon `PriceParam` qua `requiredFromBeacon`
 * (`ConsumeMAGIC/offchain/src/consume.ts`), và nó ném `CONSUME-007` khi `op_type` vắng
 * trong BEACON — cố ý không lùi về bảng này. Bảng này chỉ là mặc định cho `pricePerOp`
 * khi người gọi không truyền bảng nào (báo giá thử, bài kiểm, công cụ ngoại tuyến).
 *
 * Nhưng nó vẫn phải KHỚP sổ `CONTRACT.md §A`, vì người đọc mã không phân biệt được hai vai
 * đó bằng mắt. Ca thật (`ol0920magic-e`, 2026-09-20): bảng này thiếu mã 3 và 4 trong khi
 * beacon đang deploy CÓ đủ bốn dòng (`scripts/deploy/09_deploy_consume.ts` ▸ `priceParam`);
 * một nhà tiêu thụ mở đúng tệp này, đếm hai dòng, và kết luận mã của họ chưa được định giá
 * — một chặn không có thật, giữ họ đứng lại một vòng thư. Một bảng phụ lệch sổ thì nó không
 * im lặng, nó nói SAI.
 *
 * Đơn vị: nanogic (1 MAGIC = 1e9). `base_price` là governance param on-chain do DAO chốt;
 * số ở đây là giá TẠM cho tới lượt chốt đó.
 *
 * `demand_mult` ở đây để 1.0× cho mọi dòng: bảng này là giá DANH NGHĨA ngoại tuyến,
 * không phải trạng thái tải của một cụm nào. Hệ số thật đọc từ beacon.
 * (Tên cũ `MVP_BASE_PRICE` đã đổi cùng lượt — cái tên ấy nay nói sai, vì mỗi dòng
 * mang cả hệ số chứ không chỉ mang giá gốc.)
 */
export const MVP_PRICE_TABLE: PriceTable = Object.freeze({
  [OP_IMAGE]: { base_price: 10_000_000n, demand_mult: Q }, //             0.01  MAGIC
  [OP_CID]: { base_price: 1_000_000n, demand_mult: Q }, //                0.001 MAGIC
  [OP_RECOGNITION_STORAGE]: { base_price: 1_000_000_000n, demand_mult: Q }, // 1 MAGIC — MỘT LẦN lưu, không phải MB
  [OP_RECOGNITION_COMPUTE]: { base_price: 1_000_000_000n, demand_mult: Q }, // 1 MAGIC — MỘT LẦN tính, không phải MB
});

// ── load_raw → demand history → SMA → clamp (FIR) ─────────────────────────────

/**
 * load_raw = ops_served_epoch / target_capacity   (scaled by Q).
 * Q-format ratio of demand vs capacity for one epoch.
 * Pure BigInt; division is floor (conservative — never over-prices on rounding).
 *
 * target_capacity is a governance param (> 0). Guarded to avoid div-by-zero:
 * a zero/negative capacity is treated as 1 (degenerate config), matching the
 * defensive `den = ... : 1n` pattern in UMKeeper computeUMRaw.
 */
export function computeLoadRaw(opsServedEpoch: bigint, targetCapacity: bigint): bigint {
  const den = targetCapacity > 0n ? targetCapacity : 1n;
  const ops = opsServedEpoch > 0n ? opsServedEpoch : 0n;
  return (ops * Q) / den;
}

/**
 * Append a raw load sample, keeping the last ≤ N values (FIR window).
 * Stores RAW (un-clamped) values — clamping happens only at the smoothed output,
 * mirroring UMKeeper appendHistory semantics. Pure: returns a new array.
 */
export function appendLoadHistory(
  history: readonly bigint[],
  newRaw: bigint,
  window: number = DEMAND_WINDOW,
): bigint[] {
  return [...history, newRaw].slice(-window);
}

/**
 * SMA_N — simple moving average of the load history (Q-format).
 * Empty history → neutral 1.0 (no demand signal yet). Floor division.
 * Identical structure to UMKeeper computeSMA.
 */
export function smaLoad(history: readonly bigint[]): bigint {
  if (history.length === 0) return M_NEUTRAL_Q;
  let sum = 0n;
  for (const x of history) sum += x;
  return sum / BigInt(history.length);
}

/**
 * demand_mult(history) = clamp( SMA_N(load_raw) , m_min , m_max )   (Q-format).
 *
 * This is the whole controller: an FIR low-pass (SMA) followed by a clamp.
 * Output is in [m_min, m_max] for ANY input → BIBO stable by construction.
 *
 * @param history  raw load samples (Q-format), newest-last, length ≤ window.
 * @param mMinQ    lower clamp (Q-format), default 0.5×Q.
 * @param mMaxQ    upper clamp (Q-format), default 2.0×Q.
 */
export function demandMult(
  history: readonly bigint[],
  mMinQ: bigint = M_MIN_Q,
  mMaxQ: bigint = M_MAX_Q,
): bigint {
  return clamp(smaLoad(history), mMinQ, mMaxQ);
}

// ── price ─────────────────────────────────────────────────────────────────────

/**
 * price_per_op = base_price[op_type] × demand_mult / Q   (nanogic).
 *
 * Floor division on the Q de-scale: price never exceeds the exact real value,
 * so the quote is never rounded UP against the user.
 *
 * Chỉ dùng để HIỂN THỊ giá 1 op. KHÔNG dùng làm nền tính tổng phải trả — nhân
 * `pricePerOp × opCount` là floor-trước-nhân-sau, thu THIẾU. Tổng phải trả đi qua
 * `requiredForOp` / `requiredBurn` (fold-floor-một-lần, P8 với `pricing.required_for`).
 *
 * Bất biến kế toán on-chain là DẤU BẰNG: `total_burned == total_required`
 * (SPEC §7.4 C-CM-2). Over-burn bị từ chối y như under-burn — bản cũ của bình luận
 * này ghi `magic_burned ≥ required`, thuộc mô hình token-mint đã chết.
 *
 * `demand_mult` đọc từ CHÍNH DÒNG (`CC-LOAD-COUNT-UNIT`), không còn là tham số rời —
 * gương của on-chain `pricing.price_of(pp, op_type)`, vốn cũng chỉ nhận beacon + mã.
 *
 * @param opType     op_type key into the price table.
 * @param priceTable governance price table (base_price + demand_mult per op).
 * @returns price in nanogic for ONE op of this type.
 * @throws  if op_type is absent from the table (unknown op = no authoritative price).
 */
export function pricePerOp(
  opType: number,
  priceTable: PriceTable = MVP_PRICE_TABLE,
): bigint {
  const row = priceTable[opType];
  if (row === undefined) {
    throw new Error(`PRICE-001: unknown op_type ${opType} (not in price table)`);
  }
  return (row.base_price * row.demand_mult) / Q;
}

/**
 * required for ONE op line = ⌊ base_price × demand_mult × op_count / Q ⌋ (nanogic).
 *
 * FOLD-FLOOR-ONCE — P8 parity với onchain pricing.required_for:
 *   base × demand × count, RỒI chia Q một lần (KHÔNG floor per-op rồi nhân count).
 * Floor-before-multiply (bản cũ) mất phần dư mỗi op × count ⇒ thu THIẾU (under-charge)
 * ⇒ Σburns off-chain < required on-chain ⇒ MỌI consume tx bị validator từ chối.
 *
 * VÁ FAIL-OPEN (2026-08-09): bản cũ làm `count = opCount > 0n ? opCount : 0n` ⇒ một
 * `opCount` âm cho ra giá **0** trong IM LẶNG, trong khi on-chain `expect op_count >= 1`
 * TỪ CHỐI. App có lỗi dấu sẽ hiện "0 MAGIC", cấp dịch vụ, RỒI tx mới bị từ chối — dịch
 * vụ đã cấp không lấy lại được. Trả 0 là câu trả lời SAI, không phải câu trả lời an toàn.
 *
 * @throws PRICE-001 if op_type is absent from the table (unknown op = no authoritative price).
 * @throws PRICE-002 if opCount < 1 (mirror on-chain `expect op_count >= 1`).
 */
export function requiredForOp(
  opType: number,
  opCount: bigint,
  priceTable: PriceTable = MVP_PRICE_TABLE,
): bigint {
  if (opCount < 1n) {
    throw new Error(
      `PRICE-002: op_count phải ≥ 1 (nhận ${opCount}). On-chain consume.ak ép ` +
        `\`expect op_count >= 1\`; trả 0 im lặng là fail-open trên đường tiền.`,
    );
  }
  const row = priceTable[opType];
  if (row === undefined) {
    throw new Error(`PRICE-001: unknown op_type ${opType} (not in price table)`);
  }
  return (row.base_price * row.demand_mult * opCount) / Q;
}

/**
 * required = Σ ⌊ base(op)×demand×count / Q ⌋   (nanogic) — total burn quote for a tx.
 * Mỗi dòng đi qua `requiredForOp` ⇒ thừa hưởng cả hai lỗi có mã (PRICE-001/PRICE-002).
 * Mirrors the on-chain C-CM-2 accumulation (fold-floor-once PER op line, then Σ).
 * On-chain sum_required_over_engage_inputs folds each Engage input's required_for
 * (một lần / input) rồi cộng ⇒ off-chain fold per item rồi cộng = KHỚP. Pure BigInt.
 */
export function requiredBurn(
  items: ReadonlyArray<{ opType: number; opCount: bigint }>,
  priceTable: PriceTable = MVP_PRICE_TABLE,
): bigint {
  let total = 0n;
  for (const { opType, opCount } of items) {
    total += requiredForOp(opType, opCount, priceTable);
  }
  return total;
}

// ── valid_param off-chain — CỔNG TRƯỚC KHI POST BEACON ────────────────────────
//
// VÌ SAO CẦN: on-chain `pricing.valid_param` chạy ở lúc TIÊU, tức bảng giá sai chỉ lộ
// ra khi mọi tx consume đã chết hàng loạt và beacon thì chỉ committee sửa được. Bên
// tiêu thụ (keeper / DAO tooling) trước đây KHÔNG có cách nào tự biết bảng của mình
// hợp lệ. Đây là bản gương off-chain: chạy TRƯỚC khi post, ném lỗi có mã.
//
// Nguồn NORMATIVE (đối chiếu từng dòng):
//   ConsumeMAGIC/onchain/lib/magiclamp/consume/pricing.ak — `valid_param`,
//   `sorted_strict_op_types`, `max_op_prices`.

/** Trần số dòng `op_prices` — khớp `pricing.ak:max_op_prices`. */
export const MAX_OP_PRICES = 16;

/**
 * `op_type` bị ép GIÁ CỐ ĐỊNH: `demand_mult` của dòng đó PHẢI đúng bằng `Q` (1.0×).
 * Khớp BIT với hằng Aiken `pricing.ak` ▸ `fixed_price_op_types` (P8, cùng thay đổi).
 *
 * Lý do đầy đủ nằm ở docstring bên Aiken — đừng chép xuống đây, một sự thật một nơi
 * giữ. Bản rút gọn để đọc mã này: mã 7 là `did.rotate`, một THAO TÁC AN NINH. Một hệ
 * số bám theo tải làm nó ĐẮT LÊN đúng lúc nhiều người cùng phải xoay khoá (đợt lộ
 * khoá hàng loạt), và cái đó tự khuếch đại. Trần `m_max = 2.0×` chặn ĐỘ LỚN, không
 * chặn CHIỀU.
 */
export const FIXED_PRICE_OP_TYPES: readonly bigint[] = Object.freeze([7n]);

/**
 * Trần TRÊN của `base_price` — khớp `pricing.ak:max_base_price` (P8, cùng commit).
 * 10¹² nanogic = 1.000 MAGIC cho MỘT đơn vị nghiệp vụ.
 * (Hạ từ 10¹⁴ ngày 2026-09-12: ở 10¹⁴ bất biến chống-khoá-toàn-mạng KHÔNG thoả.)
 *
 * Lý do đầy đủ + các con số đã cân nhắc rồi loại nằm ở docstring bên Aiken; đừng chép
 * xuống đây, một sự thật một nơi giữ. Hai điều phải nhớ khi đọc mã này:
 *  - Đây là BACKSTOP chống thảm hoạ, không phải khoảng giá gợi ý. Bảng đang deploy
 *    dùng 10⁹.
 *  - Trần này KHÔNG cứu được thao tác an ninh (`did.rotate`) khỏi đòn khoá-bằng-giá.
 *    Việc đó cần một dải op_type riêng — Nợ #43, còn mở.
 */
export const MAX_BASE_PRICE = 1_000_000_000_000n;

/** Một dòng bảng giá, đúng hình dạng `OpPrice` on-chain (BigInt cả BA trường). */
export interface OpPriceRow {
  op_type: bigint;
  base_price: bigint;
  demand_mult: bigint;
}

/**
 * Hình dạng datum `PriceParam` on-chain (cấu trúc, không phụ thuộc Lucid) — BỐN
 * trường. `demand_mult` đã xuống `OpPriceRow`; xem `OpPriceSchema` bên `offchain`.
 */
export interface PriceParamLike {
  op_prices: ReadonlyArray<OpPriceRow>;
  m_min: bigint;
  m_max: bigint;
  epoch: bigint;
}

/**
 * Kiểm datum `PriceParam` TRƯỚC khi post lên beacon. Bản gương của on-chain
 * `pricing.valid_param`. KHÔNG trả về giá trị mặc định, KHÔNG trả boolean — ném lỗi
 * có mã, vì "bảng giá không hợp lệ" không có phương án dự phòng đúng nào.
 *
 * Các tầng và LÝ DO (theo pricing.ak):
 *  - PRICE-010 `m_min`/`m_max` PIN về hằng giao thức. Check tương-đối
 *    (m_min ≤ demand ≤ m_max) KHÔNG chặn được band-escape vì demand bám theo m_max:
 *    đặt m_max khổng lồ thì giá nổ ~1e6× mà vẫn "trong band".
 *  - PRICE-011 band tương-đối, nay áp cho TỪNG DÒNG (`CC-LOAD-COUNT-UNIT`):
 *    `demand_mult` đã rời mức datum xuống `OpPriceRow`, nên phép kẹp band đi xuống
 *    theo. 🔴 Đường tắt đã LOẠI tường minh: gấp nhu cầu vào thẳng `base_price` cho ra
 *    cùng hiệu ứng giá mà không đổi lược đồ — và nó PHÁ band, vì band chỉ kẹp
 *    `demand_mult`, không kẹp `base_price`.
 *  - PRICE-017 GIÁ CỐ ĐỊNH: `op_type ∈ FIXED_PRICE_OP_TYPES ⇒ demand_mult === Q`.
 *    KHÔNG suy ra được từ PRICE-011: một hệ số 1,5× nằm gọn trong band.
 *  - PRICE-012 `epoch ≥ 0`.
 *  - PRICE-013 trần 16 dòng. `valid_param` chạy MỘT LẦN / Engage input ⇒ bảng vài
 *    nghìn dòng làm MỌI tx consume vượt ex-unit = DoS toàn cơ chế.
 *  - PRICE-014 `op_type` TĂNG NGẶT (dạng chuẩn tắc). Trùng `op_type` ⇒ on-chain
 *    `list.find` lấy dòng ĐẦU, off-chain viết bằng map lấy dòng CUỐI ⇒ hai phía lệch
 *    giá (10×) mà KHÔNG bên nào báo lỗi. Tăng ngặt bao hàm "không trùng" và loại luôn
 *    bảng cùng-tập-khác-thứ-tự.
 *  - PRICE-016 TRẦN `base_price ≤ MAX_BASE_PRICE`. PRICE-015 và `base_price ≥ 0` đều là
 *    ràng buộc DƯỚI — không cái nào chặn giá vọt lên. Không có PRICE-016 thì một bảng giá
 *    hợp lệ đặt `base_price = 2⁶³` cho `op_type = 7` (`did.rotate`) khoá quyền xoay khoá
 *    của mọi người, đúng lúc người ta cần tự vệ vì nghi lộ khoá.
 *  - PRICE-015 GATE `base_price × m_min ≥ Q` cho MỌI dòng: bảo đảm giá 1 đơn vị ở
 *    demand THẤP NHẤT vẫn ≥ 1 nanogic ⇒ đóng collapse-to-0 (base quá nhỏ ⇒ giá làm
 *    tròn về 0 ⇒ drain miễn phí). GATE này BAO HÀM `base_price ≥ 0` và cấm luôn
 *    `base_price == 0` (nhánh chết: consume ép `required > 0`).
 *
 * GATE PRICE-015 cũng chính là chỗ chặn sớm toán hạng ÂM — xem MATH.md §5: P8 giữa
 * Aiken và JS chỉ đúng khi MỌI toán hạng ≥ 0 (Aiken `/` là floor, JS BigInt `/` là
 * trunc-về-0; chúng lệch nhau trên số âm).
 *
 * @throws PRICE-010..PRICE-017 (mã kèm chỉ số dòng khi lỗi thuộc về một dòng cụ thể).
 */
export function assertValidPriceParam(pp: PriceParamLike): void {
  if (pp.m_min !== M_MIN_Q || pp.m_max !== M_MAX_Q) {
    throw new Error(
      `PRICE-010: m_min/m_max phải PIN đúng hằng giao thức ` +
        `(m_min=${M_MIN_Q}, m_max=${M_MAX_Q}), nhận (${pp.m_min}, ${pp.m_max}). ` +
        `Band lệch hằng = band-escape: demand bám theo m_max nên giá nổ mà vẫn "trong band".`,
    );
  }
  if (pp.epoch < 0n) {
    throw new Error(`PRICE-012: epoch phải ≥ 0 (nhận ${pp.epoch})`);
  }
  if (pp.op_prices.length > MAX_OP_PRICES) {
    throw new Error(
      `PRICE-013: op_prices có ${pp.op_prices.length} dòng, vượt trần ${MAX_OP_PRICES}. ` +
        `Bảng phình ⇒ mọi tx consume vượt ex-unit ⇒ DoS toàn cơ chế.`,
    );
  }
  for (let i = 1; i < pp.op_prices.length; i++) {
    const prev = pp.op_prices[i - 1]!;
    const cur = pp.op_prices[i]!;
    if (cur.op_type <= prev.op_type) {
      throw new Error(
        `PRICE-014: op_prices phải TĂNG NGẶT theo op_type; dòng ${i} có ` +
          `op_type=${cur.op_type} ≤ dòng ${i - 1} op_type=${prev.op_type}. ` +
          `Sắp xếp bằng \`toCanonicalOpPrices\` trước khi post.`,
      );
    }
  }
  for (let i = 0; i < pp.op_prices.length; i++) {
    const row = pp.op_prices[i]!;
    if (row.base_price * pp.m_min < Q) {
      throw new Error(
        `PRICE-015: dòng ${i} (op_type=${row.op_type}) có base_price=${row.base_price}; ` +
          `GATE đòi base_price × m_min ≥ Q (${row.base_price} × ${pp.m_min} < ${Q}). ` +
          `Dưới GATE thì giá làm tròn về 0 ở demand thấp nhất ⇒ drain miễn phí. ` +
          `base_price ≤ 0 luôn rớt GATE này.`,
      );
    }
    if (row.demand_mult < pp.m_min || row.demand_mult > pp.m_max) {
      throw new Error(
        `PRICE-011: dòng ${i} (op_type=${row.op_type}) có demand_mult=${row.demand_mult}, ` +
          `ngoài band [${pp.m_min}, ${pp.m_max}]. Band là thứ DUY NHẤT chặn biên độ một ` +
          `lượt đăng giá; bỏ nó thì chỉ còn MAX_BASE_PRICE đứng giữa một lượt đăng và một ` +
          `mức giá gấp trăm lần.`,
      );
    }
    if (FIXED_PRICE_OP_TYPES.includes(row.op_type) && row.demand_mult !== Q) {
      throw new Error(
        `PRICE-017: dòng ${i} có op_type=${row.op_type} thuộc FIXED_PRICE_OP_TYPES nên ` +
          `demand_mult phải ĐÚNG BẰNG Q (${Q}), nhận ${row.demand_mult}. Đây là thao tác ` +
          `an ninh: giá của nó không được nhúc nhích theo tải, CẢ HAI CHIỀU — rẻ đi lúc ` +
          `tải thấp cũng là đắt lên lúc tải cao. Band [m_min, m_max] KHÔNG bắt hộ luật ` +
          `này (${row.demand_mult} vẫn có thể nằm trong band).`,
      );
    }
    if (row.base_price > MAX_BASE_PRICE) {
      throw new Error(
        `PRICE-016: dòng ${i} (op_type=${row.op_type}) có base_price=${row.base_price}, ` +
          `vượt trần ${MAX_BASE_PRICE} nanogic (= 1.000 MAGIC / một đơn vị nghiệp vụ). ` +
          `Trần là backstop chống khoá-dịch-vụ-bằng-giá; xem \`pricing.ak:max_base_price\`.`,
      );
    }
  }
}

/**
 * Đưa bảng giá về DẠNG CHUẨN TẮC: sắp xếp `op_type` tăng dần, từ chối trùng.
 * Dùng TRƯỚC `assertValidPriceParam` để khỏi tự sắp tay (sai thứ tự = beacon chết).
 * Thuần: trả mảng mới.
 *
 * @throws PRICE-014 nếu có hai dòng cùng `op_type` (không tự chọn dòng nào thắng —
 *   on-chain lấy dòng đầu, map off-chain lấy dòng cuối; im lặng chọn một bên là chỗ
 *   sinh ra lệch giá 10× không ai báo).
 */
export function toCanonicalOpPrices(rows: ReadonlyArray<OpPriceRow>): OpPriceRow[] {
  const sorted = [...rows].sort((a, b) => (a.op_type < b.op_type ? -1 : a.op_type > b.op_type ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.op_type === sorted[i - 1]!.op_type) {
      throw new Error(
        `PRICE-014: op_type ${sorted[i]!.op_type} xuất hiện 2 lần trong bảng giá. ` +
          `Bỏ dòng thừa — không có luật "dòng nào thắng" nào an toàn.`,
      );
    }
  }
  return sorted;
}
