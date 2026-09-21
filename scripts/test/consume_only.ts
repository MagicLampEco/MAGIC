// scripts/test/consume_only.ts — Tiêu MAGIC THẬT (co-spend Engage + vault sinh MAGIC).
// Run: VAULT_KIND=schedule npx tsx test/consume_only.ts
//
// ── HAI ĐƯỜNG, MỘT TỆP ────────────────────────────────────────────────────────
//   `VAULT_KIND=schedule` (mặc định)  — vault ScheduleGen. ĐƯỜNG DUY NHẤT CHẠY ĐƯỢC.
//   `VAULT_KIND=instant`              — vault InstantGen. Đang kẹt, xem dưới.
//
//   Vì sao một tệp phục vụ được cả hai: `consume` KHÔNG giải mã `VaultDatum`. Nó chỉ
//   đọc trường 0 (`owner`) qua `un_constr_data`
//   (ConsumeMAGIC/onchain/validators/consume.ak:443-461). Và hai `VaultDatum` trùng
//   khít — 17 trường, cùng tên, cùng thứ tự — còn `BurnBatch` là constr 2 ở cả hai
//   (InstantGen/offchain/src/types.ts:184 · ScheduleGen/offchain/src/types.ts:179).
//   Nên phần dựng tx giống hệt nhau; chỉ khác bộ apply-param dựng lại hash vault.
//   Chép tệp này thành hai bản là tạo ra hai thứ sẽ trôi khỏi nhau trong im lặng.
//
//   ĐƯỜNG instant ĐANG KẸT (Nợ #19): `consumed_credit` chỉ tăng ở `BurnBatch`, mà
//   `BurnBatch` đòi `magic_batches` khác rỗng, mà nhánh `InstantGen` là nơi DUY NHẤT
//   ghi `magic_batches` — vòng tự tham chiếu. ScheduleGen không có vòng đó:
//   `ScheduleFire` ghi thẳng `magic_batches` (ScheduleGen/onchain/validators/vault.ak:483)
//   và `BurnBatch` nằm ngay trong cùng validator (vault.ak:512).
//
// PREREQ (theo thứ tự):
//   1a. VAULT_KIND=schedule: 01/03/06/07 → commit → chờ 2 epoch → fire
//       ⟹ vault ScheduleGen UTxO mang ≥1 MagicBatch CÒN SỐNG.
//   1b. VAULT_KIND=instant : 01/02/05 + test:instant (hiện chưa qua được, xem Nợ #19).
//   2. 09_deploy_consume         → có PriceParam beacon + Engage UTxO.
//   ⚠  §4.2 use-or-lose (decay_window=1): batch chỉ tiêu được trong ĐÚNG epoch nó
//      được sinh. Trên Preview 1 epoch = 1 ngày → gen (test:instant) + consume PHẢI
//      cùng epoch (cùng ngày UTC). Beacon epoch cũng nên = epoch hiện tại (stale 0).
//
// ENV (từ deploy trước):
//   LAMP_POLICY_ID, UM_NFT_POLICY_ID, UM_DATUM_HASH, BACKING_NFT_POLICY_ID,
//   VAULT_KIND=schedule: LAMP_POLICY_ID, SHARD_NFT_POLICY_ID, VAULT_SCHEDULE_HASH
//   VAULT_KIND=instant : LAMP_POLICY_ID, UM_NFT_POLICY_ID, UM_DATUM_HASH,
//                        BACKING_NFT_POLICY_ID, BACKING_SCRIPT_HASH, VAULT_INSTANT_HASH
//   PRICE_NFT_POLICY, ENGAGE_NFT_POLICY, MAX_PRICE_STALE — để reconstruct consume hash.
//   PRICE_BEACON_UTXO, ENGAGE_UTXO           — "txHash#idx" (in ra bởi 09).
//   REF_CONSUME_UTXO       — ref-script `consume` (09 in ra).      BẮT BUỘC.
//   REF_VAULT_SCHEDULE_UTXO / REF_VAULT_INSTANT_UTXO — ref-script vault. BẮT BUỘC.
//   SCHEDULE_VAULT_UTXO / INSTANT_VAULT_UTXO  — "txHash#idx" của vault đã gen (tuỳ chọn;
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
// ── VÌ SAO tệp này dựng tx THỦ CÔNG ────────────────────────────────────────────
//   Lý do lịch sử, KHÔNG còn đúng: bản trước của khối này viết "buildConsumeTx KHÔNG
//   tạo output tiếp nối cho vault nên tx sẽ bị vault từ chối". Câu đó SAI TỪ CHÍNH
//   COMMIT SINH RA NÓ — `82a22699` vừa thêm `vaultOutDatumCbor` + vault continuing
//   output vào `ConsumeMAGIC/offchain/src/consume.ts:317-324`, vừa để lại câu trên.
//   Nên hơn một tháng qua, tệp này dạy mọi người tích hợp đi tự dựng tx bằng tay.
//
//   Đường ĐÚNG cho app, kể từ 2026-09-03:
//       const vaultSide = buildVaultBurnBatch({ vaultUtxo, required, currentEpoch,
//                                               vaultPlutusJson });
//       await buildConsumeTx({ ..., vaultBurnRedeemerCbor: vaultSide.vaultBurnRedeemerCbor,
//                                   vaultOutDatumCbor:     vaultSide.vaultOutDatumCbor });
//   (`MagicSDK/src/burnBatch.ts` — gương đúng `validate_burn_batch`, chọn ĐA batch và
//   ưu tiên batch sắp chết; tệp này chỉ chọn được MỘT batch, xem dòng ~309.)
//
//   Tệp này GIỮ đường thủ công có chủ ý: nó là bản đối chứng độc lập với SDK. Nếu
//   `burnBatch.ts` lệch khỏi Aiken thì hai đường cho hai CBOR khác nhau và chỗ lệch lộ
//   ra ở đây. Đừng viết lại nó thành lời gọi SDK — làm thế là mất chính phép đối chứng.

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
import { requiredForOp } from "@magiclamp/consumemagic-pricing";
import { consumeParams, instantVaultParams, scheduleVaultParams } from "../deployParams.js";
import {
  encodeEngageDatum, decodeEngageDatum, decodePriceParam,
  ConsumeRedeemerSchema,
  type ConsumeRedeemerT, type PriceParamT, type EngageDatumT,
} from "../../ConsumeMAGIC/offchain/src/types.js";
// Lược đồ dùng chung cho CẢ HAI loại vault: đo được là trùng khít — 17 trường, cùng
// tên, cùng thứ tự, `BurnBatch` constr 2 ở cả hai. Nhập từ một nơi để nếu hai bên có
// ngày trôi khỏi nhau thì `tsc` gãy ngay, thay vì tx im lặng sai.
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

// 🔴 P8 — dùng CHUNG hàm với gói định giá, không tự chép công thức.
//   Bản cũ ở đây tự tính SÀN-TRƯỚC-NHÂN-SAU:
//        const unit = (base × demand_mult) / Q ;  return unit × op_count
//   và chú thích của nó viết "required = price × count". Cả hai đều SAI so với
//   trọng tài: `required = ⌊ base × demand_mult × op_count / Q ⌋`, GỘP rồi SÀN
//   MỘT lần (ConsumeMAGIC/onchain/lib/magiclamp/consume/pricing.ak:53-57, và
//   chính chú thích ở :49-51 cấm đúng cách làm cũ: phần dư mỗi op bị mất, cộng
//   dồn theo op_count ⟹ THU THIẾU tới op_count nanogic mỗi dòng).
//   Vì sao nó nằm im lâu: với `demand_mult = Q` hai công thức cho cùng kết quả,
//   mà mọi lần chạy tới nay đều để demand_mult = Q. Nó chỉ lộ khi ai đó đặt hệ số
//   cầu khác 1,0× — lúc đó `Σburns ≠ required` và tx bị từ chối ở consume.ak:171,
//   còn người chạy thì đi soi hạ tầng chứ không soi số học.
//   Phép đo: base=1e6, demand=1_333_333_333, count=5 → đúng 6_666_666, cũ 6_666_665.
function computeRequired(pp: PriceParamT, opType: bigint, opCount: bigint): bigint {
  const row = pp.op_prices.find((p) => p.op_type === opType);
  if (!row) throw new Error(`op_type ${opType} không có trong beacon op_prices`);
  // Bảng giá là của BEACON đang sống trên chuỗi, không phải bảng MVP mặc định.
  return requiredForOp(Number(opType), opCount, pp.demand_mult, { [Number(opType)]: row.base_price });
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

  const vaultKind = (process.env.VAULT_KIND ?? "schedule").toLowerCase();
  if (vaultKind !== "schedule" && vaultKind !== "instant") {
    throw new Error(`VAULT_KIND phải là "schedule" hoặc "instant" — nhận "${vaultKind}".`);
  }
  const isSchedule = vaultKind === "schedule";
  const vaultHashEnv    = isSchedule ? "VAULT_SCHEDULE_HASH"     : "VAULT_INSTANT_HASH";
  const vaultRefEnv     = isSchedule ? "REF_VAULT_SCHEDULE_UTXO" : "REF_VAULT_INSTANT_UTXO";
  const vaultUtxoEnv    = isSchedule ? "SCHEDULE_VAULT_UTXO"     : "INSTANT_VAULT_UTXO";
  const vaultDeployStep = isSchedule ? "bước 07_create_schedule_vault" : "bước 05_create_instant_vault";
  const expectedVaultHash = req(vaultHashEnv, `${vaultDeployStep} in ra`);
  console.log(`Loại vault:           ${vaultKind}`);

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
      vaultScriptHash:      expectedVaultHash,
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

  // ── Dựng lại vault — CÙNG bản đồ tham số với bước deploy tương ứng ──────────
  //   ScheduleGen: 4 tham số (deploy/07) · InstantGen: 7 tham số (deploy/05).
  //   Thiếu hay lệch thứ tự MỘT tham số là ra hash khác, địa chỉ khác, và không
  //   lệnh nào báo lỗi — chỉ có tx chết ở phase-1. Nên đối chiếu hash ngay dưới.
  const vaultBlueprint = await loadBlueprint(isSchedule ? "ScheduleGen" : "InstantGen");
  const vaultV = findValidator(vaultBlueprint, "vault.vault.spend");
  const { hash: vaultHash } = appliedScript(
    vaultV,
    isSchedule
      ? scheduleVaultParams({
          lampPolicyId:  POLICY_IDS.lamp,
          lampAssetName: ASSET_NAMES.lamp,
          shardPolicyId: POLICY_IDS.shard_nft,
          msPerEpoch:    PROTOCOL.MS_PER_EPOCH,
        })
      : instantVaultParams({
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
  if (vaultHash !== expectedVaultHash) {
    // CỐ Ý ném lỗi chứ không cảnh báo. Hash lệch nghĩa là địa chỉ vault lệch: tx sẽ
    // dựng xong, gửi đi, rồi chết ở phase-1 với thông điệp không nói vì sao. Mà mỗi
    // lần thử lại tốn một cửa sổ epoch (§4.2 use-or-lose), nên hỏng ở đây rẻ hơn
    // hỏng ở đó rất nhiều.
    throw new Error(
      `Hash vault dựng lại (${vaultHash}) ≠ ${vaultHashEnv} (${expectedVaultHash}).\n` +
      `  Loại vault đang chọn: ${vaultKind}. Kiểm bộ apply-param của ${vaultDeployStep}:\n` +
      (isSchedule
        ? "  LAMP_POLICY_ID · ASSET_NAMES.lamp (tLAMP/LAMP theo mạng) · SHARD_NFT_POLICY_ID · MS_PER_EPOCH"
        : "  LAMP_POLICY_ID · ASSET_NAMES.lamp · UM_NFT_POLICY_ID · UM_DATUM_HASH · BACKING_NFT_POLICY_ID · BACKING_SCRIPT_HASH · MS_PER_EPOCH"),
    );
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
    outRef: req(vaultRefEnv, `${vaultDeployStep} in ra`),
    wantHash: vaultHash,
    label: vaultRefEnv,
  });

  let vaultUtxo: UTxO | undefined;
  if (process.env[vaultUtxoEnv]) {
    const vref = parseOutRef(process.env[vaultUtxoEnv]!);
    [vaultUtxo] = await lucid.utxosByOutRef([vref]);
  } else {
    const vs = await lucid.utxosAt(vaultAddr);
    vaultUtxo = vs.find((u) => {
      if (!u.datum) return false;
      try { return decodeVaultOwner(u.datum) === ownerPkh; } catch { return false; }
    });
  }
  if (!vaultUtxo?.datum) throw new Error("InstantGen vault UTxO không tìm thấy (chạy test:instant trước, cùng epoch).");

  // 🔴 KIỂM CHỦ VAULT Ở CẢ HAI NHÁNH, không chỉ nhánh tự tìm.
  //  Nhánh tự tìm (else ở trên) lọc theo `decodeVaultOwner(...) === ownerPkh`, nên nó
  //  không bao giờ trả về vault của người khác. Nhánh GHIM qua env thì trước đây nhận
  //  bất cứ out-ref nào người chạy đưa vào — dán nhầm hash của một lượt chạy trước với
  //  ví khác là tx dựng xong xuôi rồi mới chết ở `expect authed` trong
  //  `validate_burn_batch` (ScheduleGen/onchain/validators/vault.ak) lúc ledger chạy.
  //  Hỏng ồn, tài sản an toàn — nhưng tốn nguyên một cửa sổ epoch để biết một điều
  //  off-chain trả lời được ngay, và cửa sổ đó chỉ dài ĐÚNG một epoch.
  {
    let chuVault: string;
    try {
      chuVault = decodeVaultOwner(vaultUtxo.datum);
    } catch (e: any) {
      throw new Error(
        `Không giải mã nổi owner từ datum của vault ${vaultUtxo.txHash}#${vaultUtxo.outputIndex}: ${e?.message ?? e}. ` +
        `UTxO này có phải vault không, hay đang trỏ nhầm sang một script khác?`,
      );
    }
    if (chuVault.toLowerCase() !== ownerPkh.toLowerCase()) {
      throw new Error(
        `Vault ${vaultUtxo.txHash}#${vaultUtxo.outputIndex} KHÔNG thuộc ví đang dùng.\n` +
        `  owner trong datum : ${chuVault}\n` +
        `  ví đang chạy      : ${ownerPkh}\n` +
        `BurnBatch đòi chữ ký của owner, nên tx này chắc chắn bị từ chối. ` +
        `Kiểm lại ${vaultUtxoEnv} (hoặc bỏ nó đi để kịch bản tự tìm vault của ví này).`,
      );
    }
  }

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

  // 🔴 GOM NHIỀU BATCH, không chọn MỘT. Bản cũ dùng
  //      batches.find(b => !isExpired(b) && b.current_amount >= required)
  //    tức đòi MỘT batch tự nó đủ `required`. Vault hoàn toàn có thể có đủ MAGIC mà
  //    không batch nào đủ một mình — `ScheduleFire` bắn tối đa
  //    `max_fires_per_tx_catchup = 8` lệnh trong một lượt, và `schedule_decay_window = 1`
  //    nên cả 8 batch cùng sống trong ĐÚNG epoch đó. Lúc ấy bản cũ ném
  //    "Không có MagicBatch còn sống" trong khi vault đang giữ thừa MAGIC — một lần
  //    ĐỦ TIỀN đọc y hệt một lần THIẾU TIỀN, và người chạy mất trọn epoch vì tưởng
  //    fire hỏng.
  //    Validator vốn đã cho phép: `apply_burns` (ScheduleGen/onchain/validators/vault.ak:624)
  //    đệ quy theo danh sách `burns`, không đòi thứ tự, chỉ đòi mỗi `bid` khớp ĐÚNG
  //    một batch, `amt > 0`, `amt <= current_amount`, batch chưa hết hạn. Ràng buộc
  //    tổng nằm ở consume.ak: `Σburns == required` (dấu BẰNG).
  const liveBatches = batches.filter((b) => !isExpired(b, currentEpoch) && b.current_amount > 0n);
  const totalLive = liveBatches.reduce((s, b) => s + b.current_amount, 0n);
  if (totalLive < required) {
    throw new Error(
      `MAGIC còn sống KHÔNG ĐỦ tại epoch ${currentEpoch}: tổng ${totalLive} < required ${required}. ` +
      `(Đây là thiếu THẬT — đã cộng qua mọi batch còn sống, không phải giới hạn của kịch bản.) ` +
      `Batches: ${JSON.stringify(batches.map((b) => ({ id: b.batch_id.slice(0, 8), amt: b.current_amount.toString(), created: b.created_epoch.toString(), song: !isExpired(b, currentEpoch) })))}. ` +
      `Chạy fire lại trong CÙNG epoch để có batch tươi.`,
    );
  }

  // ── burns = gom tham lam theo THỨ TỰ BATCH TRONG DATUM; Σburns == required ─────
  //    Giữ nguyên thứ tự của `magic_batches` chứ không sắp lại: `apply_burns` không
  //    đòi thứ tự, nhưng `expectedBatches` phải khớp TUYỆT ĐỐI với thứ tự validator
  //    sinh ra, và validator dựng nó bằng `list.filter_map` trên danh sách gốc.
  const burns: [string, bigint][] = [];
  {
    let remaining = required;
    for (const b of liveBatches) {
      if (remaining === 0n) break;
      const take = b.current_amount < remaining ? b.current_amount : remaining;
      burns.push([b.batch_id, take]);
      remaining -= take;
    }
    // Bất biến cục bộ: `totalLive >= required` đã kiểm ở trên ⟹ remaining phải về 0.
    // Kiểm lại chứ không tin — sai ở đây là Σburns != required và tx bị từ chối với
    // một thông điệp không nhắc gì tới chỗ hỏng thật.
    if (remaining !== 0n) {
      throw new Error(`LỖI NỘI BỘ: gom burns còn dư ${remaining} nanogic dù totalLive=${totalLive} ≥ required=${required}.`);
    }
  }
  const burnByBatch = new Map<string, bigint>(burns);
  console.log(`Gom ${burns.length} batch cho required=${required}: ` +
    burns.map(([id, amt]) => `${id.slice(0, 8)}→${amt}`).join(" + "));

  // ── Vault output datum (A02 — vault.ak 684-708): magic_batches sau burn+prune,
  //    consumed_credit += required, last_updated_epoch=current, attribution +1 ────
  const burned = batches
    .map((b) => {
      const take = burnByBatch.get(b.batch_id);
      return take === undefined ? b : { ...b, current_amount: b.current_amount - take };
    })
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

  // 🔴 CHỦ THREAD PHẢI LÀ CHỦ VAULT (vá 2026-09-15). `consume.ak` nhánh spend kết thúc
  //    bằng `all_vault_owners_are(...)` VÔ ĐIỀU KIỆN — vế `|| chữ ký chủ thread` đã bị
  //    gỡ, nên `VaultDatum.owner != EngageDatum.owner` bị từ chối 100%, không tổ hợp chữ
  //    ký nào cứu được. Bản cũ ở cuối hàm này còn `addSignerKey(engageOwner)` cho đúng ca
  //    đó — một chữ ký cho một tx chắc chắn chết ở phase-2, tức mất collateral để biết
  //    một điều đọc được ngay tại đây. Đã gỡ.
  //    (Chủ vault đã được đối chiếu với ví đang chạy ở khối kiểm phía trên, nên so với
  //    `ownerPkh` là so đúng đại lượng.)
  {
    const engageOwner = oldEngage.owner.toLowerCase();
    if (engageOwner !== ownerPkh.toLowerCase()) {
      throw new Error(
        `Thread Engage ${engageUtxo.txHash}#${engageUtxo.outputIndex} KHÔNG thuộc ví đang chạy.\n` +
        `  owner trong EngageDatum : ${engageOwner}\n` +
        `  ví đang chạy / chủ vault: ${ownerPkh}\n` +
        `Thread và vault phải mở bằng CÙNG MỘT khoá. Không có đường xoay \`owner\` của ` +
        `một thread đã mở (cả \`Consume\` lẫn \`BindDID\` đều ép \`owner\` bảo toàn, và ` +
        `không có redeemer thứ ba). Trỏ ENGAGE_UTXO sang một thread của ví này, hoặc ` +
        `đúc một thread mới bằng ví này rồi cập nhật ENGAGE_UTXO.`,
      );
    }
  }

  const newEngage: EngageDatumT = {
    owner: oldEngage.owner,
    consumed_count: oldEngage.consumed_count + opCount,
    last_epoch: currentEpoch,
    did_commit: oldEngage.did_commit, // bất biến TRÊN NHÁNH NÀY (Consume). Đổi được
                                      // đúng một lần qua redeemer BindDID, và chỉ từ rỗng.
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
  console.log(`Batch còn sống: ${liveBatches.length} (tổng ${totalLive} nanogic) → đốt ${burns.length} batch, còn lại ${totalLive - required}`);
  for (const [id, amt] of burns) {
    const b = liveBatches.find((x) => x.batch_id === id)!;
    console.log(`  ${id.slice(0, 12)}… ${b.current_amount} − ${amt} = ${b.current_amount - amt}`);
  }
  console.log(`consumed_count: ${oldEngage.consumed_count} → ${newEngage.consumed_count}\n`);

  // ── CO-SPEND tx: Engage(Consume) + Vault(BurnBatch) + beacon ref ──────────────
  let txBuild = lucid
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
    .validTo(Number(upperMs));

  const tx = await txBuild.complete({ presetWalletInputs: [collateral] });

  // DRY_RUN=1: `complete()` đã chạy thử validator cục bộ — dừng trước khi ký, cùng quy ước
  // với test/mint_engage_only.ts.
  if (process.env.DRY_RUN === "1") {
    console.log("✔ DRY RUN: tx dựng xong và qua validator khi chạy thử. Không ký, không gửi.");
    return;
  }

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
  // 🔴 Vùng `try` ở đây ôm ĐÚNG lệnh gọi mạng, không ôm phép khẳng định.
  //
  // Bản trước gói cả ba việc — đọc UTxO, giải mã datum, so `consumed_count` — vào một
  // `try` mà `catch` của nó mang chú thích `/* index lag */`. Nên câu `throw` báo SAI SỐ
  // rơi vào chính cái `catch` đó và bị đọc thành "chỉ mục chưa kịp", vòng lặp chạy tiếp,
  // rồi 5 phút sau tệp báo *"Engage output mới chưa thấy"* — một câu KHÔNG ĐÚNG: output
  // đã thấy, chỉ là nó mang sai số. Ba trạng thái (khớp · LỆCH · chưa đo được) bị nén
  // thành hai, và trạng thái bị nuốt đúng là trạng thái nói rằng validator đã ghi sai.
  //
  // Nay chỉ lỗi MẠNG được nuốt, và cả nó cũng phải in ra — một chuỗi lỗi mạng lặp lại là
  // dấu của khoá sai hoặc mạng sai, không phải của chỉ mục chậm.
  for (let i = 0; i < 30; i++) {
    await sleep(10_000);

    let fresh: UTxO | undefined;
    try {
      const es = await lucid.utxosAt(consumeAddr);
      fresh = es.find((u) => u.txHash === txHash && (u.assets[engageNftUnit] ?? 0n) === 1n);
    } catch (e) {
      process.stdout.write(`   attempt ${i + 1}… (chỉ mục chưa trả lời: ${String((e as Error)?.message ?? e).slice(0, 160)})\n`);
      continue;
    }

    if (!fresh?.datum) {
      process.stdout.write(`   attempt ${i + 1}…\n`);
      continue;
    }

    // Từ đây trở xuống KHÔNG còn nhánh nuốt lỗi. `decodeEngageDatum` ném ra là datum sai
    // hình dạng — đó là một phát hiện, không phải độ trễ chỉ mục.
    const d = decodeEngageDatum(fresh.datum);
    if (d.consumed_count !== newEngage.consumed_count) {
      throw new Error(
        `SAI SỐ, không phải độ trễ: Engage UTxO ${fresh.txHash}#${fresh.outputIndex} `
        + `mang consumed_count = ${d.consumed_count}, kỳ vọng ${newEngage.consumed_count} `
        + `(= ${oldEngage.consumed_count} + ${opCount}). UTxO đã vào khối và đã đọc được.`,
      );
    }
    console.log(`\n✅ Engage state confirmed: consumed_count = ${d.consumed_count} (=${oldEngage.consumed_count}+${opCount}).`);
    console.log(`   New Engage UTxO: ${fresh.txHash}#${fresh.outputIndex}`);
    return;
  }
  throw new Error("Engage output mới chưa thấy sau ~5 phút — kiểm tra tx trên explorer.");
}

// Decode chỉ field owner của VaultDatum (nhẹ, để lọc vault theo owner).
function decodeVaultOwner(datumCbor: string): string {
  const d: any = Data.from(datumCbor, VaultDatumSchema as any);
  return d.owner;
}

main().catch((e) => { console.error(e); process.exit(1); });
