// scripts/test/schedule_fire_only.ts — ScheduleGen Fire smoke test.
// Reads first gen_schedule from vault datum; fires up to MAX_FIRES_PER_TX_CATCHUP.

import {
  Lucid, Blockfrost, Data, Constr,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, ADDRESSES, PROTOCOL,
} from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { scheduleVaultParams, shardSpendParams } from "../deployParams.js";
import { buildScheduleFireTx } from "../../ScheduleGen/offchain/src/schedule.js";
import { VaultDatumSchema } from "../../ScheduleGen/offchain/src/types.js";

async function fetchTip() {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await res.json() as { slot: number; time: number };
  return { posixMs: BigInt(tip.time) * 1000n };
}

// ── Script tham chiếu (CIP-33) ──────────────────────────────────────────────
// Đính kèm CẢ HAI validator (vault + shard) làm tx vượt trần 16384 byte — đo
// thật trên Preview: 17303. Nên hai bước ScheduleGen BẮT BUỘC đọc script từ
// chain. Chạy `npx tsx deploy/06_publish_ref_scripts.ts` rồi nạp hai biến.
async function refScriptUtxos(lucid: any) {
  const refs = [process.env.REF_VAULT_SCHEDULE_UTXO, process.env.REF_SHARD_UTXO]
    .filter((s): s is string => !!s)
    .map((s) => { const [h, i] = s.split("#"); return { txHash: h!, outputIndex: Number(i) }; });
  if (refs.length === 0) return undefined;
  return await lucid.utxosByOutRef(refs);
}

async function main() {
  console.log("╔════════════════════════════════════════════╗");
  console.log(`║  ScheduleFire smoke test — ${NETWORK.padEnd(15)}║`);
  console.log("╚════════════════════════════════════════════╝\n");

  // Apply-param THEO TÊN — dùng chung bản đồ giá trị với deploy/07.
  const blueprint      = await loadBlueprint("ScheduleGen");
  const vaultUnapplied = findValidator(blueprint, "vault.vault.spend");
  const shardUnapplied = findValidator(blueprint, "vault.shard.spend");

  const { script: vaultScript, hash: vaultHash } = appliedScript(
    vaultUnapplied,
    scheduleVaultParams({
      lampPolicyId:  POLICY_IDS.lamp,
      lampAssetName: ASSET_NAMES.lamp,
      shardPolicyId: POLICY_IDS.shard_nft,
      msPerEpoch:    PROTOCOL.MS_PER_EPOCH,
    }),
  );
  const { script: shardScript, hash: shardHash } = appliedScript(
    shardUnapplied,
    shardSpendParams({ shardPolicyId: POLICY_IDS.shard_nft }),
  );
  const vaultAddr = credentialToAddress(NETWORK, scriptHashToCredential(vaultHash));
  const shardAddr = credentialToAddress(NETWORK, scriptHashToCredential(shardHash));

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const ownerPkh = getAddressDetails(address).paymentCredential!.hash;

  // Blockfrost đánh chỉ mục UTxO trễ vài giây sau tx trước (ScheduleCommit vừa
  // xác nhận). Không chờ thì bước này báo "Vault not found" và che mất lý do
  // THẬT — đo được trên Preview 2026-08-13: commit PASS ngay trước đó.
  const wantedTx = process.env.VAULT_TX_HASH;
  const mine = (u: { datum?: string | null }) => {
    if (!u.datum) return false;
    try { return Data.from(u.datum, VaultDatumSchema).owner === ownerPkh; } catch { return false; }
  };
  let vaultUtxo;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const vaultUtxos = await lucid.utxosAt(vaultAddr);
    vaultUtxo = vaultUtxos.find((u) => mine(u) && (!wantedTx || u.txHash === wantedTx));
    if (vaultUtxo) break;
    // Hết lượt mà vẫn không thấy đúng tx: lấy vault CÓ lịch mới nhất, còn hơn
    // dừng ở một thông báo không nói được gì.
    if (attempt === 5) {
      vaultUtxo = vaultUtxos.find((u) => mine(u) && Data.from(u.datum!, VaultDatumSchema).gen_schedules.length > 0);
      if (vaultUtxo) console.log(`⚠ không thấy VAULT_TX_HASH=${wantedTx}; dùng vault có lịch: ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`);
      break;
    }
    console.log(`  … chưa thấy vault ở chỉ mục Blockfrost (lần ${attempt}), chờ 15s`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!vaultUtxo) { console.error("❌ Vault not found"); process.exit(1); }

  const vd = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  if (vd.gen_schedules.length === 0) {
    console.error("❌ No schedules. Run Commit first or deploy with PRESEED_SCHEDULE_L>0.");
    process.exit(1);
  }
  const scheduleId = process.env.SCHEDULE_ID ?? vd.gen_schedules[0].schedule_id;
  const sched = vd.gen_schedules.find(s => s.schedule_id === scheduleId)!;
  console.log(`Vault UTxO:        ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`);
  console.log(`Schedule ID:       ${scheduleId.slice(0, 16)}...`);
  console.log(`Start fire epoch:  ${sched.start_fire_epoch}`);
  console.log(`Fired count:       ${sched.fired_count} / ${sched.schedule_length}`);

  // One-shot policy issues 16 DISTINCT asset names (SHARD#0..15). Match any
  // asset under the shard NFT policy id, not a single shared "SHARD" name.
  const allShards = await lucid.utxosAt(shardAddr);
  const shardUtxos = allShards.filter(u =>
    Object.keys(u.assets).some(unit => unit.startsWith(POLICY_IDS.shard_nft) && u.assets[unit] > 0n));
  console.log(`Shards (total/active): ${allShards.length}/${shardUtxos.length}\n`);

  const tip = await fetchTip();
  console.log(`Current epoch:     ${tip.posixMs / PROTOCOL.MS_PER_EPOCH}\n`);

  const tamper = process.env.TAMPER;
  const tamperOutputDatum = tamper ? ((d: any) => {
    if (tamper === "lamp_balance") return { ...d, lamp_balance: d.lamp_balance + 1n };
    throw new Error(`Unknown TAMPER: ${tamper}`);
  }) : undefined;

  try {
    if (tamper) console.log(`⚠  TEST MODE: ${tamper} — expecting REJECT.\n`);
    const refUtxos = await refScriptUtxos(lucid);
    const result = await buildScheduleFireTx({
      refScriptUtxos: refUtxos,
      lucid, vaultUtxo, shardUtxos, scheduleId,
      vaultScript, shardScript,
      lampPolicyId: POLICY_IDS.lamp,
      lampAssetName: ASSET_NAMES.lamp,
      network: NETWORK, tipPosixMs: tip.posixMs,
      tamperOutputDatum,
    });
    console.log(result.summary);
    const signed = await result.tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("\n╔════════════════════════════════════════════╗");
    console.log("║              ✅ SUCCESS                    ║");
    console.log("╚════════════════════════════════════════════╝");
    console.log(`TX hash:  ${txHash}`);
    console.log(`Explorer: https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  } catch (err: any) {
    console.error("\n╔════════════════════════════════════════════╗");
    console.error("║              ❌ FAILED                     ║");
    console.error("╚════════════════════════════════════════════╝");
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
