// scripts/test_run_result.ts — bộ ca cho `runResult.ts`. Không gọi mạng.
// Chạy từ scripts/:  npx tsx test_run_result.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Mỗi luật có CẶP ca: một ca phải qua, một ca chỉ khác đúng một chỗ phải ném. Ca dương
// đứng một mình xanh được ở cả bản đúng lẫn bản "chấp nhận mọi thứ".

import {
  parseOutRef, parsePositiveInteger, parseFlag, decideStateBook,
  singleOutputIndexWithUnit, resultLine, assertTxHash,
} from "./runResult.js";

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

const H = "ab".repeat(32);          // 64 hex
const PKH = "cd".repeat(28);        // 56 hex
const POLICY = "ef".repeat(28);
const NFT = POLICY + "12".repeat(32);

console.log("── parseOutRef");
ca("dạng chuẩn ⟹ tách đúng", () => {
  const r = parseOutRef(`${H}#3`, "X");
  bang(r.txHash, H, "txHash"); bang(r.outputIndex, 3, "outputIndex");
});
ca("thiếu chỉ số ⟹ ném", () => phaiNem(() => parseOutRef(H, "ENGAGE_OUTREF"), "ENGAGE_OUTREF sai định dạng"));
ca("hash 63 hex ⟹ ném", () => phaiNem(() => parseOutRef(`${H.slice(1)}#0`, "X"), "sai định dạng"));
ca("hash chữ HOA ⟹ ném (không tự hạ)", () => phaiNem(() => parseOutRef(`${H.toUpperCase()}#0`, "X"), "sai định dạng"));
ca("chỉ số âm / số 0 đầu ⟹ ném", () => {
  phaiNem(() => parseOutRef(`${H}#-1`, "X"), "sai định dạng");
  phaiNem(() => parseOutRef(`${H}#01`, "X"), "sai định dạng");
});
ca("khoảng trắng thừa ⟹ ném", () => phaiNem(() => parseOutRef(` ${H}#0`, "X"), "sai định dạng"));

console.log("── parsePositiveInteger");
ca("vắng ⟹ mặc định", () => bang(parsePositiveInteger(undefined, "LAMP_DEPOSIT", 10000n), 10000n, "v"));
ca("'1001' ⟹ 1001n", () => bang(parsePositiveInteger("1001", "LAMP_DEPOSIT", 1n), 1001n, "v"));
ca("'0' ⟹ ném", () => phaiNem(() => parsePositiveInteger("0", "LAMP_DEPOSIT", 1n), "LAMP_DEPOSIT phải là số nguyên dương"));
ca("'-5' ⟹ ném", () => phaiNem(() => parsePositiveInteger("-5", "LAMP_DEPOSIT", 1n), "số nguyên dương"));
ca("'' (đặt rỗng) ⟹ ném, không lấy mặc định", () => phaiNem(() => parsePositiveInteger("", "LAMP_DEPOSIT", 1n), "số nguyên dương"));
ca("' 12 ' / '1e3' / '1.5' ⟹ ném", () => {
  phaiNem(() => parsePositiveInteger(" 12 ", "L", 1n), "số nguyên dương");
  phaiNem(() => parsePositiveInteger("1e3", "L", 1n), "số nguyên dương");
  phaiNem(() => parsePositiveInteger("1.5", "L", 1n), "số nguyên dương");
});

console.log("── parseFlag");
ca("vắng / '0' ⟹ false, '1' ⟹ true", () => {
  bang(parseFlag(undefined, "DRY_RUN"), false, "vắng");
  bang(parseFlag("0", "DRY_RUN"), false, "0");
  bang(parseFlag("1", "DRY_RUN"), true, "1");
});
ca("'true' ⟹ ném (không đọc thành chạy thật)", () => phaiNem(() => parseFlag("true", "DRY_RUN"), "DRY_RUN chỉ nhận"));

console.log("── decideStateBook");
ca("WALLET_SEED, không cờ ⟹ ghi (giữ hành vi runner)", () =>
  bang(decideStateBook({ dryRun: false, flag: undefined, signsWithPrivateKey: false }).write, true, "write"));
ca("PRIVATE_KEY, không cờ ⟹ KHÔNG ghi", () =>
  bang(decideStateBook({ dryRun: false, flag: undefined, signsWithPrivateKey: true }).write, false, "write"));
ca("PRIVATE_KEY + WRITE_STATE_BOOK=1 ⟹ ghi", () =>
  bang(decideStateBook({ dryRun: false, flag: "1", signsWithPrivateKey: true }).write, true, "write"));
ca("WALLET_SEED + WRITE_STATE_BOOK=0 ⟹ KHÔNG ghi", () =>
  bang(decideStateBook({ dryRun: false, flag: "0", signsWithPrivateKey: false }).write, false, "write"));
ca("DRY_RUN thắng cả WRITE_STATE_BOOK=1", () =>
  bang(decideStateBook({ dryRun: true, flag: "1", signsWithPrivateKey: false }).write, false, "write"));
ca("cờ lạ ⟹ ném, kể cả khi DRY_RUN", () => {
  phaiNem(() => decideStateBook({ dryRun: false, flag: "yes", signsWithPrivateKey: false }), "WRITE_STATE_BOOK chỉ nhận");
  phaiNem(() => decideStateBook({ dryRun: true, flag: "yes", signsWithPrivateKey: false }), "WRITE_STATE_BOOK chỉ nhận");
});

console.log("── singleOutputIndexWithUnit");
const ADDR = "addr_test1vault";
ca("đúng 1 output mang NFT ⟹ chỉ số của nó", () => {
  const outs = [
    { address: "addr_test1change", assets: { lovelace: 5n } },
    { address: ADDR, assets: { lovelace: 2n, [NFT]: 1n } },
  ];
  bang(singleOutputIndexWithUnit(outs, ADDR, NFT), 1, "index");
});
ca("NFT ở địa chỉ KHÁC ⟹ ném", () => phaiNem(() =>
  singleOutputIndexWithUnit([{ address: "addr_test1other", assets: { [NFT]: 1n } }], ADDR, NFT), "thấy 0"));
ca("hai output mang NFT ⟹ ném", () => phaiNem(() =>
  singleOutputIndexWithUnit([{ address: ADDR, assets: { [NFT]: 1n } }, { address: ADDR, assets: { [NFT]: 1n } }], ADDR, NFT), "thấy 2"));
ca("lượng 2 thay vì 1 ⟹ ném", () => phaiNem(() =>
  singleOutputIndexWithUnit([{ address: ADDR, assets: { [NFT]: 2n } }], ADDR, NFT), "thấy 0"));

console.log("── resultLine");
const good = { vault_outref: `${H}#0`, vault_nft: NFT, owner: { type: "key" as const, hash: PKH }, dry_run: false };
ca("dạng chuẩn ⟹ 'RESULT ' + JSON một dòng, đọc ngược ra đúng", () => {
  const line = resultLine(good);
  if (!line.startsWith("RESULT {")) throw new Error(`tiền tố sai: ${line.slice(0, 12)}`);
  if (line.includes("\n")) throw new Error("có xuống dòng");
  const j = JSON.parse(line.slice("RESULT ".length));
  bang(j.vault_outref, good.vault_outref, "vault_outref");
  bang(j.owner.type, "key", "owner.type"); bang(j.owner.hash, PKH, "owner.hash");
  bang(j.dry_run, false, "dry_run");
});
ca("dry_run=true có mặt trong JSON", () =>
  bang(JSON.parse(resultLine({ ...good, dry_run: true }).slice(7)).dry_run, true, "dry_run"));
ca("owner.hash 54 hex ⟹ ném", () => phaiNem(() => resultLine({ ...good, owner: { type: "key", hash: PKH.slice(2) } }), "owner.hash"));
ca("owner.type lạ ⟹ ném", () => phaiNem(() => resultLine({ ...good, owner: { type: "pkh" as never, hash: PKH } }), "owner.type"));
ca("vault_outref thiếu '#' ⟹ ném", () => phaiNem(() => resultLine({ ...good, vault_outref: H }), "vault_outref sai định dạng"));
ca("vault_nft lẻ ký tự ⟹ ném", () => phaiNem(() => resultLine({ ...good, vault_nft: NFT + "a" }), "vault_nft"));

console.log("── assertTxHash");
ca("64 hex ⟹ trả nguyên", () => bang(assertTxHash(H, "tx"), H, "hash"));
ca("rỗng ⟹ ném", () => phaiNem(() => assertTxHash("", "tx"), "không phải tx hash"));

console.log(sai === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${sai} ca sai ===`);
process.exit(sai === 0 ? 0 : 1);
