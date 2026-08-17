// scripts/test/consume_only.ts — Tiêu MAGIC THẬT (co-spend Engage + InstantGen vault) trên Preview.
// Run: npx tsx test/consume_only.ts   (hoặc thêm "test:consume" vào package.json)
//
// PREREQ (theo thứ tự):
//   1. 01/02/05 + test:instant → có InstantGen vault UTxO mang ≥1 MagicBatch CÒN SỐNG.
//   2. 09_deploy_consume         → có PriceParam beacon + Engage UTxO.
//   ⚠  §4.2 use-or-lose (decay_window=1): batch chỉ tiêu được trong ĐÚNG epoch nó
//      được sinh. Trên Preview 1 epoch = 1 ngày → gen (test:instant) + consume PHẢI
//      cùng epoch (cùng ngày UTC). Beacon epoch cũng nên = epoch hiện tại (stale 0).
//
// ENV (từ deploy trước):
//   LAMP_POLICY_ID, UM_NFT_POLICY_ID, UM_DATUM_HASH, BACKING_NFT_POLICY_ID,
//   BACKING_SCRIPT_HASH, VAULT_INSTANT_HASH   — để reconstruct vault InstantGen (như instant_only).
//   PRICE_NFT_POLICY, ENGAGE_NFT_POLICY, MAX_PRICE_STALE — để reconstruct consume hash.
//   PRICE_BEACON_UTXO, ENGAGE_UTXO           — "txHash#idx" (in ra bởi 09).
//   REF_CONSUME_UTXO       — ref-script `consume` (09 in ra).      BẮT BUỘC.
//   REF_VAULT_INSTANT_UTXO — ref-script vault InstantGen (05 in ra). BẮT BUỘC.
//   INSTANT_VAULT_UTXO                        — "txHash#idx" của vault đã gen (tuỳ chọn;
//                                               nếu thiếu → tự tìm ở vault addr theo owner).
//   op_type (default 1), op_count (default 1).
//
// ── VÌ SAO HAI REF-SCRIPT LÀ BẮT BUỘC, không phải tuỳ chọn ─────────────────────
//   Đính kèm cả hai validator vào tx cho 17.310 byte ngay ở vault RỖNG, vượt trần
//   giao thức 16.384 ⟹ đường `attach` KHÔNG dựng nổi tx consume nào, ở bất kỳ cỡ
//   datum nào (đo của agent A3, 2026-08-17). Bản trước của tệp này attach cả hai,
//   nên nó chưa từng qua nổi phase-2 trên chuỗi. Nay readFrom cả hai.
//   `script_inputs_confined_to` chỉ duyệt `tx.inputs`, không chạm `reference_inputs`
//   (ConsumeMAGIC/onchain/lib/magiclamp/consume/util.ak:104-118) nên readFrom không
//   bị chốt đó chặn.
//
// ── VÌ SAO KHÔNG gọi buildConsumeTx (ConsumeMAGIC/offchain/src/consume.ts) ──────
//   buildConsumeTx() collect vault input bằng BurnBatch NHƯNG KHÔNG tạo output tiếp
//   nối cho vault (chỉ tạo Engage output) rồi tự .complete() — không thể chèn thêm
//   output sau đó. Trong khi validate_burn_batch của InstantGen (vault.ak dòng
//   684-722) BẮT BUỘC 1 vault output với datum A02 đúng + value preserved → tx từ
//   buildConsumeTx sẽ BỊ vault validator từ chối. Nên ở đây dựng tx THỦ CÔNG, phản
//   chiếu đúng bất biến của consume.ak (engage side) + validate_burn_batch (vault
//   output). (Encoders/redeemer schema vẫn tái dùng từ ConsumeMAGIC + InstantGen.)

import {
  Lucid, Blockfrost, Data,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, PROTOCOL, SCRIPT_HASHES,
} from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { consumeParams, instantVaultParams } from "../deployParams.js";
import {
  encodeEngageDatum, decodeEngageDatum, decodePriceParam,
  ConsumeRedeemerSchema,
  type ConsumeRedeemerT, type PriceParamT, type EngageDatumT,
} from "../../ConsumeMAGIC/offchain/src/types.js";
import { VaultDatumSchema, VaultRedeemerSchema } from "../../InstantGen/offchain/src/types.js";
import { fetchRefScriptUtxo } from "../refScripts.js";

const PRICE_NFT_NAME  = "5052494345";
const BURN_BATCH_CONSTR = 2n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isPureAda = (u: UTxO) => Object.keys(u.assets).every((k) => k === "lovelace");
function parseOutRef(s: string): { txHash: string; outputIndex: number } {
  const [h, i] = s.split("#");
  if (!h || i === undefined) throw new Error(`OutRef sai định dạng (cần txHash#idx): ${s}`);
  return { txHash: h, outputIndex: Number(i) };
}
function req(name: string, hint = "chạy 09_deploy_consume trước"): string {
  const v = process.env[name];
  if (!v) throw new Error(`Env ${name} bắt buộc — ${hint}.`);
  return v;
}

// Số học giá KHỚP on-chain pricing.ak: price = base × demand_mult / Q (floor); required = price × count.
function computeRequired(pp: PriceParamT, opType: bigint, opCount: bigint): bigint {
  const row = pp.op_prices.find((p) => p.op_type === opType);
  if (!row) throw new Error(`op_type ${opType} không có trong beacon op_prices`);
  const unit = (row.base_price * pp.demand_mult) / PROTOCOL.Q;
  return unit * opCount;
}

// Mirror InstantGen decay.ak: is_expired = current - created >= decay_window.
type MagicBatchT = { batch_id: string; created_epoch: bigint; decay_window: bigint; current_amount: bigint; [k: string]: unknown };
const isExpired = (b: MagicBatchT, epoch: bigint) => epoch - b.created_epoch >= b.decay_window;

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  ConsumeMAGIC — tiêu MAGIC thật (Preview)    ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const opType  = BigInt(process.env.op_type ?? "1");
  const opCount = BigInt(process.env.op_count ?? "1");
  if (opCount < 1n) throw new Error("op_count phải ≥ 1");

  const priceNftPolicy  = req("PRICE_NFT_POLICY");
  const maxPriceStale   = BigInt(process.env.MAX_PRICE_STALE ?? "1");
  const vaultInstantHash = req("VAULT_INSTANT_HASH");

  // ── Dựng lại consume validator — apply-param THEO TÊN, dùng chung bản đồ với 09 ──
  const priceParamHash = req("PRICE_PARAM_HASH");
  const consumeBlueprint = await loadBlueprint("ConsumeMAGIC");
  const consumeV = findValidator(consumeBlueprint, "consume.consume.spend");
  // Chỉ cần HASH: hai validator vào tx bằng ref-script, không đính kèm CBOR.
  const { hash: consumeHash } = appliedScript(
    consumeV,
    consumeParams({
      priceNftPolicy,
      priceNftName:         PRICE_NFT_NAME,
      vaultScriptHash:      vaultInstantHash,
      burnBatchConstr:      BURN_BATCH_CONSTR,
      maxPriceStale,
      msPerEpoch:           PROTOCOL.MS_PER_EPOCH,
      priceParamScriptHash: priceParamHash,
    }),
  );
  // Thread token Engage do CHÍNH consume đúc ⇒ policy id == consume script hash.
  // Tên asset = blake2b_256(cbor(seed)) nên KHÔNG suy ra được từ hash: lấy nguyên
  // ENGAGE_NFT_UNIT do deploy/09 in ra.
  const engageNftUnit   = req("ENGAGE_NFT_UNIT");
  const engageNftPolicy = engageNftUnit.slice(0, 56);

  if (process.env.CONSUME_SCRIPT_HASH && process.env.CONSUME_SCRIPT_HASH !== consumeHash) {
    throw new Error(
      `Consume hash reconstruct (${consumeHash}) ≠ CONSUME_SCRIPT_HASH env ` +
      `(${process.env.CONSUME_SCRIPT_HASH}). Kiểm tra PRICE/ENGAGE policy + PRICE_PARAM_HASH + MAX_PRICE_STALE.`,
    );
  }

  // ── Dựng lại InstantGen vault — cùng bản đồ tham số với deploy/05 ───────────
  const vaultBlueprint = await loadBlueprint("InstantGen");
  const vaultV = findValidator(vaultBlueprint, "vault.vault.spend");
  const { hash: vaultHash } = appliedScript(
    vaultV,
    instantVaultParams({
      lampPolicyId:      POLICY_IDS.lamp,
      lampAssetName:     ASSET_NAMES.lamp,
      umNftPolicy:       POLICY_IDS.um_nft,
      umScriptHash:      SCRIPT_HASHES.um_datum,
      backingNftPolicy:  POLICY_IDS.backing,
      backingScriptHash: SCRIPT_HASHES.backing_beacon,
      msPerEpoch:        PROTOCOL.MS_PER_EPOCH,
    }),
  );
  if (engageNftPolicy !== consumeHash) {
    throw new Error(
      `ENGAGE_NFT_UNIT policy (${engageNftPolicy}) ≠ consume hash (${consumeHash}). ` +
      `Thread token Engage do chính consume đúc — hai giá trị này PHẢI trùng.`,
    );
  }

  // Chỗ này từng cảnh báo "codec offchain còn 4 trường, thiếu `consumed_nanogic`".
  // Đã hết hạn: `ConsumeMAGIC/offchain/src/types.ts` nay đủ 5 trường, khớp
  // `types.ak`. Giữ cảnh báo lại sẽ đẩy người đọc đi "sửa" một codec đang đúng.

  const vaultAddr = credentialToAddress(NETWORK, scriptHashToCredential(vaultHash));
  if (vaultHash !== vaultInstantHash) {
    console.warn(`⚠  vault reconstruct hash ${vaultHash} ≠ VAULT_INSTANT_HASH ${vaultInstantHash} — kiểm tra param.`);
  }

  // Lucid + wallet
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  // ── Fetch 3 UTxO: beacon (ref), engage (spend), vault (spend BurnBatch) ───────
  const beaconRef = parseOutRef(req("PRICE_BEACON_UTXO"));
  const engageRef = parseOutRef(req("ENGAGE_UTXO"));
  const [priceBeaconUtxo] = await lucid.utxosByOutRef([beaconRef]);
  const [engageUtxo]      = await lucid.utxosByOutRef([engageRef]);
  if (!priceBeaconUtxo?.datum) throw new Error("Beacon UTxO thiếu hoặc không có inline datum.");
  if (!engageUtxo?.datum)      throw new Error("Engage UTxO thiếu hoặc không có inline datum.");
  if ((engageUtxo.assets[engageNftUnit] ?? 0n) !== 1n) throw new Error("Engage UTxO không mang đúng 1 thread NFT.");

  // ── Hai ref-script (bắt buộc — xem đầu tệp) ──────────────────────────────────
  //   Kiểm hash NGAY: đưa nhầm thì tx chết ở phase-1 với "MissingScriptWitness",
  //   thông điệp không nói nhầm cái nào. Hai UTxO này đỗ cạnh nhau ở cùng một bãi
  //   nên đảo hai biến env cho nhau là chuyện rất dễ xảy ra.
  const consumeRefUtxo = await fetchRefScriptUtxo({
    lucid, outRef: req("REF_CONSUME_UTXO"), wantHash: consumeHash,
    label: "REF_CONSUME_UTXO",
  });
  const vaultRefUtxo = await fetchRefScriptUtxo({
    lucid,
    outRef: req("REF_VAULT_INSTANT_UTXO", "bước 05_create_instant_vault in ra"),
    wantHash: vaultHash,
    label: "REF_VAULT_INSTANT_UTXO",
  });

  let vaultUtxo: UTxO | undefined;
  if (process.env.INSTANT_VAULT_UTXO) {
    const vref = parseOutRef(process.env.INSTANT_VAULT_UTXO);
    [vaultUtxo] = await lucid.utxosByOutRef([vref]);
  } else {
    const vs = await lucid.utxosAt(vaultAddr);
    vaultUtxo = vs.find((u) => {
      if (!u.datum) return false;
      try { return decodeVaultOwner(u.datum) === ownerPkh; } catch { return false; }
    });
  }
  if (!vaultUtxo?.datum) throw new Error("InstantGen vault UTxO không tìm thấy (chạy test:instant trước, cùng epoch).");

  // ── Tip → epoch + cửa sổ CHẶT ≤ 1 epoch (khớp consume.ak upper + vault lower) ─
  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, { headers: { project_id: BLOCKFROST_KEY } });
  const tip = await tipRes.json() as { time: number };
  const tipPosixMs = BigInt(tip.time) * 1000n;
  const mspe = PROTOCOL.MS_PER_EPOCH;
  const currentEpoch = tipPosixMs / mspe;
  // Cửa sổ = TRỌN epoch hiện tại [epochStart, epochEnd-1]. PHẢI chứa `now` (ledger từ
  // chối nếu now > validTo) NHƯNG vẫn ≤ 1 epoch cho cả 2 validator:
  //   vault.ak get_current_epoch: epoch = lower/mspe; ép upper < (epoch+1)*mspe.
  //   consume.ak util.get_epoch:  epoch = upper/mspe (floor); ép upper-lower ≤ mspe.
  // ⚠  buildConsumeTx dùng [epochStart, epochStart+1] → validTo ở QUÁ KHỨ so với now →
  //    ledger reject (OutsideValidityInterval). Đây là lý do THỨ HAI phải dựng tay.
  const lowerMs = currentEpoch * mspe;          // đầu epoch → floor = currentEpoch, ≤ now
  const upperMs = (currentEpoch + 1n) * mspe - 1n; // cuối epoch → floor = currentEpoch, ≥ now

  // ── Giá có thẩm quyền từ beacon ──────────────────────────────────────────────
  const pp: PriceParamT = decodePriceParam(priceBeaconUtxo.datum);
  if (currentEpoch < pp.epoch) throw new Error(`beacon epoch ${pp.epoch} > current ${currentEpoch}.`);
  if (currentEpoch - pp.epoch > maxPriceStale) {
    throw new Error(`giá quá cũ: current ${currentEpoch} - beacon ${pp.epoch} > max_stale ${maxPriceStale}. Re-post beacon.`);
  }
  const required = computeRequired(pp, opType, opCount);
  if (required <= 0n) throw new Error(`required=${required} (≤0).`);

  // ── Vault datum → chọn batch CÒN SỐNG đủ MAGIC cho required ───────────────────
  const vaultDatum: any = Data.from(vaultUtxo.datum, VaultDatumSchema as any);
  if (vaultDatum.pending_profile !== null) {
    throw new Error("Vault có pending_profile — test này không mô phỏng lazy-apply. Dùng vault khác.");
  }
  if (vaultDatum.last_updated_epoch > currentEpoch) {
    throw new Error(`last_updated_epoch ${vaultDatum.last_updated_epoch} > current ${currentEpoch} (vault từ tương lai?).`);
  }
  const batches: MagicBatchT[] = vaultDatum.magic_batches;
  const live = batches.find((b) => !isExpired(b, currentEpoch) && b.current_amount >= required);
  if (!live) {
    throw new Error(
      `Không có MagicBatch còn sống với current_amount ≥ required(${required}) tại epoch ${currentEpoch}. ` +
      `Batches: ${JSON.stringify(batches.map((b) => ({ id: b.batch_id.slice(0, 8), amt: b.current_amount.toString(), created: b.created_epoch.toString() })))}. ` +
      `Chạy test:instant lại trong CÙNG epoch để có batch tươi.`,
    );
  }

  // ── burns = [(batch_id, required)]; Σburns == required (mô hình ==) ───────────
  const burns: [string, bigint][] = [[live.batch_id, required]];

  // ── Vault output datum (A02 — vault.ak 684-708): magic_batches sau burn+prune,
  //    consumed_credit += required, last_updated_epoch=current, attribution +1 ────
  const burned = batches
    .map((b) => (b.batch_id === live.batch_id ? { ...b, current_amount: b.current_amount - required } : b))
    .filter((b) => b.current_amount > 0n);             // apply_burns: prune batch về 0
  const expectedBatches = burned.filter((b) => !isExpired(b, currentEpoch)); // prune_expired
  const newVaultDatum = {
    ...vaultDatum,
    magic_batches: expectedBatches,
    activity_state: {
      ...vaultDatum.activity_state,
      consumed_credit: vaultDatum.activity_state.consumed_credit + required,
    },
    last_updated_epoch: currentEpoch,
    attribution: {
      ...vaultDatum.attribution,
      total_events: vaultDatum.attribution.total_events + 1n,
      last_event_epoch: currentEpoch,
    },
  };
  const newVaultDatumCbor = Data.to(newVaultDatum, VaultDatumSchema as any);

  // ── Engage output datum: consumed_count += op_count, last_epoch=current ───────
  const oldEngage: EngageDatumT = decodeEngageDatum(engageUtxo.datum);
  const newEngage: EngageDatumT = {
    owner: oldEngage.owner,
    consumed_count: oldEngage.consumed_count + opCount,
    last_epoch: currentEpoch,
    did_commit: oldEngage.did_commit, // immutable
    // W-CM-12: validator ép Σ consumed_nanogic(out) == Σ(in) + total_required.
    // Thiếu trường này thì tx dựng ra bị validator từ chối — trước đây không lộ vì
    // gói `scripts/` chưa có `tsconfig.json` để `tsc` bắt.
    consumed_nanogic: oldEngage.consumed_nanogic + required,
  };

  // ── Redeemers ────────────────────────────────────────────────────────────────
  const consumeRedeemerVal: ConsumeRedeemerT = {
    op_type: opType,
    op_count: opCount,
    price_ref: { transaction_id: priceBeaconUtxo.txHash, output_index: BigInt(priceBeaconUtxo.outputIndex) },
    vault_ref: { transaction_id: vaultUtxo.txHash, output_index: BigInt(vaultUtxo.outputIndex) },
  };
  const consumeRedeemer = Data.to(consumeRedeemerVal, ConsumeRedeemerSchema as unknown as ConsumeRedeemerT);
  const vaultBurnRedeemer = Data.to({ BurnBatch: { burns } }, VaultRedeemerSchema as any);

  // ── Collateral thuần ADA (tránh CollateralContainsNonADA) ────────────────────
  const walletUtxos = await lucid.wallet().getUtxos();
  const collateral = walletUtxos.find((u) => isPureAda(u) && (u.assets.lovelace ?? 0n) >= 5_000_000n);
  if (!collateral) throw new Error("Cần 1 UTxO thuần ADA ≥5 ADA làm collateral. Tách UTxO trước.");

  console.log(`Network:            ${NETWORK}`);
  console.log(`Current epoch:      ${currentEpoch}   (beacon epoch ${pp.epoch}, stale ${currentEpoch - pp.epoch})`);
  console.log(`Consume address:    ${credentialToAddress(NETWORK, scriptHashToCredential(consumeHash))}`);
  console.log(`Vault UTxO:         ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}`);
  console.log(`Engage UTxO:        ${engageUtxo.txHash}#${engageUtxo.outputIndex}`);
  console.log(`Beacon (ref):       ${priceBeaconUtxo.txHash}#${priceBeaconUtxo.outputIndex}`);
  console.log(`Ref consume:        ${consumeRefUtxo.txHash}#${consumeRefUtxo.outputIndex}`);
  console.log(`Ref vault instant:  ${vaultRefUtxo.txHash}#${vaultRefUtxo.outputIndex}`);
  console.log(`op_type=${opType} × op_count=${opCount} → required=${required} nanogic`);
  console.log(`Batch: ${live.batch_id.slice(0, 12)}… ${live.current_amount} → ${live.current_amount - required}`);
  console.log(`consumed_count: ${oldEngage.consumed_count} → ${newEngage.consumed_count}\n`);

  // ── CO-SPEND tx: Engage(Consume) + Vault(BurnBatch) + beacon ref ──────────────
  const tx = await lucid
    .newTx()
    .collectFrom([engageUtxo], consumeRedeemer)
    .collectFrom([vaultUtxo], vaultBurnRedeemer)
    // Beacon giá + HAI ref-script, tất cả là reference input (KHÔNG tiêu).
    .readFrom([priceBeaconUtxo, consumeRefUtxo, vaultRefUtxo])
    .pay.ToAddressWithData(
      engageUtxo.address,
      { kind: "inline", value: encodeEngageDatum(newEngage) },
      { ...engageUtxo.assets },                 // value BẢO TOÀN tuyệt đối (engage side)
    )
    .pay.ToAddressWithData(
      vaultUtxo.address,
      { kind: "inline", value: newVaultDatumCbor },
      { ...vaultUtxo.assets },                  // LAMP + ADA preserved (BurnBatch không đụng LAMP)
    )
    .addSignerKey(ownerPkh)                      // vault BurnBatch: owner phải ký
    .validFrom(Number(lowerMs))
    .validTo(Number(upperMs))
    .complete({ presetWalletInputs: [collateral] });

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║              ✅ SUBMITTED                     ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`TX hash:  ${txHash}`);
  console.log(`Explorer: https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);

  // ── Poll Engage UTxO mới → assert consumed_count += op_count ──────────────────
  console.log("\n⏳ Polling Engage output mới...");
  const consumeAddr = engageUtxo.address;
  for (let i = 0; i < 30; i++) {
    await sleep(10_000);
    try {
      const es = await lucid.utxosAt(consumeAddr);
      const fresh = es.find((u) => u.txHash === txHash && (u.assets[engageNftUnit] ?? 0n) === 1n);
      if (fresh?.datum) {
        const d = decodeEngageDatum(fresh.datum);
        if (d.consumed_count === newEngage.consumed_count) {
          console.log(`\n✅ Engage state confirmed: consumed_count = ${d.consumed_count} (=${oldEngage.consumed_count}+${opCount}).`);
          console.log(`   New Engage UTxO: ${fresh.txHash}#${fresh.outputIndex}`);
          return;
        }
        throw new Error(`consumed_count = ${d.consumed_count}, kỳ vọng ${newEngage.consumed_count}.`);
      }
    } catch (e) { /* index lag */ }
    process.stdout.write(`   attempt ${i + 1}…\n`);
  }
  throw new Error("Engage output mới chưa thấy sau ~5 phút — kiểm tra tx trên explorer.");
}

// Decode chỉ field owner của VaultDatum (nhẹ, để lọc vault theo owner).
function decodeVaultOwner(datumCbor: string): string {
  const d: any = Data.from(datumCbor, VaultDatumSchema as any);
  return d.owner;
}

main().catch((e) => { console.error(e); process.exit(1); });
