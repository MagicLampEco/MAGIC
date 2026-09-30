// scripts/test_gen_vault_tx_api_deployment.ts — bộ ca cho `gen_vault_tx_api_deployment.ts`.
// Không gọi mạng, không đọc sổ thật: sổ trạng thái ở đây là sổ GIẢ dựng trong bộ nhớ.
// Chạy từ scripts/:  npx tsx test_gen_vault_tx_api_deployment.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Trọng tài là CHÍNH bộ nạp của dịch vụ (`VaultTxAPI/src/config.ts` ▸ `parseDeployment`),
// không phải một bản chép lại hình dạng của nó: khối sinh ra phải đi qua đúng hàm mà
// `VaultTxAPI` gọi lúc khởi động.

import { credentialToAddress, scriptHashToCredential } from "@lucid-evolution/lucid";
import {
  buildDeployment, GEN_V2_STATE_KEYS, SCHEDULE_ONLY_STATE_KEYS,
  type StateBook, type VaultKind,
} from "./gen_vault_tx_api_deployment.js";
import { consumeKey } from "./consumeBook.js";
import { parseDeployment } from "../VaultTxAPI/src/config.js";

let sai = 0;
function ca(ten: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${ten}`); }
  catch (e) { sai++; console.log(`  ✗ ${ten}\n      ${(e as Error).message.split("\n")[0]}`); }
}
function bang<T>(thuc: T, cho: T, nhan: string) {
  if (thuc !== cho) throw new Error(`${nhan}: nhận ${String(thuc)}, chờ ${String(cho)}`);
}
function phaiNem(fn: () => void, chua: string[]): string {
  try { fn(); } catch (e) {
    const m = (e as Error).message;
    for (const c of chua) {
      if (!m.includes(c)) throw new Error(`ném nhưng câu lỗi thiếu "${c}": ${m.split("\n")[0]}`);
    }
    return m;
  }
  throw new Error("KHÔNG ném");
}

const NET = "Preprod" as const;
// Hash giả: 56 hex thường, mỗi vai một giá trị riêng để phép so không trùng nhầm.
const h = (b: string) => b.repeat(28);
const addr = (hash: string) => credentialToAddress(NET, scriptHashToCredential(hash));
const ref = (b: string, ix: number) => `${b.repeat(32)}#${ix}`;

function fullBook(kind: VaultKind): StateBook {
  const k = kind === "Instant" ? "instant" : "schedule";
  return {
    // 56 hex không nằm trong danh sách nhái/đã-thay của `assertLampPolicyId`.
    LAMP_POLICY_ID: h("a1"),
    SHARD_HASH: h("a2"),
    REF_SHARD_UTXO: ref("a3", 1),
    VAULT_INSTANT_ADDR: addr(h("a4")),
    REF_VAULT_INSTANT_UTXO: ref("a5", 0),
    VAULT_SCHEDULE_ADDR: addr(h("a6")),
    REF_VAULT_SCHEDULE_UTXO: ref("a7", 0),
    [consumeKey("CONSUME_ADDRESS", k)]: addr(h("a8")),
    [consumeKey("PRICE_PARAM_HASH", k)]: h("a9"),
    [consumeKey("PRICE_NFT_UNIT", k)]: h("aa") + "5052494345",
    [consumeKey("MAX_PRICE_STALE", k)]: "1",
    [consumeKey("REF_CONSUME_UTXO", k)]: ref("ab", 2),
    ANCHOR_NFT_POLICY: h("ac"),
    // Khoá Gen v2.0
    RATE_PARAM_HASH: h("b1"),
    GREENBACK_BEACON_HASH: h("b2"),
    GB_SHARD_HASH: h("b3"),
    GB_SHARD_CAP_NANOGIC: "1000000000000000",
    VAULT_REGISTRY_HASH: h("b4"),
    REF_GB_SHARD_UTXO: ref("b5", 4),
    REF_COMMIT_SCHEDULE_UTXO: ref("b6", 3),
  };
}
const META = { sourcePath: "scripts/state.Preprod.sh (GIẢ)", mtime: "2026-09-30T00:00:00Z", sha: "testsha" };

function genJson(book: StateBook, kind: VaultKind): string {
  return JSON.stringify(buildDeployment(book, NET, kind, META).deployment);
}
function without(book: StateBook, key: string): StateBook {
  const b = { ...book };
  delete b[key];
  return b;
}

console.log("── Ca dương: khối sinh ra đi qua bộ nạp của VaultTxAPI");
for (const kind of ["Instant", "Schedule"] as const) {
  ca(`${kind}: parseDeployment nhận, có genV2 + gb_shard`, () => {
    const d = parseDeployment(genJson(fullBook(kind), kind), NET);
    if (d.genV2 === undefined) throw new Error("genV2 vắng");
    if (d.refScriptUtxos.gbShard === undefined) throw new Error("refScriptUtxos.gbShard vắng");
    bang(d.genV2.rateScriptHash, h("b1"), "rateScriptHash suy từ địa chỉ");
    bang(d.genV2.rateNftPolicy, h("b1"), "rateNftPolicy = hash rate_param");
    bang(d.genV2.gbBeaconScriptHash, h("b2"), "gbBeaconScriptHash");
    bang(d.genV2.gbBeaconNftPolicy, h("b2"), "gbBeaconNftPolicy = hash greenback_beacon");
    bang(d.genV2.gbShardPolicyId, h("b3"), "gbShardPolicyId");
    bang(d.genV2.gbShardCapNanogic, 1_000_000_000_000_000n, "gbShardCapNanogic");
    bang(d.genV2.vaultRegistryPolicy, h("b4"), "vaultRegistryPolicy");
    bang(d.refScriptUtxos.gbShard.txHash, "b5".repeat(32), "gb_shard txHash");
    bang(d.vaults[0].vaultType, kind, "vault_type");
  });
}
ca("Instant: KHÔNG phát commit (chỉ két Schedule dùng)", () => {
  const d = parseDeployment(genJson(fullBook("Instant"), "Instant"), NET);
  bang(d.refScriptUtxos.commit, undefined, "refScriptUtxos.commit");
});
ca("Schedule: phát commit đúng out-ref", () => {
  const d = parseDeployment(genJson(fullBook("Schedule"), "Schedule"), NET);
  bang(d.refScriptUtxos.commit?.txHash, "b6".repeat(32), "commit txHash");
  bang(d.refScriptUtxos.commit?.outputIndex, 3, "commit outputIndex");
});

console.log("── Mục `instant` cũ không bao giờ được phát");
const bookV1Leftover: StateBook = {
  ...fullBook("Instant"),
  UM_DATUM_HASH: h("c1"), UM_NFT_POLICY_ID: h("c2"),
  BACKING_SCRIPT_HASH: h("c3"), BACKING_NFT_POLICY_ID: h("c4"),
};
ca("sổ còn khoá UM_*/BACKING_* ⟹ khối không có `instant`, dịch vụ nạp được", () => {
  const out = JSON.parse(genJson(bookV1Leftover, "Instant")) as Record<string, unknown>;
  bang("instant" in out, false, "khoá instant có mặt");
  parseDeployment(JSON.stringify(out), NET);
});
ca("cặp âm: cùng khối đó CỘNG khoá `instant` ⟹ dịch vụ từ chối khởi động", () => {
  const out = JSON.parse(genJson(bookV1Leftover, "Instant")) as Record<string, unknown>;
  out.instant = { um_datum_address: addr(h("c1")) };
  phaiNem(() => parseDeployment(JSON.stringify(out), NET), ["instant", "gen_v2"]);
});

console.log("── Ca âm: thiếu MỘT khoá Gen v2.0 ⟹ bộ sinh ném, nêu đúng tên khoá");
for (const kind of ["Instant", "Schedule"] as const) {
  const keys = Object.keys({ ...GEN_V2_STATE_KEYS, ...(kind === "Schedule" ? SCHEDULE_ONLY_STATE_KEYS : {}) });
  for (const key of keys) {
    ca(`${kind}: thiếu ${key} ⟹ ném`, () => {
      const m = phaiNem(() => buildDeployment(without(fullBook(kind), key), NET, kind, META), [key, "thiếu 1 khoá Gen v2.0"]);
      // Chỉ nêu khoá thiếu, không nêu khoá đang có.
      const other = keys.find((k) => k !== key)!;
      if (m.includes(`· ${other} `)) throw new Error(`câu lỗi kể cả khoá không thiếu ${other}`);
    });
  }
}
ca("Instant: thiếu REF_COMMIT_SCHEDULE_UTXO KHÔNG làm ném (cặp với ca Schedule ở trên)", () => {
  const d = parseDeployment(genJson(without(fullBook("Instant"), "REF_COMMIT_SCHEDULE_UTXO"), "Instant"), NET);
  if (d.genV2 === undefined) throw new Error("genV2 vắng");
});
ca("thiếu nhiều khoá ⟹ kể ĐỦ trong một lần ném", () => {
  let b = fullBook("Schedule");
  for (const k of Object.keys({ ...GEN_V2_STATE_KEYS, ...SCHEDULE_ONLY_STATE_KEYS })) b = without(b, k);
  phaiNem(() => buildDeployment(b, NET, "Schedule", META),
    ["thiếu 7 khoá", ...Object.keys(GEN_V2_STATE_KEYS), "REF_COMMIT_SCHEDULE_UTXO"]);
});
ca("giá trị rỗng tính là thiếu (không đệm chuỗi rỗng)", () => {
  phaiNem(() => buildDeployment({ ...fullBook("Instant"), GB_SHARD_HASH: "" }, NET, "Instant", META), ["GB_SHARD_HASH"]);
});
ca("hash sai hình dạng ⟹ ném, nêu tên khoá", () => {
  phaiNem(() => buildDeployment({ ...fullBook("Instant"), VAULT_REGISTRY_HASH: "xyz" }, NET, "Instant", META), ["VAULT_REGISTRY_HASH"]);
});
ca("cap sai hình dạng ⟹ bộ sinh cho qua, DỊCH VỤ chặn (một cổng quyết)", () => {
  const json = genJson({ ...fullBook("Instant"), GB_SHARD_CAP_NANOGIC: "0" }, "Instant");
  phaiNem(() => parseDeployment(json, NET), ["gb_shard_cap_nanogic"]);
});

console.log(sai === 0 ? "=== ĐẠT ===" : `=== HỎNG: ${sai} ca sai ===`);
if (sai !== 0) process.exit(1);
