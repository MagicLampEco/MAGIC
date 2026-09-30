// src/instant.ts — InstantGen transaction builder (§6.3)
//
// PHA 2 model:
//   • LAMP NEVER MOVES (I-ACT-7). There is no Treasury output; `lamp_balance`,
//     `lamp_locked` and `loyalty_holdings` are byte-identical across the tx.
//     Holding LAMP only opens eligibility.
//   • The grant is keyed to MAGIC ALREADY CONSUMED:
//       grant = min( reward(consumed), cap_surplus(br), 0.5 × pp_schedule )
//     `consumed` = activity_state.consumed_credit, zeroed by this tx.
//   • The new batch is a 1-epoch cliff (§4.2) and dead batches are collected.
//
// Uses Lucid Evolution (https://github.com/Anastasia-Labs/lucid-evolution).

import {
  Lucid, Blockfrost, Data, Constr, toUnit, getAddressDetails,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator, type TxBuilder,
} from "@lucid-evolution/lucid";
import {
  TESTNET_CONFIG, MAX_BATCHES_PER_VAULT, MAGIC_DECAY_WINDOW,
  MIN_INSTANT_HOLDING, MAX_BACKING_STALE, PM_Q,
} from "./constants.js";
import {
  computeInstantGrantWithLent, computeCapLent, getUmForInstant, isExpired, instantGenInEpoch, applyPendingProfile,
  nanogicToMagicStr, qToStr,
} from "./math.js";
import { getTipSlot, posixMsToEpoch, msPerEpoch, epochValidityWindow, lampAssetName as lampAssetNameFor, vaultOutValue, assertVaultIdentityKept, collateralCompleteOptions, type Network } from "@magiclamp/protocol-utils";
import { applyOwnerAuth, resolveOwnerAuth, ownerRefOf, type OwnerAuth } from "@magiclamp/protocol-utils";
import { slotToUnixTime, unixTimeToSlot } from "@lucid-evolution/lucid";
import {
  VaultDatum, UMDatum, BackingBeaconDatum, VaultRedeemer,
  type MagicBatch,
} from "./types.js";
import { blake2b } from "@noble/hashes/blake2b";

// ── Types ─────────────────────────────────────────────────────

export interface InstantGenParams {
  /** Lucid instance connected to Preview testnet */
  lucid: LucidEvolution;
  /** The vault UTxO to spend */
  vaultUtxo: UTxO;
  /** UM datum UTxO (used as reference input) */
  umDatumUtxo: UTxO;
  /**
   * BackingBeacon UTxO (reference input, §6.3).  [CẦN XÁC NHẬN — chờ CARP]
   * REQUIRED: without it the validator cannot evaluate cap_surplus and the tx
   * is rejected. That is deliberate — the Gen door is shut rather than opened
   * on an invented `br`.
   */
  backingBeaconUtxo: UTxO;
  /** User's wallet address (must match vault.owner) */
  userAddress: string;
  /** Compiled vault validator with all 8 params already applied per-network, đúng thứ tự
   *  (lamp_policy_id, lamp_asset_name, um_nft_policy, um_script_hash, backing_nft_policy,
   *  backing_script_hash, ms_per_epoch, wakeme_vault_hash). Required to spend the vault UTxO. */
  vaultScript: Validator;
  /** Két Wakeme ghim két IG này (reference input, CC-GEN-LENT-READ). Có thì L_lent của nó
   *  vào ngưỡng C-INST-1/3 và trần LAMP (`computeCapLent`); vắng ⟹ L_lent = 0, y như cũ.
   *  Két không đạt luật đọc ⟹ NÉM `GEN-INST-010` (validator sẽ từ chối cả tx). */
  wakemeVaultUtxo?: UTxO;
  /** Hash script két Wakeme — PHẢI bằng apply-param #8 `wakeme_vault_hash` của `vaultScript`.
   *  Bắt buộc khi có `wakemeVaultUtxo`. */
  wakemeVaultHash?: string;
  /** UTxO CIP-33 mang script vault đã deploy. Có thì giao dịch ĐỌC script (`readFrom`) thay vì
   *  đính kèm: đo trên Preprod 27/09 (tx `66185661…`), đính kèm chiếm 11.599 / 12.634 byte và
   *  ≈0,33 ADA phí mỗi lượt, và datum vault còn lớn dần theo số batch tới trần 16.384 byte.
   *  Hash script trên UTxO phải trùng hash `vaultScript` — lệch thì NÉM `GEN-INST-009`, vì
   *  `readFrom` một script khác vẫn dựng xong và chỉ chết ở pha script. Vắng ⟹ đính kèm như cũ. */
  vaultRefScriptUtxo?: UTxO;
  /** LAMP policy id (hex) — must match `lamp_policy_id` param applied to validator. */
  lampPolicyId: string;
  /** LAMP asset name (hex). Bỏ trống thì DẪN THEO MẠNG qua `lampAssetName(network)`,
   *  KHÔNG rơi về hằng testnet. Chỉ đặt tay khi LAMP được mint dưới tên phi chuẩn. */
  lampAssetName?: string;
  /** Network — picks ms_per_epoch for POSIX-based epoch math (must match validator). */
  network?: Network;
  /** Optional tip POSIX ms. If omitted, derived from `getTipSlot(lucid, network)`. */
  tipPosixMs?: bigint;
  /** TEST ONLY: mutate output datum (negative tests). */
  tamperOutputDatum?: (d: any) => any;
  /** Cách chứng minh quyền chủ vault (`VaultDatum.owner` là `Credential`).
   *  Bỏ trống: chủ là khoá ⟹ `addSignerKey(pkh)` lấy từ datum; chủ là script ⟹ NÉM
   *  `OWNER_SCRIPT_WITNESS_UNAVAILABLE` (bộ dựng không bịa redeemer của stake-script chủ).
   *  Truyền mà khác chủ trong datum ⟹ NÉM `OWNER_AUTH_MISMATCH`. */
  ownerAuth?: OwnerAuth<TxBuilder>;
  /** TEST ONLY: bỏ hẳn bước chứng minh quyền chủ (ca âm của cổng owner). */
  skipOwnerSig?: boolean;
  /** TEST ONLY: send LAMP out of the vault to prove I-ACT-7 rejects it. */
  tamperLampOutOil?: bigint;
  /** Lượng thế chấp TƯỜNG MINH (lovelace) — đặt khi phí + thế chấp do ví trả phí bên thứ ba
   *  gánh (mô hình Feecover, trần mất thế chấp 3 tADA). Bỏ trống ⟹ lucid tự đặt (5 ADA).
   *  Hình dạng: `@magiclamp/protocol-utils` ▸ `collateralCompleteOptions`. */
  collateralLovelace?: bigint;
}

export interface InstantGenResult {
  /** The built but not yet signed/submitted transaction */
  tx: TxSignBuilder;
  /** Granted MAGIC in nanogic (= redeemer `claimed_amount`) */
  grantNanogic: bigint;
  /** consumed_credit consumed by this tx (zeroed afterwards) */
  consumedCreditSpent: bigint;
  /** The three ceilings, for diagnostics */
  ceilings: { reward: bigint; capSurplus: bigint; capPp: bigint };
  /** UM value used (after stale check) */
  umUsedQ: bigint;
  /** Current epoch at time of building */
  currentEpoch: bigint;
  /** Whether UM fallback was applied due to staleness */
  umFallbackApplied: boolean;
  /** LAMP balance after tx — ALWAYS equal to the balance before (I-ACT-7). */
  newLampBalance: bigint;
  /** Human-readable summary */
  summary: string;
}

// ── Lucid setup ───────────────────────────────────────────────

/** Create a Lucid instance connected to Preview testnet. */
export async function createLucid(blockfrostApiKey: string): Promise<LucidEvolution> {
  return Lucid(
    new Blockfrost(TESTNET_CONFIG.blockfrostUrl, blockfrostApiKey),
    TESTNET_CONFIG.network,
  );
}

// ── Main builder ─────────────────────────────────────────────

/**
 * Build an InstantGen transaction.
 *
 * Flow:
 *  1. eligibility — LAMP sits in the vault, unencumbered (C-INST-1 / C-INST-3)
 *  2. read UM datum → C-UM-6 stale check
 *  3. read BackingBeacon → depeg + staleness (fail-closed)
 *  4. grant = min(reward(consumed), cap_surplus, 0.5×pp) (C-INST-5)
 *  5. collect dead batches (§4.2 cliff) and append the new one
 *  6. build tx: vault→vault only, LAMP untouched
 */
export async function buildInstantGenTx(
  params: InstantGenParams,
): Promise<InstantGenResult> {
  const {
    lucid, vaultUtxo, umDatumUtxo, backingBeaconUtxo,
    vaultScript, lampPolicyId,
  } = params;
  const network = params.network ?? TESTNET_CONFIG.network;
  // Suy theo MẠNG, không lấy mặc định testnet. Bản cũ rơi về `TESTNET_CONFIG`
  // ("tLAMP") kể cả khi network là Mainnet — đúng thứ BOUNDARIES.md §2 gọi là dựng
  // ra một vault mainnet không bao giờ nhìn thấy LAMP của chính nó. Override tường
  // minh vẫn được tôn trọng, cho ca mint không chuẩn.
  //
  // ScheduleGen đã vá đúng lỗi này và viết lại lý do ở `schedule.ts` ▸ `lampAssetName`;
  // bản sao ở đây nằm chưa vá cho tới 2026-09-14. Đó là lý do rule đòi quét anh em
  // TRƯỚC khi đóng một đợt vá: đợt vá lấy phạm vi bằng phạm vi của triệu chứng thì
  // để lại nguyên nguyên nhân, và bản chưa vá không tự khai là nó chưa được vá.
  const lampAssetName = params.lampAssetName ?? lampAssetNameFor(network);

  // A vault UTxO always carries ADA; assert it so the output cannot be built
  // with an under-stated lovelace amount (Assets is an index signature).
  const vaultLovelace = vaultUtxo.assets.lovelace;
  if (vaultLovelace === undefined) {
    throw new Error(`GEN-INST-000: vault UTxO carries no lovelace — refusing to build.`);
  }

  // ── Decode datums ────────────────────────────────────────────
  const rawVaultDatum = Data.from(vaultUtxo.datum!, VaultDatum);
  const umDatum    = Data.from(umDatumUtxo.datum!, UMDatum);
  const backing    = Data.from(backingBeaconUtxo.datum!, BackingBeaconDatum);

  // ── Get current epoch (POSIX-ms-based, matches Aiken validator) ──
  const tipPosixMs = params.tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(lucid as never, network)));
  const currentEpoch = posixMsToEpoch(tipPosixMs, network);

  // `validate_instant_gen` tính trên `apply_pending_profile(input_datum, current_epoch)`:
  // hệ số PM lấy từ hồ sơ ĐÃ ÁP, và datum ra phải mang `profile`/`pending_profile` đã áp.
  // Dùng datum thô thì két vừa đổi hồ sơ khai sai `claimed_amount` và giữ `pending_profile`
  // cũ ⟹ chuỗi từ chối với một câu không trỏ về đâu.
  const vaultDatum = applyPendingProfile(rawVaultDatum, currentEpoch);

  // ── L_lent (CC-GEN-LENT-READ) — gương `wakeme_lent.ak ▸ lent_lamp` ──
  let lLent = 0n;
  if (params.wakemeVaultUtxo !== undefined) {
    if (params.wakemeVaultHash === undefined) {
      throw new Error(`GEN-INST-010: có wakemeVaultUtxo nhưng thiếu wakemeVaultHash (apply-param #8).`);
    }
    const ownScriptHash = validatorToScriptHash(vaultScript);
    lLent = readLentLamp(params.wakemeVaultUtxo, {
      wakemeVaultHash: params.wakemeVaultHash,
      ownScriptHash,
      ownVaultName:    singleVaultIdName(vaultUtxo, ownScriptHash),
      currentPeriod:   currentEpoch,
      lampPolicyId,
      lampAssetName,
    });
  }

  // ── C-INST-1: LAMP must SIT in the vault (eligibility only) ──
  // CC-GEN-LENT-THRESHOLD: ngưỡng tính cả L_lent.
  if (vaultDatum.lamp_balance + lLent < MIN_INSTANT_HOLDING) {
    throw new Error(
      `GEN-INST-001: lamp_balance ${vaultDatum.lamp_balance} + L_lent ${lLent} < MIN_INSTANT_HOLDING ` +
      `${MIN_INSTANT_HOLDING} oildrop (10 LAMP). Holding LAMP opens the door; it is never spent.`,
    );
  }

  // ── C-INST-3: the eligible LAMP must be unencumbered ────────
  const lAvail = vaultDatum.lamp_balance - vaultDatum.lamp_locked;
  if (lAvail + lLent < MIN_INSTANT_HOLDING) {
    throw new Error(
      `GEN-INST-003: L_avail ${lAvail} + L_lent ${lLent} < MIN_INSTANT_HOLDING ${MIN_INSTANT_HOLDING} oildrop. ` +
      `lamp_locked=${vaultDatum.lamp_locked} — locked LAMP does not buy eligibility.`,
    );
  }

  // ── §4.2 cliff: keep only LIVE batches ───────────────────────
  const liveBatches = vaultDatum.magic_batches.filter(
    (b) => !isExpired(b.created_epoch, b.decay_window, currentEpoch),
  );
  const prunedCount = vaultDatum.magic_batches.length - liveBatches.length;

  // ── C-INST-7: batch budget ───────────────────────────────────
  if (liveBatches.length >= MAX_BATCHES_PER_VAULT) {
    throw new Error(
      `GEN-VAULT-001: |live batches|=${liveBatches.length} ≥ ${MAX_BATCHES_PER_VAULT}. Burn some first.`,
    );
  }

  // ── C-UM-6: stale check ──────────────────────────────────────
  const umUsedQ = getUmForInstant(umDatum, currentEpoch);
  const umFallbackApplied = umUsedQ !== umDatum.smoothed_q;

  // ── §6.3 backing gate — FAIL-CLOSED ─────────────────────────
  if (backing.depeg) {
    throw new Error(
      `GEN-INST-006: BackingBeacon reports depeg → cap_surplus = 0. Gen is shut.`,
    );
  }
  const backingAge = currentEpoch - backing.last_updated_epoch;
  if (backingAge < 0n || backingAge > MAX_BACKING_STALE) {
    throw new Error(
      `GEN-INST-007: BackingBeacon stale (age=${backingAge} > ${MAX_BACKING_STALE}). ` +
      `A stale beacon counts as ABSENT — no default br is ever substituted.`,
    );
  }

  // ── C-INST-5: the §6.3 grant ─────────────────────────────────
  const pmQ = PM_Q[vaultDatum.profile];
  if (!pmQ) throw new Error(`Unknown profile: ${vaultDatum.profile}`);

  const consumed = vaultDatum.activity_state.consumed_credit;
  // `lAvail` đã tính ở cổng C-INST-3 phía trên — dùng lại, đừng khai lần hai:
  // hai `const` cùng tên trong một scope là lỗi biên dịch TS2451, và vitest KHÔNG
  // bắt được vì esbuild strip type mà không kiểm kiểu.
  const grant = computeInstantGrantWithLent(
    consumed, umUsedQ, pmQ, backing.br_q, backing.magic_supply, lAvail, lLent,
  );
  const ceilings = diagnoseCeilings(vaultDatum, consumed, umUsedQ, pmQ, backing, lLent);

  if (grant <= 0n) {
    throw new Error(
      `GEN-INST-005: grant = 0 → nothing to mint. ` +
      `reward=${ceilings.reward} cap_surplus=${ceilings.capSurplus} cap_pp=${ceilings.capPp} ` +
      `(consumed_credit=${consumed}, L_avail=${lAvail} oildrop). InstantGen only pays out ` +
      `against MAGIC actually consumed, and never above half the per-epoch rate that the ` +
      `same LAMP would earn on the shortest ScheduleGen commitment.`,
    );
  }

  // ── C-INST-8: trần theo EPOCH, không theo lượt ─────────────
  // Gương của `validate_instant_gen`: `expect gen_so_far + grant <= cap_total`,
  // `cap_total = compute_cap_pp(avail) + compute_cap_lent(lent)` — CÙNG trần với `grant`.
  // `grant` do validator tự tính và redeemer phải khai ĐÚNG nó, nên bộ dựng không được
  // hạ `grant` cho vừa trần — chỉ được từ chối. Thiếu cổng này thì lượt sinh thứ hai
  // trong cùng epoch chết ở pha đánh giá script (`Spend[0] … crashed`), một câu không
  // nói gì với người dùng (đo trên Preprod 2026-09-27).
  const genSoFar = instantGenInEpoch(liveBatches, currentEpoch);
  const capPpEpoch = computeCapPp(lAvail) + computeCapLent(lLent);
  if (genSoFar + grant > capPpEpoch) {
    throw new Error(
      `GEN-INST-008: epoch ${currentEpoch} đã sinh ${genSoFar} nanogic qua InstantGen; ` +
      `lượt này cấp ${grant} sẽ vượt trần epoch ${capPpEpoch} (cap_pp của L_avail=${lAvail} + cap_lent của L_lent=${lLent} ` +
      `oildrop). Trần về 0 ở epoch ${currentEpoch + 1n} — sinh lại từ đó.`,
    );
  }

  // ── New batch for THIS epoch (§4.2 cliff) ────────────────────
  const newBatchId = computeBatchId(vaultUtxo, vaultDatum.next_batch_index);
  const newBatch: MagicBatch = {
    batch_id:            newBatchId,
    source:              "Instant",
    created_epoch:       currentEpoch,
    initial_amount:      grant,
    current_amount:      grant,
    decay_window:        MAGIC_DECAY_WINDOW,   // 1 — dies next epoch
    profile_at_creation: null,                 // C-DECAY-4: None for Instant
    contract_id:         null,
    halved:              false,                // dead field, always false
  };

  const updatedBatches = [...liveBatches, newBatch];

  // ── Update attribution hash (C-ATT-1, C-ATT-2) ──────────────
  const newAttribution = updateAttribution(vaultDatum.attribution, {
    type: "BatchCreated",
    source: "Instant",
    epoch: currentEpoch,
  });

  // ── Validity range (POSIX ms, matches validator's epoch math) ─
  // Tính TRƯỚC khi dựng datum: `instant_unlock_ms` neo vào cận TRÊN của chính
  // khoảng này, nên hai thứ không được tính ở hai chỗ rời nhau.
  //
  // 🔴 `reserveTrailingSlots: 1` — KHÔNG phải một khoảng đệm cho chắc.
  // Mốc ghi vào datum là `cận-trên + P`. Cận trên mặc định là slot CUỐI của epoch
  // này ⟹ mốc rơi đúng slot CUỐI của epoch sau ⟹ lượt rút **tại đúng mốc được
  // quảng cáo** có `validFrom` và `validTo` cùng một slot ⟹ khoảng rỗng ⟹ sổ cái
  // từ chối, **mọi lần**. Chừa một slot đẩy mốc ra khỏi ô chết đó.
  // Giá phải trả: khoá ngắn đi đúng 1000 ms, vẫn nằm trong `[P, 2P)`.
  const { lowerMs: lowerTime, upperMs: upperTime } =
    epochValidityWindow(tipPosixMs, network, 1n);

  // ── C-INST-9: mốc khoá LAMP sau lượt sinh ─────────────────────
  //
  // Gương của `validate_instant_gen`:
  //     unlock_from_now = get_validity_upper_ms(tx) + ms_per_epoch
  //     new_unlock_ms   = max(input.instant_unlock_ms, unlock_from_now)
  //
  // 🔴 `get_validity_upper_ms` đọc cận trên mà SỔ CÁI trình ra, KHÔNG phải con số
  // mili-giây ta truyền vào `.validTo()`. Lucid quy nó về SLOT trước
  // (`validTo` → `unixTimeToSlot` → `unixTimeToEnclosingSlot`, tức làm tròn XUỐNG
  // biên slot), rồi script đọc lại bằng `slotToBeginUnixTime`.
  // `epochValidityWindow` đã trả về mốc căn ĐẦU slot, nên vòng quy đổi dưới đây
  // phải là phép ĐỒNG NHẤT. Giữ nó lại làm phép đối chứng chứ không phải làm phép
  // tính: nó chạy bằng bảng slot thật của Lucid, nên nếu giả định "biên slot trùng
  // biên 1000 ms" của `slotFloorMs` sai trên một mạng nào đó thì chỗ này kêu —
  // thay vì để `expect output_datum.instant_unlock_ms == new_unlock_ms` vỡ trên chuỗi.
  const upperMsOnChain = BigInt(slotToUnixTime(network, unixTimeToSlot(network, upperTime)));
  if (upperMsOnChain !== BigInt(upperTime)) {
    throw new Error(
      `Lưới slot lệch: epochValidityWindow trả ${upperTime} nhưng vòng quy đổi của ` +
      `Lucid cho ${upperMsOnChain} trên mạng ${network}. ` +
      `SLOT_LENGTH_MS hoặc giả định zeroTime ≡ 0 (mod 1000) không còn đúng.`,
    );
  }
  const unlockFromNow = upperMsOnChain + msPerEpoch(network);
  const newUnlockMs = vaultDatum.instant_unlock_ms > unlockFromNow
    ? vaultDatum.instant_unlock_ms
    : unlockFromNow;

  // ── Build updated VaultDatum (A02: field-by-field) ────────────
  // I-ACT-7: lamp_balance / lamp_locked / loyalty_holdings are copied verbatim.
  const newVaultDatum: VaultDatum = {
    ...vaultDatum,
    magic_batches:      updatedBatches,
    next_batch_index:   vaultDatum.next_batch_index + 1n,
    last_updated_epoch: currentEpoch,
    // INV-CASHBACK-BOUND: the credit is SPENT, never reusable.
    activity_state:     { ...vaultDatum.activity_state, consumed_credit: 0n },
    attribution:        newAttribution,
    // Trường 17 — đây là nhánh DUY NHẤT ghi nó; mọi nhánh spend khác ép đứng yên.
    instant_unlock_ms:  newUnlockMs,
  };

  // ── Build transaction ─────────────────────────────────────────
  const vaultScriptAddress = credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(vaultScript)),
  );

  // TEST ONLY: mutate output datum if tamper provided
  if (params.tamperOutputDatum) {
    Object.assign(newVaultDatum, params.tamperOutputDatum(newVaultDatum));
  }

  const redeemer = Data.to(
    { InstantGen: { claimed_amount: grant } },
    VaultRedeemer,
  );

  const lampUnit = toUnit(lampPolicyId, lampAssetName);

  // `lowerTime` / `upperTime` đã tính ở trên, cạnh `newUnlockMs` — hai thứ neo vào
  // cùng một cận nên phải nằm cùng chỗ.

  // I-ACT-7: the vault output carries EXACTLY the LAMP it came in with.
  const lampOut = vaultDatum.lamp_balance - (params.tamperLampOutOil ?? 0n);

  // Value ra của vault, tách thành CÂU LỆNH RIÊNG để chốt không biến mất cùng lần viết
  // lại biểu thức value — đó chính là lần viết lại nó sinh ra để bắt.
  const vaultOutAssets = vaultOutValue(vaultUtxo.assets, {
    lovelace:  vaultLovelace,                // ADA stays on vault
    [lampUnit]: lampOut,                     // LAMP stays on vault (I-ACT-7)
  });
  assertVaultIdentityKept(vaultUtxo.assets, vaultOutAssets);

  const vaultRef = params.vaultRefScriptUtxo;
  if (vaultRef !== undefined) assertVaultRefScript(vaultRef, vaultScript);
  const spend = lucid.newTx().collectFrom([vaultUtxo], redeemer);
  const oracleRefs = params.wakemeVaultUtxo !== undefined
    ? [umDatumUtxo, backingBeaconUtxo, params.wakemeVaultUtxo]
    : [umDatumUtxo, backingBeaconUtxo];
  const withScript = vaultRef !== undefined
    ? spend.readFrom([vaultRef, ...oracleRefs])
    : spend.attach.SpendingValidator(vaultScript).readFrom(oracleRefs);

  let txBuilder = withScript
    .pay.ToAddressWithData(
      vaultScriptAddress,
      { kind: "inline", value: Data.to(newVaultDatum, VaultDatum) },
      // 🔴 `vaultOutValue` bê nguyên value đầu vào rồi mới đè. Dựng lại object từ đầu
      // là làm rơi vault-id NFT (INV-VAULT-IDENTITY), và mọi nhánh spend đòi NFT còn
      // nguyên ở output — NFT one-shot nên rơi là vault chết vĩnh viễn, không phải một
      // tx hỏng. Bản vá gốc `ca5870df` (tuanzoro2k, 11/8) bị lần trộn hội tụ đánh rơi.
      // Chốt lúc chạy ở ngay trên (`assertVaultIdentityKept`).
      vaultOutAssets,
    )
    .validFrom(lowerTime)
    .validTo(upperTime);

  if (!params.skipOwnerSig) {
    txBuilder = applyOwnerAuth(
      txBuilder,
      resolveOwnerAuth(ownerRefOf(vaultDatum.owner), params.ownerAuth),
    );
  }
  const tx = await txBuilder.complete(collateralCompleteOptions(params.collateralLovelace));

  const summary = buildSummary({
    grant,
    consumed,
    ceilings,
    umUsedQ,
    umFallbackApplied,
    currentEpoch,
    prunedCount,
    newBatchCount: updatedBatches.length,
    lampBalance: vaultDatum.lamp_balance,
  });

  return {
    tx,
    grantNanogic: grant,
    consumedCreditSpent: consumed,
    ceilings,
    umUsedQ,
    currentEpoch,
    umFallbackApplied,
    newLampBalance: vaultDatum.lamp_balance,   // unchanged by construction
    summary,
  };
}

/** UTxO ref-script phải mang ĐÚNG script vault. Kiểm hash trên chính `scriptRef`. */
function assertVaultRefScript(ref: UTxO, vaultScript: Validator): void {
  const at = `${ref.txHash}#${ref.outputIndex}`;
  if (!ref.scriptRef) {
    throw new Error(`GEN-INST-009: UTxO ref-script ${at} không mang script tham chiếu nào.`);
  }
  const got = validatorToScriptHash(ref.scriptRef);
  const want = validatorToScriptHash(vaultScript);
  if (got !== want) {
    throw new Error(`GEN-INST-009: UTxO ref-script ${at} mang script ${got}, không phải vault ${want}.`);
  }
}

// ── Submit helper ────────────────────────────────────────────

/** Sign (with user's wallet) and submit the tx. Returns tx hash. */
export async function signAndSubmit(
  lucid : LucidEvolution,
  tx    : TxSignBuilder,
): Promise<string> {
  const signedTx = await tx.sign.withWallet().complete();
  return signedTx.submit();
}

// ── Diagnostics: the three ceilings separately ───────────────

import { computeRewardFromConsumed, computeCapSurplus, computeCapPp } from "./math.js";

export function diagnoseCeilings(
  vaultDatum: VaultDatum,
  consumed  : bigint,
  umQ       : bigint,
  pmQ       : bigint,
  backing   : BackingBeaconDatum,
  lLentOildrop: bigint = 0n,
): { reward: bigint; capSurplus: bigint; capPp: bigint } {
  return {
    reward:     computeRewardFromConsumed(consumed, umQ, pmQ),
    capSurplus: computeCapSurplus(backing.br_q, backing.magic_supply),
    // Trần theo LAMP = phần riêng + phần mượn đã kẹp (`computeCapLent`); lent = 0 ⟹ như cũ.
    capPp:      computeCapPp(vaultDatum.lamp_balance - vaultDatum.lamp_locked)
                  + computeCapLent(lLentOildrop),
  };
}

// ── L_lent: gương `onchain/lib/magiclamp/protocol/wakeme_lent.ak ▸ lent_lamp` ──
//
// Luật y hệt bên Aiken, trên MỘT UTxO két đã chọn: vế nào validator FAIL thì ở đây NÉM
// `GEN-INST-010` (dựng tiếp chỉ ra một tx chết ở pha script); vế (d) ghim trong chính kỳ
// và vế (f) value thiếu LAMP thì trả 0n như validator. Đọc datum theo VỊ TRÍ, ≥ 13 trường.

export interface LentReadContext {
  wakemeVaultHash: string;
  ownScriptHash:   string;
  ownVaultName:    string;
  currentPeriod:   bigint;
  lampPolicyId:    string;
  lampAssetName:   string;
}

export function readLentLamp(utxo: UTxO, ctx: LentReadContext): bigint {
  const fail = (why: string): never => {
    throw new Error(`GEN-INST-010: két Wakeme ${utxo.txHash}#${utxo.outputIndex} không đạt luật đọc L_lent — ${why}`);
  };
  // Luật 1 — payment credential phải là Script(wakemeVaultHash). Validator LỌC (bỏ qua),
  // nhưng bộ dựng nhận đúng một UTxO do người gọi chọn: sai địa chỉ là lỗi người gọi.
  const pc = getAddressDetails(utxo.address).paymentCredential;
  if (pc?.type !== "Script" || pc.hash !== ctx.wakemeVaultHash) fail("không nằm ở script két Wakeme");
  // (a) inline datum, Constr 0, ≥ 13 trường.
  if (!utxo.datum || utxo.datumHash) fail("datum không inline");
  const d = Data.from(utxo.datum!);
  if (!(d instanceof Constr) || d.index !== 0 || d.fields.length < 13) fail("datum không phải Constr 0 ≥ 13 trường");
  const f = (d as Constr<Data>).fields;
  const ownerCommit = f[0], conditional = f[3], owned = f[7], genVault = f[11], pinPeriod = f[12];
  if (typeof ownerCommit !== "string" || typeof conditional !== "bigint" ||
      typeof owned !== "bigint" || typeof pinPeriod !== "bigint") fail("sai kiểu trường");
  // (b) đúng MỘT token dưới policy két, số lượng 1, tên == owner_commit (32 byte).
  const nfts = Object.entries(utxo.assets).filter(([u]) => u !== "lovelace" && u.slice(0, 56) === ctx.wakemeVaultHash);
  if (nfts.length !== 1 || nfts[0]![1] !== 1n) fail("không đúng một NFT két số lượng 1");
  if ((ownerCommit as string).length !== 64 || nfts[0]![0].slice(56) !== ownerCommit) fail("tên NFT ≠ owner_commit 32 byte");
  // (c) gen_vault == Some(GenPin{ ownScriptHash, ownVaultName }) — so nguyên khối Data.
  const expectedPin = new Constr(0, [new Constr(0, [ctx.ownScriptHash, ctx.ownVaultName])]);
  if (Data.to(genVault as Data) !== Data.to(expectedPin)) fail("két không ghim két IG này");
  // (e) hai lượng không âm.
  if ((conditional as bigint) < 0n || (owned as bigint) < 0n) fail("lượng âm");
  const lent = (conditional as bigint) + (owned as bigint);
  // (d) ghim trong chính kỳ đang sinh ⟹ 0.
  if ((pinPeriod as bigint) >= ctx.currentPeriod) return 0n;
  // (f) LAMP thật trong value phải đỡ được datum ⟹ thiếu thì 0.
  const held = utxo.assets[ctx.lampPolicyId + ctx.lampAssetName] ?? 0n;
  return held < lent ? 0n : lent;
}

/** Tên NFT vault-id DUY NHẤT dưới policy = hash script vault (INV-VAULT-IDENTITY). */
function singleVaultIdName(vaultUtxo: UTxO, ownScriptHash: string): string {
  const ids = Object.entries(vaultUtxo.assets).filter(([u]) => u !== "lovelace" && u.slice(0, 56) === ownScriptHash);
  if (ids.length !== 1 || ids[0]![1] !== 1n) {
    throw new Error(`GEN-INST-010: vault UTxO không mang đúng một NFT vault-id dưới ${ownScriptHash}.`);
  }
  return ids[0]![0].slice(56);
}

// ── Utility: compute batch_id ─────────────────────────────────
//
// batch_id = blake2b256(vault_utxo_ref ∥ encode(next_batch_index))
// MUST match onchain/validators/vault.ak: compute_batch_id
// (P8: bit-identical across implementations)

function computeBatchId(vaultUtxo: UTxO, nextBatchIndex: bigint): string {
  const txHash = Buffer.from(vaultUtxo.txHash, "hex");
  const outputIndex = Buffer.alloc(8);
  outputIndex.writeBigUInt64BE(BigInt(vaultUtxo.outputIndex));
  const indexBytes = Buffer.alloc(8);
  indexBytes.writeBigUInt64BE(nextBatchIndex);

  const preimage = Buffer.concat([txHash, outputIndex, indexBytes]);
  const hash = blake2b(preimage, { dkLen: 32 });
  return Buffer.from(hash).toString("hex");
}

// ── Utility: update attribution hash chain ────────────────────
//
// new_root = blake2b256(old_root ∥ encode(event)) — §7.2

function updateAttribution(
  attr  : VaultDatum["attribution"],
  event : { type: string; source: string; epoch: bigint },
): VaultDatum["attribution"] {
  const oldRoot  = Buffer.from(attr.attribution_root, "hex");
  const eventEnc = Buffer.from(JSON.stringify({ ...event, epoch: event.epoch.toString() }));
  const preimage = Buffer.concat([oldRoot, eventEnc]);
  const newRoot  = Buffer.from(blake2b(preimage, { dkLen: 32 })).toString("hex");

  return {
    attribution_root: newRoot,
    last_event_epoch: event.epoch,
    total_events:     attr.total_events + 1n,
  };
}

// ── Human-readable summary ────────────────────────────────────

function buildSummary(params: {
  grant            : bigint;
  consumed         : bigint;
  ceilings         : { reward: bigint; capSurplus: bigint; capPp: bigint };
  umUsedQ          : bigint;
  umFallbackApplied: boolean;
  currentEpoch     : bigint;
  prunedCount      : number;
  newBatchCount    : number;
  lampBalance      : bigint;
}): string {
  const binding =
    params.grant === params.ceilings.reward ? "reward(consumed)"
    : params.grant === params.ceilings.capSurplus ? "cap_surplus(br)"
    : "0.5 × pp_schedule";

  const lines = [
    `═══ InstantGen Summary ═══`,
    `Epoch:            ${params.currentEpoch}`,
    `LAMP in vault:    ${params.lampBalance / 1_000_000n} tLAMP — UNCHANGED (I-ACT-7)`,
    `MAGIC consumed:   ${nanogicToMagicStr(params.consumed)} MAGIC (credit spent by this tx)`,
    `UM used:          ${qToStr(params.umUsedQ)}× ${params.umFallbackApplied ? "⚠ FALLBACK (stale UM — keeper not updated)" : "✓"}`,
    ``,
    `Ceilings (min wins):`,
    `  reward(consumed): ${nanogicToMagicStr(params.ceilings.reward)}`,
    `  cap_surplus(br):  ${nanogicToMagicStr(params.ceilings.capSurplus)}`,
    `  0.5 × pp_sched:   ${nanogicToMagicStr(params.ceilings.capPp)}`,
    `  → GRANTED:        ${nanogicToMagicStr(params.grant)} MAGIC (bound by ${binding})`,
    ``,
    `Batch lifetime:   1 epoch (§4.2 use-or-lose — spend it this epoch or lose it)`,
    `  Dead batches collected: ${params.prunedCount}`,
    `  Live batches after tx:  ${params.newBatchCount} (incl. new)`,
    ``,
    params.umFallbackApplied
      ? `⚠  UM was stale (staleness > 1 epoch). Used UM_FALLBACK=0.5×. Submit after the keeper updates UM for a better rate.`
      : `✓  UM fresh. Full UM=${qToStr(params.umUsedQ)}× applied.`,
  ];
  return lines.join("\n");
}
