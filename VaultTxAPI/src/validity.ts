// VaultTxAPI/src/validity.ts — MỘT nguồn hạn cho mọi tx dịch vụ phát ra: `validTo` trong thân tx.
//
// ── VÌ SAO TỆP NÀY TỒN TẠI (2026-10-06) ──────────────────────────────────────────
// Trước bản này dịch vụ có BỐN đồng hồ cùng mượn một con số `lock_ttl_ms`: khoá mềm, `expires_at`
// trả app, sổ phát-hành (`× 4`) và sổ input vừa nộp. Còn hạn THẬT — thứ sổ cái ép — là `validTo`
// trong thân tx, và nó khác theo route: 1 giờ (ví trả phí), cuối epoch (gen/consume/schedule),
// 10 phút (tài trợ T2/T3), hoặc KHÔNG CÓ (create-vault/open-thread/bind-did đường `change_address`).
// App hiện `expires_at` cho người dùng, nên người dùng đọc một mốc không nói gì về tx họ ký.
//
// Luật mới, một câu: dịch vụ CHỌN cận trên (`planValidity`), bộ dựng ghi nó vào thân, rồi dịch vụ
// ĐỌC NGƯỢC nó từ chính CBOR (`readTxExpiry`) để ra `expires_at` + `expires_reason` và hạn của sổ
// phát-hành. Không chỗ nào tính lại hạn bằng phép cộng trên đồng hồ của dịch vụ.
//
// ── TẬP `expires_reason` ─────────────────────────────────────────────────────────
// Ba giá trị, mỗi giá trị là MỘT cận đã thắng phép `min`:
//   · `tx_validity`     — hạn ký cấu hình (`VAULT_TX_API_TX_VALIDITY_MS`, mặc định 15 phút);
//   · `epoch_end`       — route mà validator đòi hai cận validity CÙNG một epoch giao thức
//                         (gen, consume, schedule, tài trợ T2–T4): cuối epoch tới trước;
//   · `fee_reservation` — UTxO ví trả phí xin qua `/fee/utxo` hết giờ giữ chỗ ở Feecover
//                         (`reserved_until`) trước: sau mốc đó UTxO đó có thể đã giao cho tx khác.
// Không có `funding_cap` (trần 1 giờ của ví trả phí, `FUNDING_MAX_VALIDITY_MS`): hạn ký cấu hình
// được kẹp ≤ 1 giờ ở `config.ts`, nên trần đó không bao giờ thắng NGẶT. Đổi khoảng cho phép của
// biến môi trường thì phải thêm lại giá trị đó.

import { CML, slotToUnixTime } from "@lucid-evolution/lucid";
import {
  SLOT_LENGTH_MS, WindowOriginError, epochStartMs, posixMsToEpoch, slotFloorMs, type Network,
} from "@magiclamp/protocol-utils";

import { CodedApiError } from "./errors.js";

/** Hạn ký mặc định của một tx (ms tính từ đỉnh chuỗi lúc dựng). Chủ dự án chọn 15 phút. */
export const DEFAULT_TX_VALIDITY_MS = 900_000;

/**
 * Biên lệch đồng hồ giữa máy chạy dịch vụ và nút chuỗi, cộng vào `validTo` khi quyết một tx đã
 * HẾT HẠN ở phía dịch vụ. Sổ cái so slot hiện tại của NÚT với `validTo`; đồng hồ của dịch vụ có thể
 * chạy nhanh hơn vài giây. Trong biên này dịch vụ vẫn gửi tx tới nút và để nút phán (nút từ chối
 * `OutsideValidityInterval` ⟹ 410 như thường) — biên chỉ làm dịch vụ BỚT từ chối nhầm, không làm
 * một tx hết hạn lên được chuỗi. 30 giây rộng gấp nhiều lần lệch NTP thường gặp, và hẹp hơn nhiều
 * so với hạn ký 15 phút.
 */
export const CLOCK_SKEW_MARGIN_MS = 30_000;

export type ExpiresReason = "tx_validity" | "epoch_end" | "fee_reservation";
export const EXPIRES_REASONS: readonly ExpiresReason[] = ["tx_validity", "epoch_end", "fee_reservation"];

export interface ValidityPlan {
  /** Cận trên đã chọn (POSIX ms, căn đầu slot). Bộ dựng KHÔNG được đặt `validTo` vượt mốc này. */
  capMs: bigint;
  /** Cận nào thắng phép `min`. */
  reason: ExpiresReason;
  /** `capMs − tip` cho các bộ dựng tự tính cửa sổ epoch (`epochValidityWindow(…, maxAheadMs)`):
   *  chúng kẹp tiếp vào cuối epoch, nên với route có epoch thì `capMs` chỉ là trần, không phải đích. */
  maxAheadMs: bigint;
}

export interface PlanValidityInput {
  tipPosixMs: bigint;
  network: Network;
  /** Hạn ký cấu hình (ms). */
  txValidityMs: number;
  /** Route mà validator đòi hai cận cùng một epoch giao thức. */
  epochBound: boolean;
  /** `reserved_until` của UTxO ví trả phí xin qua `/fee/utxo` (POSIX ms). Vắng ⟹ không giữ chỗ. */
  feeReservedUntilMs?: number;
}

/**
 * Chọn cận trên cho một lượt dựng: `min(tip + hạn ký, cuối epoch nếu route có epoch, reserved_until)`.
 *
 * Mạng không có gốc cửa sổ epoch (Preview) ⟹ không có ứng viên `epoch_end`: bộ dựng của route có
 * epoch sẽ tự ném `WIN-PREVIEW`, đúng như trước bản này.
 *
 * Giờ giữ chỗ phí đã qua (hoặc còn dưới một slot) ⟹ 409 `FEE_PAYER_RESERVATION_EXPIRED`: dựng tiếp
 * là ra một tx có khoảng hiệu lực rỗng, hoặc một tx tiêu UTxO Feecover đã giao cho người khác.
 */
export function planValidity(p: PlanValidityInput): ValidityPlan {
  const tip = p.tipPosixMs;
  const cands: Array<{ at: bigint; reason: ExpiresReason }> = [
    { at: slotFloorMs(tip + BigInt(p.txValidityMs)), reason: "tx_validity" },
  ];
  if (p.epochBound) {
    let next: bigint | undefined;
    try {
      next = epochStartMs(posixMsToEpoch(tip, p.network) + 1n, p.network);
    } catch (e) {
      if (!(e instanceof WindowOriginError)) throw e;
    }
    // Mốc hợp lệ cuối của epoch là `next − 1`; đầu slot chứa nó là `next − 1000`.
    if (next !== undefined) cands.push({ at: slotFloorMs(next - 1n), reason: "epoch_end" });
  }
  if (p.feeReservedUntilMs !== undefined) {
    cands.push({ at: slotFloorMs(BigInt(p.feeReservedUntilMs)), reason: "fee_reservation" });
  }
  // `min` ổn định: hoà nhau thì cận khai TRƯỚC thắng (hạn ký, rồi cuối epoch, rồi giữ chỗ).
  let best = cands[0]!;
  for (const c of cands) if (c.at < best.at) best = c;
  if (best.reason === "fee_reservation" && best.at - slotFloorMs(tip) < SLOT_LENGTH_MS) {
    const at = new Date(p.feeReservedUntilMs!).toISOString();
    throw new CodedApiError(409, "FEE_PAYER_RESERVATION_EXPIRED",
      `UTxO ví trả phí đã hết giờ giữ chỗ ở Feecover (reserved_until ${at}) trước khi tx kịp có một ` +
      `khoảng hiệu lực. Gọi lại POST /fee/utxo để xin UTxO mới rồi dựng lại.`,
      { reserved_until: at });
  }
  return { capMs: best.at, reason: best.reason, maxAheadMs: best.at - tip };
}

/** `validTo` (POSIX ms) đọc từ thân tx, hoặc `undefined` khi thân không có `ttl`. */
export function validToOfTx(tx: CML.Transaction | string, network: Network): bigint | undefined {
  const t = typeof tx === "string" ? CML.Transaction.from_cbor_hex(tx) : tx;
  const ttl = t.body().ttl();
  return ttl === undefined ? undefined : BigInt(slotToUnixTime(network, Number(ttl)));
}

/** `validFrom` (POSIX ms) đọc từ thân tx, hoặc `undefined` khi thân không có cận dưới. */
export function validFromOfTx(tx: CML.Transaction | string, network: Network): bigint | undefined {
  const t = typeof tx === "string" ? CML.Transaction.from_cbor_hex(tx) : tx;
  const start = t.body().validity_interval_start();
  return start === undefined ? undefined : BigInt(slotToUnixTime(network, Number(start)));
}

export interface TxExpiry {
  /** `validTo` của CHÍNH thân tx (POSIX ms). */
  validToMs: bigint;
  /** Cùng mốc, dạng ISO 8601 UTC (`Date#toISOString`, ví dụ `2026-10-06T00:15:06.000Z`) —
   *  trường `expires_at` app đọc. Giữ đúng khuôn cũ: app chặn ký khi không đọc được nó. */
  expiresAt: string;
  reason: ExpiresReason;
}

/**
 * Đọc hạn từ CHÍNH CBOR vừa dựng và đối chiếu với kế hoạch.
 *
 * Thân không có `ttl`, `validTo` vượt cận đã chọn, hoặc không đứng sau đỉnh chuỗi ⟹ NÉM lỗi bất
 * biến nội bộ (500): bộ dựng đã bỏ qua cận mà dịch vụ giao, và trả tx đó là trả cho app một mốc
 * `expires_at` không phải hạn thật của nó. Không đệm, không suy hộ.
 */
export function readTxExpiry(txCbor: string, network: Network, plan: ValidityPlan, tipPosixMs: bigint): TxExpiry {
  const validToMs = validToOfTx(txCbor, network);
  if (validToMs === undefined) {
    throw new Error("[bất biến nội bộ] tx vừa dựng không có validTo — mọi đường dựng phải đặt hạn (validity.ts).");
  }
  if (validToMs > plan.capMs) {
    throw new Error(
      `[bất biến nội bộ] validTo ${validToMs} của tx vừa dựng vượt cận đã chọn ${plan.capMs} (${plan.reason}) — ` +
      `bộ dựng đã bỏ qua cận dịch vụ giao.`);
  }
  if (validToMs <= tipPosixMs) {
    throw new Error(`[bất biến nội bộ] validTo ${validToMs} của tx vừa dựng không đứng sau đỉnh chuỗi ${tipPosixMs}.`);
  }
  return { validToMs, expiresAt: new Date(Number(validToMs)).toISOString(), reason: plan.reason };
}

/** Câu hạn cho `witness_notes`, sinh từ `expires_at` thật — không còn chuỗi "≤ 1 giờ" cứng. */
export function expiryNote(e: Pick<TxExpiry, "expiresAt" | "reason">): string {
  const why = e.reason === "epoch_end"
    ? "cuối epoch giao thức tới trước hạn ký"
    : e.reason === "fee_reservation"
      ? "giờ giữ chỗ UTxO ví trả phí ở Feecover hết trước hạn ký"
      : "hạn ký của dịch vụ";
  return `Hạn dùng: giao dịch này chỉ lên chuỗi được trước ${e.expiresAt} (${why}). Ký và nộp trước mốc đó; ` +
    `quá mốc thì /tx/submit trả 410 TX_EXPIRED và phải dựng lại.`;
}
