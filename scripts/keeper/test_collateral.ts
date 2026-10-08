// scripts/keeper/test_collateral.ts — bộ ca của `keeper/collateral.ts`: thế chấp LUÔN chỉ-ADA.
// Không gọi mạng, không đọc khoá (ví Emulator sinh ngẫu nhiên).
// Chạy: npx tsx keeper/test_collateral.ts   (từ thư mục scripts/)
// Dòng cuối NÓI RA trạng thái: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===`.
//
// Hai tầng:
//   1. Hàm chọn thuần (`selectPureAdaInputs`) — ca ví chỉ có token, ví có cả hai, nhiều UTxO
//      thuần ADA (tất định), ngưỡng.
//   2. Emulator: dựng tx ghi beacon GreenBack THẬT (UPLC chạy trong `complete()`) với ví mà UTxO
//      LỚN NHẤT mang token — đúng ca hỏng 2026-10-08. Đọc `collateral_inputs` từ thân tx.
//      Cặp ca: `complete()` trần ⟹ thế chấp mang token (tái hiện lỗi); `complete(pureAda…)` ⟹
//      thế chấp thuần ADA.

import {
  Emulator,
  generateEmulatorAccount,
  getAddressDetails,
  Lucid,
  type LucidEvolution,
  type TxSignBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  deriveGenBeaconsScripts,
  initGreenBackBeaconTx,
  loadBlueprint,
  postGreenBackTx,
} from "../../GenBeacons/offchain/src/index.js";
import { isPureAda, MIN_COLLATERAL_UTXO_LOVELACE, pureAdaCompleteOptions, selectPureAdaInputs } from "./collateral.js";

let failures = 0;
async function testCase(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message.split("\n")[0]}`);
  }
}
function eq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) throw new Error(`${label}: nhận ${String(actual)}, chờ ${String(expected)}`);
}
function expectThrows(fn: () => unknown, mustContain: string[]): void {
  try {
    fn();
  } catch (e) {
    const m = (e as Error).message;
    for (const c of mustContain) if (!m.includes(c)) throw new Error(`ném nhưng câu lỗi thiếu "${c}": ${m}`);
    return;
  }
  throw new Error("KHÔNG ném");
}

const TOKEN = "28e916b0" + "0".repeat(48) + "4532454e4f544c414d50"; // policy giả + "E2ENOTLAMP"
const H = (c: string) => c.repeat(64);
const utxo = (hash: string, index: number, assets: Record<string, bigint>, extra: Partial<UTxO> = {}): UTxO => ({
  txHash: H(hash), outputIndex: index, address: "addr_test1fake", assets, ...extra,
});
const ADA = (n: number) => BigInt(n) * 1_000_000n;

console.log("— hàm chọn thuần —");

await testCase("ví chỉ có UTxO mang token ⟹ NÉM, câu lỗi nêu ví, số UTxO và prepare_wallet", () => {
  const wallet = [utxo("a", 0, { lovelace: ADA(4820), [TOKEN]: 1n }), utxo("b", 0, { lovelace: ADA(50), [TOKEN]: 3n })];
  expectThrows(() => selectPureAdaInputs(wallet, "addr_test1ví"), ["addr_test1ví", "2 UTxO", "0 thuần ADA", "prepare_wallet"]);
});

await testCase("ví rỗng ⟹ NÉM (không trả mảng rỗng im lặng)", () => {
  expectThrows(() => selectPureAdaInputs([], "addr_test1ví"), ["0 UTxO", "prepare_wallet"]);
});

await testCase("có UTxO thuần ADA nhưng dưới ngưỡng ⟹ NÉM, nêu số lớn nhất", () => {
  const wallet = [utxo("a", 0, { lovelace: ADA(4820), [TOKEN]: 1n }), utxo("b", 0, { lovelace: MIN_COLLATERAL_UTXO_LOVELACE - 1n })];
  expectThrows(() => selectPureAdaInputs(wallet, "w"), ["1 thuần ADA", `lớn nhất ${MIN_COLLATERAL_UTXO_LOVELACE - 1n}`]);
});

await testCase("đúng ngưỡng ⟹ qua", () => {
  const wallet = [utxo("b", 0, { lovelace: MIN_COLLATERAL_UTXO_LOVELACE })];
  eq(selectPureAdaInputs(wallet, "w").collateral.txHash, H("b"), "thế chấp");
});

await testCase("ví có cả hai ⟹ chọn UTxO thuần ADA dù UTxO token lớn hơn nhiều; tập đầu vào không còn UTxO token", () => {
  const wallet = [
    utxo("a", 0, { lovelace: ADA(4820), [TOKEN]: 1n }),
    utxo("b", 0, { lovelace: ADA(20) }),
    utxo("c", 0, { lovelace: ADA(30), [TOKEN]: 1n }),
  ];
  const r = selectPureAdaInputs(wallet, "w");
  eq(r.collateral.txHash, H("b"), "thế chấp");
  eq(r.inputs.length, 1, "số UTxO trong tập");
  eq(r.inputs.every(isPureAda), true, "mọi UTxO trong tập thuần ADA");
});

await testCase("UTxO thuần ADA mang scriptRef không được chọn (Lucid loại nó khỏi thế chấp)", () => {
  const withRef = utxo("a", 0, { lovelace: ADA(900) }, { scriptRef: { type: "PlutusV3", script: "00" } });
  const plain = utxo("b", 0, { lovelace: ADA(10) });
  eq(selectPureAdaInputs([withRef, plain], "w").collateral.txHash, H("b"), "thế chấp");
});

await testCase("nhiều UTxO thuần ADA ⟹ chọn lớn nhất", () => {
  const wallet = [utxo("a", 0, { lovelace: ADA(10) }), utxo("b", 0, { lovelace: ADA(40) }), utxo("c", 0, { lovelace: ADA(25) })];
  eq(selectPureAdaInputs(wallet, "w").collateral.txHash, H("b"), "thế chấp");
});

await testCase("hoà lovelace ⟹ tất định theo (txHash, outputIndex), không phụ thuộc thứ tự đầu vào", () => {
  const a1 = utxo("a", 1, { lovelace: ADA(10) });
  const a0 = utxo("a", 0, { lovelace: ADA(10) });
  const b0 = utxo("b", 0, { lovelace: ADA(10) });
  for (const order of [[a1, a0, b0], [b0, a1, a0], [a0, b0, a1], [b0, a0, a1]]) {
    const r = selectPureAdaInputs(order, "w");
    eq(`${r.collateral.txHash.slice(0, 1)}#${r.collateral.outputIndex}`, "a#0", "thế chấp");
    eq(r.inputs.map((u) => `${u.txHash.slice(0, 1)}#${u.outputIndex}`).join(","), "a#0,a#1,b#0", "thứ tự tập");
  }
});

await testCase("không sửa mảng đầu vào của người gọi", () => {
  const wallet = [utxo("a", 0, { lovelace: ADA(4820), [TOKEN]: 1n }), utxo("b", 0, { lovelace: ADA(20) }), utxo("c", 0, { lovelace: ADA(30) })];
  const before = wallet.map((u) => u.txHash).join();
  selectPureAdaInputs(wallet, "w");
  eq(wallet.map((u) => u.txHash).join(), before, "thứ tự đầu vào");
});

// ── Emulator ─────────────────────────────────────────────────────────────────
console.log("— Emulator: tx ghi beacon GreenBack —");

const MS_PER_EPOCH = 3_600_000n;
const WINDOW_ORIGIN = 1_654_041_600_000n;
const EPOCH0 = 500_000n;
const NOW_MS = Number(WINDOW_ORIGIN + EPOCH0 * MS_PER_EPOCH + 60_000n);

function collateralRefs(tx: TxSignBuilder): string[] {
  const list = tx.toTransaction().body().collateral_inputs();
  const out: string[] = [];
  for (let i = 0; list !== undefined && i < list.len(); i++) out.push(`${list.get(i).transaction_id().to_hex()}#${list.get(i).index()}`);
  return out;
}
const refOf = (u: UTxO) => `${u.txHash}#${u.outputIndex}`;

/** Ví Emulator: một UTxO LỚN mang token + 5 UTxO thuần ADA nhỏ hơn (UTxO đổi, kèm token, vẫn lớn nhất). */
async function buildWallet(): Promise<{ lucid: LucidEvolution; emulator: Emulator; writerPkh: string }> {
  const account = generateEmulatorAccount({ lovelace: ADA(5000), [TOKEN]: 1n });
  const emulator = new Emulator([account]);
  emulator.time = NOW_MS;
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(account.seedPhrase);
  let split = lucid.newTx();
  for (let i = 0; i < 5; i++) split = split.pay.ToAddress(account.address, { lovelace: ADA(20) });
  const signed = await (await split.complete()).sign.withWallet().complete();
  await signed.submit();
  emulator.awaitBlock(1);
  const cred = getAddressDetails(account.address).paymentCredential;
  if (cred?.type !== "Key") throw new Error("ví Emulator không có key credential");
  return { lucid, emulator, writerPkh: cred.hash };
}

/** Dựng tx ghi beacon (UPLC chạy thật trong complete) — `mode` chọn tham số của `complete()`. */
async function buildBeaconPostTx(lucid: LucidEvolution, emulator: Emulator, writerPkh: string, mode: "bare" | "pure-ada"): Promise<TxSignBuilder> {
  const wallet = await lucid.wallet().getUtxos();
  const seeds = wallet.filter(isPureAda).sort((a, b) => refOf(a).localeCompare(refOf(b)));
  if (seeds.length < 5) throw new Error(`cần ≥5 UTxO thuần ADA làm seed, có ${seeds.length}`);
  const ref = (u: UTxO) => ({ txHash: u.txHash, outputIndex: u.outputIndex });
  const scripts = deriveGenBeaconsScripts(loadBlueprint(), "Custom", {
    msPerEpoch: MS_PER_EPOCH, windowOriginMs: WINDOW_ORIGIN,
    vaultRegistrySeed: ref(seeds[0]!), greenbackWriter: writerPkh, greenbackSeed: ref(seeds[1]!),
    gbShardCapNanogic: 1_800_000_000_000_000n, gbShardSeed: ref(seeds[2]!),
    rateKey: writerPkh, rhoMaxQ: 4_000_000_000n, rateSeed: ref(seeds[3]!),
  });
  // Khởi tạo beacon (đúc) rồi ghi một lượt — lượt ghi là tx cần bắt.
  const init = initGreenBackBeaconTx(lucid, { greenback: scripts.greenback, seedUtxo: seeds[1]!, gbNanogic: 0n, nowMs: NOW_MS });
  const initDone = await init.tx.complete(await pureAdaCompleteOptions(lucid));
  await (await initDone.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);
  const beacon = await lucid.utxoByUnit(scripts.greenback.nftUnit);
  const post = postGreenBackTx(lucid, { greenback: scripts.greenback, beaconUtxo: beacon, gbNanogic: 1_000n, depeg: false, nowMs: NOW_MS });
  return mode === "bare" ? post.tx.complete() : post.tx.complete(await pureAdaCompleteOptions(lucid));
}

await testCase("ĐỐI CHỨNG (tái hiện lỗi): complete() trần trên ví có UTxO token lớn nhất ⟹ thế chấp MANG TOKEN", async () => {
  const { lucid, emulator, writerPkh } = await buildWallet();
  const tx = await buildBeaconPostTx(lucid, emulator, writerPkh, "bare");
  const wallet = await lucid.wallet().getUtxos();
  const refs = collateralRefs(tx);
  eq(refs.length >= 1, true, "có thế chấp");
  const withToken = refs.filter((r) => { const u = wallet.find((w) => refOf(w) === r); return u !== undefined && !isPureAda(u); });
  eq(withToken.length >= 1, true, `thế chấp mang token (${refs.join(",")})`);
});

await testCase("complete(pureAdaCompleteOptions) trên cùng ví ⟹ mọi thế chấp trong thân tx là UTxO thuần ADA", async () => {
  const { lucid, emulator, writerPkh } = await buildWallet();
  const tx = await buildBeaconPostTx(lucid, emulator, writerPkh, "pure-ada");
  const wallet = await lucid.wallet().getUtxos();
  const refs = collateralRefs(tx);
  eq(refs.length >= 1, true, "có thế chấp");
  for (const r of refs) {
    const u = wallet.find((w) => refOf(w) === r);
    if (!u) throw new Error(`thế chấp ${r} không nằm trong ví`);
    eq(isPureAda(u), true, `thế chấp ${r} thuần ADA`);
  }
  // Input trả phí cũng không chạm UTxO token của ví.
  const inputs = tx.toTransaction().body().inputs();
  for (let i = 0; i < inputs.len(); i++) {
    const r = `${inputs.get(i).transaction_id().to_hex()}#${inputs.get(i).index()}`;
    const u = wallet.find((w) => refOf(w) === r);
    if (u) eq(isPureAda(u), true, `input ${r} thuần ADA`);
  }
});

await testCase("ví chỉ còn UTxO token ⟹ pureAdaCompleteOptions NÉM (không để Lucid chọn token làm thế chấp)", async () => {
  const account = generateEmulatorAccount({ lovelace: ADA(5000), [TOKEN]: 1n });
  const lucid = await Lucid(new Emulator([account]), "Custom");
  lucid.selectWallet.fromSeed(account.seedPhrase);
  let message = "";
  try { await pureAdaCompleteOptions(lucid); } catch (e) { message = (e as Error).message; }
  if (!message.includes(account.address) || !message.includes("prepare_wallet")) throw new Error(`không ném đúng: "${message}"`);
});

console.log(failures === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${failures} ca sai ===`);
process.exit(failures === 0 ? 0 : 1);
