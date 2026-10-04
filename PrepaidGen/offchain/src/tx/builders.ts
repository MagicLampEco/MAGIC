// src/tx/builders.ts — bộ dựng giao dịch PrepaidGen (Nợ #60).
//
// Mỗi nhánh có cặp `planX` (thuần) + `addX(tx, …)` (gắn vào TxBuilder). Datum đầu
// ra LUÔN do hàm luật ở `../prepaid.ts` tính — bộ dựng không có phép tính kế toán
// riêng nào, nên luật lệch validator thì lệch ở đúng một chỗ.
//
// Neo hình dạng giao dịch, theo TÊN HÀM ở `PrepaidGen/onchain/validators/prepaid.ak`:
//   mint vault  ▸ validate_mint_vault_id     mint quỹ ▸ validate_mint_fund_nft
//   Lock        ▸ validate_lock + validate_fund_lock (qua fund_common_checks)
//   Draw        ▸ validate_draw              BurnBatch ▸ validate_burn_batch
//   SettleLine  ▸ validate_settle_line + validate_fund_settle
//   FundClaim   ▸ validate_fund_claim
//   FundReclaim ▸ validate_fund_reclaim (tiếp nối) / validate_fund_close +
//                 validate_burn_fund_nft (đóng) — phần quỹ; phần két Wakeme do bên Wakeme ghép
//   mọi spend vault ▸ vault_identity_preserved (NFT còn nguyên, ADA không giảm,
//                     ≤ 2 policy, không ref-script)

import { credentialToAddress, type Assets, type TxBuilder, type UTxO } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/lucid";
import { MIN_BUFFER_BPS } from "../constants.js";
import { computeFundId } from "../math.js";
import { ownerCredential, ownerRefOf, type OwnerRef } from "../ownerAuth.js";
import {
  assertFundGenesis,
  burnBatches,
  claimBeneficiaryOutput,
  creditsAfterLock,
  drawMagic,
  fundAfterClaim,
  fundAfterLock,
  fundAfterReclaim,
  fundAfterSettle,
  lockRequiredSigner,
  settleLine,
  settleLineDebt,
} from "../prepaid.js";
import type { MagicBatch, PaidFundDatum, PlutusAddress, PrepaidVaultDatum } from "../types.js";
import type { Credential as LucidCredential } from "@lucid-evolution/lucid";
import {
  FUND_BURN_REDEEMER,
  FUND_MINT_REDEEMER,
  PrepaidTxError,
  burnBatchRedeemer,
  drawRedeemer,
  encodeFundDatum,
  encodeVaultDatum,
  fundClaimRedeemer,
  fundLockRedeemer,
  fundReclaimRedeemer,
  fundSettleRedeemer,
  lockRedeemer,
  mintVaultIdRedeemer,
  readFundUtxo,
  readVaultUtxo,
  settleLineRedeemer,
  vaultIdAssetName,
} from "./codec.js";
import { applyPlan, type OwnerProof, type TxPlan } from "./plan.js";
import type { PrepaidScripts } from "./scripts.js";
import { epochOfValidity, type TxValidity } from "./window.js";

function fail(code: string, message: string): never {
  throw new PrepaidTxError(code, message);
}

const epochOf = (s: PrepaidScripts, v: TxValidity): bigint =>
  epochOfValidity(v, s.params.msPerEpoch, s.params.windowOriginMs);

/** Value vault đầu ra = value vault đầu vào (NFT + ADA), không thêm/bớt gì. */
const sameAssets = (u: UTxO): Assets => ({ ...u.assets });

function addCarp(a: Assets, unit: string, delta: bigint): Assets {
  const next = (a[unit] ?? 0n) + delta;
  if (next < 0n) fail("C-PP-3", `CARP sau thay đổi âm (${next})`);
  const out: Assets = { ...a };
  if (next === 0n) delete out[unit];
  else out[unit] = next;
  return out;
}

const emptyPlan = (): TxPlan => ({
  plainInputs: [],
  spends: [],
  mints: [],
  outputs: [],
  signers: [],
  owner: null,
  validity: null,
});

// ══════════════════════════════════════════════════════════════
// T1 — mint két Prepaid (MintVaultId)
// ══════════════════════════════════════════════════════════════

export interface MintPrepaidVaultParams {
  scripts: PrepaidScripts;
  /** UTxO one-shot bị TIÊU trong tx; tên NFT = blake2b_256(cbor(OutputReference)). */
  seedUtxo: UTxO;
  /** Chủ két: `{type:"script", hash: did_stake}` cho người dùng PersonDID, hoặc khoá. */
  owner: OwnerRef;
  /**
   * `false` khi mảnh khác trong cùng tx đã `collectFrom` chính UTxO seed này (vd mint
   * thread dùng chung seed) — tiêu một UTxO hai lần là lỗi dựng tx.
   */
  collectSeed: boolean;
}

export interface MintPrepaidVaultResult {
  plan: TxPlan;
  datum: PrepaidVaultDatum;
  nftName: string;
  nftUnit: string;
}

/**
 * Gương `validate_mint_vault_id`: seed bị tiêu · đúc đúng 1 NFT dưới policy vault ·
 * đúng một output mang nó, ở địa chỉ enterprise của vault, không ref-script, ≤ 2
 * policy · datum genesis sạch (`did_commit == #""`, hạn-mức/batch rỗng, mọi bộ đếm 0)
 * · `owner_authorized(tx, owner)`.
 */
export function planMintPrepaidVault(p: MintPrepaidVaultParams): MintPrepaidVaultResult {
  const owner = ownerRefOf(ownerCredential(p.owner.type, p.owner.hash));
  const nftName = vaultIdAssetName({ txHash: p.seedUtxo.txHash, outputIndex: p.seedUtxo.outputIndex });
  const nftUnit = p.scripts.vault.hash + nftName;
  const datum: PrepaidVaultDatum = {
    owner: ownerCredential(owner.type, owner.hash),
    // Validator đòi rỗng ở genesis; gắn DID (nếu cần) đi qua nhánh SetDidCommit sau.
    // Thread consume mang did_commit RIÊNG của nó — hai trường không liên quan.
    did_commit: "",
    prepaid_credits: [],
    magic_batches: [],
    next_batch_index: 0n,
    personal_delegate: null,
    last_updated_epoch: 0n,
    attribution: { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
  };
  const plan = emptyPlan();
  if (p.collectSeed) plan.plainInputs.push(p.seedUtxo);
  plan.mints.push({
    script: p.scripts.vault,
    assets: { [nftUnit]: 1n },
    redeemerCbor: mintVaultIdRedeemer({ txHash: p.seedUtxo.txHash, outputIndex: p.seedUtxo.outputIndex }),
  });
  plan.outputs.push({ address: p.scripts.vault.address, datumCbor: encodeVaultDatum(datum), assets: { [nftUnit]: 1n } });
  plan.owner = owner;
  return { plan, datum, nftName, nftUnit };
}

/** Mảnh T1 phía két. `ownerProof: {mode:"deferred"}` khi mint thread cùng tx gắn mục rút. */
export function addMintPrepaidVault(
  tx: TxBuilder,
  p: MintPrepaidVaultParams & { ownerProof: OwnerProof },
): MintPrepaidVaultResult & { tx: TxBuilder } {
  const r = planMintPrepaidVault(p);
  return { ...r, tx: applyPlan(tx, r.plan, p.ownerProof) };
}

// ══════════════════════════════════════════════════════════════
// Genesis quỹ (đúc NFT quỹ) — điều kiện tiên quyết của T2
// ══════════════════════════════════════════════════════════════

export interface MintPaidFundParams {
  scripts: PrepaidScripts;
  /** UTxO bị tiêu; `fund_id = blake2b_256(tx_hash ‖ be8(index))`. */
  seedUtxo: UTxO;
  /** pkh bên tài trợ (app) — ký genesis, ký claim, được nạp thêm vào dòng đã có. */
  platformPkh: string;
  /** Đích nhận CARP của FundClaim: không stake, ≠ script quỹ/vault. Ghim trọn đời. */
  beneficiary: PlutusAddress;
  /** Bắt buộc khi beneficiary là script. */
  beneficiaryDatum: Data | null;
  bufferBps: bigint;
  collectSeed: boolean;
}

export function planMintPaidFund(p: MintPaidFundParams): { plan: TxPlan; datum: PaidFundDatum; fundId: string; nftUnit: string } {
  if (p.bufferBps < MIN_BUFFER_BPS) fail("C-PP-15", `buffer_bps ${p.bufferBps} < sàn ${MIN_BUFFER_BPS}`);
  const fundId = computeFundId(p.seedUtxo.txHash, BigInt(p.seedUtxo.outputIndex));
  const datum: PaidFundDatum = {
    fund_id: fundId,
    platform: p.platformPkh.toLowerCase(),
    vault_hash: p.scripts.vault.hash,
    carp_locked: 0n,
    credit_issued: 0n,
    magic_settled: 0n,
    provider_claimed: 0n,
    buffer_bps: p.bufferBps,
    last_updated_epoch: 0n,
    beneficiary: p.beneficiary,
    beneficiary_datum: p.beneficiaryDatum,
    // Quỹ thường (không tài trợ). Quỹ tài trợ cho một DID (DESIGN-reclaim §10.3)
    // cần bộ dựng genesis nhận `sponsorship` — CHƯA có ở đây.
    sponsorship: null,
    sponsor_reclaimed: 0n,
  };
  const signers = assertFundGenesis(datum, p.scripts.paidFund.hash);
  const nftUnit = p.scripts.paidFund.hash + fundId;
  const plan = emptyPlan();
  if (p.collectSeed) plan.plainInputs.push(p.seedUtxo);
  plan.mints.push({ script: p.scripts.paidFund, assets: { [nftUnit]: 1n }, redeemerCbor: FUND_MINT_REDEEMER });
  plan.outputs.push({ address: p.scripts.paidFund.address, datumCbor: encodeFundDatum(datum), assets: { [nftUnit]: 1n } });
  plan.signers.push(...signers);
  return { plan, datum, fundId, nftUnit };
}

export function addMintPaidFund(tx: TxBuilder, p: MintPaidFundParams) {
  const r = planMintPaidFund(p);
  return { ...r, tx: applyPlan(tx, r.plan, { mode: "deferred" }) };
}

// ══════════════════════════════════════════════════════════════
// T2 — PrepaidLock (vault) + FundLock (quỹ)
// ══════════════════════════════════════════════════════════════

export interface PrepaidLockParams {
  scripts: PrepaidScripts;
  vaultUtxo: UTxO;
  fundUtxo: UTxO;
  /** carpdrop, ≥ 1 CARP. CARP đi từ ví đang chọn (bên tài trợ) qua chọn-coin của Lucid. */
  amount: bigint;
  validity: TxValidity;
  /**
   * Ai chứng minh quyền (C-PP-9): mở dòng mới ⟹ CHỈ `owner`; nạp thêm dòng đã có ⟹
   * `platform` hoặc `owner`. Chọn `platform` cho dòng mới là NÉM ngay (không đổi lặng).
   */
  by: "owner" | "platform";
}

export interface PrepaidLockResult {
  plan: TxPlan;
  epoch: bigint;
  vaultDatumOut: PrepaidVaultDatum;
  fundDatumOut: PaidFundDatum;
  opensNewLine: boolean;
}

export function planPrepaidLock(p: PrepaidLockParams): PrepaidLockResult {
  const v = readVaultUtxo(p.scripts, p.vaultUtxo);
  const f = readFundUtxo(p.scripts, p.fundUtxo);
  const epoch = epochOf(p.scripts, p.validity);
  const signer = lockRequiredSigner(v.datum, f.datum, f.fundId, p.by);
  const opensNewLine = !v.datum.prepaid_credits.some((c) => c.fund_id === f.fundId);

  const vaultDatumOut: PrepaidVaultDatum = {
    ...v.datum,
    prepaid_credits: creditsAfterLock(v.datum.prepaid_credits, f.fundId, p.amount, epoch),
    last_updated_epoch: epoch,
  };
  const fundDatumOut = fundAfterLock(f.datum, p.amount, epoch);

  const plan = emptyPlan();
  plan.spends.push(
    { utxo: p.vaultUtxo, redeemerCbor: lockRedeemer(f.fundId, p.amount), script: p.scripts.vault },
    { utxo: p.fundUtxo, redeemerCbor: fundLockRedeemer(), script: p.scripts.paidFund },
  );
  plan.outputs.push(
    { address: p.vaultUtxo.address, datumCbor: encodeVaultDatum(vaultDatumOut), assets: sameAssets(p.vaultUtxo) },
    {
      address: p.fundUtxo.address,
      datumCbor: encodeFundDatum(fundDatumOut),
      assets: addCarp(sameAssets(p.fundUtxo), p.scripts.carpUnit, p.amount),
    },
  );
  plan.validity = p.validity;
  if (signer.by === "owner") plan.owner = signer.owner;
  else plan.signers.push(signer.pkh);
  // `validate_fund_lock`: quỹ tài trợ đòi bên tài trợ KÝ lượt nạp.
  const sponsorPkh = sponsorLockSigner(f.datum);
  if (sponsorPkh !== null && !plan.signers.includes(sponsorPkh)) plan.signers.push(sponsorPkh);
  return { plan, epoch, vaultDatumOut, fundDatumOut, opensNewLine };
}

export function addPrepaidLock(
  tx: TxBuilder,
  p: PrepaidLockParams & { ownerProof: OwnerProof },
): PrepaidLockResult & { tx: TxBuilder } {
  const r = planPrepaidLock(p);
  return { ...r, tx: applyPlan(tx, r.plan, p.ownerProof) };
}

// ══════════════════════════════════════════════════════════════
// T3 — PrepaidDraw
// ══════════════════════════════════════════════════════════════

export interface PrepaidDrawParams {
  scripts: PrepaidScripts;
  vaultUtxo: UTxO;
  fundId: string;
  /** carpdrop rút khỏi hạn-mức; MAGIC sinh = par(amount) nanogic. */
  amount: bigint;
  validity: TxValidity;
}

export interface PrepaidDrawResult {
  plan: TxPlan;
  epoch: bigint;
  vaultDatumOut: PrepaidVaultDatum;
  /** Batch vừa sinh: `created_epoch == epoch`, sống đúng kỳ này (cliff 1). */
  batch: MagicBatch;
}

export function planPrepaidDraw(p: PrepaidDrawParams): PrepaidDrawResult {
  const v = readVaultUtxo(p.scripts, p.vaultUtxo);
  const epoch = epochOf(p.scripts, p.validity);
  // own_ref của batch_id = CHÍNH UTxO vault đang tiêu (validator dùng `own_ref`).
  const vaultDatumOut = drawMagic(v.datum, p.fundId, p.amount, epoch, {
    txHash: p.vaultUtxo.txHash,
    outputIndex: BigInt(p.vaultUtxo.outputIndex),
  });
  const batch = vaultDatumOut.magic_batches[vaultDatumOut.magic_batches.length - 1]!;
  const plan = emptyPlan();
  plan.spends.push({ utxo: p.vaultUtxo, redeemerCbor: drawRedeemer(p.fundId, p.amount), script: p.scripts.vault });
  plan.outputs.push({ address: p.vaultUtxo.address, datumCbor: encodeVaultDatum(vaultDatumOut), assets: sameAssets(p.vaultUtxo) });
  plan.validity = p.validity;
  plan.owner = ownerRefOf(v.datum.owner);
  return { plan, epoch, vaultDatumOut, batch };
}

export function addPrepaidDraw(
  tx: TxBuilder,
  p: PrepaidDrawParams & { ownerProof: OwnerProof },
): PrepaidDrawResult & { tx: TxBuilder } {
  const r = planPrepaidDraw(p);
  return { ...r, tx: applyPlan(tx, r.plan, p.ownerProof) };
}

// ══════════════════════════════════════════════════════════════
// T4 — BurnBatch (phía vault, cho bộ dựng consume)
// ══════════════════════════════════════════════════════════════

/**
 * Chọn lô để đốt đủ `required` nanogic từ các batch CÒN SỐNG ở `epoch` (C-PP-5),
 * theo thứ tự trong datum. Không đủ ⟹ NÉM (không đốt thiếu, không đốt batch chết).
 */
export function planPrepaidBurns(
  vault: PrepaidVaultDatum,
  required: bigint,
  epoch: bigint,
): Array<[string, bigint]> {
  if (required <= 0n) fail("C-PP-9", `required ${required} phải > 0`);
  let left = required;
  const out: Array<[string, bigint]> = [];
  for (const b of vault.magic_batches) {
    if (left === 0n) break;
    if (b.created_epoch !== epoch || b.current_amount <= 0n) continue;
    const take = b.current_amount < left ? b.current_amount : left;
    out.push([b.batch_id, take]);
    left -= take;
  }
  if (left > 0n) {
    fail("C-PP-5", `MAGIC sống ở kỳ ${epoch} thiếu ${left} nanogic so với required ${required}`);
  }
  return out;
}

export interface PrepaidBurnFor {
  /** Cho `ConsumeTxParams.vaultBurnRedeemerCbor`. */
  vaultBurnRedeemerCbor: string;
  /** Cho `ConsumeTxParams.vaultOutDatumCbor`. */
  vaultOutDatumCbor: string;
  /** Cho `ConsumeTxParams.vaultOutAssets` — đúng value vault vào (BurnBatch không đụng value). */
  vaultOutAssets: Assets;
  vaultDatumOut: PrepaidVaultDatum;
  /** Chủ vault phải chứng minh quyền (`validate_burn_batch ▸ authed_owner`). */
  owner: OwnerRef;
}

/**
 * Redeemer `BurnBatch` + datum vault đầu ra theo `burnBatches`. `epoch` PHẢI là kỳ
 * của validity tx consume (gọi `epochOfValidity` trên đúng cặp cận đó).
 */
export function prepaidBurnFor(
  scripts: PrepaidScripts,
  vaultUtxo: UTxO,
  burns: readonly (readonly [string, bigint])[],
  epoch: bigint,
): PrepaidBurnFor {
  const v = readVaultUtxo(scripts, vaultUtxo);
  const vaultDatumOut = burnBatches(v.datum, burns, epoch);
  return {
    vaultBurnRedeemerCbor: burnBatchRedeemer(burns),
    vaultOutDatumCbor: encodeVaultDatum(vaultDatumOut),
    vaultOutAssets: sameAssets(vaultUtxo),
    vaultDatumOut,
    owner: ownerRefOf(v.datum.owner),
  };
}

/**
 * BurnBatch đứng một mình (chỉ chủ ký, không thread consume). Validator vault không
 * đòi đồng-tiêu consume ở nhánh này — `required` do ConsumeMAGIC ép ở tầng trên —
 * nên mảnh này hợp lệ trên chuỗi; dùng cho kiểm thử và cho chủ tự huỷ MAGIC.
 */
export function addPrepaidBurnBatch(
  tx: TxBuilder,
  p: {
    scripts: PrepaidScripts;
    vaultUtxo: UTxO;
    burns: readonly (readonly [string, bigint])[];
    validity: TxValidity;
    ownerProof: OwnerProof;
  },
) {
  const epoch = epochOf(p.scripts, p.validity);
  const b = prepaidBurnFor(p.scripts, p.vaultUtxo, p.burns, epoch);
  const plan = emptyPlan();
  plan.spends.push({ utxo: p.vaultUtxo, redeemerCbor: b.vaultBurnRedeemerCbor, script: p.scripts.vault });
  plan.outputs.push({ address: p.vaultUtxo.address, datumCbor: b.vaultOutDatumCbor, assets: b.vaultOutAssets });
  plan.validity = p.validity;
  plan.owner = b.owner;
  return { ...b, plan, epoch, tx: applyPlan(tx, plan, p.ownerProof) };
}

// ══════════════════════════════════════════════════════════════
// SettleLine (vault, constr 6) + FundSettle (quỹ) — permissionless
// ══════════════════════════════════════════════════════════════

export interface SettleLineParams {
  scripts: PrepaidScripts;
  vaultUtxo: UTxO;
  fundUtxo: UTxO;
  validity: TxValidity;
}

export function planSettleLine(p: SettleLineParams) {
  const v = readVaultUtxo(p.scripts, p.vaultUtxo);
  const f = readFundUtxo(p.scripts, p.fundUtxo);
  const epoch = epochOf(p.scripts, p.validity);
  const delta = settleLineDebt(v.datum, f.fundId);
  const vaultDatumOut = settleLine(v.datum, f.fundId, epoch);
  const fundDatumOut = fundAfterSettle(f.datum, delta, epoch);
  const plan = emptyPlan();
  plan.spends.push(
    { utxo: p.vaultUtxo, redeemerCbor: settleLineRedeemer(f.fundId), script: p.scripts.vault },
    { utxo: p.fundUtxo, redeemerCbor: fundSettleRedeemer(), script: p.scripts.paidFund },
  );
  plan.outputs.push(
    { address: p.vaultUtxo.address, datumCbor: encodeVaultDatum(vaultDatumOut), assets: sameAssets(p.vaultUtxo) },
    { address: p.fundUtxo.address, datumCbor: encodeFundDatum(fundDatumOut), assets: sameAssets(p.fundUtxo) },
  );
  plan.validity = p.validity;
  return { plan, epoch, delta, vaultDatumOut, fundDatumOut };
}

export function addSettleLine(tx: TxBuilder, p: SettleLineParams) {
  const r = planSettleLine(p);
  return { ...r, tx: applyPlan(tx, r.plan, { mode: "deferred" }) };
}

// ══════════════════════════════════════════════════════════════
// FundClaim (C-PP-6) — platform ký, CARP ra đích đã ghim
// ══════════════════════════════════════════════════════════════

export interface FundClaimParams {
  scripts: PrepaidScripts;
  fundUtxo: UTxO;
  amount: bigint;
  validity: TxValidity;
}

/**
 * Lưu ý cho người gọi: validator cấm MỌI input ở địa chỉ bên hưởng. Ví trả phí
 * không được là địa chỉ enterprise của bên hưởng — bộ dựng không kiểm được điều đó
 * trước `complete()` vì chọn-coin xảy ra ở đó.
 */
export function planFundClaim(p: FundClaimParams) {
  const f = readFundUtxo(p.scripts, p.fundUtxo);
  const epoch = epochOf(p.scripts, p.validity);
  const fundDatumOut = fundAfterClaim(f.datum, p.amount, epoch);
  const payout = claimBeneficiaryOutput(f.datum, p.amount);
  const pc = payout.paymentCredential;
  const benAddress = credentialToAddress(p.scripts.network, { type: pc.kind, hash: pc.hash });
  const plan = emptyPlan();
  plan.spends.push({ utxo: p.fundUtxo, redeemerCbor: fundClaimRedeemer(p.amount), script: p.scripts.paidFund });
  plan.outputs.push(
    {
      address: p.fundUtxo.address,
      datumCbor: encodeFundDatum(fundDatumOut),
      assets: addCarp(sameAssets(p.fundUtxo), p.scripts.carpUnit, -p.amount),
    },
    { address: benAddress, datumCbor: payout.inlineDatumCbor, assets: { [p.scripts.carpUnit]: p.amount } },
  );
  plan.signers.push(f.datum.platform);
  plan.validity = p.validity;
  return { plan, epoch, fundDatumOut, beneficiaryAddress: benAddress };
}

export function addFundClaim(tx: TxBuilder, p: FundClaimParams) {
  const r = planFundClaim(p);
  return { ...r, tx: applyPlan(tx, r.plan, { mode: "deferred" }) };
}

// ══════════════════════════════════════════════════════════════
// FundReclaim (DESIGN-reclaim §10.6) — trả phần chưa giao về ví bên tài trợ
// ══════════════════════════════════════════════════════════════

/** pkh bên tài trợ phải ký `FundLock` (quỹ tài trợ); `null` với quỹ thường. */
export function sponsorLockSigner(fund: PaidFundDatum): string | null {
  const s = fund.sponsorship;
  if (s === null) return null;
  const pc = s.sponsor.payment_credential;
  if (!("VerificationKey" in pc)) {
    fail("C-PP-RECLAIM", `quỹ ${fund.fund_id}: bên tài trợ không phải ví khoá — genesis không cho hình dạng này`);
  }
  return pc.VerificationKey[0];
}

function lucidCred(c: PlutusAddress["payment_credential"]): LucidCredential {
  return "VerificationKey" in c
    ? { type: "Key", hash: c.VerificationKey[0] }
    : { type: "Script", hash: c.Script[0] };
}

/** Địa chỉ ĐẦY ĐỦ (giữ phần stake) — validator so địa chỉ đầy đủ. Pointer ⟹ NÉM. */
export function plutusAddressToBech32(network: PrepaidScripts["network"], a: PlutusAddress): string {
  const sc = a.stake_credential;
  if (sc === null) return credentialToAddress(network, lucidCred(a.payment_credential));
  if (!("Inline" in sc)) fail("C-PP-RECLAIM", "địa chỉ bên tài trợ dùng stake Pointer — bộ dựng không hỗ trợ");
  return credentialToAddress(network, lucidCred(a.payment_credential), lucidCred(sc.Inline[0]));
}

/** Inline datum bắt buộc của output trả bên tài trợ: `fund_id` (ByteArray) — chống thoả-mãn-kép. */
export function reclaimPayoutDatumCbor(fundId: string): string {
  return Data.to(fundId);
}

export interface FundReclaimParams {
  scripts: PrepaidScripts;
  fundUtxo: UTxO;
  /** Validity của CẢ giao dịch ghép; kỳ của nó ghi vào `last_updated_epoch` (nhánh tiếp nối). */
  validity: TxValidity;
}

export interface FundReclaimResult {
  plan: TxPlan;
  epoch: bigint;
  /** R — CARP trả bên tài trợ. */
  reclaimed: bigint;
  /** `true` ⟹ nhánh ĐÓNG: đốt NFT quỹ, không quỹ tiếp nối, ADA của quỹ về bên tài trợ. */
  closing: boolean;
  /** Datum quỹ tiếp nối; `null` khi đóng. */
  fundDatumOut: PaidFundDatum | null;
  /** Địa chỉ bech32 ĐẦY ĐỦ của bên tài trợ (output trả). */
  sponsorAddress: string;
  /**
   * Phần bên Wakeme PHẢI ghép vào cùng giao dịch (mảnh này KHÔNG dựng nó): tiêu đúng
   * MỘT UTxO ở script `scriptHash` mang NFT `vaultNftUnit`, redeemer `ReclaimEpoch`
   * (constr `reclaimEpochConstr`). Thiếu phần này validator quỹ từ chối.
   */
  wakeme: { scriptHash: string; vaultNftUnit: string; reclaimEpochConstr: 1 };
}

/**
 * Kế hoạch phần QUỸ của `FundReclaim`, cả hai hình dạng (thuần, không I/O):
 *   · tiếp nối (E > 0): quỹ ở lại với `carp_locked − R`, `sponsor_reclaimed = R`;
 *   · đóng (E = 0): không output quỹ, đốt NFT quỹ (−1), toàn bộ ADA quỹ theo phần trả.
 * Output trả bên tài trợ: địa chỉ đầy đủ, inline datum `fund_id`, đúng `R` CARP.
 *
 * KHÔNG dựng phần két Wakeme (`ReclaimEpoch`) — đó là mảnh của bên Wakeme, ghép vào
 * cùng `TxBuilder` (xem `wakeme` trong kết quả). Lưu ý cho người gọi: validator cấm
 * MỌI input ở địa chỉ bên tài trợ, nên ví trả phí không được là ví đó; và mỗi giao
 * dịch chỉ một quỹ cho mỗi bản deploy `paid_fund`.
 */
export function planFundReclaim(p: FundReclaimParams): FundReclaimResult {
  const f = readFundUtxo(p.scripts, p.fundUtxo);
  const epoch = epochOf(p.scripts, p.validity);
  const o = fundAfterReclaim(f.datum, epoch);
  const sponsorAddress = plutusAddressToBech32(p.scripts.network, o.sponsorship.sponsor);
  const payoutDatum = reclaimPayoutDatumCbor(f.fundId);

  const plan = emptyPlan();
  plan.spends.push({ utxo: p.fundUtxo, redeemerCbor: fundReclaimRedeemer(), script: p.scripts.paidFund });
  if (o.closing) {
    plan.mints.push({ script: p.scripts.paidFund, assets: { [f.nftUnit]: -1n }, redeemerCbor: FUND_BURN_REDEEMER });
    const lovelace = p.fundUtxo.assets.lovelace ?? 0n;
    if (lovelace <= 0n) {
      fail("C-PP-SHAPE", `UTxO quỹ ${p.fundUtxo.txHash}#${p.fundUtxo.outputIndex} không có lovelace`);
    }
    plan.outputs.push({
      address: sponsorAddress,
      datumCbor: payoutDatum,
      assets: { lovelace, [p.scripts.carpUnit]: o.reclaimed },
    });
  } else {
    if (o.fundOut === null) fail("C-PP-RECLAIM", "nhánh tiếp nối thiếu datum quỹ đầu ra");
    plan.outputs.push(
      {
        address: p.fundUtxo.address,
        datumCbor: encodeFundDatum(o.fundOut),
        assets: addCarp(sameAssets(p.fundUtxo), p.scripts.carpUnit, -o.reclaimed),
      },
      { address: sponsorAddress, datumCbor: payoutDatum, assets: { [p.scripts.carpUnit]: o.reclaimed } },
    );
  }
  plan.validity = p.validity;
  return {
    plan,
    epoch,
    reclaimed: o.reclaimed,
    closing: o.closing,
    fundDatumOut: o.fundOut,
    sponsorAddress,
    wakeme: {
      scriptHash: p.scripts.params.wakemeVaultHash,
      vaultNftUnit: p.scripts.params.wakemeVaultHash + o.sponsorship.owner_commit,
      reclaimEpochConstr: 1,
    },
  };
}

/** Mảnh quỹ của `FundReclaim` gắn vào `tx`. Phần két Wakeme người gọi ghép riêng. */
export function addFundReclaim(tx: TxBuilder, p: FundReclaimParams) {
  const r = planFundReclaim(p);
  return { ...r, tx: applyPlan(tx, r.plan, { mode: "deferred" }) };
}
