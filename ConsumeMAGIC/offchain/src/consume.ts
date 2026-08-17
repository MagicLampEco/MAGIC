// src/consume.ts — ConsumeMAGIC v2 ENGAGEMENT tx-builder (CONTRACT §B3, §D).
//
// Dựng 1 tx CO-SPEND 2 validator để tiêu MAGIC dạng kế toán (KHÔNG mint, KHÔNG
// transfer MAGIC):
//   - Engage UTxO (consume.ak)  spend bằng Consume { op_type, op_count, price_ref,
//     vault_ref } → ghi state per-app (consumed_count += op_count, last_epoch).
//   - Vault UTxO (generator vault, module khác) spend bằng BurnBatch → GIẢM
//     current_amount (nơi DUY NHẤT giảm MAGIC). consume.ak ép Σburns == required.
//   - PriceParam beacon đọc dạng REFERENCE input (readFrom — KHÔNG tiêu).
//
// Builder KHÔNG tự dựng redeemer BurnBatch NI datum output của vault (constr index +
// schema khác nhau per vault: Instant=2/Snapshot=1/Vacuum=4/Schedule=2) → caller truyền
// CBOR hex sẵn (redeemer + datum output) để tránh coupling type cross-module. Builder
// chịu trách nhiệm phần Engage + GHÉP cả hai continuing output (vault + engage).
//
// VALIDITY RANGE: cửa sổ = TRỌN epoch hiện tại [epochStart, epochEnd-1] — PHẢI chứa
// `now` (ledger từ chối nếu now > validTo) NHƯNG vẫn ≤ 1 epoch cho cả hai validator:
//   vault.ak get_current_epoch: epoch = lower/mspe (đầu epoch → currentEpoch, ≤ now).
//   consume.ak util.get_epoch:  epoch = upper/mspe floor (cuối epoch → currentEpoch, ≥ now).
// (Bản cũ dùng [epochStart, epochStart+1ms] → validTo ở QUÁ KHỨ so với now giữa epoch →
//  ledger reject OutsideValidityInterval. Đã vá.)
// `util.get_epoch` ép THÊM: hai biên đều Finite VÀ ⌊lo/mspe⌋ == ⌊hi/mspe⌋ (trọn MỘT
// epoch) — cửa sổ dưới đây thoả theo dựng, không được nới ra ngoài biên epoch.
//
// THREAD NFT: policy == script hash của `consume` sau apply 7 param (tự tham chiếu),
// tên == blake2b_256(cbor(seed)) — xem `engageId.ts`. KHÔNG còn `engage_nft.ak`,
// KHÔNG còn hằng tên `454e47`.

import {
  Data, toUnit, validatorToScriptHash, validatorToAddress,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator, type Assets,
} from "@lucid-evolution/lucid";
import { msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import { Q, assertValidPriceParam } from "@magiclamp/consumemagic-pricing";
import {
  ConsumeRedeemerSchema,
  encodeEngageDatum, decodeEngageDatum, decodePriceParam,
  encodeEngageMintRedeemer,
  type EngageDatumT, type PriceParamT, type ConsumeRedeemerT,
  type OutputReferenceT,
} from "./types.js";
import { engageAssetName, type EngageIdSeed } from "./engageId.js";

// ── Params ────────────────────────────────────────────────────────────────────

export interface ConsumeParams {
  /** Lucid instance (Preview). */
  lucid: LucidEvolution;
  /** Engage UTxO (state per-app) — spent bằng Consume. */
  engageUtxo: UTxO;
  /** Vault UTxO (generator vault) — spent bằng BurnBatch (redeemer do caller dựng). */
  vaultUtxo: UTxO;
  /** PriceParam beacon UTxO — đọc REFERENCE (không tiêu). Phải mang price NFT. */
  priceBeaconUtxo: UTxO;
  /** Compiled consume validator — ĐÃ apply ĐÚNG 7 param, theo THỨ TỰ:
   *  price_nft_policy, price_nft_name, vault_script_hash, burn_batch_constr,
   *  max_price_stale, ms_per_epoch, price_param_script_hash.
   *  (`engage_nft_policy` / `engage_nft_name` KHÔNG còn là param — thread NFT dùng
   *   chính script hash này làm policy, biết qua tự tham chiếu.) */
  consumeScript: Validator;
  /** Compiled vault validator (module khác) — cần để spend vault input. */
  vaultScript: Validator;
  /** op_type (1=ảnh, 2=CID) — phải có trong PriceParam.op_prices. */
  opType: number;
  /** op_count ≥ 1. */
  opCount: bigint;
  /** Redeemer BurnBatch của vault, dạng CBOR hex (caller dựng theo type vault đó).
   *  consume.ak đọc redeemer này qua tx.redeemers; Σburns PHẢI == required. */
  vaultBurnRedeemerCbor: string;
  /** Datum output tiếp-nối của vault, dạng CBOR hex (caller dựng theo schema vault đó).
   *  validate_burn_batch (vault.ak) BẮT BUỘC 1 vault output mang datum này (InstantGen
   *  A02: magic_batches sau burn+prune, consumed_credit += required, last_updated_epoch,
   *  attribution +1) + value preserved. THIẾU field này ⟹ vault reject. */
  vaultOutDatumCbor: string;
  /** Value output của vault — mặc định copy y nguyên vaultUtxo.assets (LAMP+ADA preserved;
   *  BurnBatch KHÔNG đụng LAMP, C-BURN-NO-LAMP). Chỉ override khi caller có lý do rõ. */
  vaultOutAssets?: Assets;
  /** Owner pkh (hex) — addSignerKey cho ràng buộc owner-sig của BurnBatch (vault.ak). */
  ownerSignerKeyHash?: string;
  /** Collateral UTxO thuần ADA (tránh CollateralContainsNonADA khi ví có UTxO token). */
  collateralUtxo?: UTxO;
  /** Thread NFT unit (policyId+nameHex) — TUỲ CHỌN.
   *  Bỏ trống ⇒ builder TỰ tìm: policy = hash(consumeScript), phải có ĐÚNG 1 asset
   *  dưới policy đó với qty 1 (mirror `single_thread_nft` on-chain). Truyền vào ⇒
   *  builder vẫn kiểm prefix policy == hash(consumeScript) rồi mới dùng. Tên NFT là
   *  blake2b_256(cbor(seed)) — KHÔNG phải hằng `454e47`, đừng tự bịa. */
  engageNftUnit?: string;
  /** UTxO mang script tham chiếu CIP-33 của `consume` — TUỲ CHỌN nhưng gần như BẮT BUỘC
   *  trên chuỗi thật. Có ⟹ builder `readFrom` thay vì `attach`.
   *  Vì sao: đính kèm cả hai validator vào tx cho **17.310 byte ngay ở vault RỖNG**, vượt
   *  trần giao thức 16.384 ⟹ **không tx consume nào dựng nổi ở bất kỳ cỡ datum nào** (đo
   *  của agent A3 2026-08-17, đối chiếu số 17.303 B mà `06_publish_ref_scripts.ts:5-7` đã
   *  đo thật trên Preview cho cặp vault+shard ScheduleGen). Bỏ trống ⟹ giữ đường `attach`
   *  cũ, dùng được cho test đơn vị và emulator, KHÔNG dùng được trên chuỗi. */
  consumeRefUtxo?: UTxO;
  /** UTxO mang script tham chiếu CIP-33 của vault. Cùng lý do `consumeRefUtxo`.
   *  Hai script này là hai UTxO RIÊNG — cộng lại chúng đã vượt trần nếu công bố chung
   *  một tx (`scripts/deploy/06_publish_ref_scripts.ts:93`). */
  vaultRefUtxo?: UTxO;
  /** Network (chọn ms_per_epoch cho validity-range — PHẢI khớp validator param). */
  network: Network;
  /** Tip POSIX ms hiện tại (đầu vào để tính epoch + validity-range). */
  tipPosixMs: bigint;
}

export interface ConsumeResult {
  tx: TxSignBuilder;
  /** required (nanogic) = price(op_type) × op_count — phải == Σburns vault. */
  requiredNanogic: bigint;
  /** epoch tham chiếu (từ upper bound) dùng để ghi last_epoch. */
  currentEpoch: bigint;
  /** EngageDatum mới (output). */
  newEngageDatum: EngageDatumT;
  summary: string;
}

// ── ref → OutputReferenceT (CBOR datum) ───────────────────────────────────────

function utxoToRef(u: UTxO): OutputReferenceT {
  return { transaction_id: u.txHash, output_index: BigInt(u.outputIndex) };
}

// ── required (giá CÓ THẨM QUYỀN, đọc TỪ beacon datum) ─────────────────────────

/**
 * required = ⌊ base_price × demand_mult × op_count / Q ⌋  (nanogic).
 *
 * FIX #3 (P8 fold-floor) + FIX #4 (price authority):
 *  - base_price đọc TỪ pp.op_prices (beacon datum) THEO op_type — KHÔNG hardcode bảng
 *    MVP. PostPrice đổi base_price ⇒ off-chain tự theo, không lệch on-chain.
 *  - FOLD-FLOOR-ONCE: base×demand×count rồi ÷Q một lần — KHỚP byte-perfect
 *    onchain pricing.required_for. Floor-before-multiply = under-charge ⇒ tx reject.
 *  - op_type vắng trong beacon ⇒ THROW (không im lặng fallback trên đường tiền).
 *
 * VÁ FAIL-OPEN (2026-08-09): bản cũ làm `count = opCount > 0n ? opCount : 0n` ⇒
 * `opCount` âm/0 trả về **0** trong IM LẶNG, trong khi on-chain `expect op_count >= 1`
 * TỪ CHỐI. Hệ quả thực: app có lỗi dấu hiển thị "0 MAGIC", cấp dịch vụ, RỒI tx mới bị
 * validator từ chối — dịch vụ đã cấp không lấy lại được. Nay ném lỗi có mã.
 *
 * @throws CONSUME-007 nếu op_type không có trong pp.op_prices.
 * @throws CONSUME-008 nếu opCount < 1 (mirror on-chain `expect op_count >= 1`).
 */
export function requiredFromBeacon(
  pp: PriceParamT,
  opType: number,
  opCount: bigint,
): bigint {
  if (opCount < 1n) {
    throw new Error(
      `CONSUME-008: op_count phải ≥ 1 (nhận ${opCount}). On-chain consume.ak ép ` +
        `\`expect op_count >= 1\` — trả 0 im lặng là fail-open: app hiện "0 MAGIC", ` +
        `cấp dịch vụ, rồi tx mới bị từ chối.`,
    );
  }
  const row = pp.op_prices.find((p) => Number(p.op_type) === opType);
  if (row === undefined) {
    throw new Error(
      `CONSUME-007: op_type ${opType} không có trong beacon PriceParam.op_prices ` +
        `(giá có thẩm quyền phải đến từ beacon, không fallback MVP trên đường tiền)`,
    );
  }
  return (row.base_price * pp.demand_mult * opCount) / Q;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Dựng tx tiêu MAGIC. KHÔNG mint. Caller sign + submit (signAndSubmit).
 *
 * Bất biến builder bám validator (consume.ak):
 *  - required = ⌊base_price×demand_mult×op_count/Q⌋ (fold-floor-once, base_price ĐỌC
 *    TỪ beacon datum theo op_type — P8 khớp on-chain) — caller phải đảm bảo
 *    vaultBurnRedeemerCbor có Σburns == required.
 *  - Engage output: value bảo toàn TUYỆT ĐỐI (copy y nguyên engageUtxo.assets),
 *    consumed_count += op_count, consumed_nanogic += required, last_epoch = currentEpoch,
 *    did_commit immutable.
 *  - validity-range nằm TRỌN trong một epoch, hai biên Finite.
 *
 * KHÔNG mint ở đây: mint thread Engage là tx RIÊNG (`buildMintEngageTx`).
 */
export async function buildConsumeTx(params: ConsumeParams): Promise<ConsumeResult> {
  const {
    lucid, engageUtxo, vaultUtxo, priceBeaconUtxo,
    consumeScript, vaultScript, opType, opCount,
    vaultBurnRedeemerCbor, vaultOutDatumCbor, vaultOutAssets,
    ownerSignerKeyHash, collateralUtxo,
    engageNftUnit, consumeRefUtxo, vaultRefUtxo, network, tipPosixMs,
  } = params;

  if (opCount < 1n) throw new Error("CONSUME-001: op_count phải ≥ 1");

  // ── ref-script phải ĐÚNG script, không chỉ "một UTxO có scriptRef" ───────────
  //    Đưa nhầm UTxO ref-script làm tx chết ở phase-1 với "MissingScriptWitness" —
  //    thông điệp không chỉ ra nhầm cái nào. Kiểm hash tại đây, nêu đích danh.
  const assertRefIs = (u: UTxO | undefined, want: Validator, label: string) => {
    if (!u) return;
    const wantHash = validatorToScriptHash(want);
    if (!u.scriptRef) {
      throw new Error(`CONSUME-004: ${label} không mang scriptRef (${u.txHash}#${u.outputIndex})`);
    }
    const gotHash = validatorToScriptHash(u.scriptRef);
    if (gotHash !== wantHash) {
      throw new Error(
        `CONSUME-005: ${label} mang script hash ${gotHash}, cần ${wantHash}`,
      );
    }
  };
  assertRefIs(consumeRefUtxo, consumeScript, "consumeRefUtxo");
  assertRefIs(vaultRefUtxo,   vaultScript,   "vaultRefUtxo");

  // ── đọc PriceParam beacon (datum CBOR → struct) ─────────────────────────────
  if (!priceBeaconUtxo.datum) {
    throw new Error("CONSUME-002: beacon UTxO thiếu inline datum PriceParam");
  }
  const pp: PriceParamT = decodePriceParam(priceBeaconUtxo.datum);

  // ── beacon phải hợp lệ: mirror `expect pricing.valid_param(pp)` on-chain ─────
  //    Chạy TRƯỚC khi dựng tx: beacon rác (bảng không sắp xếp, > 16 dòng, rớt GATE
  //    giá-tối-thiểu, band lệch hằng) làm validator từ chối ở phase-2 — lúc đó
  //    collateral đã mất. Ném PRICE-010..015 với lý do cụ thể thay vì một
  //    "script evaluation failed" không đọc được.
  assertValidPriceParam(pp);

  // ── required (giá có thẩm quyền từ beacon, fold-floor-once — P8) ─────────────
  const requiredNanogic = requiredFromBeacon(pp, opType, opCount);
  if (requiredNanogic <= 0n) {
    throw new Error(`CONSUME-003: required=${requiredNanogic} (op_count<1 hoặc base_price 0)`);
  }

  // ── epoch tham chiếu = từ UPPER bound (khớp util.get_epoch vá) ───────────────
  const mspe = msPerEpoch(network);
  const currentEpoch = tipPosixMs / mspe;
  // cửa sổ CHẶT: lower = đầu epoch hiện tại; upper = lower + 1ms (cùng epoch sau floor)
  const lowerMs = currentEpoch * mspe;              // đầu epoch → floor = currentEpoch, ≤ now
  const upperMs = (currentEpoch + 1n) * mspe - 1n;  // cuối epoch → floor = currentEpoch, ≥ now

  // ── stale guard offchain (mirror C-CM-5; fail sớm trước khi submit) ──────────
  if (currentEpoch < pp.epoch) {
    throw new Error(`CONSUME-004: beacon epoch ${pp.epoch} > current ${currentEpoch} (tương lai)`);
  }

  // ── EngageDatum cũ → mới ────────────────────────────────────────────────────
  // HAI trục kế toán song song (consume.ak `enforce_engagement`):
  //   (a) Σ consumed_count(out)   == Σ(in) + Σ op_count      — số LƯỢT
  //   (b) Σ consumed_nanogic(out) == Σ(in) + total_required  — GIÁ TRỊ đã trả
  // Builder này dựng tx MỘT Engage input ⇒ total_required == requiredNanogic của
  // chính nó. Nếu về sau gộp N Engage input trong 1 tx thì (b) là bất biến TỔNG:
  // phải cộng requiredNanogic của MỌI input rồi phân bổ, không cộng riêng lẻ mù.
  if (!engageUtxo.datum) throw new Error("CONSUME-005: engage UTxO thiếu inline datum");
  const oldDatum: EngageDatumT = decodeEngageDatum(engageUtxo.datum);
  const newEngageDatum: EngageDatumT = {
    owner: oldDatum.owner,
    consumed_count: oldDatum.consumed_count + opCount,
    last_epoch: currentEpoch,
    did_commit: oldDatum.did_commit,                            // IMMUTABLE
    consumed_nanogic: oldDatum.consumed_nanogic + requiredNanogic, // bất biến (b)
  };

  // ── Consume redeemer (Engage input) ─────────────────────────────────────────
  const consumeRedeemerVal: ConsumeRedeemerT = {
    op_type: BigInt(opType),
    op_count: opCount,
    price_ref: utxoToRef(priceBeaconUtxo),
    vault_ref: utxoToRef(vaultUtxo),
  };
  const consumeRedeemer = Data.to(
    consumeRedeemerVal,
    ConsumeRedeemerSchema as unknown as ConsumeRedeemerT,
  );

  // ── Engage output: VALUE BẢO TOÀN tuyệt đối (copy y nguyên assets input) ─────
  // Cổng định danh mirror `single_thread_nft`: policy của thread NFT PHẢI == script
  // hash của chính `consume` (tự tham chiếu, BẤT BIẾN #1) và UTxO phải mang ĐÚNG MỘT
  // asset dưới policy đó với qty 1. UTxO "engage giả" (ai cũng gửi tới địa chỉ script
  // được) có 0 asset ⇒ chết ở đây thay vì chết trong phase-2 sau khi đã tốn collateral.
  const consumePolicyId = validatorToScriptHash(consumeScript);
  const resolvedNftUnit = resolveThreadNft(engageUtxo, consumePolicyId, engageNftUnit);
  const engageOutAssets = { ...engageUtxo.assets };

  const engageAddress = engageUtxo.address;

  // ── Nguồn WITNESS của hai validator: readFrom (CIP-33) hay attach ────────────
  //    readFrom đưa script vào tx bằng một CON TRỎ tới UTxO đã đỗ trên chain, thay
  //    vì bê nguyên CBOR vào tx. Với HEAD đây KHÔNG phải tối ưu hoá mà là điều kiện
  //    sống: attach cả hai = 17.310 B > trần 16.384 (A3, 2026-08-17).
  //    `script_inputs_confined_to` chỉ duyệt `tx.inputs`, KHÔNG chạm
  //    `reference_inputs` (`ConsumeMAGIC/onchain/lib/magiclamp/consume/util.ak:104-118`)
  //    ⟹ readFrom không bị chốt đó chặn. (A4 xác nhận 2026-08-17.)
  const refInputs: UTxO[] = [priceBeaconUtxo];
  if (consumeRefUtxo) refInputs.push(consumeRefUtxo);
  if (vaultRefUtxo)   refInputs.push(vaultRefUtxo);

  let txBuilder = lucid
    .newTx()
    // Engage input (Consume) + vault input (BurnBatch CBOR caller cung cấp)
    .collectFrom([engageUtxo], consumeRedeemer)
    .collectFrom([vaultUtxo], vaultBurnRedeemerCbor)
    // PriceParam beacon = reference input (KHÔNG tiêu); kèm ref-script nếu có
    .readFrom(refInputs);

  if (!consumeRefUtxo) txBuilder = txBuilder.attach.SpendingValidator(consumeScript);
  if (!vaultRefUtxo)   txBuilder = txBuilder.attach.SpendingValidator(vaultScript);

  txBuilder = txBuilder
    // Engage continuing output (value preserved, state +op_count)
    .pay.ToAddressWithData(
      engageAddress,
      { kind: "inline", value: encodeEngageDatum(newEngageDatum) },
      engageOutAssets,
    )
    // Vault continuing output (datum A02 do caller dựng + value preserved) — BẮT BUỘC bởi
    // validate_burn_batch (vault.ak); thiếu ⟹ vault reject. LAMP+ADA giữ nguyên.
    .pay.ToAddressWithData(
      vaultUtxo.address,
      { kind: "inline", value: vaultOutDatumCbor },
      vaultOutAssets ?? { ...vaultUtxo.assets },
    )
    .validFrom(Number(lowerMs))
    .validTo(Number(upperMs));

  // BurnBatch đòi owner ký (vault.ak) — thêm signer key nếu caller cung cấp.
  if (ownerSignerKeyHash) txBuilder = txBuilder.addSignerKey(ownerSignerKeyHash);

  // Collateral thuần ADA (tránh CollateralContainsNonADA khi ví có UTxO token).
  const tx = collateralUtxo
    ? await txBuilder.complete({ presetWalletInputs: [collateralUtxo] })
    : await txBuilder.complete();

  const summary =
    `consume op_type=${opType} ×${opCount} | required=${requiredNanogic} ng | ` +
    `epoch=${currentEpoch} | thread=${resolvedNftUnit} | ` +
    `count ${oldDatum.consumed_count}→${newEngageDatum.consumed_count} | ` +
    `nanogic ${oldDatum.consumed_nanogic}→${newEngageDatum.consumed_nanogic}`;

  return { tx, requiredNanogic, currentEpoch, newEngageDatum, summary };
}

/**
 * Thread NFT của Engage UTxO — mirror `single_thread_nft` (consume.ak).
 *
 * Policy BẮT BUỘC == script hash của `consume` đã apply param (tự tham chiếu). Tên
 * tuỳ seed nên builder KHÔNG đoán được; nó tìm asset duy nhất dưới policy đó.
 *
 * @throws CONSUME-006 nếu không có đúng 1 asset dưới policy, hoặc qty ≠ 1.
 * @throws CONSUME-009 nếu caller truyền `engageNftUnit` sai policy.
 */
function resolveThreadNft(
  engageUtxo: UTxO,
  consumePolicyId: string,
  declaredUnit?: string,
): string {
  const underPolicy = Object.keys(engageUtxo.assets).filter((u) =>
    u.startsWith(consumePolicyId),
  );
  if (underPolicy.length !== 1) {
    throw new Error(
      `CONSUME-006: Engage UTxO phải mang ĐÚNG 1 thread NFT dưới policy ` +
        `${consumePolicyId} (== hash consume), thấy ${underPolicy.length}`,
    );
  }
  const unit = underPolicy[0]!;
  if ((engageUtxo.assets[unit] ?? 0n) !== 1n) {
    throw new Error(
      `CONSUME-006: thread NFT ${unit} có qty ${engageUtxo.assets[unit]} ≠ 1`,
    );
  }
  if (declaredUnit !== undefined && declaredUnit.toLowerCase() !== unit.toLowerCase()) {
    throw new Error(
      `CONSUME-009: engageNftUnit caller truyền (${declaredUnit}) khác thread NFT ` +
        `thật trên UTxO (${unit}). Tên NFT = blake2b_256(cbor(seed)), KHÔNG phải hằng.`,
    );
  }
  return unit;
}

// ── Mint thread Engage (genesis) ──────────────────────────────────────────────

export interface MintEngageParams {
  lucid: LucidEvolution;
  /** Compiled consume validator (ĐÃ apply 7 param) — vừa là policy, vừa là địa chỉ. */
  consumeScript: Validator;
  /** UTxO seed one-shot: PHẢI bị TIÊU trong chính tx này (`list.any(tx.inputs, ...)`). */
  seedUtxo: UTxO;
  /** Owner pkh (hex) — `validate_mint_engage_id` ép `list.has(tx.extra_signatories, owner)`. */
  ownerPkh: string;
  /** did_commit đặt MỘT LẦN lúc genesis, IMMUTABLE sau đó. MVP = "" (rỗng). */
  didCommit?: string;
  /** Lovelace gắn kèm thread UTxO (min-ADA). Default 2 ADA. */
  lovelace?: bigint;
  network: Network;
}

export interface MintEngageResult {
  tx: TxSignBuilder;
  /** policyId + nameHex của thread NFT vừa đúc. */
  engageNftUnit: string;
  /** Địa chỉ script consume — nơi Engage UTxO genesis phải nằm. */
  engageAddress: string;
  /** Datum genesis (mọi trục kế toán = 0). */
  genesisDatum: EngageDatumT;
  summary: string;
}

/**
 * Dựng tx MINT thread Engage (genesis). Đây là "nhà" của MintEngage vì handler `mint`
 * nằm TRONG chính validator `consume` (multi-purpose) — cùng script, cùng module.
 *
 * ⚠ MINT VÀ SPEND KHÔNG ĐI CHUNG MỘT TX. `consume.spend` ép
 * `script_inputs_confined_to(inputs, own_hash, vault_script_hash)` và cổng định danh
 * "mọi input tại địa chỉ engage mang đúng 1 thread NFT"; còn tx mint tiêu UTxO seed
 * của VÍ. Gộp hai việc chỉ làm rối ràng buộc mà không tiết kiệm được gì — tách hẳn.
 *
 * Ràng buộc `validate_mint_engage_id` mà builder này bám (đọc thẳng consume.ak):
 *   - seed UTxO bị tiêu trong tx (one-shot ⇒ thread NFT singleton vĩnh viễn);
 *   - đúng 1 asset dưới policy, qty +1, tên = blake2b_256(cbor.serialise(seed));
 *   - đúng 1 output tại ĐỊA CHỈ SCRIPT này mang NFT đó (chống "mint sạch → dời nhà bẩn");
 *   - datum inline, decode được EngageDatum 5 trường;
 *   - owner nằm trong `extra_signatories`;
 *   - consumed_count == 0 ∧ consumed_nanogic == 0 ∧ last_epoch == 0;
 *   - output genesis có nhiều nhất 2 policy ({ADA, thread NFT}) — không nhét token lạ.
 */
export async function buildMintEngageTx(
  params: MintEngageParams,
): Promise<MintEngageResult> {
  const {
    lucid, consumeScript, seedUtxo, ownerPkh,
    didCommit = "", lovelace = 2_000_000n, network,
  } = params;

  if (!/^[0-9a-fA-F]{56}$/.test(ownerPkh)) {
    throw new Error(`MINT-ENGAGE-001: ownerPkh phải là hex 28 byte, nhận "${ownerPkh}"`);
  }
  if (didCommit !== "" && !/^([0-9a-fA-F]{2})+$/.test(didCommit)) {
    throw new Error(`MINT-ENGAGE-002: did_commit phải là hex (hoặc rỗng), nhận "${didCommit}"`);
  }

  const policyId = validatorToScriptHash(consumeScript);
  const engageAddress = validatorToAddress(network, consumeScript);

  const seed: EngageIdSeed = {
    txHash: seedUtxo.txHash,
    outputIndex: seedUtxo.outputIndex,
  };
  const unit = policyId + engageAssetName(seed);

  // GENESIS SẠCH: cả ba trục state tích luỹ = 0. `last_epoch` KHÔNG phải epoch hiện
  // tại — nó là "epoch consume gần nhất", thread chưa consume lần nào ⇒ 0 (validator
  // ép `expect ed.last_epoch == 0`).
  const genesisDatum: EngageDatumT = {
    owner: ownerPkh.toLowerCase(),
    consumed_count: 0n,
    last_epoch: 0n,
    did_commit: didCommit.toLowerCase(),
    consumed_nanogic: 0n,
  };

  const mintRedeemer = encodeEngageMintRedeemer({
    seed: { transaction_id: seed.txHash, output_index: BigInt(seedUtxo.outputIndex) },
  });

  const tx = await lucid
    .newTx()
    .collectFrom([seedUtxo]) // one-shot: seed PHẢI nằm trong inputs
    .mintAssets({ [unit]: 1n }, mintRedeemer)
    .attach.MintingPolicy(consumeScript)
    .pay.ToAddressWithData(
      engageAddress,
      { kind: "inline", value: encodeEngageDatum(genesisDatum) },
      { lovelace, [unit]: 1n }, // ≤ 2 policy: ADA + thread NFT
    )
    .addSignerKey(ownerPkh.toLowerCase())
    .complete();

  const summary =
    `mint engage thread ${unit} | seed=${seed.txHash}#${seedUtxo.outputIndex} | ` +
    `addr=${engageAddress} | genesis count=0 nanogic=0 last_epoch=0`;

  return { tx, engageNftUnit: unit, engageAddress, genesisDatum, summary };
}

// ── Submit helper ─────────────────────────────────────────────────────────────

/** Sign (ví user) + submit. Trả tx hash. */
export async function signAndSubmit(tx: TxSignBuilder): Promise<string> {
  const signed = await tx.sign.withWallet().complete();
  return signed.submit();
}

export { toUnit };
