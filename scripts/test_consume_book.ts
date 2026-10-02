// scripts/test_consume_book.ts — bộ ca cho `consumeBook.ts`. Không gọi mạng.
// Chạy từ scripts/:  npx tsx test_consume_book.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).

import {
  consumeKey, parseVaultKind, requireConsumeVaultHash, selectConsumeBook, vaultHashKey, vaultRefKey,
} from "./consumeBook.js";

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
ca("nhận schedule / instant / prepaid, không phân biệt hoa thường", () => {
  bang(parseVaultKind("schedule"), "schedule", "schedule");
  bang(parseVaultKind("INSTANT"), "instant", "INSTANT");
  bang(parseVaultKind("Prepaid"), "prepaid", "Prepaid");
});
ca("mỗi loại trỏ đúng khoá hash vault của nó", () => {
  bang(vaultHashKey("schedule"), "VAULT_SCHEDULE_HASH", "schedule");
  bang(vaultHashKey("instant"), "VAULT_INSTANT_HASH", "instant");
  bang(vaultHashKey("prepaid"), "VAULT_PREPAID_HASH", "prepaid");
  bang(consumeKey("CONSUME_SCRIPT_HASH", "prepaid"), "CONSUME_SCRIPT_HASH_PREPAID", "consumeKey prepaid");
});
ca("không có mặc định: rỗng ⟹ ném", () => phaiNem(() => parseVaultKind(undefined), "Không có mặc định"));
ca("giá trị lạ ⟹ ném", () => phaiNem(() => parseVaultKind("snapshot"), "snapshot"));

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


console.log("── requireConsumeVaultHash (bước 09 chọn hash vault, fail-closed)");
const H_P = "7a".repeat(28);
const H_Q = "7b".repeat(28);
ca("prepaid: sổ khớp hash dựng lại ⟹ trả hash", () => {
  bang(requireConsumeVaultHash({ VAULT_PREPAID_HASH: H_P }, "prepaid", H_P), H_P, "hash");
});
ca("prepaid CỰC ĐỐI: sổ ≠ hash dựng lại (đời CARP khác) ⟹ ném", () => {
  phaiNem(() => requireConsumeVaultHash({ VAULT_PREPAID_HASH: H_P }, "prepaid", H_Q), "đời CARP");
});
ca("prepaid: không truyền hash dựng lại ⟹ ném (đối chiếu là bắt buộc)", () => {
  phaiNem(() => requireConsumeVaultHash({ VAULT_PREPAID_HASH: H_P }, "prepaid"), "chưa truyền hash dựng lại");
});
ca("prepaid: thiếu VAULT_PREPAID_HASH ⟹ ném, chỉ đúng bước 10", () => {
  phaiNem(() => requireConsumeVaultHash({ VAULT_INSTANT_HASH: H_P }, "prepaid", H_P), "VAULT_PREPAID_HASH");
  phaiNem(() => requireConsumeVaultHash({}, "prepaid", H_P), "bước 10");
});
ca("giá trị giữ chỗ / sai hình dạng ⟹ ném", () => {
  phaiNem(() => requireConsumeVaultHash({ VAULT_PREPAID_HASH: "FILL_AFTER_AIKEN_BUILD" }, "prepaid", H_P), "Thiếu");
  phaiNem(() => requireConsumeVaultHash({ VAULT_PREPAID_HASH: H_P.toUpperCase() }, "prepaid", H_P), "hex thường");
});
ca("VAULT_HASH khác ⟹ ném; schedule/instant không đòi hash dựng lại", () => {
  phaiNem(() => requireConsumeVaultHash({ VAULT_SCHEDULE_HASH: H_P, VAULT_HASH: H_Q }, "schedule"), "VAULT_HASH");
  bang(requireConsumeVaultHash({ VAULT_INSTANT_HASH: H_Q }, "instant"), H_Q, "instant");
});
ca("ref vault chân thứ hai: prepaid ⟹ REF_VAULT_PREPAID_UTXO (bước 10)", () => {
  bang(vaultRefKey("prepaid").key, "REF_VAULT_PREPAID_UTXO", "key");
  bang(vaultRefKey("prepaid").step, "bước 10", "step");
  bang(vaultRefKey("schedule").key, "REF_VAULT_SCHEDULE_UTXO", "schedule");
});

console.log(sai === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${sai} ca sai ===`);
process.exit(sai === 0 ? 0 : 1);
