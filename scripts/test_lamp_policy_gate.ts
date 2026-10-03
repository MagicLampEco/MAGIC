// scripts/test_lamp_policy_gate.ts — bộ ca cho cổng `LAMP_POLICY_ID` ở `config.ts`
// (`checkLampPolicyId` · `POLICY_IDS.lamp`) và cho việc hai bản chép tay của các bảng
// policy — ở đây và ở `MagicSDK/src/lampPolicy.ts` — còn trùng tập khoá. Không gọi mạng.
// Chạy từ scripts/:  npx tsx test_lamp_policy_gate.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Mỗi luật có CẶP ca: một ca phải qua, một ca chỉ khác đúng MỘT biến (ack · policy ·
// mạng) phải ném. Ca dương đứng một mình xanh được ở cả bản đúng lẫn bản "cho qua mọi
// đời đã bị thay".
//
// `config.ts` ném ngay lúc import nếu thiếu biến Blockfrost/ví, và nạp `dotenv` từ thư
// mục đang đứng. Bộ ca này đặt GIÁ TRỊ GIẢ cho hai biến đó (không bao giờ đọc giá trị
// thật) và đổi thư mục đang đứng sang một thư mục tạm rỗng TRƯỚC khi import, để không
// `.env` nào của máy chạy lọt vào phép đo.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir(mkdtempSync(join(tmpdir(), "lamp-policy-gate-")));
process.env.BLOCKFROST_KEY = "gia-tri-gia-cua-bo-kiem";
process.env.WALLET_SEED = "gia tri gia cua bo kiem";
delete process.env.PRIVATE_KEY;
process.env.NETWORK = "Preprod";
delete process.env.LAMP_POLICY_ID;
delete process.env.LAMP_REHEARSAL_ACK;

const cfg = await import("./config.js");
const sdk = await import("../MagicSDK/src/lampPolicy.js");

let sai = 0;
function ca(ten: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${ten}`); }
  catch (e) { sai++; console.log(`  ✗ ${ten}\n      ${(e as Error).message.split("\n")[0]}`); }
}
function bang<T>(thuc: T, cho: T, nhan: string) {
  if (thuc !== cho) throw new Error(`${nhan}: nhận ${String(thuc)}, chờ ${String(cho)}`);
}
function phaiNem(fn: () => void, chua: string) {
  try { fn(); } catch (e) {
    const m = (e as Error).message;
    if (!m.includes(chua)) throw new Error(`ném nhưng câu lỗi thiếu "${chua}": ${m.split("\n")[0]}`);
    return;
  }
  throw new Error("KHÔNG ném");
}

/** Đời tập dượt — nằm trong CẢ bảng đã-bị-thay lẫn bảng tập dượt. */
const REHEARSAL = "8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd";
/** Đã bị thay, NGOÀI bảng tập dượt. */
const SUPERSEDED_ONLY = "d9c09230079b810ab5ed92e8db4c190d42efc42db6aac028656f7e07";
/** Policy tLAMP Preprod CUỐI (thư LAMP `lam1003mg-a`, 2026-10-03; `DEPLOYED.md`). */
const ACTIVE = "493002cc03004e3e14fd607cfba59312bd946e478e69d6ab431ccfac";
/** Hai đời bỏ 2026-10-03 — cả hai bị thay bởi ACTIVE. */
const DROPPED_53BC = "53bc12ade5ee24d43750b9560f152a54b48b804fab34dab810fb8743";
const DROPPED_7ECB = "7ecbffe2b41f68c917035f52a1053efbd2323dfd85a81cf840089ea2";
/** 56 hex hợp lệ, không nằm trong bảng nào. */
const UNKNOWN = "ab".repeat(28);
const LOOKALIKE = "28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4";

const BI_THAY = "ĐÃ BỊ THAY";

console.log("── checkLampPolicyId: lối mở tập dượt");
ca("8169b76c không ack ⟹ ném", () =>
  phaiNem(() => cfg.checkLampPolicyId(REHEARSAL, undefined, "Preprod"), BI_THAY));
ca("8169b76c ack = chính nó, Preprod ⟹ qua", () =>
  bang(cfg.checkLampPolicyId(REHEARSAL, REHEARSAL, "Preprod"), REHEARSAL, "trả về"));
ca("8169b76c ack = chính nó, Mainnet ⟹ ném", () =>
  phaiNem(() => cfg.checkLampPolicyId(REHEARSAL, REHEARSAL, "Mainnet"), BI_THAY));
ca("8169b76c ack = chính nó, mạng lạ ('preprod' thường) ⟹ ném", () =>
  phaiNem(() => cfg.checkLampPolicyId(REHEARSAL, REHEARSAL, "preprod"), BI_THAY));
ca("8169b76c ack = '1' (kiểu cờ) ⟹ ném — xác nhận là GIÁ TRỊ", () =>
  phaiNem(() => cfg.checkLampPolicyId(REHEARSAL, "1", "Preprod"), BI_THAY));
ca("d9c09230 (ngoài bảng tập dượt) ack = chính nó ⟹ vẫn ném", () =>
  phaiNem(() => cfg.checkLampPolicyId(SUPERSEDED_ONLY, SUPERSEDED_ONLY, "Preprod"), BI_THAY));
ca("ack = 8169b76c nhưng policy = d9c09230 ⟹ ném", () =>
  phaiNem(() => cfg.checkLampPolicyId(SUPERSEDED_ONLY, REHEARSAL, "Preprod"), BI_THAY));
ca("ACTIVE 493002cc không ack ⟹ qua", () =>
  bang(cfg.checkLampPolicyId(ACTIVE, undefined, "Preprod"), ACTIVE, "trả về"));

console.log("── checkLampPolicyId: hai đời bỏ 2026-10-03 (cặp với ca ACTIVE ngay trên)");
ca("53bc12ad không ack ⟹ ném, câu lỗi nêu policy thay thế 493002cc", () =>
  phaiNem(() => cfg.checkLampPolicyId(DROPPED_53BC, undefined, "Preprod"), "493002cc"));
ca("7ecbffe2 không ack ⟹ ném, câu lỗi nêu policy thay thế 493002cc", () =>
  phaiNem(() => cfg.checkLampPolicyId(DROPPED_7ECB, undefined, "Preprod"), "493002cc"));
ca("53bc12ad ack = chính nó, Preprod ⟹ VẪN ném (không nằm trong bảng tập dượt)", () =>
  phaiNem(() => cfg.checkLampPolicyId(DROPPED_53BC, DROPPED_53BC, "Preprod"), BI_THAY));
ca("7ecbffe2 ack = chính nó, Preprod ⟹ VẪN ném", () =>
  phaiNem(() => cfg.checkLampPolicyId(DROPPED_7ECB, DROPPED_7ECB, "Preprod"), BI_THAY));
// Giới hạn ĐÃ KHAI, ghim lại để ai đổi sang danh sách CHO PHÉP phải đảo ca này có chủ ý:
// cổng là danh sách TỪ CHỐI, nên một hex 56 ký tự lạ đi qua.
ca("hex lạ ngoài mọi bảng ⟹ QUA (cổng là danh sách từ chối, không phải cho phép)", () =>
  bang(cfg.checkLampPolicyId(UNKNOWN, undefined, "Preprod"), UNKNOWN, "trả về"));
ca("ack KHÔNG mở cửa cho policy nhái", () =>
  phaiNem(() => cfg.checkLampPolicyId(LOOKALIKE, LOOKALIKE, "Preprod"), "KHÔNG PHẢI LAMP"));
ca("sai hình dạng vẫn ném câu cũ", () =>
  phaiNem(() => cfg.checkLampPolicyId("", undefined, "Preprod"), "thiếu hoặc sai hình dạng"));

console.log("── POLICY_IDS.lamp: ack đi từ MÔI TRƯỜNG tới cổng (NETWORK=Preprod lúc import)");
ca("LAMP_POLICY_ID=8169b76c, không LAMP_REHEARSAL_ACK ⟹ ném", () => {
  process.env.LAMP_POLICY_ID = REHEARSAL;
  delete process.env.LAMP_REHEARSAL_ACK;
  phaiNem(() => cfg.POLICY_IDS.lamp, BI_THAY);
});
ca("LAMP_POLICY_ID=8169b76c, LAMP_REHEARSAL_ACK=8169b76c ⟹ qua", () => {
  process.env.LAMP_POLICY_ID = REHEARSAL;
  process.env.LAMP_REHEARSAL_ACK = REHEARSAL;
  bang(cfg.POLICY_IDS.lamp, REHEARSAL, "POLICY_IDS.lamp");
});
ca("LAMP_POLICY_ID=d9c09230, LAMP_REHEARSAL_ACK=8169b76c ⟹ ném", () => {
  process.env.LAMP_POLICY_ID = SUPERSEDED_ONLY;
  process.env.LAMP_REHEARSAL_ACK = REHEARSAL;
  phaiNem(() => cfg.POLICY_IDS.lamp, BI_THAY);
});
ca("LAMP_POLICY_ID=493002cc (policy cuối), không ack ⟹ qua", () => {
  process.env.LAMP_POLICY_ID = ACTIVE;
  delete process.env.LAMP_REHEARSAL_ACK;
  bang(cfg.POLICY_IDS.lamp, ACTIVE, "POLICY_IDS.lamp");
});
ca("LAMP_POLICY_ID=53bc12ad (sổ trạng thái cũ), không ack ⟹ ném", () => {
  process.env.LAMP_POLICY_ID = DROPPED_53BC;
  delete process.env.LAMP_REHEARSAL_ACK;
  phaiNem(() => cfg.POLICY_IDS.lamp, "493002cc");
});
delete process.env.LAMP_POLICY_ID;
delete process.env.LAMP_REHEARSAL_ACK;

// So TỪNG bảng một, và so TẬP chứ không so số đếm: hai bảng lệch nhau hai mục khác nhau
// vẫn cho cùng một số; một khoá chuyển nhầm sang bảng kia vẫn cho cùng một hợp.
console.log("── hai bản chép tay trùng TẬP KHOÁ (scripts/config.ts ↔ MagicSDK/src/lampPolicy.ts)");
const tap = (o: Record<string, string>) => Object.keys(o).sort().join(",");
for (const ten of ["NON_LAMP_LOOKALIKE_POLICIES", "SUPERSEDED_LAMP_POLICIES", "REHEARSAL_LAMP_POLICIES"] as const) {
  ca(`${ten}: cùng tập khoá`, () => bang(tap(cfg[ten]), tap(sdk[ten]), ten));
}
ca("bảng tập dượt là tập con của bảng đã-bị-thay (cả hai bên)", () => {
  for (const p of Object.keys(cfg.REHEARSAL_LAMP_POLICIES)) {
    if (!cfg.SUPERSEDED_LAMP_POLICIES[p]) throw new Error(`config.ts: ${p} không nằm trong bảng đã-bị-thay`);
  }
  for (const p of Object.keys(sdk.REHEARSAL_LAMP_POLICIES)) {
    if (!sdk.SUPERSEDED_LAMP_POLICIES[p]) throw new Error(`lampPolicy.ts: ${p} không nằm trong bảng đã-bị-thay`);
  }
});

if (sai === 0) console.log("=== ĐẠT ===");
else { console.log(`=== HỎNG: ${sai} ca sai ===`); process.exit(1); }
