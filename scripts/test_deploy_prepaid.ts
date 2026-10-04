// scripts/test_deploy_prepaid.ts — bộ ca cho tầng deploy PrepaidGen (đường tài trợ):
// bước 10 (cặp script + ref-script CIP-33) và nhánh `VAULT_KIND=prepaid` của bước 09.
// Chạy từ scripts/:  npx tsx test_deploy_prepaid.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Không gọi mạng, không đọc sổ thật, không đọc khoá. Emulator Lucid đo kích thước tx thật.
//
//   (A) hash: `deployParams.ts` ▸ `prepaidScriptPair` == bộ dựng của PrepaidGen
//       (`PrepaidGen/offchain/src/tx/scripts.ts` ▸ `derivePrepaidScripts`) — cặp cực đối cho
//       từng tham số thật sự đi vào bytes;
//   (B) kế hoạch ref-script + khoá sổ + phép đối chiếu hash của bước 09;
//   (C) Emulator: kích thước tx công bố (từng cái, và gộp hai) so trần 16.384 byte; công bố
//       thật bằng `publishRefScript`, idempotent, và đường đọc lại bằng hash.

import {
  Emulator, Lucid, PROTOCOL_PARAMETERS_DEFAULT, generateEmulatorAccount,
  validatorToScriptHash, type LucidEvolution,
} from "@lucid-evolution/lucid";
import { msPerEpoch, wakemeVaultHash, windowOriginMs } from "@magiclamp/protocol-utils";
import { loadBlueprint, findValidator, appliedScript } from "./applyParams.js";
import {
  prepaidScriptPair, prepaidRefScriptPlan, prepaidVaultParams,
  REF_VAULT_PREPAID_KEY, REF_PAID_FUND_KEY, type PaidFundParamInputs,
} from "./deployParams.js";
import { requireConsumeVaultHash } from "./consumeBook.js";
import { PREPAID_STATE_KEYS } from "./gen_vault_tx_api_deployment.js";
import { publishRefScript, parkAddressFor, fetchRefScriptUtxo } from "./refScripts.js";
import { minAdaForRefScriptWithMargin } from "./minAda.js";
import { carpAssetClass } from "../PrepaidGen/offchain/src/constants.js";
import { derivePrepaidScripts, type PrepaidBlueprint } from "../PrepaidGen/offchain/src/tx/scripts.js";

let sai = 0;
function check(ten: string, ok: boolean, chiTiet = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗"} ${ten}${chiTiet ? ` — ${chiTiet}` : ""}`);
  if (!ok) sai++;
}
async function phaiNem(ten: string, f: () => unknown, re: RegExp): Promise<void> {
  try { await f(); check(ten, false, "không ném"); }
  catch (e) {
    const m = (e as Error).message ?? String(e);
    check(ten, re.test(m), re.test(m) ? "" : `ném câu khác: ${m.slice(0, 200)}`);
  }
}

const MAX_TX = 16_384;
const NET = "Preprod" as const;
// Cặp CARP canonical của Preprod (cửa duy nhất: `carpAssetClass`). Đời CARP của đợt đúc lại
// chưa biết; kích thước tx không đổi theo nó vì cả hai vế đều 28 byte cố định.
const CARP = carpAssetClass(NET);
const IN: PaidFundParamInputs = {
  carpPolicyId: CARP.policyId, carpAssetName: CARP.assetName,
  msPerEpoch: msPerEpoch(NET), windowOriginMs: windowOriginMs(NET),
  wakemeVaultHash: wakemeVaultHash(NET),
};
const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);

async function main() {
  const bp = await loadBlueprint("PrepaidGen");
  const bpRaw = { validators: bp.validators } as unknown as PrepaidBlueprint;
  const rawVault = findValidator(bp, "prepaid.prepaid_vault.spend");
  console.log(`Blueprint PrepaidGen: prepaid_vault (chưa apply) ${validatorToScriptHash({ type: "PlutusV3", script: rawVault.compiledCode }).slice(0, 8)}…`);

  // ── (A) hash ─────────────────────────────────────────────────────────────
  console.log("── (A) prepaidScriptPair ↔ derivePrepaidScripts (PrepaidGen/offchain)");
  const pair = prepaidScriptPair(bp, IN);
  const base = derivePrepaidScripts(bpRaw, NET, IN);
  check("paid_fund: deployParams == PrepaidGen", pair.fundHash === base.paidFund.hash, pair.fundHash);
  check("prepaid_vault: deployParams == PrepaidGen", pair.vaultHash === base.vault.hash, pair.vaultHash);
  check("CBOR trùng byte (không chỉ trùng hash)",
    pair.fundScript.script === base.paidFund.script.script && pair.vaultScript.script === base.vault.script.script);

  const otherName = prepaidScriptPair(bp, { ...IN, carpAssetName: flip(IN.carpAssetName) });
  check("CỰC ĐỐI: đổi carp_asset_name ⟹ CẢ HAI hash khác (hash phụ thuộc đời CARP)",
    otherName.fundHash !== pair.fundHash && otherName.vaultHash !== pair.vaultHash);
  const otherPolicy = prepaidScriptPair(bp, { ...IN, carpPolicyId: flip(IN.carpPolicyId) });
  check("CỰC ĐỐI: đổi carp_policy_id ⟹ CẢ HAI hash khác",
    otherPolicy.fundHash !== pair.fundHash && otherPolicy.vaultHash !== pair.vaultHash);
  const otherOrigin = prepaidScriptPair(bp, { ...IN, windowOriginMs: IN.windowOriginMs + 1n });
  check("CỰC ĐỐI: window_origin_ms +1 ⟹ CẢ HAI hash khác",
    otherOrigin.fundHash !== pair.fundHash && otherOrigin.vaultHash !== pair.vaultHash);
  const otherWakeme = prepaidScriptPair(bp, { ...IN, wakemeVaultHash: flip(IN.wakemeVaultHash) });
  check("CỰC ĐỐI: đổi wakeme_vault_hash ⟹ CẢ HAI hash khác (quỹ phụ thuộc bản deploy Wakeme)",
    otherWakeme.fundHash !== pair.fundHash && otherWakeme.vaultHash !== pair.vaultHash);
  // `paid_fund_hash` của két phải là hash quỹ ĐÃ apply: dựng két bằng hash quỹ chưa apply
  // ra một hash hợp lệ KHÁC — phép so này phân biệt được hai cách nối.
  const rawFundHash = validatorToScriptHash({ type: "PlutusV3", script: findValidator(bp, "prepaid.paid_fund.spend").compiledCode });
  const wrongWire = appliedScript(rawVault, prepaidVaultParams({ ...IN, paidFundHash: rawFundHash })).hash;
  check("CỰC ĐỐI: két nối hash quỹ CHƯA apply ⟹ hash khác cặp đúng", wrongWire !== pair.vaultHash);

  // ── (B) kế hoạch ref-script + bước 09 ────────────────────────────────────
  console.log("── (B) prepaidRefScriptPlan + requireConsumeVaultHash");
  const plan = prepaidRefScriptPlan(bp, IN);
  check("hai mục, đúng thứ tự két → quỹ, đúng hash",
    plan.length === 2 && plan[0]!.hash === pair.vaultHash && plan[1]!.hash === pair.fundHash);
  check("khoá sổ = REF_VAULT_PREPAID_UTXO · REF_PAID_FUND_UTXO",
    plan[0]!.bookKey === REF_VAULT_PREPAID_KEY && plan[1]!.bookKey === REF_PAID_FUND_KEY
      && REF_VAULT_PREPAID_KEY === "REF_VAULT_PREPAID_UTXO" && REF_PAID_FUND_KEY === "REF_PAID_FUND_UTXO");
  check("hai khoá nằm trong bảng Prepaid của bộ sinh deployment",
    plan.every((p) => p.bookKey in PREPAID_STATE_KEYS));
  check("bước 09: sổ ghi đúng hash của đời CARP ⟹ nhận",
    requireConsumeVaultHash({ VAULT_PREPAID_HASH: pair.vaultHash }, "prepaid", pair.vaultHash) === pair.vaultHash);
  await phaiNem("bước 09 CỰC ĐỐI: sổ ghi hash két của đời CARP khác ⟹ ném",
    () => requireConsumeVaultHash({ VAULT_PREPAID_HASH: otherName.vaultHash }, "prepaid", pair.vaultHash), /đời CARP/);

  // ── (C) Emulator: kích thước + công bố ───────────────────────────────────
  console.log("── (C) Emulator: tx công bố ref-script");
  const deployer = generateEmulatorAccount({ lovelace: 500_000_000n });
  const emulator = new Emulator([deployer], { ...PROTOCOL_PARAMETERS_DEFAULT, maxTxSize: MAX_TX });
  const lucid: LucidEvolution = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(deployer.seedPhrase);
  const park = parkAddressFor("Custom", deployer.address);
  const size = (tx: { toCBOR(): string }) => tx.toCBOR().length / 2;

  const lov = plan.map((p) => minAdaForRefScriptWithMargin(p.script.script));
  const single: number[] = [];
  for (const [i, p] of plan.entries()) {
    const tx = await lucid.newTx().pay.ToAddressWithData(park, undefined, { lovelace: lov[i]! }, p.script).complete();
    single.push(size(tx));
    console.log(`     ${p.label}: script ${p.script.script.length / 2} B · tx chưa ký ${size(tx)} B · min-ADA ${lov[i]! / 1_000_000n} ADA`);
  }
  check("mỗi tx công bố riêng < 16.384 byte", single.every((s) => s < MAX_TX), single.join(" / "));
  let combined = -1;
  try {
    const tx = await lucid.newTx()
      .pay.ToAddressWithData(park, undefined, { lovelace: lov[0]! }, plan[0]!.script)
      .pay.ToAddressWithData(park, undefined, { lovelace: lov[1]! }, plan[1]!.script)
      .complete();
    combined = size(tx);
  } catch (e) {
    console.log(`     gộp hai script một tx: KHÔNG dựng được — ${(e as Error).message.slice(0, 160)}`);
  }
  // Đo, không ép: gộp được hay không là dữ kiện cho lựa chọn tách (khối đầu `10_deploy_prepaid.ts`),
  // không phải điều kiện đúng. In ra để người đọc thấy biên.
  console.log(`     gộp hai script một tx: ${combined < 0 ? "không dựng được" : `${combined} B, còn ${MAX_TX - combined} B tới trần`}`);

  const before = (await lucid.wallet().getUtxos()).length;
  const refs: string[] = [];
  for (const [i, p] of plan.entries()) {
    refs.push(await publishRefScript({
      lucid, parkAddr: park, label: p.label, script: p.script, hash: p.hash, lovelace: lov[i]!,
      attempts: 1, retryDelayMs: 0,
    }));
    emulator.awaitBlock(1);
  }
  const parked = await lucid.utxosAt(park);
  check("bãi đỗ mang đúng hai ref-script theo hash",
    plan.every((p) => parked.some((u) => u.scriptRef && validatorToScriptHash(u.scriptRef) === p.hash)),
    `${parked.length} UTxO ở bãi`);
  const again = await publishRefScript({
    lucid, parkAddr: park, label: "prepaid_vault ref (lần 2)", script: plan[0]!.script, hash: plan[0]!.hash,
    lovelace: lov[0]!, attempts: 1, retryDelayMs: 0,
  });
  check("idempotent: công bố lần hai trả đúng UTxO cũ, không đỗ thêm",
    again === refs[0] && (await lucid.utxosAt(park)).length === parked.length);
  check("ví còn UTxO sau hai lượt công bố", before > 0 && (await lucid.wallet().getUtxos()).length > 0);

  const vRef = await fetchRefScriptUtxo({ lucid, outRef: refs[0]!, wantHash: pair.vaultHash, label: REF_VAULT_PREPAID_KEY });
  check("đọc lại REF_VAULT_PREPAID_UTXO bằng hash két", vRef.txHash === refs[0]!.split("#")[0]);
  await phaiNem("CỰC ĐỐI: đảo hai khoá ref-script ⟹ ném nêu khả năng bị đảo",
    () => fetchRefScriptUtxo({ lucid, outRef: refs[1]!, wantHash: pair.vaultHash, label: REF_VAULT_PREPAID_KEY }), /đảo/);
}

main()
  .then(() => {
    console.log(sai === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${sai} ca sai ===`);
    process.exit(sai === 0 ? 0 : 1);
  })
  .catch((e) => { console.error(e); console.log("\n=== HỎNG: bộ ca không chạy hết ==="); process.exit(1); });
