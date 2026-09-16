// scripts/test/schedule_commit_only.ts — ScheduleGen Commit smoke test.
//
// Env knobs:
//   VAULT_TX_HASH=<hex>
//   SCHEDULE_LENGTH=<int>   (L ∈ [10, 200], default 10)
//   LAMP_PER_EPOCH=<int>    (λ in tLAMP, default 1)
//   TAMPER=<mode>
//   SKIP_OWNER_SIG=1

import {
  Lucid, Blockfrost, Data, Constr,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, ADDRESSES, PROTOCOL,
  lampToOildrop,
} from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { scheduleVaultParams, shardSpendParams } from "../deployParams.js";
import { buildScheduleCommitTx } from "../../ScheduleGen/offchain/src/schedule.js";
import { VaultDatumSchema } from "../../ScheduleGen/offchain/src/types.js";

const L = BigInt(process.env.SCHEDULE_LENGTH ?? "10");
const LAMBDA = lampToOildrop(BigInt(process.env.LAMP_PER_EPOCH ?? "1"));

async function fetchTip() {
  const res = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await res.json() as { slot: number; time: number };
  return { slot: BigInt(tip.slot), posixMs: BigInt(tip.time) * 1000n };
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
  console.log(`║  ScheduleCommit smoke test — ${NETWORK.padEnd(13)}║`);
  console.log("╚════════════════════════════════════════════╝\n");

  // Apply-param THEO TÊN — dùng chung bản đồ giá trị với deploy/07 nên địa chỉ
  // dựng lại ở đây không thể lệch với vault đã deploy.
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
    shardSpendParams({ shardPolicyId: POLICY_IDS.shard_nft, vaultScriptHash: vaultHash }),
  );
  const vaultAddr = credentialToAddress(NETWORK, scriptHashToCredential(vaultHash));
  const shardAddr = credentialToAddress(NETWORK, scriptHashToCredential(shardHash));

  console.log(`Vault address:  ${vaultAddr}`);
  console.log(`Shard address:  ${shardAddr}\n`);

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const ownerPkh = getAddressDetails(address).paymentCredential!.hash;

  const wantedTx = process.env.VAULT_TX_HASH;
  const vaultUtxos = await lucid.utxosAt(vaultAddr);
  const vaultUtxo = vaultUtxos.find((u) => {
    if (!u.datum) return false;
    if (wantedTx && u.txHash !== wantedTx) return false;
    try { return Data.from(u.datum, VaultDatumSchema).owner === ownerPkh; } catch { return false; }
  });
  // 🔴 `Vault not found` GỘP BỐN NGUYÊN NHÂN ĐÒI BỐN HÀNH ĐỘNG KHÁC NHAU.
  //
  //  Bộ lọc trên có bốn vế loại: địa chỉ rỗng · không datum · khác `wantedTx` · khác
  //  chủ. Bốn vế đó in ra CÙNG MỘT dòng, nên người đọc không biết mình đang ở ca nào —
  //  và hai trong bốn ca đòi hành động NGƯỢC NHAU: ca "vault đã dời" thì phải đi TIẾP
  //  sang chặng 2, ca "vault chưa có" thì phải quay LẠI bước [4/5]. Đoán sai chiều ở
  //  đây tốn một lượt cam kết thừa (thêm một `gen_schedule` vào vault đang sống) hoặc
  //  một lượt tạo vault thừa (chôn 10.000 tLAMP).
  //
  //  Ca nguy nhất là **vault đã dời**: `ScheduleCommit` TIÊU UTxO vault
  //  (`ScheduleGen/offchain/src/schedule.ts` ▸ `buildScheduleCommitTx` ▸ `.collectFrom`),
  //  nên một lượt cam kết ĐÃ THÀNH CÔNG làm `VAULT_TX_HASH` đã ghim trỏ vào một UTxO
  //  đã chết. Triệu chứng của "cam kết đã xong" và của "vault chưa bao giờ có" giống
  //  hệt nhau nếu chỉ đọc một dòng.
  if (!vaultUtxo) {
    const coDatum = vaultUtxos.filter((u) => u.datum);
    const cuaMinh = coDatum.filter((u) => {
      try { return Data.from(u.datum!, VaultDatumSchema).owner === ownerPkh; } catch { return false; }
    });
    console.error(`\n❌ Không tìm được vault khớp bộ lọc. Số đo tại ${vaultAddr}:`);
    console.error(`   UTxO tại địa chỉ vault : ${vaultUtxos.length}`);
    console.error(`   … trong đó có datum    : ${coDatum.length}`);
    console.error(`   … trong đó chủ là mình : ${cuaMinh.length}   (owner = ${ownerPkh})`);
    console.error(`   VAULT_TX_HASH đang ghim: ${wantedTx ?? "(không ghim)"}`);

    for (const u of cuaMinh) {
      const d = Data.from(u.datum!, VaultDatumSchema) as any;
      console.error(
        `   • ${u.txHash}#${u.outputIndex}` +
        `  gen_schedules=${(d.gen_schedules as any[]).length}` +
        `  magic_batches=${(d.magic_batches as any[]).length}` +
        `  lamp_locked=${d.lamp_locked}`,
      );
    }

    if (cuaMinh.length > 0 && wantedTx && !cuaMinh.some((u) => u.txHash === wantedTx)) {
      const song = cuaMinh[0]!;
      const d = Data.from(song.datum!, VaultDatumSchema) as any;
      const daCoLich = (d.gen_schedules as any[]).length > 0;
      console.error(
        `\n⟹ VAULT ĐÃ DỜI. Vault của mình còn SỐNG, chỉ là ở tx khác hash đang ghim.\n` +
        `   Nguyên nhân thường gặp nhất: một lượt cam kết TRƯỚC ĐÂY đã chạy xong —\n` +
        `   cam kết TIÊU UTxO vault rồi tạo lại, nên hash tạo-vault không còn trỏ đúng.\n` +
        (daCoLich
          ? `   🔴 Vault này ĐÃ CÓ ${(d.gen_schedules as any[]).length} lịch. ĐỪNG cam kết lại —\n` +
            `      cam kết lần nữa chỉ thêm một lịch thừa vào vault đang sống. Việc cần làm\n` +
            `      là ĐI TIẾP sang chặng 2 với hash dưới đây (chờ đủ 2 epoch kể từ lúc cam\n` +
            `      kết thật, không phải kể từ bây giờ):\n\n` +
            `      bash run_consume_schedule_e2e.sh ${NETWORK} 2 ${song.txHash}\n`
          : `   Vault này CHƯA có lịch nào ⟹ lượt cam kết trước chưa xong, hoặc vault vừa\n` +
            `   dời vì một lý do khác. Cập nhật dòng VAULT_TX_HASH_SCHEDULE trong\n` +
            `   deployed.${NETWORK}.env thành ${song.txHash} rồi chạy lại chặng 1.\n`),
      );
      process.exit(1);
    }
    if (vaultUtxos.length === 0) {
      console.error(
        `\n⟹ ĐỊA CHỈ VAULT RỖNG. Hai khả năng, đòi hai hành động ngược nhau:\n` +
        `   (a) vault chưa từng được tạo ở địa chỉ NÀY — thường là apply-param đã đổi nên\n` +
        `       địa chỉ đổi theo. Đối chiếu địa chỉ in ở đầu với scripts/DEPLOYED.md.\n` +
        `   (b) chỉ mục Blockfrost còn trễ. Chờ ~1 phút rồi chạy lại; lượt chạy này KHÔNG\n` +
        `       gửi giao dịch nào nên chạy lại không mất gì.\n` +
        `   ⛔ ĐỪNG xoá VAULT_TX_HASH_SCHEDULE để "tạo vault mới" trước khi phân biệt xong:\n` +
        `      ở ca (b) nó chôn thêm 10.000 tLAMP vào một vault thứ hai.`,
      );
      process.exit(1);
    }
    if (cuaMinh.length === 0) {
      console.error(
        `\n⟹ CÓ VAULT NHƯNG KHÔNG CÁI NÀO CỦA VÍ NÀY. Ví đang dùng không phải chủ vault,\n` +
        `   hoặc địa chỉ vault này thuộc một lượt deploy khác. Kiểm biến seed đang nạp.`,
      );
      process.exit(1);
    }
    process.exit(1);
  }
  console.log(`Vault UTxO:     ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`);

  // One-shot policy issues 16 DISTINCT asset names (SHARD#0..15, = "SHARD" ∥
  // byte(id)) — the validator now identifies each shard by its distinct name.
  // Match any asset under the shard NFT policy id.
  const allShards = await lucid.utxosAt(shardAddr);
  const shardUtxos = allShards.filter(u =>
    Object.keys(u.assets).some(unit => unit.startsWith(POLICY_IDS.shard_nft) && u.assets[unit] > 0n));
  console.log(`Shards (total/active): ${allShards.length}/${shardUtxos.length}\n`);
  if (shardUtxos.length < PROTOCOL.SHARD_COUNT) {
    console.error(`❌ Expected ${PROTOCOL.SHARD_COUNT} shards`); process.exit(1);
  }

  const tip = await fetchTip();
  console.log(`Current epoch:  ${tip.posixMs / PROTOCOL.MS_PER_EPOCH}`);
  console.log(`L = ${L}, λ = ${LAMBDA / 1_000_000n} tLAMP\n`);

  const tamper = process.env.TAMPER;
  const tamperOutputDatum = tamper ? ((d: any) => {
    if (tamper === "lamp_locked")        return { ...d, lamp_locked: d.lamp_locked + 1n };
    if (tamper === "no_schedule_added")  return { ...d, gen_schedules: [] };
    if (tamper === "fake_rate_locked")   return {
      ...d,
      gen_schedules: d.gen_schedules.map((s: any, i: number) =>
        i === d.gen_schedules.length - 1 ? { ...s, rate_locked_q: s.rate_locked_q * 2n } : s),
    };
    throw new Error(`Unknown TAMPER: ${tamper}`);
  }) : undefined;

  try {
    if (tamper || process.env.SKIP_OWNER_SIG === "1") {
      console.log(`⚠  TEST MODE: ${tamper ?? "skipOwnerSig"} — expecting REJECT.\n`);
    }
    const refUtxos = await refScriptUtxos(lucid);
    const result = await buildScheduleCommitTx({
      refScriptUtxos: refUtxos,
      lucid, vaultUtxo, shardUtxos,
      scheduleLength: L, lampPerEpoch: LAMBDA,
      userAddress: address,
      vaultScript, shardScript,
      lampPolicyId: POLICY_IDS.lamp,
      lampAssetName: ASSET_NAMES.lamp,
      network: NETWORK, tipPosixMs: tip.posixMs,
      tamperOutputDatum, skipOwnerSig: process.env.SKIP_OWNER_SIG === "1",
    });
    console.log(result.summary);
    const signed = await result.tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    console.log("\n╔════════════════════════════════════════════╗");
    console.log("║              ✅ SUCCESS                    ║");
    console.log("╚════════════════════════════════════════════╝");
    console.log(`TX hash:    ${txHash}`);
    console.log(`Explorer:   https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  } catch (err: any) {
    console.error("\n╔════════════════════════════════════════════╗");
    console.error("║              ❌ FAILED                     ║");
    console.error("╚════════════════════════════════════════════╝");
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
