// src/paymaster.ts — Paymaster tx-builder (SPEC-Paymaster §B, §D).
//
// Dựng 1 tx APP SPONSOR: app (= personal_delegate của vault user) trả ADA+LAMP hộ,
// đồng trigger BurnBatch của VAULT validator để tiêu MAGIC user (delegate-consume-right).
// MAGIC KHÔNG là token, KHÔNG mint — chỉ giảm current_amount trong vault. Phí = kế toán
// trong SponsorMeter datum (cập quota per-DID + global theo epoch).
//
// Co-spend topology (mirror paymaster.ak):
//   - SponsorMeter UTxO (thread token) spend bằng Sponsor{...} → cập did_lamp_map + global.
//   - Vault UTxO(s) (generator vault, module khác) spend bằng BurnBatch → giảm current_amount.
//     App PHẢI là personal_delegate (field 15) của MỌI vault (PM-1.5). Redeemer BurnBatch
//     do caller dựng (constr index khác per vault: Instant=2/Snapshot=1/Vacuum=4/Schedule=2).
//   - SponsorPolicy beacon + ProtocolFeeParams beacon đọc REFERENCE input (không tiêu).
//
// Builder KHÔNG tin client: magic_consumed = Σ caller-truyền burns (đại lượng giống
// validator đọc lại từ redeemer thật). Builder TÍNH lamp_this ≤ lamp_cap, ada_this ≤
// ada_cap, áp epoch reset, dựng meter_out KHỚP validator để tx không bị từ chối on-chain.
//
// VALIDITY RANGE: cửa sổ CHẶT ≤ 1 epoch (lower=đầu epoch, upper=+1ms) khớp util.get_epoch
// (epoch ref on-chain lấy từ UPPER bound). app_authority PHẢI ký (addSigner).

import {
  Data,
  type LucidEvolution, type UTxO, type TxSignBuilder, type Validator, type OutRef,
} from "@lucid-evolution/lucid";
import { msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import { lampCap, adaCap, sumBurns, lookupDid, addDid, updateGlobalMagic, type Burn } from "./math.js";
import {
  PaymasterRedeemerSchema,
  encodeSponsorMeter, decodeSponsorMeter,
  decodeSponsorPolicy, decodeProtocolFeeParams,
  type SponsorMeterT, type SponsorPolicyT, type ProtocolFeeParamsT,
  type PaymasterRedeemerT, type OutputReferenceT, type DidLampEntryT,
} from "./types.js";

// ── Params ────────────────────────────────────────────────────────────────────

export interface SponsorVaultInput {
  /** Vault UTxO (generator vault) — spent bằng BurnBatch. App là delegate field 15. */
  utxo: UTxO;
  /** Redeemer BurnBatch dạng CBOR hex (caller dựng theo type vault đó). */
  burnRedeemerCbor: string;
  /** burns khai trong redeemer trên (asset_name_hex, amount_nanogic) — phải KHỚP
   *  redeemer CBOR. Builder dùng để tính magic_consumed (validator đọc lại từ redeemer). */
  burns: readonly Burn[];
}

export interface SponsorParams {
  /** Lucid instance (Preview). */
  lucid: LucidEvolution;
  /** SponsorMeter UTxO (thread token, 1/app/epoch) — spent bằng Sponsor. */
  meterUtxo: UTxO;
  /** Các vault co-spend (≥1). magic_consumed = Σ burns dedup theo OutRef. */
  vaultInputs: SponsorVaultInput[];
  /** SponsorPolicy beacon UTxO — đọc REFERENCE (không tiêu). Mang policy NFT. */
  policyBeaconUtxo: UTxO;
  /** ProtocolFeeParams beacon UTxO — đọc REFERENCE (sàn DAO). Mang protocol NFT. */
  protocolBeaconUtxo: UTxO;
  /** Compiled paymaster validator (đã apply 9 param). */
  paymasterScript: Validator;
  /** Compiled vault validator (module khác) — cần để spend vault input(s). */
  vaultScript: Validator;
  /** did_key per-user trong did_lamp_map (MVP = EngageDatum.owner / owner-key hex). */
  didKey: string;
  /** Meter thread NFT unit (policyId+nameHex) — bảo toàn trên output Meter. */
  meterNftUnit: string;
  /** Network (chọn ms_per_epoch cho validity-range — PHẢI khớp validator param). */
  network: Network;
  /** Tip POSIX ms hiện tại (đầu vào tính epoch + validity-range). */
  tipPosixMs: bigint;
  /** TUỲ CHỌN: LAMP app sponsor op này (oildrop). Mặc định = lamp_cap (sponsor tối đa).
   *  Validator ép 0 ≤ lamp_this ≤ lamp_cap; nếu protocol_fee_active thì > 0. */
  lampThisOverride?: bigint;
  /** TUỲ CHỌN: ADA app sponsor op này (lovelace). Mặc định = ada_cap. 0 ≤ ada_this ≤ ada_cap. */
  adaThisOverride?: bigint;
}

export interface SponsorResult {
  tx: TxSignBuilder;
  /** magic_consumed (nanogic) = Σ burns dedup. */
  magicConsumed: bigint;
  /** lamp_this (oildrop) app sponsor op này — đã cap. */
  lampThis: bigint;
  /** ada_this (lovelace) app sponsor op này — đã cap. */
  adaThis: bigint;
  /** epoch tham chiếu (từ upper bound). */
  currentEpoch: bigint;
  /** SponsorMeter mới (output). */
  newMeter: SponsorMeterT;
  summary: string;
}

// ── helpers ────────────────────────────────────────────────────────────────────

function utxoToRef(u: UTxO): OutputReferenceT {
  return { transaction_id: u.txHash, output_index: BigInt(u.outputIndex) };
}

function refKey(u: UTxO): string {
  return `${u.txHash}#${u.outputIndex}`;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Dựng tx app-sponsor. KHÔNG mint MAGIC. Caller (app) sign bằng app_authority + submit.
 *
 * Bất biến builder bám validator (paymaster.ak):
 *  - PM-2: magic_consumed = Σ burns trên vault PHÂN BIỆT (dedup theo OutRef).
 *  - PM-3/4: lamp_this ≤ lamp_cap(magic, lamp_q); ada_this ≤ ada_cap(magic, ada_q).
 *  - PM-3.5: lamp_q ≥ sàn; nếu protocol_fee_active ⇒ lamp_this > 0.
 *  - PM-8: epoch mới ⇒ reset budget (base map=[], global=0) TRƯỚC khi cộng op này.
 *  - PM-5/6: did_spent + lamp_this ≤ max_per_did; base_global + lamp_this ≤ max_global.
 *  - Meter output: did_lamp_map = add_did(base, did, lamp_this); global = base+lamp_this;
 *    value BẢO TOÀN tuyệt đối (copy nguyên meterUtxo.assets — giữ ADA + meter NFT).
 *  - validity-range cửa sổ ≤ 1 epoch; epoch ref = upper bound. app_authority addSigner.
 */
export async function buildSponsorTx(params: SponsorParams): Promise<SponsorResult> {
  const {
    lucid, meterUtxo, vaultInputs, policyBeaconUtxo, protocolBeaconUtxo,
    paymasterScript, vaultScript, didKey, meterNftUnit, network, tipPosixMs,
    lampThisOverride, adaThisOverride,
  } = params;

  if (vaultInputs.length < 1) throw new Error("PM-001: cần ≥1 vault input để sponsor");

  // ── đọc beacons (datum CBOR → struct) ───────────────────────────────────────
  if (!policyBeaconUtxo.datum) throw new Error("PM-002: policy beacon thiếu inline datum");
  if (!protocolBeaconUtxo.datum) throw new Error("PM-003: protocol beacon thiếu inline datum");
  const policy: SponsorPolicyT = decodeSponsorPolicy(policyBeaconUtxo.datum);
  const protocol: ProtocolFeeParamsT = decodeProtocolFeeParams(protocolBeaconUtxo.datum);

  // ── PM-3.5: sàn DAO (fail sớm trước submit) ─────────────────────────────────
  if (policy.lamp_per_magic_q < protocol.min_lamp_per_magic_q) {
    throw new Error(
      `PM-004: lamp_per_magic_q ${policy.lamp_per_magic_q} < sàn ${protocol.min_lamp_per_magic_q}`,
    );
  }

  // ── epoch tham chiếu = từ UPPER bound (khớp util.get_epoch) ──────────────────
  const mspe = msPerEpoch(network);
  const currentEpoch = tipPosixMs / mspe;
  const lowerMs = currentEpoch * mspe;
  const upperMs = lowerMs + 1n;

  // ── PM-10: policy freshness (fail sớm) ──────────────────────────────────────
  if (currentEpoch < policy.epoch) {
    throw new Error(`PM-005: policy epoch ${policy.epoch} > current ${currentEpoch} (tương lai)`);
  }

  // ── PM-2: magic_consumed = Σ burns trên vault PHÂN BIỆT (dedup theo OutRef) ──
  const seen = new Set<string>();
  let magicConsumed = 0n;
  for (const v of vaultInputs) {
    const k = refKey(v.utxo);
    if (seen.has(k)) continue;
    seen.add(k);
    magicConsumed += sumBurns(v.burns);
  }
  if (magicConsumed <= 0n) throw new Error("PM-006: magic_consumed phải > 0");

  // ── PM-3/4: trần sponsor theo tỷ giá ────────────────────────────────────────
  const lampCapVal = lampCap(magicConsumed, policy.lamp_per_magic_q);
  const adaCapVal = adaCap(magicConsumed, policy.ada_per_magic_q);
  const lampThis = lampThisOverride ?? lampCapVal;
  const adaThis = adaThisOverride ?? adaCapVal;
  if (lampThis < 0n || lampThis > lampCapVal) {
    throw new Error(`PM-007: lamp_this ${lampThis} ngoài [0, ${lampCapVal}]`);
  }
  if (adaThis < 0n || adaThis > adaCapVal) {
    throw new Error(`PM-008: ada_this ${adaThis} ngoài [0, ${adaCapVal}]`);
  }
  // PM-3.5: chống sponsor=0 khi phí giao thức bật.
  if (protocol.protocol_fee_active && lampThis <= 0n) {
    throw new Error("PM-009: protocol_fee_active ⇒ lamp_this phải > 0");
  }

  // ── PM-8: base state theo epoch (reset nếu meter epoch cũ) ───────────────────
  if (!meterUtxo.datum) throw new Error("PM-010: meter UTxO thiếu inline datum");
  const meterIn: SponsorMeterT = decodeSponsorMeter(meterUtxo.datum);
  if (meterIn.epoch > currentEpoch) {
    throw new Error(`PM-011: meter epoch ${meterIn.epoch} > current ${currentEpoch} (tương lai)`);
  }
  const epochRollover = meterIn.epoch < currentEpoch;
  const baseMap: DidLampEntryT[] = epochRollover ? [] : meterIn.did_lamp_map;
  const baseGlobal: bigint = epochRollover ? 0n : meterIn.global_lamp_epoch;
  const baseMagic: bigint = epochRollover ? 0n : meterIn.global_magic_epoch;

  // ── PM-5/6: cap fail-closed (offchain mirror, fail sớm) ──────────────────────
  const didSpent = lookupDid(baseMap as ReadonlyArray<readonly [string, bigint]>, didKey);
  if (didSpent + lampThis > policy.max_per_did_per_epoch) {
    throw new Error(
      `PM-012: per-DID cap vượt: ${didSpent}+${lampThis} > ${policy.max_per_did_per_epoch}`,
    );
  }
  if (baseGlobal + lampThis > policy.max_global_per_epoch) {
    throw new Error(
      `PM-013: global cap vượt: ${baseGlobal}+${lampThis} > ${policy.max_global_per_epoch}`,
    );
  }

  // ── Meter state transition (KHỚP validator paymaster.ak:142-144) ─────────────
  const newMap = addDid(
    baseMap as ReadonlyArray<readonly [string, bigint]>,
    didKey,
    lampThis,
  );
  const newMeter: SponsorMeterT = {
    app_id: meterIn.app_id,
    epoch: currentEpoch,
    did_lamp_map: newMap as DidLampEntryT[],
    global_lamp_epoch: baseGlobal + lampThis,
    global_magic_epoch: updateGlobalMagic(baseMagic, magicConsumed),
  };

  // ── Sponsor redeemer (Meter input) ──────────────────────────────────────────
  const vaultRefs: OutputReferenceT[] = vaultInputs.map((v) => utxoToRef(v.utxo));
  const sponsorRedeemerVal: PaymasterRedeemerT = {
    vault_refs: vaultRefs,
    policy_ref: utxoToRef(policyBeaconUtxo),
    protocol_ref: utxoToRef(protocolBeaconUtxo),
    did_key: didKey,
    lamp_this: lampThis,
    ada_this: adaThis,
  };
  const sponsorRedeemer = Data.to(
    sponsorRedeemerVal,
    PaymasterRedeemerSchema as unknown as PaymasterRedeemerT,
  );

  // ── Meter output: VALUE BẢO TOÀN tuyệt đối (copy nguyên assets — PM-11) ──────
  if ((meterUtxo.assets[meterNftUnit] ?? 0n) !== 1n) {
    throw new Error("PM-014: meter UTxO không mang đúng 1 thread NFT");
  }
  const meterOutAssets = { ...meterUtxo.assets };

  // ── dựng tx co-spend ────────────────────────────────────────────────────────
  let txBuilder = lucid
    .newTx()
    .collectFrom([meterUtxo], sponsorRedeemer)
    .attach.SpendingValidator(paymasterScript)
    .attach.SpendingValidator(vaultScript)
    .readFrom([policyBeaconUtxo, protocolBeaconUtxo]);

  // vault input(s) spend bằng BurnBatch (CBOR caller cung cấp) — DEDUP theo OutRef.
  const spentVault = new Set<string>();
  for (const v of vaultInputs) {
    const k = refKey(v.utxo);
    if (spentVault.has(k)) continue;
    spentVault.add(k);
    txBuilder = txBuilder.collectFrom([v.utxo], v.burnRedeemerCbor);
  }

  txBuilder = txBuilder
    .pay.ToAddressWithData(
      meterUtxo.address,
      { kind: "inline", value: encodeSponsorMeter(newMeter) },
      meterOutAssets,
    )
    // PM-1: app_authority (VerificationKeyHash hex) PHẢI ký (= delegate trigger BurnBatch).
    // addSignerKey nhận keyHash hex trực tiếp → ép vào extra_signatories (list.has on-chain).
    .addSignerKey(policy.app_authority)
    .validFrom(Number(lowerMs))
    .validTo(Number(upperMs));

  const tx = await txBuilder.complete();

  const summary =
    `sponsor did=${didKey.slice(0, 8)} | magic=${magicConsumed} ng | ` +
    `lamp_this=${lampThis} oildrop (cap ${lampCapVal}) | ada_this=${adaThis} lov (cap ${adaCapVal}) | ` +
    `epoch=${currentEpoch}${epochRollover ? " (reset)" : ""} | ` +
    `global ${baseGlobal}→${newMeter.global_lamp_epoch}`;

  return { tx, magicConsumed, lampThis, adaThis, currentEpoch, newMeter, summary };
}

// ── Submit helper ─────────────────────────────────────────────────────────────

/** Sign (ví app = app_authority) + submit. Trả tx hash. */
export async function signAndSubmit(tx: TxSignBuilder): Promise<string> {
  const signed = await tx.sign.withWallet().complete();
  return signed.submit();
}

export type { OutRef };
