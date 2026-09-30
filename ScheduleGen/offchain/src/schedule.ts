// src/schedule.ts — ScheduleGen: Commit + Fire transaction builders (Gen v2.0)
// Forward contract: `M_i` chốt lúc ký từ ρ + GreenBack; fire permissionless, bắn bù, KHÔNG
// đọc beacon (CC-GEN-SCHEDULE-FIXED, SPEC §6.1.4).
//
// Mọi phép tính datum nằm ở `genPlan.ts` (thuần, không mạng). Tệp này chỉ: tìm đúng UTxO,
// kiểm neo hai lớp của beacon (NFT + địa chỉ script), gọi `planScheduleCommit` /
// `planScheduleFire`, rồi dán kết quả vào giao dịch.

import {
  Lucid, Blockfrost, Data, toUnit,
  validatorToScriptHash, credentialToAddress, scriptHashToCredential, paymentCredentialOf,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator, type TxBuilder,
} from "@lucid-evolution/lucid";
import { applyOwnerAuth, resolveOwnerAuth, ownerRefOf, type OwnerAuth } from "@magiclamp/protocol-utils";
import {
  TESTNET_CONFIG, SCHEDULE_DELAY, RATE_NFT_NAME, GREENBACK_NFT_NAME, VAULT_REGISTRY_NFT_NAME,
} from "./constants.js";
import { computeShardId, nanogicToMagicStr, qToStr } from "./math.js";
import {
  getTipSlot, posixMsToEpoch, msPerEpoch, epochValidityWindow, lampAssetName as lampAssetNameFor,
  type Network,
  vaultOutValue,
  assertVaultIdentityKept,
  assertRefScriptsCover,
  collateralCompleteOptions,
} from "@magiclamp/protocol-utils";
import { slotToUnixTime } from "@lucid-evolution/lucid";
import {
  VaultDatum, VaultRedeemer, ShardRedeemer, ScheduleShardDatum,
  RateParam, GreenBackBeacon, GbShard, GbShardRedeemer,
  decodeVaultDatum, decodeScheduleShardDatum,
} from "./types.js";
import {
  planScheduleCommit, planScheduleFire, gbShardNftName, type VaultOutRef,
} from "./genPlan.js";

// ── Cổng CIP-33 ───────────────────────────────────────────────
//
// Module này BẮT BUỘC đi đường script tham chiếu: đính kèm cả hai validator vượt
// trần 16 384 B (xem chú thích `refScriptUtxos` ở `CommitParams`), nên `readFrom`
// là đường duy nhất dựng nổi giao dịch. Đúng vì thế mà nó là chỗ cần cổng nhất.
//
// Không có cổng thì một danh sách ref UTxO CŨ — keeper vẫn cầm sau một lượt
// redeploy, khi apply-param đổi ⟹ hash đổi ⟹ CIP-33 mới — vẫn dựng ra giao dịch
// bình thường. `complete()` không kêu. Nó chết ở phase-1 SAU KHI đã ký, với một
// lỗi không nêu UTxO nào sai. Và `ScheduleFire` là nhánh DUY NHẤT hạ `lamp_locked`
// (BOUNDARIES §2), nên mất nó là LAMP kẹt.
//
// Mã lỗi + câu lỗi dùng chung với SDK, định nghĩa ở `@magiclamp/protocol-utils`.
function assertRefScriptsFor(
  refUtxos: UTxO[],
  required: { script: Validator; what: string }[],
): UTxO[] {
  assertRefScriptsCover(
    refUtxos.map((u) => ({
      at:      `${u.txHash}#${u.outputIndex}`,
      gotHash: u.scriptRef == null ? null : validatorToScriptHash(u.scriptRef as Validator),
    })),
    required.map((r) => ({ what: r.what, wantHash: validatorToScriptHash(r.script) })),
  );
  return refUtxos;
}

// ── Types ─────────────────────────────────────────────────────

// Số ngày mỗi epoch KHÁC NHAU theo mạng: Preview 1 ngày, Preprod và mainnet 5 ngày
// (ProtocolUtils: MS_PER_EPOCH_BY_NETWORK). Bản trước hardcode `× 5` nên trên testnet
// nó in "~10 days" cho một khoảng chờ thật là 2 ngày — người vận hành đọc số đó sẽ
// tưởng hỏng rồi bỏ đi. Suy từ tham số mạng, đừng nhớ mòn.
function fmtDays(epochs: bigint, network: Network): string {
  const days = Number(epochs) * Number(msPerEpoch(network)) / 86_400_000;
  return days === 1 ? "1 day" : `${days} days`;
}

/** Apply-param Gen v2.0 của két (#4..#8, cùng tên với `validator vault(`) mà bộ dựng cần để
 *  nhận diện beacon + shard GB, cộng apply-param `gb_shard_cap_nanogic` của `gb_shard`. */
export interface GenBeaconParams {
  gbBeaconNftPolicy  : string;
  gbBeaconScriptHash : string;
  gbShardPolicyId    : string;
  rateNftPolicy      : string;
  rateScriptHash     : string;
  /** apply-param `gb_shard_cap_nanogic` của `gb_shard`. Bỏ trống ⟹ hằng TẠM
   *  `GB_SHARD_CAP_NANOGIC`. Lệch với giá trị đã apply ⟹ shard GB bác tx. */
  gbShardCapNanogic? : bigint;
}

export interface CommitParams {
  lucid           : LucidEvolution;
  vaultUtxo       : UTxO;
  shardUtxos      : UTxO[];    // all 16 shard LAMP UTxOs (builder finds the right one)
  scheduleLength  : bigint;    // L ∈ [10,200]
  lampPerEpoch    : bigint;    // λ in oil
  userAddress     : string;
  /** Compiled vault validator — 9 apply-params, THEO THỨ TỰ (`params.ts` ▸
   *  `SCHEDULE_VAULT_PARAM_NAMES`): lamp_policy_id, lamp_asset_name, shard_policy_id,
   *  ms_per_epoch, gb_beacon_nft_policy, gb_beacon_script_hash, gb_shard_policy_id,
   *  rate_nft_policy, rate_script_hash. */
  vaultScript     : Validator;
  /** Compiled shard (LAMP aggregate) validator. */
  shardScript     : Validator;
  // ── Gen v2.0: beacon + shard GB (chỉ nhánh KÝ đọc) ──────────
  gen             : GenBeaconParams;
  /** Beacon ρ — NFT (rate_nft_policy, "RHO") tại Script(rate_script_hash). Reference input. */
  rateBeaconUtxo  : UTxO;
  /** Beacon GreenBack — NFT (gb_beacon_nft_policy, "GBB") tại Script(gb_beacon_script_hash),
   *  phải GHI TRONG epoch hiện tại, không `depeg`. Reference input. */
  gbBeaconUtxo    : UTxO;
  /** Sổ két `VaultRegistry` (NFT "VRG") — shard GB đọc nó. Reference input. */
  vaultRegistryUtxo: UTxO;
  /** 16 UTxO shard GB (builder tìm đúng shard của két theo NFT "GBS" ‖ shard_id). */
  gbShardUtxos    : UTxO[];
  /** Compiled `gb_shard` validator — hash PHẢI bằng `gen.gbShardPolicyId`. */
  gbShardScript   : Validator;
  lampPolicyId    : string;
  lampAssetName?  : string;
  network?        : Network;
  tipPosixMs?     : bigint;
  tamperOutputDatum?: (d: any) => any;
  /** Cách chứng minh quyền chủ (`VaultDatum.owner` là `Credential`). Bỏ trống: chủ khoá ⟹
   *  `addSignerKey(pkh)` từ datum; chủ script ⟹ NÉM `OWNER_SCRIPT_WITNESS_UNAVAILABLE`. */
  ownerAuth?      : OwnerAuth<TxBuilder>;
  /** TEST ONLY: bỏ hẳn bước chứng minh quyền chủ. */
  skipOwnerSig?   : boolean;
  /** UTxO mang scriptRef của vault + shard + gb_shard (CIP-33). Có thì tx ĐỌC script từ
   *  chain thay vì đính kèm. ĐÍNH KÈM CẢ HAI VALIDATOR ĐÃ VƯỢT TRẦN 16 KB
   *  (đo thật trên Preview: 17303 > 16384), nên đây không phải tối ưu — không
   *  có nó thì ScheduleCommit không dựng nổi tx nào. */
  refScriptUtxos? : UTxO[];
  /** Lượng thế chấp TƯỜNG MINH (lovelace) — đặt khi phí + thế chấp do ví trả phí bên thứ ba
   *  gánh (mô hình Feecover, trần mất thế chấp 3 tADA). Bỏ trống ⟹ lucid tự đặt (5 ADA).
   *  Hình dạng: `@magiclamp/protocol-utils` ▸ `collateralCompleteOptions`. */
  collateralLovelace?: bigint;
}

export interface CommitResult {
  tx              : TxSignBuilder;
  scheduleId      : string;
  rateLockedQ     : bigint;
  /** ρ hiệu lực ở epoch ký (Q-format). */
  rhoEffectiveQ   : bigint;
  /** `M_i` chốt lúc ký — mỗi lượt bắn cấp đúng lượng này. */
  mPerEpoch       : bigint;
  /** = `mPerEpoch` (tên cũ, giữ cho người gọi v1). */
  mPerFire        : bigint;
  usageFactorLockedQ: bigint;
  /** Lượng shard GB bị trừ trong tx này: `M × min(N, buffer_ep)`. */
  gbDraw          : bigint;
  totalMagic      : bigint;
  totalLampLocked : bigint;
  firstFireEpoch  : bigint;
  lastFireEpoch   : bigint;
  summary         : string;
}

export interface FireParams {
  lucid           : LucidEvolution;
  vaultUtxo       : UTxO;
  shardUtxos      : UTxO[];
  scheduleId      : string;
  // No userAddress — permissionless (C-SCH-FIRE-PERMISSION)
  // No beacon — fire đọc `m_per_epoch` đã chốt (CC-GEN-SCHEDULE-FIXED).
  vaultScript     : Validator;
  shardScript     : Validator;
  lampPolicyId    : string;
  lampAssetName?  : string;
  network?        : Network;
  tipPosixMs?     : bigint;
  tamperOutputDatum?: (d: any) => any;
  /** TEST ONLY: move LAMP out of the vault to prove I-ACT-7 rejects it. */
  tamperLampOutOil?: bigint;
  /** Xem `CommitParams.refScriptUtxos` — ScheduleFire cũng tiêu hai script. */
  refScriptUtxos? : UTxO[];
  /** Xem `CommitParams.collateralLovelace`. */
  collateralLovelace?: bigint;
}

export interface FireResult {
  tx             : TxSignBuilder;
  firesInTx      : number;
  mPerFire       : bigint;
  totalMagicFired: bigint;
  /** LAMP RELEASED from the locked pool — it stays in the vault (I-ACT-7). */
  lampReleased   : bigint;
  /** Epoch danh nghĩa của lượt đầu (lượt bù < epoch hiện tại ⟹ batch chết lúc sinh). */
  firstNominalEpoch: bigint;
  scheduleComplete: boolean;
  summary        : string;
}

// ── Lucid setup ───────────────────────────────────────────────
export async function createLucid(apiKey: string): Promise<LucidEvolution> {
  return Lucid(new Blockfrost(TESTNET_CONFIG.blockfrostUrl, apiKey), TESTNET_CONFIG.network);
}

// ── Tìm UTxO ──────────────────────────────────────────────────

function datumOf(u: UTxO, what: string): string {
  if (typeof u.datum !== "string" || u.datum.length === 0) {
    throw new Error(`${what} ${u.txHash}#${u.outputIndex}: không có inline datum.`);
  }
  return u.datum;
}

function refOf(u: UTxO): VaultOutRef {
  return { txHash: u.txHash, outputIndex: u.outputIndex };
}

/** Script hash của payment credential; khoá ⟹ null. */
function paymentScriptOf(address: string): string | null {
  const c = paymentCredentialOf(address);
  return c.type === "Script" ? c.hash : null;
}

/** Neo hai lớp của beacon (gương `read_rho` / `read_greenback_fresh`): mang đúng 1 NFT
 *  (policy, name) VÀ nằm tại `Script(scriptHash)`. Thiếu một vế ⟹ NÉM. */
function assertBeaconAnchor(
  u: UTxO, policy: string, name: string, scriptHash: string, what: string,
): void {
  const qty = u.assets[toUnit(policy, name)];
  if (qty !== 1n) {
    throw new Error(`GEN-SCH-BEACON: ${what} ${u.txHash}#${u.outputIndex} không mang đúng 1 NFT ${policy}.${name} (có ${qty ?? 0n}).`);
  }
  const at = paymentScriptOf(u.address);
  if (at !== scriptHash) {
    throw new Error(`GEN-SCH-BEACON: ${what} nằm tại ${at ?? "địa chỉ khoá"}, cần Script(${scriptHash}).`);
  }
}

function findAggregateShard(
  shardUtxos: UTxO[], shardId: number,
): { utxo: UTxO; datum: ScheduleShardDatum } {
  const hits = shardUtxos
    .map(u => ({ utxo: u, datum: decodeScheduleShardDatum(datumOf(u, "shard LAMP")) }))
    .filter(x => x.datum.shard_id === BigInt(shardId));
  if (hits.length !== 1) {
    throw new Error(`GEN-SCH-008: cần đúng 1 shard LAMP ${shardId}, thấy ${hits.length}.`);
  }
  return hits[0]!;
}

function findGbShard(
  gbShardUtxos: UTxO[], gbShardPolicyId: string, shardId: number,
): { utxo: UTxO; datum: GbShard } {
  const unit = toUnit(gbShardPolicyId, gbShardNftName(shardId));
  const hits = gbShardUtxos.filter(u => u.assets[unit] === 1n);
  if (hits.length !== 1) {
    throw new Error(`GEN-SCH-GB: cần đúng 1 shard GB mang ${unit}, thấy ${hits.length}.`);
  }
  const u = hits[0]!;
  if (paymentScriptOf(u.address) !== gbShardPolicyId) {
    throw new Error(`GEN-SCH-GB: shard GB ${u.txHash}#${u.outputIndex} không nằm tại Script(${gbShardPolicyId}).`);
  }
  return { utxo: u, datum: Data.from(datumOf(u, "shard GB"), GbShard) };
}

// ══════════════════════════════════════════════════════════════
// Bước 1: buildScheduleCommitTx — Gen v2.0
// ══════════════════════════════════════════════════════════════
export async function buildScheduleCommitTx(params: CommitParams): Promise<CommitResult> {
  const { lucid, vaultUtxo, shardUtxos, scheduleLength: L, lampPerEpoch: lambda, gen } = params;
  const network = params.network ?? TESTNET_CONFIG.network;

  const vaultDatum = decodeVaultDatum(datumOf(vaultUtxo, "vault"));
  const tipPosixMs = params.tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(lucid as never, network)));
  const commitEpoch = posixMsToEpoch(tipPosixMs, network);

  // gb_shard: hash script PHẢI bằng apply-param #6 của két — lệch là shard của deploy khác.
  if (validatorToScriptHash(params.gbShardScript) !== gen.gbShardPolicyId) {
    throw new Error(`GEN-SCH-GB: hash gbShardScript ≠ gen.gbShardPolicyId (${gen.gbShardPolicyId}).`);
  }

  // Beacon: neo hai lớp rồi mới giải mã.
  assertBeaconAnchor(params.rateBeaconUtxo, gen.rateNftPolicy, RATE_NFT_NAME, gen.rateScriptHash, "beacon ρ");
  assertBeaconAnchor(params.gbBeaconUtxo, gen.gbBeaconNftPolicy, GREENBACK_NFT_NAME, gen.gbBeaconScriptHash, "beacon GreenBack");
  const rateParam = Data.from(datumOf(params.rateBeaconUtxo, "beacon ρ"), RateParam);
  const gbBeacon  = Data.from(datumOf(params.gbBeaconUtxo, "beacon GreenBack"), GreenBackBeacon);
  const reg = params.vaultRegistryUtxo;
  const hasVrg = Object.entries(reg.assets).some(([unit, q]) => unit.slice(56) === VAULT_REGISTRY_NFT_NAME && q === 1n);
  if (!hasVrg) {
    throw new Error(`GEN-SCH-GB: vaultRegistryUtxo ${reg.txHash}#${reg.outputIndex} không mang NFT "VRG".`);
  }

  const shardId = computeShardId(vaultDatum.owner);
  const agg = findAggregateShard(shardUtxos, shardId);
  const gbs = findGbShard(params.gbShardUtxos, gen.gbShardPolicyId, shardId);

  const plan = planScheduleCommit({
    vaultDatum,
    vaultRef:       refOf(vaultUtxo),
    scheduleLength: L,
    lampPerEpoch:   lambda,
    currentEpoch:   commitEpoch,
    rateParam,
    gbBeacon,
    gbShardIn:      gbs.datum,
    shardIn:        agg.datum,
    ...(gen.gbShardCapNanogic !== undefined ? { gbShardCapNanogic: gen.gbShardCapNanogic } : {}),
  });

  let newVaultDatum: VaultDatum = plan.vaultDatumOut;
  if (params.tamperOutputDatum) newVaultDatum = params.tamperOutputDatum(newVaultDatum);

  // Build tx
  const { vaultScript, shardScript, gbShardScript } = params;
  const vaultAddr = credentialToAddress(network, scriptHashToCredential(validatorToScriptHash(vaultScript)));
  const shardAddr = credentialToAddress(network, scriptHashToCredential(validatorToScriptHash(shardScript)));
  const redeemer  = Data.to({ ScheduleCommit: { schedule_length: L, lamp_per_epoch: lambda } }, VaultRedeemer);
  const shardRed  = Data.to({ ShardUpdateCommit: { delta_locked: plan.totalLock, delta_committed: plan.totalLock } }, ShardRedeemer);
  const gbDrawRed = Data.to({ amount: plan.gbDraw }, GbShardRedeemer);
  const { lowerMs: lowerTime, upperMs: upperTime } =
    epochValidityWindow(tipPosixMs, network);

  let txBuilder = lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .collectFrom([agg.utxo], shardRed)
    .collectFrom([gbs.utxo], gbDrawRed)
    // Beacon ρ + beacon GB (két đọc) + sổ két (shard GB đọc): chỉ ĐỌC, không tiêu.
    .readFrom([params.rateBeaconUtxo, params.gbBeaconUtxo, reg]);
  txBuilder = params.refScriptUtxos?.length
    ? txBuilder.readFrom(assertRefScriptsFor(params.refScriptUtxos, [
        { script: vaultScript,   what: "vault (ScheduleCommit)" },
        { script: shardScript,   what: "shard (ScheduleCommit)" },
        { script: gbShardScript, what: "gb_shard (ScheduleCommit)" },
      ]))
    : txBuilder.attach.SpendingValidator(vaultScript)
        .attach.SpendingValidator(shardScript)
        .attach.SpendingValidator(gbShardScript);
  txBuilder = txBuilder
    .pay.ToAddressWithData(vaultAddr, { kind: "inline", value: Data.to(newVaultDatum, VaultDatum) }, vaultUtxo.assets)
    .pay.ToAddressWithData(shardAddr, { kind: "inline", value: Data.to(plan.shardOut, ScheduleShardDatum) }, agg.utxo.assets)
    // Shard GB về ĐÚNG địa chỉ nó đi ra, cùng value (NFT ở lại) — `gb_draw_checked`.
    .pay.ToAddressWithData(gbs.utxo.address, { kind: "inline", value: Data.to(plan.gbShardOut, GbShard) }, gbs.utxo.assets)
    .validFrom(lowerTime)
    .validTo(upperTime);
  if (!params.skipOwnerSig) {
    txBuilder = applyOwnerAuth(
      txBuilder,
      resolveOwnerAuth(ownerRefOf(vaultDatum.owner), params.ownerAuth),
    );
  }
  const tx = await txBuilder.complete(collateralCompleteOptions(params.collateralLovelace));

  const s = plan.newSchedule;
  const summary = [
    `═══ ScheduleGen Commit (Gen v2.0) ═══`,
    `Commit epoch:    ${commitEpoch}`,
    `Schedule length: ${L} orders (~${fmtDays(L, network)})`,
    `λ per fire:      ${lambda / 1_000_000n} LAMP (${lambda} oil)`,
    `Total locked:    ${plan.totalLock / 1_000_000n} LAMP`,
    // ĐƠN VỊ PHẢI IN RA: `rate_locked_q / Q` là nanogic trên mỗi oildrop, KHÔNG phải MAGIC
    // trên mỗi LAMP — hai thang lệch nhau 10³.
    `rate_locked_q:   ${plan.rateLockedQ} = ${qToStr(plan.rateLockedQ)} nanogic/oildrop`,
    `ρ hiệu lực:      ${plan.rhoEffectiveQ} = ${qToStr(plan.rhoEffectiveQ)} nanogic/oildrop`,
    `usage_factor:    ${qToStr(plan.usageFactorLockedQ)} (chốt lúc ký)`,
    `M_i per fire:    ${nanogicToMagicStr(plan.mPerEpoch)} MAGIC (chốt lúc ký, không đổi theo beacon)`,
    `Total MAGIC:     ${nanogicToMagicStr(plan.mPerEpoch * L)} MAGIC`,
    `GB draw:         ${nanogicToMagicStr(plan.gbDraw)} MAGIC từ shard GB ${shardId}`,
    `First fire:      epoch ${s.start_fire_epoch} (~${fmtDays(SCHEDULE_DELAY, network)})`,
    `Last fire:       epoch ${s.end_fire_epoch}`,
    `S_Q(${L}):       ${qToStr(plan.sQ)}×`,
    `Schedule ID:     ${s.schedule_id.slice(0, 16)}...`,
    `Shard:           ${shardId} of 16`,
    ``,
    `⚠  Cannot cancel (T10). Fire is permissionless from epoch ${s.start_fire_epoch}.`,
  ].join("\n");

  return {
    tx, scheduleId: s.schedule_id, rateLockedQ: plan.rateLockedQ,
    rhoEffectiveQ: plan.rhoEffectiveQ, mPerEpoch: plan.mPerEpoch, mPerFire: plan.mPerEpoch,
    usageFactorLockedQ: plan.usageFactorLockedQ, gbDraw: plan.gbDraw,
    totalMagic: plan.mPerEpoch * L, totalLampLocked: plan.totalLock,
    firstFireEpoch: s.start_fire_epoch, lastFireEpoch: s.end_fire_epoch, summary,
  };
}

// ══════════════════════════════════════════════════════════════
// Bước 2: buildScheduleFireTx — PERMISSIONLESS, KHÔNG đọc beacon
// ══════════════════════════════════════════════════════════════
export async function buildScheduleFireTx(params: FireParams): Promise<FireResult> {
  const { lucid, vaultUtxo, shardUtxos, scheduleId } = params;
  const network = params.network ?? TESTNET_CONFIG.network;

  const vaultDatum = decodeVaultDatum(datumOf(vaultUtxo, "vault"));
  const tipPosixMs = params.tipPosixMs
    ?? BigInt(slotToUnixTime(network, await getTipSlot(lucid as never, network)));
  const currentEpoch = posixMsToEpoch(tipPosixMs, network);

  // Assets is an index signature, so every lookup is `bigint | undefined`.
  // A vault UTxO always carries ADA — assert it rather than defaulting to 0n,
  // which would silently under-pay the vault output.
  const vaultLovelaceFire = vaultUtxo.assets.lovelace;
  if (vaultLovelaceFire === undefined) {
    throw new Error(`GEN-SCH-000: vault UTxO carries no lovelace — refusing to build.`);
  }

  const shardId = computeShardId(vaultDatum.owner);
  const agg = findAggregateShard(shardUtxos, shardId);
  const plan = planScheduleFire({
    vaultDatum, vaultRef: refOf(vaultUtxo), scheduleId, currentEpoch, shardIn: agg.datum,
  });

  let newVaultDatum: VaultDatum = plan.vaultDatumOut;
  if (params.tamperOutputDatum) newVaultDatum = params.tamperOutputDatum(newVaultDatum);
  const sched = vaultDatum.gen_schedules.find(s => s.schedule_id === scheduleId)!;

  // Build tx
  const { vaultScript, shardScript, lampPolicyId } = params;
  // Suy theo MẠNG, không lấy mặc định testnet (BOUNDARIES.md §2: `lamp_asset_name`).
  const lampAssetName = params.lampAssetName ?? lampAssetNameFor(network);
  const vaultAddr  = credentialToAddress(network, scriptHashToCredential(validatorToScriptHash(vaultScript)));
  const shardAddr  = credentialToAddress(network, scriptHashToCredential(validatorToScriptHash(shardScript)));
  const lampUnit   = toUnit(lampPolicyId, lampAssetName);
  const redeemer   = Data.to({ ScheduleFire: { schedule_id: scheduleId } }, VaultRedeemer);
  const shardRed   = Data.to({ ShardUpdateFire: { fires_in_tx: BigInt(plan.firesInTx), lambda: sched.lamp_per_epoch } }, ShardRedeemer);
  const { lowerMs: lowerTime, upperMs: upperTime } =
    epochValidityWindow(tipPosixMs, network);

  // Value ra của vault, tách thành CÂU LỆNH RIÊNG để chốt bên dưới không biến mất cùng
  // lần viết lại biểu thức value — đó chính là lần viết lại nó sinh ra để bắt.
  const vaultOutAssets = vaultOutValue(vaultUtxo.assets, {
    lovelace: vaultLovelaceFire,
    [lampUnit]: newVaultDatum.lamp_balance - (params.tamperLampOutOil ?? 0n),
  });
  assertVaultIdentityKept(vaultUtxo.assets, vaultOutAssets);

  let fireBuilder = lucid
    .newTx()
    .collectFrom([vaultUtxo], redeemer)
    .collectFrom([agg.utxo], shardRed);
  fireBuilder = params.refScriptUtxos?.length
    ? fireBuilder.readFrom(assertRefScriptsFor(params.refScriptUtxos, [
        { script: vaultScript, what: "vault (ScheduleFire)" },
        { script: shardScript, what: "shard (ScheduleFire)" },
      ]))
    : fireBuilder.attach.SpendingValidator(vaultScript).attach.SpendingValidator(shardScript);
  const tx = await fireBuilder
    // I-ACT-7: the vault output carries EXACTLY the LAMP it came in with.
    //
    // 🔴 SPREAD the input value, override ONLY lovelace + LAMP. Rebuilding the value
    // from scratch drops the vault identity NFT (INV-VAULT-IDENTITY) — and
    // `validate_fire` gates on it (`validate_vault_value`). ScheduleFire is
    // permissionless, so that NFT is the SOLE gate against a forged vault.
    // Bản vá gốc: `ca5870df` (tuanzoro2k, 11/8). Đừng viết lại thành object dựng mới.
    .pay.ToAddressWithData(vaultAddr, { kind: "inline", value: Data.to(newVaultDatum, VaultDatum) },
      vaultOutAssets)
    .pay.ToAddressWithData(shardAddr, { kind: "inline", value: Data.to(plan.shardOut, ScheduleShardDatum) }, agg.utxo.assets)
    // NO Treasury output — a fire moves no LAMP anywhere.
    // NO beacon reference input, NO shard GB — validator bác tx có input tại Script(gb_shard).
    // C-SCH-FIRE-PERMISSION: NO .addSignerKey() — permissionless
    .validFrom(lowerTime)
    .validTo(upperTime)
    .complete(collateralCompleteOptions(params.collateralLovelace));

  const newFired = sched.fired_count + BigInt(plan.firesInTx);
  const late = currentEpoch - plan.firstNominalEpoch;
  const summary = [
    `═══ ScheduleGen Fire (Gen v2.0) ═══`,
    `Epoch:          ${currentEpoch}`,
    `Fires in tx:    ${plan.firesInTx} (of ${Number(sched.schedule_length - sched.fired_count)} remaining)`,
    `M_i per fire:   ${nanogicToMagicStr(plan.mPerEpoch)} MAGIC (chốt lúc ký)`,
    `Total MAGIC:    ${nanogicToMagicStr(plan.mPerEpoch * BigInt(plan.firesInTx))} MAGIC`,
    `LAMP released:  ${plan.lampReleased / 1_000_000n} LAMP unlocked — stays in the vault (I-ACT-7)`,
    `Progress:       ${Number(newFired)}/${Number(sched.schedule_length)} orders`,
    `Schedule:       ${plan.scheduleComplete ? "COMPLETE — removed" : `${Number(sched.schedule_length - newFired)} orders remaining`}`,
    `Shard:          ${shardId} (C-SCH-FIRE-SHARD)`,
    late > 0n
      ? `ℹ  Bắn bù: lượt đầu mang epoch danh nghĩa ${plan.firstNominalEpoch}; batch của epoch đã qua chết lúc sinh.`
      : "",
    `Note: This tx required NO owner signature (C-SCH-FIRE-PERMISSION).`,
  ].filter(Boolean).join("\n");

  return {
    tx, firesInTx: plan.firesInTx, mPerFire: plan.mPerEpoch,
    totalMagicFired: plan.mPerEpoch * BigInt(plan.firesInTx), lampReleased: plan.lampReleased,
    firstNominalEpoch: plan.firstNominalEpoch, scheduleComplete: plan.scheduleComplete, summary,
  };
}

// ── Submit ────────────────────────────────────────────────────
export async function signAndSubmit(lucid: LucidEvolution, tx: TxSignBuilder): Promise<string> {
  return (await tx.sign.withWallet().complete()).submit();
}

// getTipSlot moved to @magiclamp/protocol-utils — network-aware fallback (P8).
