// scripts/keeper/opPrices.ts — gộp các dòng giá đặt qua `KEEPER_OP_PRICES_SET` vào bảng giá
// đang nằm trên beacon.
//
// Vì sao việc này nằm trong keeper chứ không ở một kịch bản riêng: `price_param.ak` chỉ nhận
// `out.epoch > in.epoch` và `out.epoch <= epoch hiện tại`, nên mỗi beacon đổi được ĐÚNG MỘT
// lần mỗi epoch — và lượt đó keeper dùng để đẩy epoch. Một kịch bản thứ hai sẽ giành lượt ấy
// với keeper; ai tới sau phải chờ trọn một epoch (5 ngày trên Preprod). Đặt dòng giá cùng
// lượt đẩy epoch thì không có gì để giành.
//
// Thuần, không gọi mạng. Kiểm tính hợp lệ của bảng sau khi gộp là việc của
// `assertValidPriceParam` (ConsumeMAGIC/pricing) — hàm này không chép lại luật đó.

import { Q, toCanonicalOpPrices, type OpPriceRow } from "@magiclamp/consumemagic-pricing";

/**
 * Một dòng đặt qua biến môi trường: CHỈ giá gốc. `demand_mult` không đặt được từ đây — dòng
 * đã có giữ hệ số đang nằm trên beacon, dòng mới nhận `Q` (1×). Hệ số cầu từng mã là việc của
 * lượt điều giá theo cầu, không phải của lượt đặt bảng.
 */
export interface OpPriceSetRow { op_type: bigint; base_price: bigint }

/**
 * Đọc `"<op_type>:<base_price>,…"`. Rỗng ⟹ mảng rỗng.
 * Ném khi sai dạng: một biến môi trường gõ nhầm mà bị bỏ qua im lặng thì keeper báo "xong"
 * trong khi dòng giá không bao giờ lên chuỗi.
 */
export function parseOpPriceSet(raw: string | undefined): OpPriceSetRow[] {
  const rows: OpPriceSetRow[] = [];
  for (const item of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+):(\d+)$/.exec(item);
    if (!m) throw new Error(`KEEPER_OP_PRICES_SET: "${item}" sai dạng — cần <op_type>:<base_price> (số nguyên, nanogic)`);
    rows.push({ op_type: BigInt(m[1]!), base_price: BigInt(m[2]!) });
  }
  // Hai dòng cùng op_type trong chính biến môi trường: không có dòng nào "thắng" an toàn.
  toCanonicalOpPrices(rows.map((r) => ({ ...r, demand_mult: Q })));
  return rows;
}

export interface OpPriceChange { op_type: bigint; from?: bigint; to: bigint }

/**
 * Đặt từng dòng của `set` vào `current`: thêm dòng mới (`demand_mult = Q`), đổi giá dòng đã có
 * (giữ `demand_mult` của dòng đó). Không xoá dòng nào.
 * Trả bảng ở dạng chuẩn tắc (op_type tăng ngặt) và danh sách thay đổi; `changes` rỗng nghĩa
 * là bảng trên beacon đã đúng như yêu cầu.
 */
export function applyOpPriceSet(
  current: ReadonlyArray<OpPriceRow>,
  set: ReadonlyArray<OpPriceSetRow>,
): { rows: OpPriceRow[]; changes: OpPriceChange[] } {
  const byType = new Map(current.map((r) => [r.op_type, r]));
  const changes: OpPriceChange[] = [];
  for (const r of set) {
    const cur = byType.get(r.op_type);
    if (cur?.base_price === r.base_price) continue;
    changes.push(cur === undefined ? { op_type: r.op_type, to: r.base_price } : { op_type: r.op_type, from: cur.base_price, to: r.base_price });
    byType.set(r.op_type, { op_type: r.op_type, base_price: r.base_price, demand_mult: cur?.demand_mult ?? Q });
  }
  const rows = toCanonicalOpPrices([...byType.values()]);
  return { rows, changes };
}

export function describeChanges(changes: ReadonlyArray<OpPriceChange>): string {
  return changes
    .map((c) => (c.from === undefined ? `+op ${c.op_type}=${c.to}` : `op ${c.op_type}: ${c.from}→${c.to}`))
    .join(", ");
}
