// @magiclamp/protocol-utils — Shared primitives (GenMAGIC v3.3)
// Single source of truth for all modules.
// ALL arithmetic BigInt. No Number for oildrop/nanogic/Q values.

// ══════════════════════════════════════════════════════════════
// §19 Protocol constants (Immutable unless noted)
// ══════════════════════════════════════════════════════════════
export const Q                   = 1_000_000_000n;   // [Immutable]
export const OILDROP_PER_LAMP        = 1_000_000n;
export const NANOGIC_PER_MAGIC   = 1_000_000_000n;
export const S_LAMP_TOTAL        = 36_000_000_000_000_000n;  // 36×10^15 oildrop

// ── HAI ĐỒNG HỒ, ĐỘC LẬP NHAU — đừng suy bảng này ra bảng kia ─────────────────
//
// Bản trước gộp chúng làm một ("ms_per_epoch = slots_per_epoch × 1000") và câu đó
// SAI cho Preprod: mạng Preprod thật chạy 432_000 slot/epoch (5 ngày), trong khi
// bảng ms cố ý để 1 ngày. Gộp lại thì một trong hai bảng phải sai, và bảng sai đó
// đội lốt số thật — không cổng nào bắt được, vì test đơn vị dùng chính hằng đó làm
// chuẩn nên xanh cả trước lẫn sau. Nguồn phát hiện: nhà Phoenix, đo Blockfrost
// `/epochs/latest` 2026-09-04 (Preprod epoch 311 dài 432 000 s).
//
// Từ nay hai bảng khai HAI thứ khác nhau và không được suy ra nhau:

// (1) SỰ THẬT VỀ MẠNG. Tham số thật của Cardano, dùng khi phải diễn giải slot thật
//     của chuỗi. KHÔNG bao giờ đi vào apply-param của validator nào.
export const SLOTS_PER_EPOCH_BY_NETWORK = {
  Preview:   86_400n,   // 1 ngày — đo được trên chuỗi
  Preprod:  432_000n,   // 5 ngày — đo được trên chuỗi (VÁ 2026-09-05, trước ghi 86_400)
  Mainnet:  432_000n,   // 5 ngày
} as const;

/** Slots-per-epoch THẬT của mạng Cardano (không phải nhịp epoch của giao thức). */
export function slotsPerEpoch(network: Network): bigint {
  return SLOTS_PER_EPOCH_BY_NETWORK[network];
}

// (2) NHỊP ĐỒNG HỒ CỦA GIAO THỨC — apply-param #4 của mọi vault validator.
//     Validator tính `epoch = posix_ms / ms_per_epoch` từ validity_range (PlutusV3
//     mang POSIX ms, không mang slot). Phép chia đó KHÔNG trừ genesis, nên số epoch
//     của giao thức chưa bao giờ là số epoch của Cardano và không thể trở thành nó:
//     hôm nay Preprod chạy epoch Cardano 311 còn epoch giao thức ≈ 4 139. Cho nên
//     chỉnh nhịp này cho khớp Preprod cũng KHÔNG làm hai số gặp nhau — nó chỉ đổi
//     độ dài một epoch giao thức, và đổi apply-param ⟹ đổi script hash ⟹ giết mọi
//     thứ đã deploy. Hai con số vẫn là hai con số kể cả sau lần chốt 2026-09-20 bên
//     dưới: nhịp bằng nhau KHÔNG làm gốc toạ độ bằng nhau, vì phép chia không trừ
//     genesis. Đừng đem epoch giao thức so với số epoch của Blockfrost hay explorer.
//
//     ✅ ĐÃ CHỐT 2026-09-20 — chủ dự án: Preprod đi theo nhịp mạng thật (5 ngày), bằng
//     nhịp mainnet. Lý do là vai của mạng, không phải sự gọn của con số: Preprod là nơi
//     nhà phát triển ngoài và người dùng mới tập thao tác trước khi bỏ tiền thật, nên một
//     đồng hồ nén 5× ở đó dạy sai về thứ họ sắp gặp — mọi phép đo thời gian (decay, hết
//     hạn, cửa sổ fire) suy ra từ Preprod sẽ lệch 5× khi lên mainnet, và không gì kêu.
//
//     Trước ngày đó bảng này ghi Preprod = 86 400 000 (1 ngày). Con số ấy KHÔNG do ai
//     quyết: đã tìm trong `Specs/`, `BOUNDARIES.md`, `DevStatus.md`, `ChangeLog.md` và
//     `git log -S` mà không có quyết định nào chọn nó, còn bằng chứng thì nghiêng về TAI
//     NẠN — commit `640690bf` sinh CẢ HAI bảng trong cùng một hunk, bảng ms suy ra từ
//     bảng slots lúc đó đang sai, và commit message không nhắc gì tới nén.
//
//     🔴 GIÁ PHẢI TRẢ, biết trước và đã chấp nhận: đây là apply-param, nên đổi số là đổi
//     bytes ⟹ đổi script hash ⟹ đổi địa chỉ. MỌI script đang sống trên Preprod
//     (`scripts/DEPLOYED.md` §Preprod) thành mồ côi và phải deploy lại; UTxO ở địa chỉ cũ
//     không ai spend được nữa. Đổi số ở đây KHÔNG tự làm việc đó — nó chỉ làm lượt build
//     tiếp theo sinh ra địa chỉ khác. Ai đọc dòng này mà thấy sổ deploy vẫn ghi địa chỉ
//     cũ thì đó là sổ chưa được dựng lại, không phải hai nguồn mâu thuẫn.
export const MS_PER_EPOCH_BY_NETWORK = {
  Preview:   86_400_000n,   // 1 ngày — trùng nhịp mạng Preview
  Preprod:  432_000_000n,   // 5 ngày — trùng nhịp mạng Preprod (chốt 2026-09-20)
  Mainnet:  432_000_000n,   // 5 ngày — trùng nhịp mainnet
} as const;

/** Nhịp epoch của GIAO THỨC (ms). Đây là apply-param, đổi là đổi script hash. */
export function msPerEpoch(network: Network): bigint {
  return MS_PER_EPOCH_BY_NETWORK[network];
}

/** POSIX ms → epoch GIAO THỨC (khớp `get_current_epoch` của validator).
 *  KHÔNG trừ genesis ⇒ giá trị trả về KHÔNG phải epoch Cardano, đừng đem so với
 *  số epoch của Blockfrost hay của explorer. */
export function posixMsToEpoch(posixMs: bigint, network: Network): bigint {
  return posixMs / msPerEpoch(network);
}

// ══════════════════════════════════════════════════════════════
// §2.4-bis  Khoảng hiệu lực (validity range) — một slot là đơn vị NHỎ NHẤT
// ══════════════════════════════════════════════════════════════

/** Độ dài một slot Cardano, mili-giây.
 *
 *  `1000` đúng trên **cả ba** mạng ta chạy — đo ở `SLOT_CONFIG_NETWORK` của
 *  `@lucid-evolution/plutus`: `Mainnet/Preview/Preprod` đều `slotLength: 1e3`.
 *  Thêm một mạng có `slotLength` khác thì hằng này phải thành bảng theo mạng, y
 *  như `MS_PER_EPOCH_BY_NETWORK`.
 *
 *  🔴 Vì sao con số này phải nằm ở đây thay vì ẩn trong Lucid: **biên validity mà
 *  script ĐỌC ĐƯỢC luôn là biên SLOT, không phải con số mili-giây ta truyền vào.**
 *  Lucid quy `.validFrom()`/`.validTo()` về slot bằng cách làm tròn XUỐNG, rồi
 *  script đọc lại bằng `slotToBeginUnixTime`. Nên trừ `1n` mili-giây **không** lùi
 *  được một slot, và hai mốc cách nhau 999 ms là CÙNG một slot. */
export const SLOT_LENGTH_MS = 1_000n;

/** Mốc POSIX của ĐẦU slot chứa `posixMs`.
 *
 *  Dùng được phép chia thẳng vì `zeroTime` của cả ba mạng đều ≡ 0 (mod 1000)
 *  (`Mainnet 1596059091e3` · `Preview 1666656e6` · `Preprod 16540416e5+1728e6`),
 *  nên biên slot trùng biên 1000 ms của chính đồng hồ POSIX. Đó là một dữ kiện đo
 *  được, không phải một quy ước — mạng nào lệch thì hàm này sai, và `assertSlotGrid`
 *  ngay dưới là chỗ nó kêu lên. */
export function slotFloorMs(posixMs: bigint): bigint {
  return posixMs / SLOT_LENGTH_MS * SLOT_LENGTH_MS;
}

/** Lỗi ném ra khi cửa sổ hiệu lực suy biến — KHÔNG phải lỗi lập trình, mà là một
 *  trạng thái hợp lệ của đồng hồ: ở slot cuối mỗi epoch giao thức thì **không
 *  giao dịch nào dựng được**. Mang theo số mili-giây phải chờ để chỗ gọi nói được
 *  cho người dùng biết phải làm gì. */
// 🔴 Thông điệp KHÔNG được nói "tip đang ở slot CUỐI của epoch" — bản đầu nói thế và
// nó sai ngay khi `reserveTrailingSlots > 0`: với một slot được chừa, tip ở slot ÁP
// CHÓT cũng ném, và người đọc sẽ đi soi đồng hồ của mình thay vì soi tham số chừa.
// Ca lật ra nó: `InstantGen/tests/instantTxWindow.test.ts` ▸ "C-bis".
export class EmptyValidityWindowError extends Error {
  readonly waitMs: bigint;
  readonly retryAfterMs: bigint;
  constructor(waitMs: bigint, retryAfterMs: bigint) {
    super(
      `Cửa sổ hiệu lực suy biến: cận trên hợp lệ cuối cùng của epoch giao thức này ` +
      `không còn đứng SAU tip ⟹ khoảng rỗng ⟹ sổ cái từ chối. ` +
      `Chờ ${waitMs} ms (tới mốc POSIX ${retryAfterMs}) rồi dựng lại.`,
    );
    this.name = "EmptyValidityWindowError";
    this.waitMs = waitMs;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface EpochValidityWindow {
  /** truyền vào `.validFrom()` */
  lowerMs: number;
  /** truyền vào `.validTo()` — đã căn về ĐẦU slot, nên vòng quy đổi của Lucid là
   *  phép đồng nhất và `get_validity_upper_ms` của validator đọc đúng số này. */
  upperMs: number;
}

/** Cận trên xa nhất, tính từ tip, mà một giao dịch được đặt.
 *
 *  🔴 Không có trần này thì cận trên là slot cuối của epoch GIAO THỨC, và sổ cái từ
 *  chối giao dịch với `TimeTranslationPastHorizon` mỗi khi mốc đó nằm quá chân trời
 *  quy đổi slot→thời gian của node. Chân trời chỉ được bảo đảm tới safe zone `3k/f`
 *  tính từ tip sổ cái (Preprod và Mainnet: 129.600 slot = 36 giờ). Lúc epoch giao
 *  thức dài 1 ngày thì cuối epoch luôn nằm trong chân trời, nên lỗi không lộ. Với
 *  Preprod 5 ngày thì nó lộ: đo 2026-09-24, tip ở slot ~134.542.000, cận trên xin
 *  134.956.798 (cuối epoch 4144), chân trời node trả về kết thúc ở 134.870.400.
 *  `DRY_RUN` KHÔNG bắt được ca này: validator chạy cục bộ trong `complete()`, không
 *  qua node — chỉ lượt gửi thật mới chạm chân trời.
 *
 *  1 giờ nằm dưới chân trời bảo đảm của mọi mạng, và dư cho khoảng dựng → ký → gửi.
 *  Keeper giá (`scripts/keeper/keeper.ts`) đã dùng 10 phút từ trước. */
export const VALIDITY_MAX_AHEAD_MS = 3_600_000n;

/** Cửa sổ hiệu lực cho một giao dịch mà validator đòi **cả hai biên nằm trong cùng
 *  một epoch giao thức** (`epoch = lower_ms / P` và `expect upper_ms < (epoch+1)*P`).
 *
 *  Cận trên = cái SỚM hơn trong hai mốc: slot hợp lệ cuối của epoch (trừ phần chừa),
 *  và `tip + VALIDITY_MAX_AHEAD_MS` (xem hằng đó vì sao phải có trần).
 *
 *  `reserveTrailingSlots` chừa lại N slot ở cuối epoch. Chỗ duy nhất cần nó là
 *  `InstantGen`: mốc mở khoá nó ghi vào datum là `cận-trên + P`, nên nếu cận trên là
 *  slot CUỐI của epoch thì mốc ấy cũng là slot cuối của epoch sau — và lượt rút đúng
 *  tại mốc được quảng cáo sẽ suy biến, **mọi lần**. Chừa một slot đẩy mốc ra khỏi ô đó.
 *  Phép `min` không mở lại ô đó: khi trần thắng thì cận trên nằm TRƯỚC vùng chừa.
 *
 *  @throws {EmptyValidityWindowError} khi tip ở slot cuối (sau khi trừ phần chừa).
 */
export function epochValidityWindow(
  tipPosixMs: bigint,
  network: Network,
  reserveTrailingSlots: bigint = 0n,
  maxAheadMs: bigint = VALIDITY_MAX_AHEAD_MS,
): EpochValidityWindow {
  // Trần dưới một slot thì khoảng rỗng vì TRẦN, không vì cuối epoch — lỗi ném ra lúc
  // đó sẽ bảo người gọi chờ tới epoch sau, một lời khuyên sai. Ném đúng tên.
  if (maxAheadMs < SLOT_LENGTH_MS) {
    throw new RangeError(`maxAheadMs=${maxAheadMs} nhỏ hơn một slot (${SLOT_LENGTH_MS} ms)`);
  }
  const p      = msPerEpoch(network);
  const epoch  = posixMsToEpoch(tipPosixMs, network);
  const lowerSlotMs = slotFloorMs(tipPosixMs);
  // Mốc hợp lệ cuối cùng là `(epoch+1)*P - 1`; đầu slot chứa nó là `(epoch+1)*P - 1000`.
  const epochUpperSlotMs = slotFloorMs((epoch + 1n) * p - 1n)
                         - reserveTrailingSlots * SLOT_LENGTH_MS;
  const aheadSlotMs = slotFloorMs(tipPosixMs + maxAheadMs);
  const upperSlotMs = aheadSlotMs < epochUpperSlotMs ? aheadSlotMs : epochUpperSlotMs;

  if (upperSlotMs <= lowerSlotMs) {
    const retryAfterMs = (epoch + 1n) * p;
    throw new EmptyValidityWindowError(retryAfterMs - tipPosixMs, retryAfterMs);
  }
  return { lowerMs: Number(tipPosixMs), upperMs: Number(upperSlotMs) };
}

// LAMP carries a DIFFERENT asset name per network — mainnet "LAMP", testnets
// "tLAMP". Every vault validator takes it as compile-time param #2, so a wrong
// value here bakes a vault that can never see its own LAMP (MAINNET-BLOCK).
// Derived from network like ms_per_epoch — never defaulted to a testnet literal.
export const LAMP_ASSET_NAME_BY_NETWORK = {
  Preview:  "744c414d50",   // "tLAMP"
  Preprod:  "744c414d50",   // "tLAMP"
  Mainnet:  "4c414d50",     // "LAMP"
} as const;

/** LAMP asset name (hex) for a given Cardano network — validator param + unit building. */
export function lampAssetName(network: Network): string {
  return LAMP_ASSET_NAME_BY_NETWORK[network];
}

// OAC [GenMAGIC §6.4, Constitutional]
export const DRM_LOOKBACK        = 12n;   // epochs
export const MIN_BURN_FOR_OAC    = 1_000_000_000n;  // 1 MAGIC

// ══════════════════════════════════════════════════════════════
// §2.4 Epoch utilities
// ══════════════════════════════════════════════════════════════

// Cardano genesis UNIX timestamps per network (used as fallback when Blockfrost
// is unavailable). Preview Shelley genesis: slot 0 = block 1 (2022-10-25).
export const GENESIS_UNIX: Record<"Preview" | "Preprod" | "Mainnet", number> = {
  Preview:  1666656000,  // 2022-10-25
  Preprod:  1654041600,  // 2022-06-01
  Mainnet:  1596491091,  // 2020-08-03
};

export type Network = "Preview" | "Preprod" | "Mainnet";

/** slot → epoch CARDANO (chia nguyên theo `SLOTS_PER_EPOCH_BY_NETWORK`).
 *
 *  ⚠ KHÔNG dùng hàm này để lấy epoch của GIAO THỨC — đó là `posixMsToEpoch`.
 *  Hai hàm trả hai số khác hẳn nhau (đồng hồ giao thức không trừ genesis), và trộn
 *  chúng vào cùng một datum là dựng một giao dịch validator không bao giờ nhận.
 *  Chỗ gọi: `getCurrentEpoch` ngay dưới, và tái xuất qua `math.ts` của các module.
 *  (Bản trước của dòng này viết "KHÔNG mã sống nào gọi hàm này" — sai, và cái sai đó
 *   dán cảnh báo lên đúng hàm không ai gọi trong khi để `getCurrentEpoch` trần.)
 */
export function slotToEpoch(slot: bigint, network: Network): bigint {
  return slot / slotsPerEpoch(network);
}

/** Get current tip slot from a Lucid-compatible provider.
 *  Falls back to wall-clock estimate using the network's genesis UNIX time.
 *  Hardcoding 1666656000 in callers breaks Preprod/Mainnet — always pass `network`.
 */
export async function getTipSlot(
  lucid   : { provider: unknown },
  network : Network = "Preview",
): Promise<number> {
  try {
    const tip = await (lucid.provider as { getBlock: (s: string) => Promise<{ slot?: number }> })
      .getBlock("latest");
    return tip.slot ?? 0;
  } catch {
    const genesis = GENESIS_UNIX[network] ?? GENESIS_UNIX.Preview;
    return Math.max(0, Math.floor(Date.now() / 1000) - genesis);
  }
}

/** Epoch CARDANO hiện tại, đọc từ provider.
 *
 *  ⚠ ĐÂY KHÔNG PHẢI epoch của GIAO THỨC. Tên hàm nghe như thứ bạn cần, nhưng nó trả số
 *  epoch của CHUỖI (có trừ genesis), còn mọi trường datum trong kho này — `acquired_epoch`,
 *  `last_updated_epoch`, `created_epoch`, `commit_epoch` — mang epoch GIAO THỨC
 *  (`posix_ms / ms_per_epoch`, KHÔNG trừ genesis). Hai số cách nhau rất xa: cùng một lúc
 *  trên Preprod, hàm này trả ~311 còn epoch giao thức là ~20 700.
 *
 *  Nhét số của hàm này vào datum ⟹ validator từ chối, và triệu chứng là một tx fail
 *  không kèm lời giải thích nào. Muốn epoch giao thức thì dùng `posixMsToEpoch(tipMs, network)`.
 *
 *  Dùng hàm này khi và chỉ khi bạn thật sự cần đối chiếu với epoch mà explorer/Blockfrost
 *  hiển thị.
 */
export async function getCurrentEpoch(
  lucid   : { provider: unknown },
  network : Network = "Preview",
): Promise<bigint> {
  return slotToEpoch(BigInt(await getTipSlot(lucid, network)), network);
}

// ══════════════════════════════════════════════════════════════
// Unit conversions
// ══════════════════════════════════════════════════════════════
export function lampToOildrop(lamp: bigint): bigint   { return lamp * OILDROP_PER_LAMP; }
export function oildropToLamp(oildrop: bigint):  bigint   { return oildrop  / OILDROP_PER_LAMP; }
export function lAvail(balance: bigint, locked: bigint): bigint { return balance - locked; }

// ══════════════════════════════════════════════════════════════
// Display
// ══════════════════════════════════════════════════════════════
export function nanogicToMagicStr(ng: bigint, dec = 4): string {
  if (ng === 0n) return "0." + "0".repeat(dec);
  if (ng < 0n)   return "-" + nanogicToMagicStr(-ng, dec);
  const whole = ng / NANOGIC_PER_MAGIC;
  const frac  = (ng % NANOGIC_PER_MAGIC).toString().padStart(9, "0").slice(0, dec);
  return `${whole}.${frac}`;
}

/**
 * Hiển thị một giá trị Q-format. Làm tròn nửa-lên, tính TRỌN bằng BigInt.
 *
 * Bản trước dùng `Number(abs) / 1e9` rồi `toFixed`. Nó đúng với mọi giá trị đang
 * chạy hôm nay (S_Q, UM, rate_locked_q đều ≤ ~10¹⁰), và chính chỗ đó là vấn đề:
 * `Number` mất chữ số **im lặng** từ 2⁵³ ≈ 9,007×10¹⁵ trở lên, không ném, không
 * cảnh báo. Nâng suất sinh lên ~25× là đủ đẩy `M_i` qua mốc đó — và khi ấy hàm
 * này vẫn trả về một chuỗi trông hoàn toàn bình thường. Đúng hình dạng cái vỏ
 * im lặng, trên đường tiền.
 *
 * Cách vá rẻ hơn một cổng chặn: bỏ hẳn `Number` thì không còn trần nào để canh.
 * Kết quả trùng `toFixed` ở mọi giá trị `Number` còn biểu diễn đúng, nên đây
 * không phải đổi hành vi — chỉ là gỡ một cái trần.
 */
export function qToStr(qv: bigint, dec = 3): string {
  const sign = qv < 0n ? "-" : "";
  const abs  = qv < 0n ? -qv : qv;
  const scale = 10n ** BigInt(dec);
  // ⌊(abs·scale·2 + Q) / (2Q)⌋ — làm tròn nửa-lên trên số nguyên, không mất bit.
  const scaled = (abs * scale * 2n + Q) / (2n * Q);
  const whole = scaled / scale;
  if (dec === 0) return `${sign}${whole}`;
  const frac = (scaled % scale).toString().padStart(dec, "0");
  return `${sign}${whole}.${frac}`;
}

// ══════════════════════════════════════════════════════════════
// BigInt sort comparators (avoids Number() precision concern)
// Safe for all realistic values; pure BigInt comparison.
// ══════════════════════════════════════════════════════════════
export function cmpBigIntAsc(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function cmpBigIntDesc(a: bigint, b: bigint): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

// ══════════════════════════════════════════════════════════════
// LoyaltyHolding types & lock algorithm (§6.8, §A.9, T5)
// Canonical implementation — P8: all modules must use this exact code.
// ══════════════════════════════════════════════════════════════
export interface LoyaltyHolding {
  amount         : bigint;
  acquired_epoch : bigint;
  is_locked      : boolean;
}


// ══════════════════════════════════════════════════════════════
// sortAiken — P8: `list.sort` của Aiken KHÔNG ổn định
// ══════════════════════════════════════════════════════════════
//
// 🔴 Đây là chỗ P8 vỡ mà không phép kiểm nào bắt được, và nó vỡ ở đúng trạng thái mà
// giao thức TỰ SINH RA.
//
// `Array.prototype.sort` của JS ổn định từ ES2019: hai phần tử so ra `0` giữ nguyên thứ
// tự. `list.sort` của stdlib Aiken thì ĐẢO chúng. Nguồn — `aiken-lang-stdlib`
// (`lib/aiken/collection/list.ak`, bản ghim ở mọi `aiken.toml` của kho này):
//
//     sort([x, ..xs], cmp)   = insert(sort(xs, cmp), x, cmp)
//     insert([x, ..xs], e)   = if cmp(e, x) == Less { [e, ..self] }
//                              else { [x, ..insert(xs, e)] }
//
// Nó sắp phần ĐUÔI trước rồi chèn phần ĐẦU vào; `Equal` rơi vào nhánh `else` nên phần
// tử đứng trước bị đẩy ra sau. Với hai phần tử hoà, kết quả là danh sách ĐẢO.
//
// Đo thật (2026-09-05, `aiken check` trên bản sao ScheduleGen, đầu vào
// `[(100, ep10, F), (50, ep10, F)]`):
//
//     remove_newest_first(…, 30)   Aiken [(20,F),(100,F)]     TS cũ [(70,F),(50,F)]
//     select_lamp_for_lock(…, 20)  Aiken [(20,T),(30,F),(100,F)]  TS cũ [(20,T),(80,F),(50,F)]
//
// Validator so danh sách BẰNG NHAU TUYỆT ĐỐI (`ScheduleGen/onchain/validators/vault.ak:353`,
// `InstantGen/onchain/validators/vault.ak:822`), nên mỗi lệch là một tx bị chuỗi từ chối.
//
// Vì sao nó không phải ca hiếm: comparator chỉ khoá theo `acquired_epoch`, và
// `select_lamp_for_lock` khi khoá MỘT PHẦN sẽ tách một holding thành HAI holding cùng
// `acquired_epoch` (`lock.ak:34-38`). Nghĩa là lần khoá đầu tiên tự tạo ra thế hoà, và
// mọi thao tác sau đó trên vault đó đi vào đúng ca lệch.
//
// Sửa ở phía TS chứ không phía Aiken là CÓ CHỦ ĐÍCH: đổi `lock.ak` là đổi bytes ⟹ đổi
// script hash ⟹ đổi địa chỉ vault ⟹ mọi vault đang sống mồ côi. On-chain là trọng tài,
// nên bản mô phỏng phải chạy theo nó.
//
// Đây là bản soi gương ĐÚNG THUẬT TOÁN, không phải một mẹo "đảo phần tử hoà". Viết theo
// thuật toán thì nó còn đúng ở những ca mà một phép đảo hậu-kỳ sai — ví dụ ba phần tử
// hoà trở lên, hoặc các cụm hoà xen kẽ cụm không hoà.

function insertAiken<T>(self: readonly T[], e: T, cmp: (a: T, b: T) => number): T[] {
  if (self.length === 0) return [e];
  const [x, ...xs] = self;
  return cmp(e, x) < 0 ? [e, ...self] : [x, ...insertAiken(xs, e, cmp)];
}

/**
 * `list.sort` của Aiken, mô phỏng đúng thuật toán. Dùng THAY CHO `Array.sort` ở mọi chỗ
 * kết quả phải trùng bit với một hàm Aiken (P8). Không đột biến mảng vào.
 */
export function sortAiken<T>(xs: readonly T[], cmp: (a: T, b: T) => number): T[] {
  if (xs.length === 0) return [];
  const [head, ...tail] = xs;
  return insertAiken(sortAiken(tail, cmp), head, cmp);
}

/** §6.8 Youngest-first lock (T5) — maximises LF of free holdings.
 *  Lock youngest holdings first → free = oldest → LF(free) highest.
 *  Pure function: returns new array, does not mutate input.
 */
export function selectLampForLock(
  holdings : LoyaltyHolding[],
  amount   : bigint,
): LoyaltyHolding[] {
  // Sort youngest-first (desc acquired_epoch). `sortAiken`, KHÔNG `Array.sort` —
  // xem chú thích ở `sortAiken`: hai holding cùng `acquired_epoch` ra thứ tự khác nhau.
  const sorted = sortAiken(holdings, (a, b) => cmpBigIntDesc(a.acquired_epoch, b.acquired_epoch));
  let remaining = amount;
  const result: LoyaltyHolding[] = [];

  for (const h of sorted) {
    if (remaining <= 0n) { result.push(h); continue; }
    if (remaining >= h.amount) {
      result.push({ ...h, is_locked: true });
      remaining -= h.amount;
    } else {
      result.push({ amount: remaining,           acquired_epoch: h.acquired_epoch, is_locked: true  });
      result.push({ amount: h.amount - remaining, acquired_epoch: h.acquired_epoch, is_locked: false });
      remaining = 0n;
    }
  }
  if (remaining > 0n) throw new Error(`GEN-LOCK-001: insufficient holdings (${remaining} oildrop short)`);
  return result;
}

/** I-ACT-7 — Oldest-locked-first RELEASE. Called at ScheduleGen fire time.
 *
 *  Unlike `removeLockedAmount`, the LAMP stays: holdings keep their amount and
 *  acquired_epoch, only `is_locked` flips. Σholdings is therefore invariant, so
 *  the vault's `lamp_balance` (and the real LAMP in the UTxO) does not move —
 *  a fire mints MAGIC without eroding the user's principal.
 *
 *  Mirrors `unlock_locked_amount` in ScheduleGen/onchain/lib/.../lock.ak
 *  byte-for-byte, including the result order (P8):
 *    [already unlocked] ++ [newly freed] ++ [still locked]
 *
 *  Pure function: returns new array, does not mutate input.
 */
export function unlockLockedAmount(
  holdings : LoyaltyHolding[],
  amount   : bigint,
): LoyaltyHolding[] {
  const unlocked = holdings.filter(h => !h.is_locked);
  const locked   = sortAiken(holdings.filter(h => h.is_locked),        // oldest first
    (a, b) => cmpBigIntAsc(a.acquired_epoch, b.acquired_epoch));       // P8: xem sortAiken

  let remaining = amount;
  const freed:       LoyaltyHolding[] = [];
  const stillLocked: LoyaltyHolding[] = [];

  for (const h of locked) {
    if (remaining <= 0n) { stillLocked.push(h); continue; }
    if (remaining >= h.amount) {
      freed.push({ ...h, is_locked: false });
      remaining -= h.amount;
    } else {
      // Partial release splits one holding; the parts sum to the original.
      freed.push({ amount: remaining, acquired_epoch: h.acquired_epoch, is_locked: false });
      stillLocked.push({ amount: h.amount - remaining, acquired_epoch: h.acquired_epoch, is_locked: true });
      remaining = 0n;
    }
  }
  if (remaining > 0n) throw new Error(`GEN-LOCK-002: insufficient locked holdings (${remaining} oildrop short)`);
  return coalesceHoldings([...unlocked, ...freed, ...stillLocked]);
}

/** Merge holdings sharing (acquired_epoch, is_locked). Lossless: that pair is the
 *  only thing distinguishing two holdings, and `amount` is additive.
 *
 *  NOT optional. `unlockLockedAmount` splits a holding on every partial release
 *  and never drops one, so without this the list grows +1 per fire — 21 entries
 *  after 20 fires vs 2 under the old `removeLockedAmount`. MAX_LOYALTY_HOLDINGS
 *  (40 kể từ 2026-09-14) is enforced by the vault validator on both the commit
 *  and the fire branch, so an L=200 schedule would leave the user unable to
 *  withdraw at all.
 *
 *  Mirrors `coalesce_holdings` in ScheduleGen/onchain/lib/.../lock.ak, including
 *  order: the first occurrence of a bucket keeps its position (P8).
 */
export function coalesceHoldings(holdings: LoyaltyHolding[]): LoyaltyHolding[] {
  const out: LoyaltyHolding[] = [];
  for (const h of holdings) {
    const i = out.findIndex(x =>
      x.acquired_epoch === h.acquired_epoch && x.is_locked === h.is_locked);
    if (i >= 0) out[i] = { ...out[i]!, amount: out[i]!.amount + h.amount };
    else out.push({ ...h });
  }
  return out;
}

/** §A.9 Oldest-locked-first REMOVAL — deletes the LAMP.
 *
 *  Legacy/VacuumGen only. ScheduleGen moved to `unlockLockedAmount` under
 *  I-ACT-7: removing LAMP at fire time eroded the user's principal.
 *
 *  Pure function: returns new array, does not mutate input.
 */
export function removeLockedAmount(
  holdings : LoyaltyHolding[],
  amount   : bigint,
): LoyaltyHolding[] {
  const unlocked = holdings.filter(h => !h.is_locked);
  const locked   = sortAiken(holdings.filter(h => h.is_locked),        // oldest first
    (a, b) => cmpBigIntAsc(a.acquired_epoch, b.acquired_epoch));       // P8: xem sortAiken

  let remaining = amount;
  const result: LoyaltyHolding[] = [];

  for (const h of locked) {
    if (remaining <= 0n) { result.push(h); continue; }
    if (remaining >= h.amount) { remaining -= h.amount; }
    else { result.push({ ...h, amount: h.amount - remaining }); remaining = 0n; }
  }
  if (remaining > 0n) throw new Error(`GEN-LOCK-002: insufficient locked holdings (${remaining} oildrop short)`);
  return [...unlocked, ...result];
}

export function sumHoldings(holdings: LoyaltyHolding[]): bigint {
  return holdings.reduce((s, h) => s + h.amount, 0n);
}

export function sumLocked(holdings: LoyaltyHolding[]): bigint {
  return holdings.filter(h => h.is_locked).reduce((s, h) => s + h.amount, 0n);
}

// ══════════════════════════════════════════════════════════════
// OAC (§6.4) — single canonical implementation
//
// IMPORTANT: Two different window semantics exist by design:
//
//   PRUNE (ConsumeMAGIC §10.2 STEP 0e): keeps ep ≥ e − DRM_LOOKBACK
//     → keeps entries that may be counted in the NEXT SnapshotGen
//
//   COUNT (SnapshotGen §6.4, AppEconomics §8.5): counts ep ∈ [e−12, e)
//     → [current-12, current) — exclusive upper bound
//     → burns in CURRENT epoch apply to NEXT epoch's OAC (by design)
//
// These are intentionally different. Do NOT unify them.
// ══════════════════════════════════════════════════════════════

/** Prune stale entries from recent_burn_epochs (ConsumeMAGIC STEP 0e).
 *  Keeps entries with ep ≥ current − DRM_LOOKBACK.
 */
export function pruneActivityWindow(
  entries      : [string, bigint][],
  currentEpoch : bigint,
): [string, bigint][] {
  return entries.filter(([, ep]) => ep >= currentEpoch - DRM_LOOKBACK);
}

/** Count distinct active apps in OAC window (SnapshotGen §6.4).
 *  Window: [current − DRM_LOOKBACK, current) — EXCLUSIVE upper bound.
 *  Burns from current epoch NOT counted (they affect next epoch's OAC).
 */
export function countActiveAppsInOacWindow(
  entries      : [string, bigint][],
  currentEpoch : bigint,
): number {
  const lo = currentEpoch - DRM_LOOKBACK;
  const hi = currentEpoch;  // exclusive
  const active = entries.filter(([, ep]) => ep >= lo && ep < hi);
  return new Set(active.map(([id]) => id)).size;
}

/** Add or update (app_id, epoch) in recent_burn_epochs with deduplication.
 *  C-ACTIVITY-DEDUP: skip if (app_id, epoch) already present.
 *  INV-CM-ACT-ORDER: maintains epoch-descending order for efficient dedup.
 */
export function addBurnToActivity(
  entries  : [string, bigint][],
  appId    : string,
  epoch    : bigint,
): [string, bigint][] {
  // C-ACTIVITY-DEDUP: no duplicate (app_id, epoch)
  if (entries.some(([id, ep]) => id === appId && ep === epoch)) return entries;
  return [[appId, epoch], ...entries];  // prepend = epoch-descending order
}

// ══════════════════════════════════════════════════════════════
// isqrt — ⌊√n⌋ Newton's method (AppEconomics §3.3, Lemma 3.5)
// Pure BigInt — no float.
// ══════════════════════════════════════════════════════════════
export function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  // Initial guess: use bit length to estimate magnitude (BigInt-safe)
  const bits = n.toString(2).length;
  let x = 1n << BigInt(Math.ceil(bits / 2));
  let y = (x + n / x) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** isqrt_10th — ⌊n^(1/10)⌋ for AppEconomics V_dampened.
 *  BigInt Newton's method. No float for initial guess.
 *  Safe for V^7 where V ≤ S_LAMP_TOTAL = 36×10^15 (V^7 ≤ ~10^110).
 */
export function isqrt10th(n: bigint): bigint {
  if (n <= 0n) return 0n;
  if (n < 10n) return 1n;

  // Initial guess via bit-length (pure BigInt, no float)
  const bits = n.toString(2).length;
  // k^10 ≈ 2^(bits-1) → k ≈ 2^((bits-1)/10)
  let x = 1n << BigInt(Math.ceil((bits - 1) / 10) + 1);

  // Newton's method: x_{n+1} = (9x + n/x^9) / 10
  for (let iter = 0; iter < 200; iter++) {
    const x9   = x ** 9n;
    const xNew = (9n * x + n / x9) / 10n;
    if (xNew >= x) break;
    x = xNew;
  }

  // Correct boundary (one-time adjustment)
  while ((x + 1n) ** 10n <= n) x++;
  while (x > 0n && x ** 10n > n) x--;

  return x;
}

/** On-chain verification of V_dampened (§9.1 Lemma 9.2).
 *  Vd^10 ≤ V^7 < (Vd+1)^10 — cheaper than computing isqrt_10th on-chain.
 */
export function verifyVd(V: bigint, Vd: bigint): boolean {
  return Vd ** 10n <= V ** 7n && V ** 7n < (Vd + 1n) ** 10n;
}

export function vDampened(V: bigint): bigint {
  return isqrt10th(V ** 7n);
}

// ══════════════════════════════════════════════════════════════
// Q-format arithmetic (§3.2)
// ══════════════════════════════════════════════════════════════
export function mulQ(a: bigint, b: bigint): bigint { return a * b / Q; }
export function clamp(x: bigint, lo: bigint, hi: bigint): bigint {
  return x < lo ? lo : x > hi ? hi : x;
}

// ── INV-VAULT-IDENTITY: dựng value output của vault ──────────────────────────────
//
// Mọi nhánh spend của mọi vault đòi vault-id NFT còn nguyên ở output
// (`validate_vault_value`, ví dụ `ScheduleGen/onchain/validators/vault.ak:866-872`).
// NFT là one-shot, sinh cùng lúc với vault, không đúc lại được.
//
// 🔴 LỖI ĐÃ XẢY RA THẬT, HAI LẦN, VÀ IM LẶNG CẢ HAI LẦN. Cách viết
//
//     { lovelace: L, [lampUnit]: X }        // ✗ dựng lại từ đầu
//
// bỏ mất mọi tài sản khác đang nằm trên vault — trong đó có NFT danh tính. Không lỗi
// biên dịch, không test đỏ; chuỗi từ chối tx và thông điệp không nói NFT. `ca5870df`
// (tuanzoro2k, 11/8) vá đúng chỗ này, lần trộn hội tụ đánh rơi bản vá, và đường
// ScheduleFire nằm gãy từ đó tới 3/9 — đúng khoảng thời gian mà `DEPLOYED.md` ghi là
// "fire chưa bao giờ thành công trên chuỗi".
//
// Dùng hàm này thay vì viết object bằng tay. Nó ở ProtocolUtils vì cả bốn module vault
// cần cùng một bất biến, và một bất biến thì giữ ở một chỗ.

/** Tập tài sản tối thiểu mà lucid nhận cho một output. */
export type AssetsLike = Record<string, bigint>;

/**
 * Value cho output tiếp-nối của vault: bê NGUYÊN value đầu vào, chỉ đè các đơn vị được
 * nêu. Tài sản không nêu — vault-id NFT trước hết — đi qua nguyên vẹn.
 *
 * @param inputAssets value của UTxO vault đang tiêu (`vaultUtxo.assets`).
 * @param overrides   các đơn vị cần đặt lại, ví dụ `{ lovelace, [lampUnit]: newBalance }`.
 *                    Đặt một đơn vị về `0n` là XOÁ nó khỏi output (lucid không nhận
 *                    số lượng 0) — dùng khi thật sự muốn tài sản đó rời vault.
 */
export function vaultOutValue(
  inputAssets: AssetsLike,
  overrides:   AssetsLike,
): AssetsLike {
  const out: AssetsLike = { ...inputAssets, ...overrides };
  for (const [unit, qty] of Object.entries(out)) {
    if (qty === 0n) delete out[unit];
  }
  return out;
}

/**
 * Đếm số tài sản KHÔNG phải lovelace bị đánh rơi giữa value vào và value ra. Dùng cho
 * test và cho chốt lúc chạy: > 0 nghĩa là có thứ gì đó rời vault, và nếu đó là NFT danh
 * tính thì mọi nhánh spend về sau đều bị từ chối.
 */
export function droppedUnits(
  inputAssets: AssetsLike,
  outputAssets: AssetsLike,
): string[] {
  return Object.keys(inputAssets)
    .filter(u => u !== "lovelace")
    .filter(u => (inputAssets[u] ?? 0n) > 0n)
    .filter(u => (outputAssets[u] ?? 0n) === 0n);
}

/**
 * Chốt lúc chạy: value sắp trả về vault KHÔNG được đánh rơi tài sản nào của value vào.
 *
 * ⚠ Đọc kỹ trước khi ai đó gỡ nó vì "thừa": nó ĐÚNG LÀ thừa chừng nào chỗ gọi còn dùng
 * `vaultOutValue` — hàm đó bê nguyên value vào nên không thể đánh rơi gì. Nó tồn tại cho
 * đúng một tình huống, và tình huống đó đã xảy ra HAI LẦN: có người thay biểu thức value
 * bằng một object dựng mới (`{ lovelace, [lampUnit] }`). Lúc đó `vaultOutValue` biến mất
 * khỏi dòng đó, còn dòng này ở lại — và nó đổi lỗi từ "chuỗi từ chối tx với thông điệp
 * không nhắc NFT" thành "builder ném lỗi gọi đúng tên thứ bị rơi".
 *
 * Đặt nó thành CÂU LỆNH RIÊNG, đừng gộp vào biểu thức truyền cho `.pay` — gộp lại là nó
 * biến mất cùng lần viết lại mà nó sinh ra để bắt.
 */
export function assertVaultIdentityKept(
  inputAssets: AssetsLike,
  outputAssets: AssetsLike,
): void {
  const dropped = droppedUnits(inputAssets, outputAssets);
  if (dropped.length > 0) {
    throw new Error(
      `INV-VAULT-IDENTITY: value ra của vault đánh rơi ${dropped.length} tài sản ` +
      `(${dropped.join(", ")}). Vault-id NFT là one-shot, không đúc lại được, và mọi ` +
      `nhánh spend đòi nó còn nguyên ở output — rơi là vault chết vĩnh viễn. ` +
      `Dựng value ra bằng vaultOutValue(vaultUtxo.assets, {...}), đừng viết object mới.`,
    );
  }
}

// ── Script tham chiếu CIP-33 ─────────────────────────────────────────────────
//
// Vì sao CHÍNH SÁCH nằm ở đây mà PHÉP BĂM thì không: băm một script cần lucid, còn
// gói này cố ý không có dependency nào (nó được nạp qua `file:` + `prepare.mjs`, và
// `BOUNDARIES.md §4` ghi rõ đó là chỗ dễ vỡ nhất của đường cài). Nên chỗ gọi — vốn
// đã cầm lucid — tự băm rồi đưa hash vào đây; ở đây chỉ so chuỗi và dựng câu lỗi.
//
// Cái được: MỘT bộ mã lỗi cho mọi module. Trước đó cùng một hỏng ra ba mã khác nhau
// (`CONSUME-004/005`, `BIND-DID-004/005`, và một bản nữa ở SDK), nên người đọc log
// không tra ngược được về một nguyên nhân.

/** Một UTxO ứng viên làm script tham chiếu, đã quy về thứ phép so cần. */
export interface RefScriptCandidate {
  /** `txHash#outputIndex` — chỉ dùng để dựng câu lỗi. */
  at: string;
  /** Hash của script UTxO này ĐANG mang; `null` khi nó không mang `scriptRef`. */
  gotHash: string | null;
  /**
   * Vai mà chỗ gọi ĐỊNH dùng UTxO này — chỉ có khi chỗ gọi biết trước (ca một
   * script một UTxO). Đưa được thì câu `REFSCRIPT-001` nêu luôn tên, và người đọc
   * log phân biệt được `vault (WithdrawLamp)` với `vault (UpdateProfile)`.
   */
  intendedFor?: string;
}

/** Một script mà giao dịch BẮT BUỘC phải có chứng từ. */
export interface RefScriptRequirement {
  /** Tên người đọc hiểu, ví dụ `vault (WithdrawLamp)` — đi thẳng vào câu lỗi. */
  what: string;
  wantHash: string;
}

/**
 * Ép tập UTxO tham chiếu phủ ĐỦ các script được đòi.
 *
 * Vì sao phải so HASH chứ không chỉ đếm "có scriptRef": `readFrom` một UTxO mang
 * script SAI vẫn dựng ra một giao dịch hợp lệ về hình dạng, `complete()` không kêu,
 * và nó chết trên chuỗi SAU KHI người dùng đã ký — người dùng thấy màn ký bình
 * thường, ký, rồi nhận một lỗi không trỏ về đâu. Một cổng đếm-suông không phân biệt
 * được hai cực đó.
 *
 * Phép phủ theo TẬP, không theo thứ tự: chỗ gọi truyền một danh sách UTxO mà không
 * có gì bảo đảm thứ tự khớp với thứ tự script. Ghép theo chỉ số là dựng ra một phép
 * kiểm xanh khi hai script bị đổi chỗ.
 *
 * @throws `REFSCRIPT-001` khi một ứng viên không mang `scriptRef`.
 * @throws `REFSCRIPT-002` khi một script được đòi không có ứng viên nào mang.
 */
export function assertRefScriptsCover(
  candidates: RefScriptCandidate[],
  required:   RefScriptRequirement[],
): void {
  for (const c of candidates) {
    if (c.gotHash === null) {
      throw new Error(
        `REFSCRIPT-001: UTxO ${c.at} được đưa vào làm script tham chiếu` +
        `${c.intendedFor === undefined ? "" : ` của ${c.intendedFor}`} nhưng nó ` +
        `KHÔNG mang scriptRef. Đọc từ nó sẽ dựng ra một giao dịch thiếu script, và ` +
        `nó chết trên chuỗi sau khi người dùng đã ký.`,
      );
    }
  }

  const have = new Set(candidates.map((c) => c.gotHash as string));
  for (const r of required) {
    if (!have.has(r.wantHash)) {
      throw new Error(
        `REFSCRIPT-002: không UTxO tham chiếu nào mang ${r.what}.\n` +
        `  cần:  ${r.wantHash}\n` +
        `  thấy: ${candidates.length === 0 ? "(không có UTxO nào)" : [...have].join("\n         ")}\n` +
        `Hai hash khác nhau nghĩa là bản deploy đã trôi khỏi bytes mà mã đang cầm — ` +
        `apply-param là tham số lúc BIÊN DỊCH, nên đổi một giá trị là đổi hash, đổi ` +
        `địa chỉ, và phải công bố một script tham chiếu CIP-33 mới.`,
      );
    }
  }
}

// Chủ vault / thread là `Credential` (commit on-chain 856804fa) — kiểu + chính sách, không Lucid.
export * from "./ownerAuth.js";

// Nhân chứng chủ `Script(h)` khi h là `did_stake` (PhoenixKey) — cổng Cardano tiêm từ ngoài.
export * from "./didStakeOwnerAuth.js";
