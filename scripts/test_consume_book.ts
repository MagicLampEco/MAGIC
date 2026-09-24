// scripts/test_consume_book.ts — bộ ca cho `consumeBook.ts`. Không gọi mạng.
// Chạy từ scripts/:  npx tsx test_consume_book.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).

import { consumeKey, parseVaultKind, selectConsumeBook } from "./consumeBook.js";

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

console.log("── parseVaultKind");
ca("nhận schedule / instant, không phân biệt hoa thường", () => {
  bang(parseVaultKind("schedule"), "schedule", "schedule");
  bang(parseVaultKind("INSTANT"), "instant", "INSTANT");
});
ca("không có mặc định: rỗng ⟹ ném", () => phaiNem(() => parseVaultKind(undefined), "Không có mặc định"));
ca("giá trị lạ ⟹ ném", () => phaiNem(() => parseVaultKind("prepaid"), "prepaid"));

console.log("── selectConsumeBook");
ca("chép đúng bộ của loại được chọn, không lấy bộ kia", () => {
  const env: Record<string, string | undefined> = {
    CONSUME_SCRIPT_HASH_SCHEDULE: "aa", CONSUME_SCRIPT_HASH_INSTANT: "bb",
  };
  selectConsumeBook(env, "instant", ["CONSUME_SCRIPT_HASH"]);
  bang(env.CONSUME_SCRIPT_HASH, "bb", "CONSUME_SCRIPT_HASH");
});
ca("khoá không hậu tố còn sót bị XOÁ khi bộ được chọn không có khoá đó", () => {
  // Ca đã xảy ra: sổ còn PRICE_BEACON_UTXO của đời trước. Để yên thì nó lọt qua.
  const env: Record<string, string | undefined> = {
    CONSUME_SCRIPT_HASH_SCHEDULE: "aa", PRICE_BEACON_UTXO: "cu#0",
  };
  selectConsumeBook(env, "schedule", ["CONSUME_SCRIPT_HASH"]);
  bang(env.PRICE_BEACON_UTXO, undefined, "PRICE_BEACON_UTXO");
});
ca("khoá không hậu tố bị GHI ĐÈ bằng bản có hậu tố", () => {
  const env: Record<string, string | undefined> = {
    CONSUME_SCRIPT_HASH: "cu", CONSUME_SCRIPT_HASH_SCHEDULE: "moi",
  };
  selectConsumeBook(env, "schedule", ["CONSUME_SCRIPT_HASH"]);
  bang(env.CONSUME_SCRIPT_HASH, "moi", "CONSUME_SCRIPT_HASH");
});
ca("thiếu khoá bắt buộc ⟹ ném, câu lỗi nêu đúng tên có hậu tố", () => {
  phaiNem(() => selectConsumeBook({}, "instant", ["REF_CONSUME_UTXO"]), "REF_CONSUME_UTXO_INSTANT");
});
ca("sổ chỉ có bản không hậu tố ⟹ ném, KHÔNG đọc bản đó, câu lỗi gọi tên nó", () => {
  const env: Record<string, string | undefined> = { CONSUME_SCRIPT_HASH: "cu" };
  phaiNem(() => selectConsumeBook(env, "schedule", ["CONSUME_SCRIPT_HASH"]), "bản không hậu tố");
});
ca("khoá tuỳ chọn vắng ⟹ không ném", () => {
  const env: Record<string, string | undefined> = { CONSUME_SCRIPT_HASH_SCHEDULE: "aa" };
  selectConsumeBook(env, "schedule", ["CONSUME_SCRIPT_HASH"]);
  bang(env.ENGAGE_UTXO, undefined, "ENGAGE_UTXO");
});
ca("consumeKey ghép hậu tố HOA", () => bang(consumeKey("ENGAGE_UTXO", "instant"), "ENGAGE_UTXO_INSTANT", "khoá"));

console.log(sai === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${sai} ca sai ===`);
process.exit(sai === 0 ? 0 : 1);
