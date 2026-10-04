// scripts/test_gen_vault_tx_api_deployment.ts — bộ ca cho `gen_vault_tx_api_deployment.ts`.
// Không gọi mạng, không đọc sổ thật: sổ trạng thái ở đây là sổ GIẢ dựng trong bộ nhớ.
// Chạy từ scripts/:  npx tsx test_gen_vault_tx_api_deployment.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Trọng tài là CHÍNH bộ nạp của dịch vụ (`VaultTxAPI/src/config.ts` ▸ `parseDeployment`),
// không phải một bản chép lại hình dạng của nó: khối sinh ra phải đi qua đúng hàm mà
// `VaultTxAPI` gọi lúc khởi động.

import { credentialToAddress, scriptHashToCredential, validatorToScriptHash } from "@lucid-evolution/lucid";
import {
  DID_STAKE_BLUEPRINT_TITLE, DID_STAKE_UNAPPLIED_HASH_KEY, didStakeScriptFromBlueprint,
  buildDeployment, GEN_V2_STATE_KEYS, SCHEDULE_ONLY_STATE_KEYS,
  PREPAID_STATE_KEYS, buildPrepaidDeployment, parseVaultArg,
  type StateBook, type VaultKind,
} from "./gen_vault_tx_api_deployment.js";
import { REF_PAID_FUND_KEY, REF_VAULT_PREPAID_KEY } from "./deployParams.js";
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

console.log("── Két Prepaid: bộ sinh phát khối theo khuôn PREPAID_VAULT_TYPE của VaultTxAPI");
// Hash/địa chỉ giả riêng cho Prepaid; cặp HASH↔ADDR phải khớp `Script(hash)` (bộ sinh đối chiếu).
function prepaidBook(): StateBook {
  return {
    ...fullBook("Instant"),           // sổ thật mang cả khoá của két khác — bộ sinh phải bỏ qua chúng
    VAULT_PREPAID_HASH: h("d1"),
    VAULT_PREPAID_ADDR: addr(h("d1")),
    PAID_FUND_HASH: h("d2"),
    PAID_FUND_ADDR: addr(h("d2")),
    REF_VAULT_PREPAID_UTXO: ref("d3", 0),
    REF_PAID_FUND_UTXO: ref("d4", 1),
    CONSUME_ADDRESS_PREPAID: addr(h("d5")),
    REF_CONSUME_UTXO_PREPAID: ref("d6", 2),
    PRICE_PARAM_HASH_PREPAID: h("d7"),
    PRICE_NFT_UNIT_PREPAID: h("d8") + "5052494345",
    MAX_PRICE_STALE_PREPAID: "2",
  };
}
const prepaidOut = (b: StateBook) =>
  buildPrepaidDeployment(b, NET, META).deployment as Record<string, unknown> & {
    ref_script_utxos: Record<string, unknown>;
  };
ca("--vault: vắng ⟹ Instant; Instant/Schedule/Prepaid nhận đúng chữ", () => {
  bang(parseVaultArg(undefined), "Instant", "vắng");
  bang(parseVaultArg("Schedule"), "Schedule", "Schedule");
  bang(parseVaultArg("Prepaid"), "Prepaid", "Prepaid");
});
ca("--vault giá trị lạ / rỗng / sai hoa thường ⟹ ném, không lùi về Instant", () => {
  phaiNem(() => parseVaultArg(""), ["--vault"]);
  phaiNem(() => parseVaultArg("prepaid"), ["--vault", "Prepaid"]);
});
ca("sổ đủ ⟹ khối đúng từng ô, và parseDeployment của VaultTxAPI nạp được", () => {
  const out = prepaidOut(prepaidBook());
  const d = parseDeployment(JSON.stringify(out), NET);
  bang(d.vaults.length, 1, "số vault");
  bang(d.vaults[0].vaultType, "Prepaid", "vault_type");
  bang(d.vaults[0].scriptHash, h("d1"), "hash két suy từ địa chỉ");
  bang(d.prepaid?.fundAddress, addr(h("d2")), "địa chỉ quỹ");
  bang(d.prepaid?.fundScriptHash, h("d2"), "hash quỹ suy từ địa chỉ");
  bang(d.refScriptUtxos.vault.txHash, "d3".repeat(32), "ref két");
  bang(d.refScriptUtxos.paidFund?.txHash, "d4".repeat(32), "ref quỹ");
  bang(d.refScriptUtxos.paidFund?.outputIndex, 1, "ref quỹ ix");
  bang(d.refScriptUtxos.consume.txHash, "d6".repeat(32), "ref consume = bản _PREPAID");
  bang(d.consume.engageAddress, addr(h("d5")), "engage = CONSUME_ADDRESS_PREPAID");
  bang(d.consume.priceBeaconAddress, addr(h("d7")), "beacon giá = PRICE_PARAM_HASH_PREPAID");
  bang(d.consume.maxPriceStale, 2n, "max_price_stale = bản _PREPAID");
  bang(d.shardAddress, undefined, "shardAddress");
  bang(d.refScriptUtxos.shard, undefined, "ref shard");
  bang(d.genV2, undefined, "genV2");
  bang(d.didStake?.anchorNftPolicy, h("ac"), "did_stake");
});
ca("sổ có SHARD_HASH/REF_SHARD_UTXO/gen_v2 của két khác ⟹ khối Prepaid KHÔNG mang chúng", () => {
  const out = prepaidOut(prepaidBook());
  bang("shard_address" in out, false, "shard_address có mặt");
  bang("shard" in out.ref_script_utxos, false, "ref_script_utxos.shard có mặt");
  bang("gen_v2" in out, false, "gen_v2 có mặt");
  bang("instant" in out, false, "instant có mặt");
});
for (const key of Object.keys(PREPAID_STATE_KEYS)) {
  ca(`thiếu ${key} ⟹ ném, nêu đúng khoá`, () => {
    const m = phaiNem(() => buildPrepaidDeployment(without(prepaidBook(), key), NET, META),
      [key, "thiếu 1/11 khoá Prepaid", "KHÔNG phát"]);
    const other = Object.keys(PREPAID_STATE_KEYS).find((k) => k !== key)!;
    if (m.includes(`· ${other} `)) throw new Error(`câu lỗi kể cả khoá không thiếu ${other}`);
  });
}
ca("sổ rỗng ⟹ ném một lần, kể đủ 11/11 khoá Prepaid", () => {
  phaiNem(() => buildPrepaidDeployment({}, NET, META), ["KHÔNG phát", "thiếu 11/11", ...Object.keys(PREPAID_STATE_KEYS)]);
});
ca("giá trị rỗng tính là thiếu (không đệm chuỗi rỗng)", () => {
  phaiNem(() => buildPrepaidDeployment({ ...prepaidBook(), REF_PAID_FUND_UTXO: "" }, NET, META), ["REF_PAID_FUND_UTXO"]);
});
ca("địa chỉ két / quỹ lệch Script(hash) ⟹ ném (sổ giữ hai đời)", () => {
  phaiNem(() => buildPrepaidDeployment({ ...prepaidBook(), VAULT_PREPAID_ADDR: addr(h("e1")) }, NET, META),
    ["VAULT_PREPAID_ADDR", "VAULT_PREPAID_HASH"]);
  phaiNem(() => buildPrepaidDeployment({ ...prepaidBook(), PAID_FUND_ADDR: addr(h("e2")) }, NET, META),
    ["PAID_FUND_ADDR", "PAID_FUND_HASH"]);
});
ca("ref-script quỹ sai khuôn out-ref ⟹ bộ sinh cho qua, DỊCH VỤ chặn (một cổng quyết)", () => {
  const json = JSON.stringify(prepaidOut({ ...prepaidBook(), REF_PAID_FUND_UTXO: "không-phải-outref" }));
  phaiNem(() => parseDeployment(json, NET), ["ref_script_utxos.paid_fund"]);
});
ca("khoá ref-script của bước 10 nằm trong bảng Prepaid của bộ sinh", () => {
  bang(REF_VAULT_PREPAID_KEY in PREPAID_STATE_KEYS, true, REF_VAULT_PREPAID_KEY);
  bang(REF_PAID_FUND_KEY in PREPAID_STATE_KEYS, true, REF_PAID_FUND_KEY);
});
ca("khoá consume `_PREPAID` của bước 09 nằm trong bảng Prepaid", () => {
  for (const n of ["CONSUME_ADDRESS", "REF_CONSUME_UTXO", "PRICE_PARAM_HASH", "PRICE_NFT_UNIT", "MAX_PRICE_STALE"] as const) {
    bang(consumeKey(n, "prepaid") in PREPAID_STATE_KEYS, true, consumeKey(n, "prepaid"));
  }
});
// Ca CANH, LẬT DẤU so với bản trước (bản trước canh "dịch vụ vẫn đòi shard ⟹ bộ sinh phải ném").
// Nay khuôn Prepaid đã có, nên hai vế phải cùng đúng:
//   (a) khối Instant bỏ `shard_address` ⟹ dịch vụ VẪN từ chối — việc mở khuôn Prepaid không
//       được nới shard cho Instant/Schedule;
//   (b) khối Prepaid KHÔNG có shard ⟹ dịch vụ nạp được, và thêm `shard_address` vào ⟹ từ chối.
ca("canh (a): khối Instant bỏ shard_address ⟹ VaultTxAPI VẪN từ chối", () => {
  const out = JSON.parse(genJson(fullBook("Instant"), "Instant")) as Record<string, unknown>;
  delete out.shard_address;
  phaiNem(() => parseDeployment(JSON.stringify(out), NET), ["shard_address"]);
});
ca("canh (b): khối Prepaid không shard ⟹ nạp được; cộng shard_address ⟹ từ chối", () => {
  const out = prepaidOut(prepaidBook());
  parseDeployment(JSON.stringify(out), NET);
  phaiNem(() => parseDeployment(JSON.stringify({ ...out, shard_address: addr(h("a2")) }), NET), ["shard_address", "KHÔNG có shard"]);
});

// ── did_stake.unapplied_script từ --did-stake-blueprint ─────────────────────────
// Script PlutusV3 nhỏ nhất băm được (không phải did_stake thật): ca kiểm phép ĐỐI CHIẾU, không kiểm
// nội dung script.
const DS_CBOR = "4e4d01000033222220051200120011";
const DS_HASH = validatorToScriptHash({ type: "PlutusV3", script: DS_CBOR });
const blueprint = (title = DID_STAKE_BLUEPRINT_TITLE, cbor = DS_CBOR) =>
  JSON.stringify({ validators: [{ title: "khac.khac.spend", compiledCode: "00" }, { title, compiledCode: cbor }] });
const dsBook = (over: StateBook = {}): StateBook => ({ ...fullBook("Instant"), [DID_STAKE_UNAPPLIED_HASH_KEY]: DS_HASH, ...over });

ca("blueprint khớp khoá sổ ⟹ phát did_stake.unapplied_script; VaultTxAPI nạp được, hash khớp", () => {
  const book = dsBook();
  const s = didStakeScriptFromBlueprint(blueprint(), book);
  bang(s.hash, DS_HASH, "hash");
  const out = buildDeployment(book, NET, "Instant", { ...META, didStakeScript: s });
  const d = parseDeployment(JSON.stringify(out.deployment), NET);
  bang(d.didStake?.unappliedScript?.hash, DS_HASH, "unapplied_script.hash");
  bang(d.didStake?.unappliedScript?.cbor, DS_CBOR, "unapplied_script.cbor");
  bang(out.warnings.some(w => w.includes("unapplied_script")), false, "không cảnh báo khi đã phát");
});
ca("CỰC ĐỐI: có cờ mà sổ thiếu DID_STAKE_UNAPPLIED_HASH ⟹ ném, nêu khoá", () => {
  phaiNem(() => didStakeScriptFromBlueprint(blueprint(), dsBook({ [DID_STAKE_UNAPPLIED_HASH_KEY]: "" })),
    [DID_STAKE_UNAPPLIED_HASH_KEY, "thiếu"]);
});
ca("CỰC ĐỐI: khoá sổ khác hash băm lại ⟹ ném, nêu cả hai hash", () => {
  phaiNem(() => didStakeScriptFromBlueprint(blueprint(), dsBook({ [DID_STAKE_UNAPPLIED_HASH_KEY]: h("ee") })),
    [DS_HASH, h("ee"), "khác đời"]);
});
ca("CỰC ĐỐI: blueprint không có validator did_stake.did_stake.withdraw ⟹ ném, nêu tên", () => {
  phaiNem(() => didStakeScriptFromBlueprint(blueprint("did_stake.did_stake.publish"), dsBook()), [DID_STAKE_BLUEPRINT_TITLE]);
});
ca("CỰC ĐỐI: có script mà sổ thiếu ANCHOR_NFT_POLICY ⟹ ném", () => {
  const s = didStakeScriptFromBlueprint(blueprint(), dsBook());
  phaiNem(() => buildDeployment(without(dsBook(), "ANCHOR_NFT_POLICY"), NET, "Instant", { ...META, didStakeScript: s }),
    ["ANCHOR_NFT_POLICY", "--did-stake-blueprint"]);
});
ca("không cờ ⟹ hành vi cũ (chỉ anchor_nft_policy) + cảnh báo unapplied_script", () => {
  const out = buildDeployment(dsBook(), NET, "Instant", META);
  const ds = (out.deployment as { did_stake?: Record<string, unknown> }).did_stake;
  bang(ds?.anchor_nft_policy, h("ac"), "anchor");
  bang(ds !== undefined && "unapplied_script" in ds, false, "unapplied_script có mặt");
  bang(out.warnings.some(w => w.includes("unapplied_script")), true, "cảnh báo");
});

console.log(sai === 0 ? "=== ĐẠT ===" : `=== HỎNG: ${sai} ca sai ===`);
if (sai !== 0) process.exit(1);
