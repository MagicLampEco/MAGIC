// src/tx/window.ts — kỳ (epoch) của một giao dịch, gương `prepaid.ak ▸ get_epoch`.
//
// On-chain: cả hai cận validity phải HỮU HẠN, và
//   (lo − window_origin_ms) / ms_per_epoch == (hi − window_origin_ms) / ms_per_epoch
// (Aiken `/` là chia lấy sàn). Lệch kỳ ⟹ mọi nhánh spend của vault lẫn quỹ đều chết.
// Nên bộ dựng KHÔNG nhận "epoch" do người gọi khai — nó suy epoch từ đúng cặp cận
// sẽ ghi vào tx, để datum đầu ra và validator đọc cùng một con số.

/** Cặp cận validity (POSIX mili-giây) sẽ ghi vào tx qua `validFrom` / `validTo`. */
export interface TxValidity {
  fromMs: bigint;
  toMs: bigint;
}

/** Chia lấy sàn cho BigInt (BigInt `/` cắt về 0, Aiken `/` lấy sàn). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

/** Kỳ chứa thời điểm `ms` theo lưới (P, O). */
export function epochAtMs(ms: bigint, msPerEpoch: bigint, windowOriginMs: bigint): bigint {
  if (msPerEpoch <= 0n) throw new Error(`msPerEpoch phải > 0, nhận ${msPerEpoch}`);
  return floorDiv(ms - windowOriginMs, msPerEpoch);
}

/** Gương `get_epoch`: hai cận cùng kỳ thì trả kỳ đó, khác kỳ thì NÉM. */
export function epochOfValidity(
  v: TxValidity,
  msPerEpoch: bigint,
  windowOriginMs: bigint,
): bigint {
  if (v.toMs < v.fromMs) throw new Error(`validity ngược: from ${v.fromMs} > to ${v.toMs}`);
  const lo = epochAtMs(v.fromMs, msPerEpoch, windowOriginMs);
  const hi = epochAtMs(v.toMs, msPerEpoch, windowOriginMs);
  if (lo !== hi) {
    throw new Error(
      `[C-PP-EPOCH] validity [${v.fromMs}, ${v.toMs}] vắt qua hai kỳ (${lo} → ${hi}); ` +
        `validator đòi hai cận cùng một kỳ theo gốc cửa sổ ${windowOriginMs}.`,
    );
  }
  return lo;
}

/**
 * Một cặp cận gọn trong kỳ hiện tại: từ `nowMs − backMs` tới `nowMs + ttlMs`, kẹp
 * vào trong kỳ chứa `nowMs` và chừa 1 giây ở mỗi biên — ledger đổi mili-giây sang
 * slot bằng phép sàn theo giây, nên một cận đặt sát biên có thể rơi sang kỳ bên kia
 * sau khi làm tròn.
 */
export function validityInEpoch(
  nowMs: bigint,
  msPerEpoch: bigint,
  windowOriginMs: bigint,
  ttlMs: bigint = 600_000n,
  backMs: bigint = 60_000n,
): TxValidity {
  const e = epochAtMs(nowMs, msPerEpoch, windowOriginMs);
  const start = windowOriginMs + e * msPerEpoch;
  const end = start + msPerEpoch; // biên trên, KHÔNG thuộc kỳ e
  const fromMs = nowMs - backMs > start + 1_000n ? nowMs - backMs : start + 1_000n;
  const toMs = nowMs + ttlMs < end - 1_000n ? nowMs + ttlMs : end - 1_000n;
  // Cận trên là ttl LOẠI TRỪ, tính theo slot sau phép sàn giây: sổ cái chỉ nhận khi
  // slot(now) < slot(toMs). `nowMs == toMs` (hay cùng một giây) thì cửa sổ không chứa
  // tip dù hai số mili-giây trông như hợp lệ.
  if (toMs < fromMs || nowMs < fromMs || nowMs / 1_000n >= toMs / 1_000n) {
    throw new Error(
      `[C-PP-EPOCH] thời điểm ${nowMs} nằm trong giây đầu/cuối của kỳ ${e} — đợi qua biên rồi dựng lại.`,
    );
  }
  return { fromMs, toMs };
}
