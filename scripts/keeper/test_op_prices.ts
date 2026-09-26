// scripts/keeper/test_op_prices.ts — bộ ca của `parseOpPriceSet` / `applyOpPriceSet`. Không gọi mạng.
// Chạy: npx tsx keeper/test_op_prices.ts   (từ thư mục scripts/)
// Dòng cuối NÓI RA trạng thái: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===`.
import { assertValidPriceParam, M_MIN_Q, M_MAX_Q, Q } from "@magiclamp/consumemagic-pricing";
import { applyOpPriceSet, parseOpPriceSet, resolvePricePush } from "./opPrices.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
};
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

// Giá op 1–4 lấy theo bảng trên hai beacon Preprod (đọc Koios 2026-09-25), dựng theo lược đồ
// dòng ba trường. Op 2 mang hệ số cầu 1,5× để các ca dưới phân biệt được "giữ hệ số của dòng"
// với "đặt lại về Q": nếu mọi dòng đều mang Q thì hai hành vi đó cho cùng kết quả.
const beacon = [
  { op_type: 1n, base_price: 10_000_000n, demand_mult: Q },
  { op_type: 2n, base_price: 1_000_000n, demand_mult: 1_500_000_000n },
  { op_type: 3n, base_price: 1_000_000_000n, demand_mult: Q },
  { op_type: 4n, base_price: 1_000_000_000n, demand_mult: Q },
];
const param = (op_prices: typeof beacon) => ({ op_prices, m_min: M_MIN_Q, m_max: M_MAX_Q, epoch: 4145n });

// Ca dùng thật: thêm 7 và 8.
const set78 = parseOpPriceSet("7:2000000000, 8:10000000000");
const r78 = applyOpPriceSet(beacon, set78);
check("thêm 7·8 → 6 dòng, tăng ngặt",
  r78.rows.map((r) => r.op_type).join(",") === "1,2,3,4,7,8", r78.rows.map((r) => r.op_type).join(","));
check("thêm 7·8 → hai thay đổi, cả hai là dòng mới",
  r78.changes.length === 2 && r78.changes.every((c) => c.from === undefined), JSON.stringify(r78.changes, (_, v) => String(v)));
check("bảng sau khi thêm vẫn qua assertValidPriceParam",
  !throws(() => assertValidPriceParam(param(r78.rows))));
check("dòng mới 7·8 nhận demand_mult = Q (mã 7 bắt buộc Q, PRICE-017)",
  r78.rows.filter((r) => r.op_type >= 7n).every((r) => r.demand_mult === Q));
check("thêm 7·8 không đụng hệ số của dòng cũ", r78.rows.find((r) => r.op_type === 2n)?.demand_mult === 1_500_000_000n);

// Cặp quyết định cho "keeper không gửi thừa": chạy lại khi beacon đã mang 7·8 thì KHÔNG có thay đổi.
const again = applyOpPriceSet(r78.rows, set78);
check("chạy lại trên bảng đã có 7·8 → 0 thay đổi", again.changes.length === 0, `${again.changes.length} thay đổi`);

// Đổi giá dòng đã có: ghi được giá cũ.
const bump = applyOpPriceSet(beacon, parseOpPriceSet("2:2000000"));
check("đổi giá op 2 → một thay đổi mang giá cũ",
  bump.changes.length === 1 && bump.changes[0]!.from === 1_000_000n && bump.changes[0]!.to === 2_000_000n);
check("đổi giá không xoá dòng nào", bump.rows.length === beacon.length);
check("đổi giá op 2 giữ hệ số cầu 1,5× của dòng đó, không đặt lại về Q",
  bump.rows.find((r) => r.op_type === 2n)?.demand_mult === 1_500_000_000n);

// Biến rỗng ⟹ không đổi gì (đường mặc định của keeper).
check("biến rỗng → 0 dòng", parseOpPriceSet(undefined).length === 0 && parseOpPriceSet("").length === 0);

// Ca âm: sai dạng và trùng op_type phải NÉM, không bỏ qua.
check("sai dạng '7=2' → ném", throws(() => parseOpPriceSet("7=2")));
check("số âm '7:-1' → ném", throws(() => parseOpPriceSet("7:-1")));
check("trùng op_type trong biến → ném", throws(() => parseOpPriceSet("7:1,7:2")));

// Giá vượt luật on-chain: hàm gộp không tự chặn, assertValidPriceParam phải chặn.
const tooLow = applyOpPriceSet(beacon, parseOpPriceSet("7:1"));
check("base_price=1 (base×m_min < Q) → assertValidPriceParam ném",
  throws(() => assertValidPriceParam(param(tooLow.rows))));

// resolvePricePush: bảng đặt SAI ⟹ VẪN đẩy epoch, chỉ lùi bảng giá về bảng đang trên chuỗi.
// Vá lượt bỏ nguyên epoch khi KEEPER_OP_PRICES_SET gõ sai một lần — max_price_stale = 1 thì bỏ
// một lượt là mọi Consume chết sau ~2 epoch (xem chú thích `resolvePricePush`).
const current = param(beacon);
const badSet = parseOpPriceSet("7:1"); // base×m_min < Q, cùng ca "tooLow" ở trên
const resolvedBad = resolvePricePush(current, badSet, 4146n);
check("bảng đặt sai → datum gửi đi giữ nguyên op_prices cũ",
  JSON.stringify(resolvedBad.next.op_prices, (_, v) => String(v)) === JSON.stringify(beacon, (_, v) => String(v)),
  JSON.stringify(resolvedBad.next.op_prices, (_, v) => String(v)));
check("bảng đặt sai → epoch vẫn đẩy sang epoch mới", resolvedBad.next.epoch === 4146n);
check("bảng đặt sai → datum kết quả vẫn hợp lệ (mới đẩy epoch được)",
  !throws(() => assertValidPriceParam(resolvedBad.next)));
check("bảng đặt sai → có cảnh báo priceWarning, không nuốt lỗi",
  typeof resolvedBad.priceWarning === "string" && resolvedBad.priceWarning.length > 0);
check("bảng đặt sai → tableNote rỗng (không báo thay đổi không xảy ra)", resolvedBad.tableNote === "");

// Đối chứng: bảng đặt ĐÚNG thì đi nhánh nhanh — không cảnh báo, epoch mới, bảng đã áp set.
const resolvedOk = resolvePricePush(current, parseOpPriceSet("2:2000000"), 4146n);
check("bảng đặt đúng → không có priceWarning", resolvedOk.priceWarning === undefined);
check("bảng đặt đúng → epoch mới", resolvedOk.next.epoch === 4146n);
check("bảng đặt đúng → áp giá mới vào op_prices",
  resolvedOk.next.op_prices.find((r) => r.op_type === 2n)?.base_price === 2_000_000n);

console.log(failures === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${failures} ca sai ===`);
process.exit(failures === 0 ? 0 : 1);
