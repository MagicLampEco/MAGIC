// scripts/test_deploy_gen_v2.ts — bộ ca cho các bước deploy két Gen v2.0 (05 · 06 · 07 · 08).
// Không gọi mạng, không đọc sổ thật, không đọc khoá. Emulator Lucid đánh giá UPLC THẬT trong
// `complete()` (blueprint `InstantGen/onchain/plutus.json`, `ScheduleGen/onchain/plutus.json`).
// Chạy từ scripts/:  npx tsx test_deploy_gen_v2.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Phủ:
//   (A) hash dựng từ `deployParams.ts` TRÙNG hash của gói nền cho cùng đầu vào; cặp đối: đảo hai
//       ô cùng kiểu ⟹ hash khác (ca xanh ở cả hai cực thì nó không kiểm gì).
//   (B) `genV2BeaconRefsFromBook`: thiếu khoá ⟹ ném nêu ĐỦ tên; hex hỏng ⟹ ném.
//   (C) datum genesis của 05/07 trùng CBOR bản của MagicSDK (`buildInitialVaultDatum`), 20/19 trường.
//   (D) Emulator: genesis két SG + IG qua validator thật (cặp: một ô datum lệch ⟹ bị bác) ·
//       công bố ba ref-script ScheduleGen, mỗi cái một tx < 16 384 B (cặp: gộp két + commit ⟹
//       vượt trần) · đăng ký stake `commit` rồi chạy lại ⟹ bỏ qua (cặp: đầu dò nói sai ⟹ ledger bác).
// KHÔNG phủ ở đây: một tx ký (commit lịch) thật — cần cả cụm GenBeacons + 16 shard LAMP; ca đó
// nằm ở `ScheduleGen/tests/e2eEmulator.test.ts`, và (A) chứng minh hàm apply ở đây ra ĐÚNG hash
// của `applyScheduleScripts` mà bộ đó dùng.

import { readFileSync } from "node:fs";
import {
  Emulator, Lucid, Data, PROTOCOL_PARAMETERS_DEFAULT, generateEmulatorAccount, getAddressDetails,
  toUnit, validatorToScriptHash,
  type LucidEvolution, type Validator,
} from "@lucid-evolution/lucid";
import { msPerEpoch } from "@magiclamp/protocol-utils";
import { loadBlueprint, findValidator, appliedScript } from "./applyParams.js";
import {
  instantVaultParams, scheduleScriptPair, genV2BeaconRefsFromBook,
  type GenV2BeaconRefs, type ScheduleScriptParamInputs,
} from "./deployParams.js";
import { publishRefScript, parkAddressFor } from "./refScripts.js";
import { minAdaForRefScriptWithMargin } from "./minAda.js";
import { vaultIdAssetName, mintVaultIdRedeemer, pickSeedUtxo } from "./vaultId.js";
import { buildScheduleVaultCreateTx, scheduleGenesisDatum } from "./deploy/07_create_schedule_vault.js";
import { buildInstantVaultCreateTx, instantGenesisDatum } from "./deploy/05_create_instant_vault.js";
import { scheduleRefScriptPlan, REF_COMMIT_KEY } from "./deploy/06_publish_ref_scripts.js";
import { registerCommitStake } from "./deploy/08_register_commit_stake.js";
import { SCHEDULE_ONLY_STATE_KEYS } from "./gen_vault_tx_api_deployment.js";
import { applyInstantVaultParams } from "../InstantGen/offchain/src/vaultScript.js";
import { VaultDatum as IgVaultDatum } from "../InstantGen/offchain/src/types.js";
import { applyScheduleScripts, type ScheduleBlueprint } from "../ScheduleGen/offchain/src/params.js";
import { VaultDatum as SgVaultDatum } from "../ScheduleGen/offchain/src/types.js";
import { buildInitialVaultDatum } from "../MagicSDK/src/vaultDatum.js";
import { InstantVaultDatumSchema, VaultDatumSchema as SdkScheduleSchema } from "../MagicSDK/src/schemas.js";

let fails = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
}
async function throwsWith(name: string, f: () => unknown, re: RegExp): Promise<void> {
  try { await f(); check(name, false, "không ném"); }
  catch (e) { const m = (e as Error).message ?? String(e); check(name, re.test(m), re.test(m) ? "" : `ném câu khác: ${m.slice(0, 200)}`); }
}
const h = (b: string) => b.repeat(28);
const MAX_TX = 16_384;
const NET = "Preprod" as const;
const MS = msPerEpoch(NET);
const LAMP_POLICY = h("4c");
const LAMP_NAME = "744c414d50";

// Năm ô beacon MANG GIÁ TRỊ KHÁC NHAU — đảo hai ô phải đổi hash; cùng giá trị thì ca đảo vô nghĩa.
const BEACONS: GenV2BeaconRefs = {
  gbBeaconNftPolicy: h("a1"), gbBeaconScriptHash: h("a1"), gbShardPolicyId: h("a3"),
  rateNftPolicy: h("a5"), rateScriptHash: h("a5"),
};
const SG_IN: ScheduleScriptParamInputs = {
  lampPolicyId: LAMP_POLICY, lampAssetName: LAMP_NAME, shardPolicyId: h("5a"), msPerEpoch: MS, ...BEACONS,
};

async function main() {
  const igBp = await loadBlueprint("InstantGen");
  const sgBp = await loadBlueprint("ScheduleGen");
  const sgBpRaw = JSON.parse(readFileSync(new URL("../ScheduleGen/onchain/plutus.json", import.meta.url), "utf8")) as ScheduleBlueprint;

  // ── (A) hash trùng gói nền ──────────────────────────────────────────────────
  console.log("── (A) hash deployParams ↔ gói nền");
  const igIn = { lampPolicyId: LAMP_POLICY, lampAssetName: LAMP_NAME, ...BEACONS, wakemeVaultHash: h("77"), msPerEpoch: MS };
  const igOurs = appliedScript(findValidator(igBp, "vault.vault.spend"), instantVaultParams(igIn)).hash;
  const igBase = validatorToScriptHash(applyInstantVaultParams(findValidator(igBp, "vault.vault.spend").compiledCode, igIn));
  check("IG két: deployParams == applyInstantVaultParams", igOurs === igBase, igOurs);
  const igSwap = appliedScript(findValidator(igBp, "vault.vault.spend"),
    instantVaultParams({ ...igIn, gbBeaconNftPolicy: igIn.rateNftPolicy, rateNftPolicy: igIn.gbBeaconNftPolicy })).hash;
  check("IG két CỰC ĐỐI: đảo gb_beacon_nft_policy ↔ rate_nft_policy ⟹ hash khác", igSwap !== igOurs);

  const pair = scheduleScriptPair(sgBp, SG_IN);
  const base = applyScheduleScripts(sgBpRaw, SG_IN);
  check("SG commit: deployParams == applyScheduleScripts", pair.commitHash === base.commitScriptHash, pair.commitHash);
  check("SG két: deployParams == applyScheduleScripts", pair.vaultHash === base.vaultScriptHash, pair.vaultHash);
  const sgSwap = scheduleScriptPair(sgBp, { ...SG_IN, shardPolicyId: SG_IN.gbShardPolicyId, gbShardPolicyId: SG_IN.shardPolicyId });
  check("SG CỰC ĐỐI: đảo shard_policy_id ↔ gb_shard_policy_id ⟹ commit + két đều khác",
    sgSwap.commitHash !== pair.commitHash && sgSwap.vaultHash !== pair.vaultHash);
  const sgSwapBeacon = scheduleScriptPair(sgBp, { ...SG_IN, gbBeaconScriptHash: SG_IN.rateScriptHash, rateScriptHash: SG_IN.gbBeaconScriptHash });
  check("SG CỰC ĐỐI: đảo gb_beacon_script_hash ↔ rate_script_hash ⟹ commit khác ⟹ két khác",
    sgSwapBeacon.commitHash !== pair.commitHash && sgSwapBeacon.vaultHash !== pair.vaultHash);

  // ── (B) đọc sổ ─────────────────────────────────────────────────────────────
  console.log("── (B) genV2BeaconRefsFromBook");
  const book = { RATE_PARAM_HASH: h("a5"), GREENBACK_BEACON_HASH: h("a1"), GB_SHARD_HASH: h("a3") };
  const refs = genV2BeaconRefsFromBook(book);
  check("sổ đủ ⟹ policy NFT = script hash của đúng beacon",
    refs.rateNftPolicy === book.RATE_PARAM_HASH && refs.rateScriptHash === book.RATE_PARAM_HASH &&
    refs.gbBeaconNftPolicy === book.GREENBACK_BEACON_HASH && refs.gbBeaconScriptHash === book.GREENBACK_BEACON_HASH &&
    refs.gbShardPolicyId === book.GB_SHARD_HASH);
  await throwsWith("thiếu hai khoá ⟹ ném nêu ĐỦ cả hai", () => genV2BeaconRefsFromBook({ RATE_PARAM_HASH: h("a5") }),
    /GREENBACK_BEACON_HASH, GB_SHARD_HASH/);
  await throwsWith("hex hỏng ⟹ ném nêu khoá", () => genV2BeaconRefsFromBook({ ...book, GB_SHARD_HASH: "FILL_ME" }), /GB_SHARD_HASH="FILL_ME"/);
  check("REF_COMMIT_KEY là khoá của bảng bộ sinh", REF_COMMIT_KEY in SCHEDULE_ONLY_STATE_KEYS, REF_COMMIT_KEY);

  // ── (C) datum genesis ↔ MagicSDK ───────────────────────────────────────────
  console.log("── (C) datum genesis ↔ MagicSDK");
  const OWNER = h("0a");
  const g = { ownerPkh: OWNER, lampOildrop: 7_000_000_000n, profile: "Flame" as const, currentEpoch: 4_001n };
  const sdkIg = Data.to(buildInitialVaultDatum({ ownerPkh: OWNER, lampBalanceOildrop: g.lampOildrop, profile: "Flame", currentEpoch: g.currentEpoch, vaultType: "Instant" }) as never, InstantVaultDatumSchema as never);
  const sdkSg = Data.to(buildInitialVaultDatum({ ownerPkh: OWNER, lampBalanceOildrop: g.lampOildrop, profile: "Flame", currentEpoch: g.currentEpoch, vaultType: "Schedule" }) as never, SdkScheduleSchema as never);
  const ourIg = Data.to(instantGenesisDatum(g), IgVaultDatum);
  const ourSg = Data.to(scheduleGenesisDatum(g), SgVaultDatum);
  check("IG genesis (05) == SDK, CBOR", ourIg === sdkIg);
  check("SG genesis (07) == SDK, CBOR", ourSg === sdkSg);
  const nFields = (cbor: string) => (Data.from(cbor) as { fields: unknown[] }).fields.length;
  check("IG genesis 20 trường · SG genesis 19 trường", nFields(ourIg) === 20 && nFields(ourSg) === 19, `${nFields(ourIg)}/${nFields(ourSg)}`);

  // ── (D) Emulator ───────────────────────────────────────────────────────────
  console.log("── (D) Emulator (UPLC thật)");
  const lampUnit = toUnit(LAMP_POLICY, LAMP_NAME);
  const deployer = generateEmulatorAccount({ lovelace: 2_000_000_000n, [lampUnit]: 100_000_000_000n });
  const emulator = new Emulator([deployer], { ...PROTOCOL_PARAMETERS_DEFAULT, maxTxSize: MAX_TX });
  const lucid: LucidEvolution = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(deployer.seedPhrase);
  const ownerPkh = getAddressDetails(deployer.address).paymentCredential!.hash;
  const epoch = BigInt(emulator.now()) / MS;
  const size = (tx: { toCBOR(): string }) => tx.toCBOR().length / 2;
  const submit = async (tx: { sign: { withWallet(): { complete(): Promise<{ submit(): Promise<string> }> } } }) => {
    const hash = await (await tx.sign.withWallet().complete()).submit();
    emulator.awaitBlock(1);
    return hash;
  };

  // D1 — genesis két SG (07): validator mint thật.
  const sg = await buildScheduleVaultCreateTx({
    lucid, network: "Custom", vaultScript: pair.vaultScript, vaultHash: pair.vaultHash, ownerPkh,
    walletUtxos: await lucid.wallet().getUtxos(), lampUnit, lampOildrop: 10_000_000_000n, profile: "Flame", currentEpoch: epoch,
  });
  check("07 genesis két SG v2 qua validator mint", true, `tx ${size(sg.tx)} B`);
  await submit(sg.tx);
  const sgUtxo = (await lucid.utxosAt(sg.vaultAddress)).find((u) => u.assets[sg.vaultIdUnit] === 1n);
  check("két SG nằm ở địa chỉ két, mang NFT danh tính", sgUtxo !== undefined);

  // D1' — cặp: đúng tx đó nhưng usage_window_epoch = 1 (ô v2.0 duy nhất khác) ⟹ validator bác.
  await throwsWith("07 CỰC ĐỐI: usage_window_epoch = 1 ⟹ validator mint bác", async () => {
    const utxos = await lucid.wallet().getUtxos();
    const seedU = pickSeedUtxo(utxos);
    const seed = { txHash: seedU.txHash, outputIndex: seedU.outputIndex };
    const unit = toUnit(pair.vaultHash, vaultIdAssetName(seed));
    const d = { ...scheduleGenesisDatum({ ownerPkh, lampOildrop: 1_000_000n, profile: "Flame", currentEpoch: epoch }), usage_window_epoch: 1n };
    await lucid.newTx().collectFrom([seedU]).mintAssets({ [unit]: 1n }, mintVaultIdRedeemer(seed))
      .attach.MintingPolicy(pair.vaultScript)
      .pay.ToAddressWithData(sg.vaultAddress, { kind: "inline", value: Data.to(d, SgVaultDatum) },
        { lovelace: 2_000_000n, [lampUnit]: 1_000_000n, [unit]: 1n })
      .addSignerKey(ownerPkh).complete();
  }, /fail|script|validator|execution/i);

  // D2 — genesis két IG (05).
  const igScript = appliedScript(findValidator(igBp, "vault.vault.spend"), instantVaultParams(igIn));
  const ig = await buildInstantVaultCreateTx({
    lucid, network: "Custom", vaultScript: igScript.script, vaultHash: igScript.hash, ownerPkh,
    walletUtxos: await lucid.wallet().getUtxos(), lampUnit, lampOildrop: 10_000_000_000n, profile: "Flame", currentEpoch: epoch,
  });
  check("05 genesis két IG v2 qua validator mint", true, `tx ${size(ig.tx)} B`);
  await submit(ig.tx);
  await throwsWith("05 CỰC ĐỐI: consumed_credit = 0 (thay hạt giống) ⟹ validator mint bác", async () => {
    const utxos = await lucid.wallet().getUtxos();
    const seedU = pickSeedUtxo(utxos);
    const seed = { txHash: seedU.txHash, outputIndex: seedU.outputIndex };
    const unit = toUnit(igScript.hash, vaultIdAssetName(seed));
    const d0 = instantGenesisDatum({ ownerPkh, lampOildrop: 1_000_000n, profile: "Flame", currentEpoch: epoch });
    const d = { ...d0, activity_state: { ...d0.activity_state, consumed_credit: 0n } };
    await lucid.newTx().collectFrom([seedU]).mintAssets({ [unit]: 1n }, mintVaultIdRedeemer(seed))
      .attach.MintingPolicy(igScript.script)
      .pay.ToAddressWithData(ig.vaultAddress, { kind: "inline", value: Data.to(d, IgVaultDatum) },
        { lovelace: 2_000_000n, [lampUnit]: 1_000_000n, [unit]: 1n })
      .addSignerKey(ownerPkh).complete();
  }, /fail|script|validator|execution/i);

  // D3 — 06: ba ref-script, mỗi cái MỘT tx; đo kích thước; cặp: gộp két + commit ⟹ vượt trần.
  const parkAddr = parkAddressFor("Custom", deployer.address);
  const plan = scheduleRefScriptPlan(sgBp, SG_IN);
  check("06 kế hoạch: két · shard · commit, hash két/commit trùng cặp của 07",
    plan.map((p) => p.bookKey).join(",") === `REF_VAULT_SCHEDULE_UTXO,REF_SHARD_UTXO,${REF_COMMIT_KEY}` &&
    plan[0]!.hash === pair.vaultHash && plan[2]!.hash === pair.commitHash);
  const refOut: Record<string, string> = {};
  for (const p of plan) {
    const lovelace = minAdaForRefScriptWithMargin(p.script.script);
    const probe = await lucid.newTx().pay.ToAddressWithData(parkAddr, undefined, { lovelace }, p.script).complete();
    check(`06 ${p.label}: tx công bố < ${MAX_TX} B`, size(probe) < MAX_TX,
      `script ${p.script.script.length / 2} B · tx ${size(probe)} B · min-ADA ${lovelace / 1_000_000n} ADA`);
    refOut[p.bookKey] = await publishRefScript({ lucid, parkAddr, label: p.label, script: p.script, hash: p.hash, lovelace, retryDelayMs: 0, attempts: 1 });
  }
  const again = await publishRefScript({ lucid, parkAddr, label: "commit ref (lần 2)", script: pair.commitScript, hash: pair.commitHash, lovelace: 1n, retryDelayMs: 0, attempts: 1 });
  check("06 chạy lại ⟹ trả UTxO đã đỗ, không công bố thêm", again === refOut[REF_COMMIT_KEY], again);
  const parkedCommit = (await lucid.utxosAt(parkAddr)).find((u) => `${u.txHash}#${u.outputIndex}` === refOut[REF_COMMIT_KEY]);
  check("REF_COMMIT_SCHEDULE_UTXO mang đúng script `commit`",
    parkedCommit?.scriptRef != null && validatorToScriptHash(parkedCommit.scriptRef as Validator) === pair.commitHash);
  await throwsWith("06 CỰC ĐỐI: gộp két + commit vào MỘT tx ⟹ vượt trần", async () => {
    const tx = await lucid.newTx()
      .pay.ToAddressWithData(parkAddr, undefined, { lovelace: minAdaForRefScriptWithMargin(pair.vaultScript.script) }, pair.vaultScript)
      .pay.ToAddressWithData(parkAddr, undefined, { lovelace: minAdaForRefScriptWithMargin(pair.commitScript.script) }, pair.commitScript)
      .complete();
    if (size(tx) > MAX_TX) throw new Error(`size ${size(tx)} > max`);
  }, /size|max|exceed/i);

  // D4 — 08: đăng ký stake `commit`, idempotent.
  const chain = (emulator as unknown as { chain: Record<string, { registeredStake?: boolean } | undefined> }).chain;
  const probe = async (addr: string) => chain[addr]?.registeredStake === true;
  const dry = await registerCommitStake({ lucid, network: "Custom", commitScript: pair.commitScript, isRegistered: probe, dryRun: true });
  check("08 DRY_RUN: dựng tx, không gửi", dry.status === "dry-run" && !(await probe(dry.rewardAddress)), `${dry.status}`);
  const r1 = await registerCommitStake({ lucid, network: "Custom", commitScript: pair.commitScript, isRegistered: probe, dryRun: false });
  check("08 lần 1: đăng ký", r1.status === "registered" && (await probe(r1.rewardAddress)),
    r1.status === "registered" ? `tx ${r1.txBytes} B` : r1.status);
  check("08 reward address = script `commit` của cặp 07", r1.commitHash === pair.commitHash);
  const r2 = await registerCommitStake({ lucid, network: "Custom", commitScript: pair.commitScript, isRegistered: probe, dryRun: false });
  check("08 lần 2: đã đăng ký ⟹ bỏ qua, không dựng tx", r2.status === "already-registered");
  await throwsWith("08 CỰC ĐỐI: đầu dò nói sai 'chưa' ⟹ ledger bác đăng ký lần hai",
    () => registerCommitStake({ lucid, network: "Custom", commitScript: pair.commitScript, isRegistered: async () => false, dryRun: false }),
    /already registered/);

  console.log(fails === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${fails} ca sai ===`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => { console.error(e); console.log("\n=== HỎNG: ném ngoài ca ==="); process.exit(1); });
