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
import { VaultDatum } from "../../ScheduleGen/offchain/src/types.js";

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
    shardSpendParams({ shardPolicyId: POLICY_IDS.shard_nft, vaultScriptHash: vaultHash }),
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
    try { return Data.from(u.datum, VaultDatum).owner === ownerPkh; } catch { return false; }
  };
  let vaultUtxo;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const vaultUtxos = await lucid.utxosAt(vaultAddr);
    vaultUtxo = vaultUtxos.find((u) => mine(u) && (!wantedTx || u.txHash === wantedTx));
    if (vaultUtxo) break;
    // Hết lượt: CHỈ được tự chọn khi người gọi KHÔNG ghim gì.
    //
    // 🔴 Bản trước thay thế cả khi `wantedTx` ĐANG được ghim — tức người gọi chỉ đúng
    //    một vault, hệ thống không tìm thấy, và nó bắn vào một vault KHÁC rồi báo bằng
    //    một dòng cảnh báo trong log. Đó là fail-open trên đường tiền: MAGIC sinh ra ở
    //    vault không ai đợi, còn vault được ghim thì hết một lượt fire của epoch này.
    //    Ghim mà không thấy là LỖI, không phải chỗ để đoán hộ.
    if (attempt === 5) {
      if (wantedTx) break;
      vaultUtxo = vaultUtxos.find((u) => mine(u) && Data.from(u.datum!, VaultDatum).gen_schedules.length > 0);
      if (vaultUtxo) console.log(`⚠ không ghim VAULT_TX_HASH; dùng vault có lịch: ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`);
      break;
    }
    console.log(`  … chưa thấy vault ở chỉ mục Blockfrost (lần ${attempt}), chờ 15s`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!vaultUtxo) {
    // "Vault not found" trần trụi che mất nguyên nhân thật. Hai nguyên nhân, và
    // cả hai đều KHÔNG phải "Blockfrost chậm" (đã chờ 4×15s ở trên):
    //   1. apply-param lệch ⇒ suy ra hash khác ⇒ soi nhầm địa chỉ;
    //   2. validator ĐÃ ĐỔI sau lần deploy ⇒ hash mới, vault cũ nằm ở địa chỉ cũ
    //      và không bao giờ xuất hiện ở đây nữa — phải deploy lại chân ScheduleGen
    //      trên bản build hiện tại, không có đường vá bằng env.
    console.error("❌ Không thấy vault nào của ví này ở địa chỉ vault ScheduleGen.");
    console.error(`   vault hash suy ra : ${vaultHash}`);
    console.error(`   địa chỉ soi       : ${vaultAddr}`);
    console.error(`   VAULT_TX_HASH ghim: ${wantedTx ?? "(không ghim)"}`);
    console.error(`   owner pkh         : ${ownerPkh}`);
    console.error("   → Đối chiếu hash trên với scripts/DEPLOYED.md. Lệch nghĩa là");
    console.error("     apply-param khác lúc deploy, HOẶC validator đã đổi từ đó.");
    process.exit(1);
  }

  const vd = Data.from(vaultUtxo.datum!, VaultDatum);
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
    console.log(`\nĐã gửi. TX hash: ${txHash}`);
    console.log(`Explorer: https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);

    // ── 🔴 ĐỌC LẠI VAULT TRƯỚC KHI NÓI "XONG" ────────────────────────────────
    //  Bản cũ in "✅ SUCCESS" ngay sau `submit()`. `submit()` chỉ nói NODE ĐÃ NHẬN
    //  tx vào mempool — nó KHÔNG nói tx đã vào khối, và tuyệt đối không nói MAGIC
    //  đã vào vault. Với `schedule_decay_window = 1`, batch chỉ sống trong ĐÚNG
    //  epoch được sinh, nên người chạy đọc dấu ✅ rồi sang bước tiêu mà không có
    //  MAGIC thì mất trọn một ngày UTC và phải chờ lại.
    //
    //  Forall §Cổng gác: phép đo phải phân biệt BA trạng thái — khớp · lệch ·
    //  KHÔNG ĐO ĐƯỢC — và trạng thái thứ ba không được đội lốt trạng thái thứ hai.
    //  `awaitTx` trả về khi tx vào khối, nhưng bảng tổng hợp của indexer nhất-quán-dần
    //  (đo được trễ vài phút — xem `scripts/deploy/01b_restore_lamp_cap.ts:131-137`).
    //  Nên: thử lại có chờ, và hết lượt mà chưa thấy thì nói đúng là CHƯA ĐO ĐƯỢC,
    //  KHÔNG nói "hỏng" và cũng KHÔNG nói "xong".
    await lucid.awaitTx(txHash);

    // 🔴 ĐO BẰNG BATCH MỚI, KHÔNG BẰNG TỔNG.
    //
    //  Bản đầu của khối này so `Σ current_amount` trước/sau và coi "không tăng" là
    //  LỆCH. Sai, và sai theo chiều tốn kém nhất: `ScheduleFire` PRUNE batch chết
    //  NGAY TRONG CÙNG TX —
    //      ScheduleGen/onchain/validators/vault.ak:454
    //      list.concat(prune_expired(datum.magic_batches, current_epoch), new_batches)
    //  với `is_expired` = `current_epoch - created_epoch >= decay_window` và
    //  `decay_window = 1`. Nên một batch to từ epoch trước (không kịp tiêu, đã chết
    //  nhưng còn nằm trong datum) bị dọn đi trong đúng tx này, và nếu λ của lịch nhỏ
    //  thì `sau < trước` TRONG KHI tx hoàn toàn đúng đặc tả.
    //  Lúc đó bản cũ in "❌ tổng MAGIC KHÔNG TĂNG" rồi `exit 1` — người chạy tin là
    //  fire hỏng, chạy lại, và tiêu thêm một ô `fired_count` của lịch (tài nguyên hữu
    //  hạn: L ∈ [10,200]) trong khi MAGIC mới ĐANG nằm sẵn trong vault và chết dần.
    //
    //  Đại lượng đúng là **batch MỚI SINH**: batch nào có `batch_id` chưa từng có
    //  trước tx. Prune chỉ BỚT phần tử, không bao giờ thêm — nên tập id mới đúng bằng
    //  tập batch do lần fire này tạo ra, không lẫn với phần bị dọn.
    const idTruoc = new Set<string>((vd.magic_batches as any[]).map((b) => b.batch_id));

    const TRIES = 6, GAP_MS = 20_000;
    let doDuoc = false;
    for (let i = 1; i <= TRIES; i++) {
      const moi = (await lucid.utxosAt(vaultAddr))
        .find((u) => u.txHash === txHash && u.datum);
      if (moi) {
        const d = Data.from(moi.datum!, VaultDatum);
        const sauBatches = d.magic_batches as any[];
        const batchMoi = sauBatches.filter((b) => !idTruoc.has(b.batch_id));
        const magicMoi = batchMoi.reduce((s, b) => s + b.current_amount, 0n);
        const tongSau = sauBatches.reduce((s, b) => s + b.current_amount, 0n);
        if (batchMoi.length > 0 && magicMoi > 0n) {
          doDuoc = true;
          console.log("\n╔════════════════════════════════════════════╗");
          console.log("║       ✅ MAGIC ĐÃ VÀO VAULT (đã đọc lại)   ║");
          console.log("╚════════════════════════════════════════════╝");
          console.log(`Batch MỚI SINH: ${batchMoi.length} → +${magicMoi} nanogic`);
          for (const b of batchMoi) {
            console.log(`  ${String(b.batch_id).slice(0, 12)}…  ${b.current_amount}  (created_epoch ${b.created_epoch})`);
          }
          console.log(`magic_batches sau tx: ${sauBatches.length} batch, tổng ${tongSau} nanogic`);
          if (sauBatches.length < idTruoc.size + batchMoi.length) {
            console.log(`(${idTruoc.size + batchMoi.length - sauBatches.length} batch chết đã bị dọn trong cùng tx — bình thường.)`);
          }
          console.log(`Vault UTxO mới: ${moi.txHash}#${moi.outputIndex}`);
          console.log(`\n🔴 Batch sống ĐÚNG epoch này (schedule_decay_window = 1).`);
          console.log(`   Bước tiêu phải xong TRƯỚC nửa đêm UTC, nếu không mất trắng số trên.`);
          break;
        }
        // UTxO mới đọc được mà KHÔNG batch nào mới ⟹ LỆCH thật, không phải trễ indexer.
        console.error("\n❌ Tx đã vào khối nhưng KHÔNG có batch MAGIC nào mới.");
        console.error(`   batch trước=${idTruoc.size}  sau=${sauBatches.length}  mới=0  tổng sau=${tongSau}`);
        console.error("   Đây KHÔNG phải độ trễ indexer — UTxO mới đã đọc được.");
        process.exit(1);
      }
      if (i < TRIES) {
        console.log(`   … chưa thấy UTxO vault mới (lượt ${i}/${TRIES}), chờ ${GAP_MS / 1000}s`);
        await new Promise((r) => setTimeout(r, GAP_MS));
      }
    }
    if (!doDuoc) {
      console.error("\n╔════════════════════════════════════════════╗");
      console.error("║   ⚠  CHƯA ĐO ĐƯỢC — KHÔNG phải đã hỏng     ║");
      console.error("╚════════════════════════════════════════════╝");
      console.error(`Tx ${txHash} đã vào khối (awaitTx trả về) nhưng sau ${TRIES} lượt`);
      console.error(`(${(TRIES * GAP_MS) / 1000}s) vẫn chưa đọc được UTxO vault mới từ indexer.`);
      console.error("Kiểm bằng đường KHÔNG qua bảng tổng hợp: mở Explorer ở trên và soi output.");
      console.error("ĐỪNG chạy lại fire trước khi biết lượt này vào hay không — chạy lại có thể");
      console.error("bắn thêm một lệnh của lịch và tiêu mất một ô fire.");
      process.exit(2);   // mã thoát RIÊNG: 2 = chưa đo được, 1 = hỏng thật
    }
  } catch (err: any) {
    console.error("\n╔════════════════════════════════════════════╗");
    console.error("║              ❌ FAILED                     ║");
    console.error("╚════════════════════════════════════════════╝");
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
