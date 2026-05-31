// LampDistribution redeemBuilder — user redeem LAMP đã thắng (CLAIMED→LIQUID, SPEC §2).
//
// Input:
//   - ClaimAccount UTxO (của owner) — spend với Redeem redeemer (proof).
//   - Treasury UTxO (giữ LAMP pool) — spend với ReleaseForRedeem redeemer.
// Reference input:
//   - MerkleRoot beacon UTxO[lottery_epoch] (read-only, không spend).
// Output:
//   - ClaimAccount': redeemed_cumulative = won_cumulative; field khác bảo toàn.
//   - Treasury': LAMP giảm đúng `released`; committee_hash + dust bảo toàn.
//   - User: nhận đúng `released` LAMP.
//
// released = won_cumulative − redeemed_cumulative  (QĐ6 cumulative accounting).
//
// Invariants (SPEC §6):
//   C-RDM-1  Merkle proof hợp lệ cho leaf (owner, won_cumulative) vs MerkleRoot beacon.
//   C-RDM-2  won_cumulative > in.redeemed_cumulative (released > 0).
//   C-RDM-3  released = won − redeemed; user nhận đúng released LAMP.
//   C-RDM-4  out.redeemed_cumulative == won_cumulative; field khác unchanged.
//   C-RDM-5  won_cumulative ≤ in.claimed_cumulative.
//   C-RDM-6  owner signs.
//   C-RDM-7  đúng 1 ClaimAccount input + 1 output.
//   C-TRE-1  treasury release ≤ released; phần dư về treasury script.
//   C-TRE-2  treasury datum (committee_hash) bảo toàn.
//   C-MINT-0 tx.mint == 0.
//   C-VAL-0  mọi assets khác bảo toàn (audit dust lesson — không drop token nào).

import {
  Data, toUnit,
  credentialToAddress, scriptHashToCredential, validatorToScriptHash,
  type LucidEvolution, type UTxO, type Validator, type TxSignBuilder,
} from "@lucid-evolution/lucid";
import type { Network } from "@magiclamp/protocol-utils";

import type { ClaimAccountDatum, TreasuryDatum } from "./types.js";
import {
  decodeClaimAccountDatum, decodeBeaconDatum,
  claimAccountDatumToCbor, redeemRedeemerToCbor,
  decodeTreasuryDatum, treasuryDatumToCbor, treasuryRedeemerToCbor,
} from "./datum.js";
import { verifyClaim, buildMerkleTree, type MerkleLeafInput } from "./merkle.js";

const DEFAULT_LAMP_ASSET_NAME = "4c414d50"; // "LAMP"

/** Strip leading 0x + lowercase. */
function normHex(hex: string): string {
  return (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();
}

export interface RedeemParams {
  lucid:        LucidEvolution;
  network:      Network;

  /** ClaimAccount UTxO của owner (inline datum bắt buộc). */
  claimAccountUtxo: UTxO;
  claimScript:      Validator;

  /** Treasury UTxO giữ LAMP pool (inline datum bắt buộc). */
  treasuryUtxo:     UTxO;
  treasuryScript:   Validator;

  /**
   * MerkleRoot beacon UTxO cho lottery_epoch — dùng làm REFERENCE input.
   * Datum phải là BeaconDatum{kind: MerkleRoot, epoch: lottery_epoch}.
   */
  merkleBeaconUtxo: UTxO;

  /** won_cumulative (oil) từ lottery engine — committee công bố trong Merkle leaf. */
  wonCumulative:    bigint;
  /** Epoch lottery của Merkle root đang dùng (khớp beacon datum.epoch). */
  lotteryEpoch:     bigint;

  /**
   * Merkle proof (sibling hex list) cho leaf (owner, won_cumulative).
   * Lấy từ buildMerkleTree(...).proofs.get(owner) (foundation). Nếu bỏ trống,
   * builder tự dựng từ `lotteryLeaves` (toàn bộ leaf epoch đó) để trích proof.
   */
  proof?: string[];
  /** Toàn bộ leaf của lottery epoch (để builder tự dựng proof nếu `proof` trống). */
  lotteryLeaves?: MerkleLeafInput[];

  /** LAMP policy + asset-name. */
  lampPolicyId:   string;
  lampAssetName?: string;

  /** Nơi nhận LAMP redeem. Mặc định = ví owner (lucid wallet). */
  destinationAddress?: string;
}

export interface RedeemResult {
  tx:            TxSignBuilder;
  released:      bigint;
  newClaimDatum: ClaimAccountDatum;
  treasuryAfter: bigint;     // LAMP còn lại trên treasury output
  summary:       string;
}

export async function buildRedeemTx(params: RedeemParams): Promise<RedeemResult> {
  const {
    lucid, network, claimAccountUtxo, claimScript,
    treasuryUtxo, treasuryScript, merkleBeaconUtxo,
    wonCumulative, lotteryEpoch, lampPolicyId,
  } = params;
  const lampAssetName = params.lampAssetName ?? DEFAULT_LAMP_ASSET_NAME;
  const lampUnit = toUnit(lampPolicyId, lampAssetName);

  // ── Decode ClaimAccount datum ──────────────────────────────────────
  if (!claimAccountUtxo.datum) throw new Error("REDEEM-001: claimAccountUtxo has no inline datum");
  const claim = decodeClaimAccountDatum(Data.from(claimAccountUtxo.datum));
  const owner = normHex(claim.owner);

  // ── released = won − redeemed (QĐ6); C-RDM-2 / C-RDM-5 ─────────────
  const released = wonCumulative - claim.redeemed_cumulative;        // C-RDM-3
  if (released <= 0n) {
    throw new Error(
      `REDEEM-002: released ≤ 0 (won=${wonCumulative}, redeemed=${claim.redeemed_cumulative}). ` +
      `Double-redeem hoặc proof cũ.`,                                // C-RDM-2
    );
  }
  if (wonCumulative > claim.claimed_cumulative) {
    throw new Error(
      `REDEEM-003: won_cumulative ${wonCumulative} > claimed_cumulative ${claim.claimed_cumulative}`, // C-RDM-5
    );
  }

  // ── Resolve Merkle proof + verify against beacon root (C-RDM-1) ────
  if (!merkleBeaconUtxo.datum) throw new Error("REDEEM-004: merkleBeaconUtxo has no inline datum");
  const beacon = decodeBeaconDatum(Data.from(merkleBeaconUtxo.datum));
  if (beacon.kind !== "MerkleRoot") {
    throw new Error(`REDEEM-005: beacon kind must be MerkleRoot, got ${beacon.kind}`);
  }
  if (beacon.epoch !== lotteryEpoch) {
    throw new Error(`REDEEM-006: beacon epoch ${beacon.epoch} ≠ lotteryEpoch ${lotteryEpoch}`);
  }
  const rootHex = normHex(beacon.value);

  let proof = params.proof;
  if (!proof) {
    if (!params.lotteryLeaves) {
      throw new Error("REDEEM-007: cần `proof` hoặc `lotteryLeaves` để trích proof");
    }
    const tree = buildMerkleTree(params.lotteryLeaves);
    if (tree.rootHex !== rootHex) {
      throw new Error(
        `REDEEM-008: root từ lotteryLeaves (${tree.rootHex}) ≠ beacon root (${rootHex})`,
      );
    }
    const p = tree.proofs.get(owner);
    if (!p) throw new Error(`REDEEM-009: owner ${owner} không có trong lotteryLeaves`);
    proof = p;
  }

  if (!verifyClaim(rootHex, owner, wonCumulative, proof)) {
    throw new Error(
      `REDEEM-010: Merkle proof không hợp lệ cho (owner=${owner}, won=${wonCumulative}) ` +
      `vs root ${rootHex}`,                                          // C-RDM-1
    );
  }

  // ── Decode Treasury datum + đảm bảo đủ LAMP (C-TRE-1) ──────────────
  if (!treasuryUtxo.datum) throw new Error("REDEEM-011: treasuryUtxo has no inline datum");
  const treasury: TreasuryDatum = decodeTreasuryDatum(Data.from(treasuryUtxo.datum));
  const treasuryLamp = treasuryUtxo.assets[lampUnit] ?? 0n;
  if (treasuryLamp < released) {
    throw new Error(
      `REDEEM-012: treasury UTxO chỉ có ${treasuryLamp} oil LAMP < released ${released}. ` +
      `Chọn treasury UTxO khác hoặc tách (QĐ7).`,
    );
  }

  // ── Addresses ──────────────────────────────────────────────────────
  const claimAddress = credentialToAddress(
    network, scriptHashToCredential(validatorToScriptHash(claimScript)),
  );
  const treasuryAddress = credentialToAddress(
    network, scriptHashToCredential(validatorToScriptHash(treasuryScript)),
  );
  const destination = params.destinationAddress ?? (await lucid.wallet().address());

  // ── Output datums ──────────────────────────────────────────────────
  // ClaimAccount': redeemed = won; các field khác unchanged (C-RDM-4).
  const newClaimDatum: ClaimAccountDatum = {
    owner:               claim.owner,
    claimed_cumulative:  claim.claimed_cumulative,
    redeemed_cumulative: wonCumulative,             // C-RDM-4
    last_claim_epoch:    claim.last_claim_epoch,
  };
  // Treasury': datum bảo toàn (C-TRE-2).
  const newTreasuryDatum: TreasuryDatum = { committee_hash: treasury.committee_hash };

  // ── Output assets: bảo toàn TẤT CẢ (audit dust lesson, C-VAL-0) ────
  // ClaimAccount: chỉ datum đổi → clone toàn bộ assets.
  const claimOutAssets: Record<string, bigint> = { ...claimAccountUtxo.assets };

  // Treasury: clone toàn bộ rồi trừ đúng `released` LAMP (giữ lovelace + dust).
  const treasuryOutAssets: Record<string, bigint> = { ...treasuryUtxo.assets };
  const treasuryAfter = treasuryLamp - released;
  if (treasuryAfter > 0n) treasuryOutAssets[lampUnit] = treasuryAfter;
  else delete treasuryOutAssets[lampUnit];          // hết LAMP → bỏ unit, giữ lovelace+dust

  // ── Redeemers ──────────────────────────────────────────────────────
  const claimRedeemer    = redeemRedeemerToCbor(wonCumulative, lotteryEpoch, proof);
  const treasuryRedeemer = treasuryRedeemerToCbor();

  // ── Build tx ───────────────────────────────────────────────────────
  const tx = await lucid
    .newTx()
    .collectFrom([claimAccountUtxo], claimRedeemer)
    .attach.SpendingValidator(claimScript)
    .collectFrom([treasuryUtxo], treasuryRedeemer)
    .attach.SpendingValidator(treasuryScript)
    .readFrom([merkleBeaconUtxo])                   // reference input (read-only)
    .pay.ToAddressWithData(
      claimAddress,
      { kind: "inline", value: claimAccountDatumToCbor(newClaimDatum) },
      claimOutAssets,
    )
    .pay.ToAddressWithData(
      treasuryAddress,
      { kind: "inline", value: treasuryDatumToCbor(newTreasuryDatum) },
      treasuryOutAssets,
    )
    .pay.ToAddress(destination, { [lampUnit]: released })   // C-RDM-3: user nhận đúng released
    .addSignerKey(owner)                            // C-RDM-6: owner signs
    .complete();

  const summary = [
    `═══ Redeem ═══`,
    `Owner:          ${owner}`,
    `Won cumulative: ${wonCumulative} oil`,
    `Redeemed before:${claim.redeemed_cumulative} oil`,
    `Released:       ${released / 1_000_000n} LAMP (${released} oil)`,
    `Lottery epoch:  ${lotteryEpoch}`,
    `Treasury LAMP:  ${treasuryLamp} → ${treasuryAfter} oil`,
    `Destination:    ${destination}`,
    `Proof len:      ${proof.length}`,
  ].join("\n");

  return { tx, released, newClaimDatum, treasuryAfter, summary };
}
