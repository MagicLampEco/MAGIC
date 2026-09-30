// src/instant.ts — bộ dựng giao dịch két InstantGen, Gen v2.0 (gói d1).
//
// Hai nhánh spend dựng ở đây:
//   • InstantGen{claimed_amount = m} — lượt SINH. `m` (nanogic) do CHỦ KÉT CHỌN; validator
//     không tự tính một con số mà ép `m` qua các cổng IG-1..IG-14 (khối chú thích trên
//     `validate_instant_gen`, `onchain/validators/vault.ak`). Lượt sinh đọc beacon ρ (khi
//     làm mới checkpoint) + beacon GreenBack + sổ két, TIÊU và TRẢ LẠI đúng shard GB của
//     két, và KHÔNG động tới LAMP (I-ACT-7).
//   • RefreshCheckpoint — chủ ký, chỉ làm mới năm ô checkpoint; value ghim nguyên khối.
//
// Mọi phép tính nằm trong hàm THUẦN (`instantGenLimits`, `computeInstantGenOutputs`,
// `computeRefreshCheckpointOutput`) — bài kiểm chạy chúng không cần mạng; bộ dựng chỉ
// soát UTxO đầu vào rồi lắp giao dịch từ kết quả của chúng.
//
// Bỏ hẳn so với v1: UM (`umDatumUtxo`), backing beacon (`backingBeaconUtxo`), phép tính
// `grant = min(reward, cap_surplus, cap_pp)` và việc xoá `consumed_credit`. Gen v2.0
// không có apply-param UM/backing (`vaultScript.ts`).
//
// Uses Lucid Evolution (https://github.com/Anastasia-Labs/lucid-evolution).

import {
  Lucid, Blockfrost, Data, Constr, getAddressDetails, validatorToScriptHash,
  slotToUnixTime, unixTimeToSlot, calculateMinLovelaceFromUTxO,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator, type TxBuilder,
} from "@lucid-evolution/lucid";
import {
  TESTNET_CONFIG, MAX_BATCHES_PER_VAULT, MAGIC_DECAY_WINDOW, MIN_INSTANT_HOLDING,
  GB_SHARD_CAP_NANOGIC, RATE_NFT_NAME, GREENBACK_NFT_NAME, VAULT_REGISTRY_NFT_NAME,
} from "./constants.js";
import {
  computeCapPp, computeCapLent, isExpired, instantGenInEpoch, applyPendingProfile,
  nanogicToMagicStr,
} from "./math.js";
import { gbVaultShare, windowAdd } from "./genFormula.js";
import {
  getTipSlot, msPerEpoch as msPerEpochOf, epochValidityWindow, vaultOutValue,
  assertVaultIdentityKept, collateralCompleteOptions, type Network,
} from "@magiclamp/protocol-utils";
import { applyOwnerAuth, resolveOwnerAuth, ownerRefOf, type OwnerAuth } from "@magiclamp/protocol-utils";
import {
  VaultDatum, VaultRedeemer, GbShard, GbShardRedeemer, RateParam, GreenBackBeacon, VaultRegistry,
  decodeVaultDatum, type MagicBatch,
} from "./types.js";
import {
  expectedCheckpoint, expectedCheckpointForGen, type Checkpoint, type WakemeRead,
} from "./checkpoint.js";
import { assertGreenbackOpen, drawShard, shardNftName, vaultShardId } from "./greenback.js";
import type { InstantVaultParams } from "./vaultScript.js";
import { blake2b } from "@noble/hashes/blake2b";

// ══════════════════════════════════════════════════════════════════════════════
// Phần THUẦN — gương `validate_instant_gen` / `validate_refresh_checkpoint`
// ══════════════════════════════════════════════════════════════════════════════

export interface OutRef {
  txHash: string;
  outputIndex: number;
}

/** Đầu vào chung của lượt sinh (trừ `m` và cận trên validity). */
export interface InstantGenContext {
  /** Datum vào THÔ (chưa áp hồ sơ chờ) — hàm tự áp như validator. */
  vaultDatum       : VaultDatum;
  /** UTxO két đang tiêu — vào `batch_id`. */
  vaultOutRef      : OutRef;
  /** Epoch giao thức = cận dưới validity / ms_per_epoch. */
  currentEpoch     : bigint;
  /** Beacon ρ; BẮT BUỘC khi `cap_epoch < currentEpoch` (lượt làm mới), vắng thì NÉM. */
  rate             : RateParam | null;
  /** Két Wakeme đã đọc (`readWakemeVault`), hoặc null nếu không đưa két vào. */
  wakeme           : WakemeRead | null;
  greenback        : GreenBackBeacon;
  /** Datum shard GB ĐANG nằm trên chuỗi (trước đặt lại lười). */
  shardIn          : GbShard;
  /** Apply-param `gb_shard_cap_nanogic` của validator shard đã deploy. */
  gbShardCapNanogic: bigint;
}

export interface InstantGenInputs extends InstantGenContext {
  /** Lượng sinh `m`, nanogic. */
  m               : bigint;
  /** Cận TRÊN validity mà script thấy (đầu slot), POSIX ms. */
  validityUpperMs : bigint;
  /** Apply-param #8 `ms_per_epoch`. */
  msPerEpoch      : bigint;
}

/** Mọi trần của lượt sinh, trước khi chọn `m`. */
export interface InstantGenLimits {
  appliedDatum : VaultDatum;
  checkpoint   : Checkpoint;
  /** Lượt này có làm mới checkpoint không (cap_epoch < e). */
  refreshed    : boolean;
  lent         : bigint;
  lAvail       : bigint;
  liveBatches  : MagicBatch[];
  prunedCount  : number;
  /** `instant_gen_in_epoch(live, e)` — đã sinh trong epoch này. */
  genSoFar     : bigint;
  /** IG-8: `cap_nanogic` của checkpoint. */
  capNanogic   : bigint;
  /** IG-9: `compute_cap_pp(avail) + compute_cap_lent(lent)`. */
  capLamp      : bigint;
  shardId      : bigint;
  /** IG-11: `GB_available` sau đặt lại lười. */
  gbAvailable  : bigint;
  /** IG-12: `gb_vault_share(reset_amount)`. */
  vaultShare   : bigint;
  /** Vế `generated` của ô 0 cửa sổ checkpoint. */
  openGenerated: bigint;
  /** `m` lớn nhất qua được IG-8, IG-9, IG-11, IG-12 cùng lúc (≥ 0; 0 ⟹ không sinh được). */
  maxM         : bigint;
}

export interface InstantGenOutputs extends InstantGenLimits {
  m            : bigint;
  newBatch     : MagicBatch;
  newUnlockMs  : bigint;
  outputDatum  : VaultDatum;
  shardOut     : GbShard;
}

function min(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b < a ? b : a));
}

/**
 * Trần của lượt sinh ở trạng thái đã cho — IG-3, IG-5, IG-6, IG-7, IG-10 và phần tính
 * của IG-8, IG-9, IG-11, IG-12. Vế nào validator `fail` bất kể `m` thì ở đây NÉM.
 */
export function instantGenLimits(ctx: InstantGenContext): InstantGenLimits {
  const e = ctx.currentEpoch;
  const d = ctx.vaultDatum;
  // IG-3
  if (e < d.last_updated_epoch) {
    throw new Error(`GEN-INST-002: epoch ${e} < last_updated_epoch ${d.last_updated_epoch} — thời gian lùi.`);
  }
  const applied = applyPendingProfile(d, e);

  // IG-5
  const { checkpoint, lent, refreshed } = expectedCheckpointForGen(applied, e, ctx.wakeme, ctx.rate);

  // IG-6 — G2 tính cả LAMP-mượn, hai vế như validator.
  if (applied.lamp_balance + lent < MIN_INSTANT_HOLDING) {
    throw new Error(
      `GEN-INST-001: lamp_balance ${applied.lamp_balance} + L_lent ${lent} < MIN_INSTANT_HOLDING ` +
      `${MIN_INSTANT_HOLDING} oildrop (10 LAMP).`,
    );
  }
  const lAvail = applied.lamp_balance - applied.lamp_locked;
  if (lAvail + lent < MIN_INSTANT_HOLDING) {
    throw new Error(
      `GEN-INST-003: L_avail ${lAvail} + L_lent ${lent} < MIN_INSTANT_HOLDING ${MIN_INSTANT_HOLDING} oildrop.`,
    );
  }

  // IG-7
  const liveBatches = applied.magic_batches.filter(b => !isExpired(b.created_epoch, b.decay_window, e));
  if (liveBatches.length >= MAX_BATCHES_PER_VAULT) {
    throw new Error(`GEN-VAULT-001: |live batches|=${liveBatches.length} ≥ ${MAX_BATCHES_PER_VAULT}. Tiêu bớt trước.`);
  }

  // IG-8, IG-9 (phần tính)
  const genSoFar = instantGenInEpoch(liveBatches, e);
  const capNanogic = checkpoint.cap_nanogic;
  const capLamp = computeCapPp(lAvail) + computeCapLent(lent);

  // IG-10
  assertGreenbackOpen(ctx.greenback, e);

  // IG-11 — shard của két. Validator đọc tên NFT `"GBS" ‖ vault_shard_id(owner)`; datum
  // shard mang `shard_id` khớp tên NFT từ genesis shard, nên so ở đây là đủ.
  const shardId = vaultShardId(applied.owner);
  if (ctx.shardIn.shard_id !== shardId) {
    throw new Error(`GEN-INST-013: két thuộc shard ${shardId}, UTxO shard đưa vào là shard ${ctx.shardIn.shard_id}.`);
  }
  const { effective } = drawShard(ctx.shardIn, ctx.greenback, ctx.gbShardCapNanogic, 0n);

  // IG-12 (phần tính)
  const open = checkpoint.usage_window[0];
  if (open === undefined) throw new Error(`GEN-INST-011: usage_window rỗng.`);
  const vaultShare = gbVaultShare(effective.reset_amount);

  const maxRaw = min(
    capNanogic - genSoFar,
    capLamp - genSoFar,
    effective.remaining,
    vaultShare - open.generated,
  );

  return {
    appliedDatum: applied,
    checkpoint, refreshed, lent, lAvail, liveBatches,
    prunedCount: applied.magic_batches.length - liveBatches.length,
    genSoFar, capNanogic, capLamp, shardId,
    gbAvailable: effective.remaining, vaultShare, openGenerated: open.generated,
    maxM: maxRaw > 0n ? maxRaw : 0n,
  };
}

/**
 * Datum két ra + datum shard ra của lượt sinh `m` — gương IG-1..IG-13. NÉM có mã ở mọi
 * vế validator sẽ từ chối.
 */
export function computeInstantGenOutputs(inp: InstantGenInputs): InstantGenOutputs {
  const lim = instantGenLimits(inp);
  const e = inp.currentEpoch;
  const m = inp.m;

  // IG-4
  if (typeof m !== "bigint" || m <= 0n) {
    throw new Error(`GEN-INST-004: m phải là bigint > 0 (không có giao dịch cấp 0), nhận ${String(m)}.`);
  }
  // IG-8
  if (lim.genSoFar + m > lim.capNanogic) {
    throw new Error(
      `GEN-INST-008: epoch ${e} đã sinh ${lim.genSoFar}, thêm ${m} vượt cap_nanogic ${lim.capNanogic} ` +
      `(amount_by_lamp của epoch). m tối đa lượt này: ${lim.maxM}.`,
    );
  }
  // IG-9
  if (lim.genSoFar + m > lim.capLamp) {
    throw new Error(
      `GEN-INST-008: epoch ${e} đã sinh ${lim.genSoFar}, thêm ${m} vượt trần LAMP ${lim.capLamp} ` +
      `(cap_pp(L_avail=${lim.lAvail}) + cap_lent(L_lent=${lim.lent})). m tối đa lượt này: ${lim.maxM}.`,
    );
  }
  // IG-11
  const { shardOut } = drawShard(inp.shardIn, inp.greenback, inp.gbShardCapNanogic, m);
  // IG-12
  if (lim.openGenerated + m > lim.vaultShare) {
    throw new Error(
      `GEN-INST-014: két đã sinh ${lim.openGenerated} trong epoch, thêm ${m} vượt phần GB mỗi két ` +
      `${lim.vaultShare} (gb_vault_share của reset_amount). m tối đa lượt này: ${lim.maxM}.`,
    );
  }

  // IG-13
  const applied = lim.appliedDatum;
  const newBatch: MagicBatch = {
    batch_id:            computeBatchId(inp.vaultOutRef, applied.next_batch_index),
    source:              "Instant",
    created_epoch:       e,
    initial_amount:      m,
    current_amount:      m,
    decay_window:        MAGIC_DECAY_WINDOW,
    profile_at_creation: null,
    contract_id:         null,
    halved:              false,
  };
  const unlockFromNow = inp.validityUpperMs + inp.msPerEpoch;
  const newUnlockMs = applied.instant_unlock_ms > unlockFromNow ? applied.instant_unlock_ms : unlockFromNow;
  const cp = lim.checkpoint;
  const outputDatum: VaultDatum = {
    ...applied,
    magic_batches:      [...lim.liveBatches, newBatch],
    next_batch_index:   applied.next_batch_index + 1n,
    last_updated_epoch: e,
    attribution:        updateAttribution(applied.attribution, { type: "BatchCreated", source: "Instant", epoch: e }),
    instant_unlock_ms:  newUnlockMs,
    wakeme_link:        cp.wakeme_link,
    cap_epoch:          cp.cap_epoch,
    cap_nanogic:        cp.cap_nanogic,
    usage_window:       windowAdd(cp.usage_window, m, 0n),
    usage_window_epoch: cp.usage_window_epoch,
  };
  return { ...lim, m, newBatch, newUnlockMs, outputDatum, shardOut };
}

/**
 * Datum ra của RefreshCheckpoint — gương `validate_refresh_checkpoint`: `..input_datum`
 * (KHÔNG áp hồ sơ chờ) + năm ô từ `expected_checkpoint(.., FollowVaultOrUnlink, force)`.
 */
export function computeRefreshCheckpointOutput(
  vaultDatum: VaultDatum, currentEpoch: bigint, wakeme: WakemeRead | null, rate: RateParam | null,
): { outputDatum: VaultDatum; checkpoint: Checkpoint } {
  const cp = expectedCheckpoint(vaultDatum, currentEpoch, "FollowVaultOrUnlink", true, wakeme, rate);
  return {
    checkpoint: cp,
    outputDatum: {
      ...vaultDatum,
      wakeme_link:        cp.wakeme_link,
      cap_epoch:          cp.cap_epoch,
      cap_nanogic:        cp.cap_nanogic,
      usage_window:       cp.usage_window,
      usage_window_epoch: cp.usage_window_epoch,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Bộ dựng giao dịch
// ══════════════════════════════════════════════════════════════════════════════

/** Cửa sổ hiệu lực + nguồn epoch dùng chung cho hai bộ dựng. */
interface WindowSource {
  lucid       : LucidEvolution;
  /** Mạng — dùng để lấy tip và tính cửa sổ theo `epochValidityWindow`. Bỏ trống ⟹ Preview. */
  network?    : Network;
  /** Tip POSIX ms; bỏ trống thì hỏi provider (`getTipSlot`). */
  tipPosixMs? : bigint;
  /**
   * Cửa sổ TƯỜNG MINH (POSIX ms, đã nằm trên lưới slot của mạng đang chạy) — bỏ qua tip
   * và `epochValidityWindow`. Dùng cho mạng giả lập (Lucid Emulator, mạng "Custom") nơi
   * lưới slot không trùng ba mạng thật. Cả hai biên phải cùng một epoch giao thức.
   */
  validity?   : { fromMs: bigint; toMs: bigint };
}

interface ResolvedWindow { fromMs: bigint; toMs: bigint; epoch: bigint }

async function resolveWindow(src: WindowSource, p: bigint, reserveTrailingSlots: bigint): Promise<ResolvedWindow> {
  if (src.validity !== undefined) {
    const { fromMs, toMs } = src.validity;
    const epoch = fromMs / p;
    if (toMs <= fromMs || toMs >= (epoch + 1n) * p) {
      throw new Error(
        `GEN-INST-015: cửa sổ [${fromMs}, ${toMs}] không nằm gọn trong epoch ${epoch} ` +
        `(ms_per_epoch ${p}) — validator đòi hai biên cùng epoch.`,
      );
    }
    return { fromMs, toMs, epoch };
  }
  const network = src.network ?? TESTNET_CONFIG.network;
  if (msPerEpochOf(network) !== p) {
    throw new Error(
      `GEN-INST-015: ms_per_epoch của két (${p}) ≠ nhịp mạng ${network} (${msPerEpochOf(network)}). ` +
      `Két dựng cho mạng khác, hoặc truyền \`validity\` tường minh.`,
    );
  }
  const tip = src.tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(src.lucid as never, network)));
  const { lowerMs, upperMs } = epochValidityWindow(tip, network, reserveTrailingSlots);
  // Cận trên script THẤY là đầu slot (Lucid làm tròn xuống). `epochValidityWindow` đã căn
  // đầu slot nên vòng quy đổi phải là phép đồng nhất — giữ làm phép đối chứng.
  const upperOnChain = BigInt(slotToUnixTime(network, unixTimeToSlot(network, upperMs)));
  if (upperOnChain !== BigInt(upperMs)) {
    throw new Error(
      `Lưới slot lệch: epochValidityWindow trả ${upperMs} nhưng vòng quy đổi của Lucid cho ` +
      `${upperOnChain} trên mạng ${network}.`,
    );
  }
  return { fromMs: BigInt(lowerMs), toMs: BigInt(upperMs), epoch: BigInt(lowerMs) / p };
}

/** Phần chung: két, script két, apply-param, quyền chủ. */
interface VaultSpendCommon extends WindowSource {
  vaultUtxo          : UTxO;
  /** Validator két đã apply 9 tham số (`vaultScript.ts ▸ applyInstantVaultParams`). */
  vaultScript        : Validator;
  /** Cùng 9 giá trị đã apply vào `vaultScript` — bộ dựng soát UTxO theo chúng. */
  vaultParams        : InstantVaultParams;
  /** UTxO CIP-33 mang script két. Có ⟹ `readFrom` thay vì đính kèm (script két ~14 KB). */
  vaultRefScriptUtxo?: UTxO;
  /** Két Wakeme ghim két này (reference input, CHỈ đọc — không bao giờ tiêu). */
  wakemeVaultUtxo?   : UTxO;
  /** Chứng minh quyền chủ (`VaultDatum.owner` là Credential). */
  ownerAuth?         : OwnerAuth<TxBuilder>;
  /** TEST ONLY: bỏ bước chứng minh quyền chủ. */
  skipOwnerSig?      : boolean;
  /** Thế chấp tường minh (lovelace). */
  collateralLovelace?: bigint;
}

export interface InstantGenParams extends VaultSpendCommon {
  /** Lượng sinh `m` (nanogic) do chủ két chọn. `instantGenLimits(..).maxM` cho trần. */
  m                    : bigint;
  /** Beacon ρ — BẮT BUỘC khi lượt này làm mới checkpoint (cap_epoch < e). */
  rateBeaconUtxo?      : UTxO;
  greenbackBeaconUtxo  : UTxO;
  /** UTxO shard GB của ĐÚNG shard két (`vaultShardId(owner)`). */
  gbShardUtxo          : UTxO;
  /** Validator shard đã apply — đính kèm khi không có `gbShardRefScriptUtxo`. */
  gbShardScript?       : Validator;
  gbShardRefScriptUtxo?: UTxO;
  /** Sổ két được phép (NFT "VRG") — validator shard đọc nó qua reference input. */
  vaultRegistryUtxo    : UTxO;
  /** Policy NFT sổ (= hash script `vault_registry`). */
  vaultRegistryPolicy  : string;
  /** Apply-param `gb_shard_cap_nanogic` của shard đã deploy. Bỏ trống ⟹ hằng TẠM
   *  `GB_SHARD_CAP_NANOGIC` (cấu hình của chính kho này, `constants.ts`). */
  gbShardCapNanogic?   : bigint;
  /** TEST ONLY: sửa datum két ra (ca âm). */
  tamperOutputDatum?   : (d: VaultDatum) => VaultDatum;
}

export interface InstantGenResult {
  tx          : TxSignBuilder;
  m           : bigint;
  currentEpoch: bigint;
  validity    : { fromMs: bigint; toMs: bigint };
  outputs     : InstantGenOutputs;
  summary     : string;
}

/** Create a Lucid instance connected to Preview testnet. */
export async function createLucid(blockfrostApiKey: string): Promise<LucidEvolution> {
  return Lucid(new Blockfrost(TESTNET_CONFIG.blockfrostUrl, blockfrostApiKey), TESTNET_CONFIG.network);
}

function outRefStr(u: UTxO): string {
  return `${u.txHash}#${u.outputIndex}`;
}

/** UTxO nằm tại `Script(hash)` và mang đúng 1 đơn vị `unit`; trả datum inline. */
function inlineAtScript(u: UTxO, scriptHash: string, unit: string, what: string): string {
  const pc = getAddressDetails(u.address).paymentCredential;
  if (pc?.type !== "Script" || pc.hash !== scriptHash) {
    throw new Error(`GEN-INST-016: ${what} ${outRefStr(u)} không nằm tại script ${scriptHash}.`);
  }
  if (u.assets[unit] !== 1n) {
    throw new Error(`GEN-INST-016: ${what} ${outRefStr(u)} không mang đúng 1 NFT ${unit}.`);
  }
  if (typeof u.datum !== "string" || u.datum.length === 0) {
    throw new Error(`GEN-INST-016: ${what} ${outRefStr(u)} không có datum inline.`);
  }
  return u.datum;
}

function decodeAs<T>(cbor: string, schema: T, what: string, u: UTxO): T {
  try {
    return Data.from(cbor, schema as never) as T;
  } catch (e) {
    throw new Error(`GEN-INST-016: datum ${what} ${outRefStr(u)} sai hình dạng — ${(e as Error).message}`);
  }
}

/** Két: đúng script, datum v2.0, LAMP value khớp datum. Trả (datum, hash, tên NFT). */
function readVault(p: VaultSpendCommon): { datum: VaultDatum; ownHash: string; ownName: string } {
  const ownHash = validatorToScriptHash(p.vaultScript);
  const pc = getAddressDetails(p.vaultUtxo.address).paymentCredential;
  if (pc?.type !== "Script" || pc.hash !== ownHash) {
    throw new Error(`GEN-INST-009: vault UTxO ${outRefStr(p.vaultUtxo)} không nằm tại script két ${ownHash}.`);
  }
  if (p.vaultUtxo.assets.lovelace === undefined) {
    throw new Error(`GEN-INST-000: vault UTxO carries no lovelace — refusing to build.`);
  }
  if (typeof p.vaultUtxo.datum !== "string") {
    throw new Error(`GEN-INST-000: vault UTxO ${outRefStr(p.vaultUtxo)} không có datum inline.`);
  }
  const datum = decodeVaultDatum(p.vaultUtxo.datum);
  const lampHeld = p.vaultUtxo.assets[p.vaultParams.lampPolicyId + p.vaultParams.lampAssetName];
  if ((lampHeld ?? 0n) !== datum.lamp_balance) {
    throw new Error(
      `GEN-INST-000: LAMP trong value két (${lampHeld ?? 0n}) ≠ lamp_balance ${datum.lamp_balance}.`,
    );
  }
  return { datum, ownHash, ownName: singleVaultIdName(p.vaultUtxo, ownHash) };
}

function readRate(p: { rateBeaconUtxo?: UTxO; vaultParams: InstantVaultParams }): RateParam | null {
  const u = p.rateBeaconUtxo;
  if (u === undefined) return null;
  const vp = p.vaultParams;
  return decodeAs(inlineAtScript(u, vp.rateScriptHash, vp.rateNftPolicy + RATE_NFT_NAME, "beacon ρ"), RateParam, "beacon ρ", u);
}

function readWakeme(p: VaultSpendCommon, ownHash: string, ownName: string, e: bigint): WakemeRead | null {
  if (p.wakemeVaultUtxo === undefined) return null;
  return readWakemeVault(p.wakemeVaultUtxo, {
    wakemeVaultHash: p.vaultParams.wakemeVaultHash,
    ownScriptHash:   ownHash,
    ownVaultName:    ownName,
    currentPeriod:   e,
    lampPolicyId:    p.vaultParams.lampPolicyId,
    lampAssetName:   p.vaultParams.lampAssetName,
  });
}

function withOwner(tx: TxBuilder, p: VaultSpendCommon, datum: VaultDatum): TxBuilder {
  if (p.skipOwnerSig) return tx;
  return applyOwnerAuth(tx, resolveOwnerAuth(ownerRefOf(datum.owner), p.ownerAuth));
}

/**
 * Dựng giao dịch InstantGen Gen v2.0.
 *
 *  1. soát + giải mã két (datum v2.0), beacon ρ (nếu có), beacon GB, shard, sổ két
 *  2. cửa sổ hiệu lực (chừa 1 slot cuối epoch — xem `resolveWindow`)
 *  3. `computeInstantGenOutputs` — mọi cổng IG, NÉM trước khi dựng
 *  4. tiêu két (InstantGen{m}) + tiêu shard (Draw{m}); trả két và shard về ĐÚNG địa chỉ
 *     cũ; reference input: ρ?, GB, sổ, Wakeme? (+ ref-script)
 */
export async function buildInstantGenTx(params: InstantGenParams): Promise<InstantGenResult> {
  const vp = params.vaultParams;
  const { datum: vaultDatum, ownHash, ownName } = readVault(params);

  // 🔴 `reserveTrailingSlots: 1` — mốc khoá ghi vào datum là `cận-trên + P`; cận trên là
  // slot CUỐI epoch thì mốc rơi đúng slot cuối epoch sau ⟹ lượt rút tại mốc có khoảng
  // rỗng ⟹ sổ cái từ chối mọi lần. Chừa một slot đẩy mốc ra khỏi ô chết đó.
  const w = await resolveWindow(params, vp.msPerEpoch, 1n);
  const e = w.epoch;

  const rate = readRate(params);
  const greenback = decodeAs(
    inlineAtScript(params.greenbackBeaconUtxo, vp.gbBeaconScriptHash, vp.gbBeaconNftPolicy + GREENBACK_NFT_NAME, "beacon GreenBack"),
    GreenBackBeacon, "beacon GreenBack", params.greenbackBeaconUtxo,
  );
  const shardId = vaultShardId(vaultDatum.owner);
  const shardIn = decodeAs(
    inlineAtScript(params.gbShardUtxo, vp.gbShardPolicyId, vp.gbShardPolicyId + shardNftName(shardId), `shard GB ${shardId}`),
    GbShard, "shard GB", params.gbShardUtxo,
  );
  const registry = decodeAs(
    inlineAtScript(params.vaultRegistryUtxo, params.vaultRegistryPolicy, params.vaultRegistryPolicy + VAULT_REGISTRY_NFT_NAME, "sổ két"),
    VaultRegistry, "sổ két", params.vaultRegistryUtxo,
  );
  if (!registry.vault_script_hashes.includes(ownHash)) {
    throw new Error(`GEN-INST-016: sổ két ${outRefStr(params.vaultRegistryUtxo)} không liệt kê script két ${ownHash} — shard sẽ từ chối.`);
  }
  const wakeme = readWakeme(params, ownHash, ownName, e);

  const outputs = computeInstantGenOutputs({
    vaultDatum, vaultOutRef: params.vaultUtxo, currentEpoch: e, rate, wakeme, greenback, shardIn,
    gbShardCapNanogic: params.gbShardCapNanogic ?? GB_SHARD_CAP_NANOGIC,
    m: params.m, validityUpperMs: w.toMs, msPerEpoch: vp.msPerEpoch,
  });
  const outDatum = params.tamperOutputDatum ? params.tamperOutputDatum(structuredClone(outputs.outputDatum)) : outputs.outputDatum;

  // IG-14: value két ra = value vào (LAMP khớp datum, NFT, ADA, tập token).
  const vaultOutAssets = vaultOutValue(params.vaultUtxo.assets, {});
  assertVaultIdentityKept(params.vaultUtxo.assets, vaultOutAssets);
  // Shard: cùng địa chỉ, non-ADA y hệt (`continuing_pair`), ADA không giảm.
  const shardOutAssets = { ...params.gbShardUtxo.assets };

  const vaultRef = params.vaultRefScriptUtxo;
  if (vaultRef !== undefined) assertRefScript(vaultRef, params.vaultScript, "két");
  const shardRef = params.gbShardRefScriptUtxo;
  if (shardRef !== undefined) {
    const got = shardRef.scriptRef ? validatorToScriptHash(shardRef.scriptRef) : null;
    if (got !== vp.gbShardPolicyId) {
      throw new Error(`GEN-INST-009: UTxO ref-script ${outRefStr(shardRef)} mang ${got ?? "không script"}, không phải shard ${vp.gbShardPolicyId}.`);
    }
  } else if (params.gbShardScript === undefined) {
    throw new Error(`GEN-INST-009: thiếu script shard — truyền gbShardScript hoặc gbShardRefScriptUtxo.`);
  } else if (validatorToScriptHash(params.gbShardScript) !== vp.gbShardPolicyId) {
    throw new Error(`GEN-INST-009: gbShardScript có hash ${validatorToScriptHash(params.gbShardScript)} ≠ gb_shard_policy_id ${vp.gbShardPolicyId}.`);
  }

  const oracleRefs: UTxO[] = [];
  if (params.rateBeaconUtxo !== undefined) oracleRefs.push(params.rateBeaconUtxo);
  oracleRefs.push(params.greenbackBeaconUtxo, params.vaultRegistryUtxo);
  if (params.wakemeVaultUtxo !== undefined) oracleRefs.push(params.wakemeVaultUtxo);
  const scriptRefs = [vaultRef, shardRef].filter((u): u is UTxO => u !== undefined);

  let tx = params.lucid.newTx()
    .collectFrom([params.vaultUtxo], Data.to({ InstantGen: { claimed_amount: outputs.m } }, VaultRedeemer))
    .collectFrom([params.gbShardUtxo], Data.to({ amount: outputs.m }, GbShardRedeemer))
    .readFrom([...scriptRefs, ...oracleRefs]);
  if (vaultRef === undefined) tx = tx.attach.SpendingValidator(params.vaultScript);
  if (shardRef === undefined) tx = tx.attach.SpendingValidator(params.gbShardScript!);
  tx = tx
    .pay.ToAddressWithData(params.vaultUtxo.address, { kind: "inline", value: Data.to(outDatum, VaultDatum) }, vaultOutAssets)
    .pay.ToAddressWithData(params.gbShardUtxo.address, { kind: "inline", value: Data.to(outputs.shardOut, GbShard) }, shardOutAssets)
    .validFrom(Number(w.fromMs))
    .validTo(Number(w.toMs));
  tx = withOwner(tx, params, vaultDatum);
  const built = await tx.complete(collateralCompleteOptions(params.collateralLovelace));

  return {
    tx: built, m: outputs.m, currentEpoch: e, validity: { fromMs: w.fromMs, toMs: w.toMs }, outputs,
    summary: buildSummary(outputs, e),
  };
}

export interface RefreshCheckpointParams extends VaultSpendCommon {
  /** Beacon ρ — RefreshCheckpoint LUÔN làm mới nên luôn cần. */
  rateBeaconUtxo: UTxO;
  /**
   * Tham số giao thức `coinsPerUtxoByte` để soát min-ADA của két ra. Bỏ trống ⟹ đọc từ
   * `lucid.config().protocolParameters`; provider không có tham số giao thức ⟹ NÉM.
   */
  coinsPerUtxoByte?: bigint;
}

/**
 * RefreshCheckpoint ghim value két NGUYÊN KHỐI (`vault_output.value == own_input.output.value`,
 * kể cả lovelace), trong khi datum ra có thể DÀI hơn datum vào (vd `cap_nanogic` 0 → số 9
 * byte) ⟹ min-ADA của output tăng. Két đang giữ đúng sát min-ADA thì Lucid tự nâng lovelace
 * và validator từ chối với một câu không trỏ về đâu (đo trên Emulator 2026-09-30: két
 * 1 978 290 lovelace ⟹ `failed script execution Spend[0]`). NÉM trước với con số cụ thể.
 * Lối thoát: lượt InstantGen cũng làm mới checkpoint và IG-14 cho lovelace ra ≥ vào.
 */
function assertRefreshKeepsMinAda(params: RefreshCheckpointParams, outDatumCbor: string): void {
  let perByte = params.coinsPerUtxoByte;
  if (perByte === undefined) {
    const pp = params.lucid.config().protocolParameters;
    if (pp === undefined) {
      throw new Error(`GEN-INST-017: provider không trả tham số giao thức — truyền coinsPerUtxoByte tường minh.`);
    }
    perByte = BigInt(pp.coinsPerUtxoByte);
  }
  const have = params.vaultUtxo.assets.lovelace;
  if (have === undefined) throw new Error(`GEN-INST-000: vault UTxO carries no lovelace — refusing to build.`);
  const need = BigInt(calculateMinLovelaceFromUTxO(perByte, {
    ...params.vaultUtxo, datum: outDatumCbor, datumHash: null, scriptRef: null,
  }));
  if (have < need) {
    throw new Error(
      `GEN-INST-017: két giữ ${have} lovelace, datum sau RefreshCheckpoint cần tối thiểu ${need}. ` +
      `Validator ghim value nguyên khối nên không nạp thêm được — dùng một lượt InstantGen ` +
      `(cũng làm mới checkpoint, cho phép ADA ra ≥ vào) thay cho RefreshCheckpoint.`,
    );
  }
}

export interface RefreshCheckpointResult {
  tx          : TxSignBuilder;
  currentEpoch: bigint;
  checkpoint  : Checkpoint;
  outputDatum : VaultDatum;
}

/**
 * Dựng RefreshCheckpoint: chủ ký, làm mới năm ô checkpoint, value két ghim NGUYÊN KHỐI
 * (`vault_output.value == own_input.output.value` — kể cả lovelace, không được nạp thêm).
 * Có két Wakeme ghim két này ⟹ `wakeme_link := owner_commit`; không có ⟹ `""` (gỡ ghim).
 */
export async function buildRefreshCheckpointTx(params: RefreshCheckpointParams): Promise<RefreshCheckpointResult> {
  const vp = params.vaultParams;
  const { datum, ownHash, ownName } = readVault(params);
  const w = await resolveWindow(params, vp.msPerEpoch, 0n);
  const rate = readRate(params);
  const wakeme = readWakeme(params, ownHash, ownName, w.epoch);
  const { outputDatum, checkpoint } = computeRefreshCheckpointOutput(datum, w.epoch, wakeme, rate);
  const outDatumCbor = Data.to(outputDatum, VaultDatum);
  assertRefreshKeepsMinAda(params, outDatumCbor);

  const vaultRef = params.vaultRefScriptUtxo;
  if (vaultRef !== undefined) assertRefScript(vaultRef, params.vaultScript, "két");
  const refs: UTxO[] = [params.rateBeaconUtxo];
  if (params.wakemeVaultUtxo !== undefined) refs.push(params.wakemeVaultUtxo);

  let tx = params.lucid.newTx()
    .collectFrom([params.vaultUtxo], Data.to("RefreshCheckpoint", VaultRedeemer))
    .readFrom(vaultRef !== undefined ? [vaultRef, ...refs] : refs);
  if (vaultRef === undefined) tx = tx.attach.SpendingValidator(params.vaultScript);
  tx = tx
    .pay.ToAddressWithData(params.vaultUtxo.address, { kind: "inline", value: outDatumCbor }, { ...params.vaultUtxo.assets })
    .validFrom(Number(w.fromMs))
    .validTo(Number(w.toMs));
  tx = withOwner(tx, params, datum);
  const built = await tx.complete(collateralCompleteOptions(params.collateralLovelace));
  return { tx: built, currentEpoch: w.epoch, checkpoint, outputDatum };
}

/** UTxO ref-script phải mang ĐÚNG script. Kiểm hash trên chính `scriptRef`. */
function assertRefScript(ref: UTxO, script: Validator, what: string): void {
  if (!ref.scriptRef) {
    throw new Error(`GEN-INST-009: UTxO ref-script ${outRefStr(ref)} không mang script tham chiếu nào.`);
  }
  const got = validatorToScriptHash(ref.scriptRef);
  const want = validatorToScriptHash(script);
  if (got !== want) {
    throw new Error(`GEN-INST-009: UTxO ref-script ${outRefStr(ref)} mang script ${got}, không phải ${what} ${want}.`);
  }
}

/** Sign (with user's wallet) and submit the tx. Returns tx hash. */
export async function signAndSubmit(lucid: LucidEvolution, tx: TxSignBuilder): Promise<string> {
  void lucid;
  const signedTx = await tx.sign.withWallet().complete();
  return signedTx.submit();
}

// ── Két Wakeme: gương `onchain/lib/magiclamp/protocol/wakeme_lent.ak ▸ wakeme_read` ──
//
// Luật y hệt bên Aiken, trên MỘT UTxO két đã chọn: vế nào validator FAIL thì ở đây NÉM
// `GEN-INST-010`; vế (d) ghim trong chính kỳ và vế (f) value thiếu LAMP thì L = 0 như
// validator (vẫn trả `owner_commit`). Đọc datum theo VỊ TRÍ, ≥ 13 trường.

export interface LentReadContext {
  wakemeVaultHash: string;
  ownScriptHash:   string;
  ownVaultName:    string;
  currentPeriod:   bigint;
  lampPolicyId:    string;
  lampAssetName:   string;
}

export function readWakemeVault(utxo: UTxO, ctx: LentReadContext): WakemeRead {
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
  const commit = ownerCommit as string;
  const lent = (conditional as bigint) + (owned as bigint);
  // (d) ghim trong chính kỳ đang sinh ⟹ 0.
  if ((pinPeriod as bigint) >= ctx.currentPeriod) return { ownerCommit: commit, lent: 0n };
  // (f) LAMP thật trong value phải đỡ được datum ⟹ thiếu thì 0.
  const held = utxo.assets[ctx.lampPolicyId + ctx.lampAssetName] ?? 0n;
  return { ownerCommit: commit, lent: held < lent ? 0n : lent };
}

/** Gương `wakeme_lent.ak ▸ lent_lamp`: chỉ phần L_lent. */
export function readLentLamp(utxo: UTxO, ctx: LentReadContext): bigint {
  return readWakemeVault(utxo, ctx).lent;
}

/** Tên NFT vault-id DUY NHẤT dưới policy = hash script vault (INV-VAULT-IDENTITY). */
function singleVaultIdName(vaultUtxo: UTxO, ownScriptHash: string): string {
  const ids = Object.entries(vaultUtxo.assets).filter(([u]) => u !== "lovelace" && u.slice(0, 56) === ownScriptHash);
  if (ids.length !== 1 || ids[0]![1] !== 1n) {
    throw new Error(`GEN-INST-010: vault UTxO không mang đúng một NFT vault-id dưới ${ownScriptHash}.`);
  }
  return ids[0]![0].slice(56);
}

// ── batch_id = blake2b256(tx_hash ∥ be64(output_index) ∥ be64(next_batch_index)) ──
// MUST match onchain/validators/vault.ak: compute_batch_id (P8).
export function computeBatchId(ref: OutRef, nextBatchIndex: bigint): string {
  const txHash = Buffer.from(ref.txHash, "hex");
  const outputIndex = Buffer.alloc(8);
  outputIndex.writeBigUInt64BE(BigInt(ref.outputIndex));
  const indexBytes = Buffer.alloc(8);
  indexBytes.writeBigUInt64BE(nextBatchIndex);
  const hash = blake2b(Buffer.concat([txHash, outputIndex, indexBytes]), { dkLen: 32 });
  return Buffer.from(hash).toString("hex");
}

// ── attribution: new_root = blake2b256(old_root ∥ encode(event)) — §7.2 ──
// Validator để `attribution_root` TỰ DO ở nhánh sinh; chỉ ép `last_event_epoch = e` và
// `total_events + 1`.
function updateAttribution(
  attr : VaultDatum["attribution"],
  event: { type: string; source: string; epoch: bigint },
): VaultDatum["attribution"] {
  const oldRoot  = Buffer.from(attr.attribution_root, "hex");
  const eventEnc = Buffer.from(JSON.stringify({ ...event, epoch: event.epoch.toString() }));
  const newRoot  = Buffer.from(blake2b(Buffer.concat([oldRoot, eventEnc]), { dkLen: 32 })).toString("hex");
  return { attribution_root: newRoot, last_event_epoch: event.epoch, total_events: attr.total_events + 1n };
}

function buildSummary(o: InstantGenOutputs, e: bigint): string {
  return [
    `═══ InstantGen v2.0 ═══`,
    `Epoch:             ${e}${o.refreshed ? " (checkpoint làm mới lượt này)" : ""}`,
    `LAMP trong két:    ${o.appliedDatum.lamp_balance} oildrop — ĐỨNG YÊN (I-ACT-7); L_lent ${o.lent}`,
    `Sinh lượt này (m): ${nanogicToMagicStr(o.m)} MAGIC`,
    `Đã sinh trong epoch trước lượt này: ${nanogicToMagicStr(o.genSoFar)} MAGIC`,
    `Trần: cap_nanogic ${nanogicToMagicStr(o.capNanogic)} · trần LAMP ${nanogicToMagicStr(o.capLamp)} · ` +
      `GB shard ${o.shardId} còn ${nanogicToMagicStr(o.gbAvailable)} · phần GB mỗi két ${nanogicToMagicStr(o.vaultShare)}`,
    `m tối đa lúc dựng: ${nanogicToMagicStr(o.maxM)} MAGIC`,
    `Batch sống 1 epoch (§4.2). Dọn ${o.prunedCount} batch chết. LAMP khoá tới ${o.newUnlockMs} ms.`,
  ].join("\n");
}
