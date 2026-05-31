// LampDistribution claimBuilder — committee 2/3 confirm → tạo/cập nhật ClaimAccount.
//
// State machine: EARNED → CLAIMED (SPEC §2). Committee xác nhận wallet `owner`
// đáng nhận `amount` oil → claimed_cumulative += amount, last_claim_epoch = current.
//
// Invariants (SPEC §6):
//   C-CLAIM-1  ≥ ⌈2N/3⌉ committee signatures.
//   C-CLAIM-2  out.claimed_cumulative = in.claimed_cumulative + amount; amount > 0.
//   C-CLAIM-3  out.owner == in.owner; redeemed_cumulative unchanged.
//   C-CLAIM-4  out.last_claim_epoch == current_epoch.
//   C-CLAIM-5  đúng 1 ClaimAccount input + 1 output cùng script (update path).
//   C-MINT-0   tx.mint == 0 (builder không gọi .mintAssets).
//   C-VAL-0    assets bảo toàn (lovelace + dust) — chỉ datum đổi, value giữ nguyên.
//
// 2 path:
//   (a) UPDATE: account đã tồn tại → spend ClaimAccount UTxO (Claim redeemer),
//       trả về output mới cùng script, bảo toàn toàn bộ assets.
//   (b) CREATE: account chưa có → chỉ pay.ToAddressWithData (không spend script),
//       initial datum {owner, claimed=amount, redeemed=0, last_claim_epoch=current}.

import {
  Data,
  credentialToAddress, scriptHashToCredential, validatorToScriptHash,
  type LucidEvolution, type UTxO, type Validator, type TxSignBuilder,
} from "@lucid-evolution/lucid";
import type { Network } from "@magiclamp/protocol-utils";

import type { ClaimAccountDatum } from "./types.js";
import {
  claimAccountDatumToCbor, claimRedeemerToCbor, decodeClaimAccountDatum,
} from "./datum.js";
import { assertCommitteeSigners } from "./committee.js";

export interface ClaimParams {
  lucid:        LucidEvolution;
  /** Applied claim_account validator (định nghĩa script address). */
  claimScript:  Validator;
  network:      Network;

  /** PKH chủ ví (hex 28-byte) được committee xác nhận. */
  ownerPkh:     string;
  /** Số oil claim thêm lần này (> 0). */
  amount:       bigint;
  /** Epoch hiện tại (committee tính off-chain từ validity range). */
  currentEpoch: bigint;

  /**
   * ClaimAccount UTxO hiện tại của owner (UPDATE path). Bỏ trống → CREATE path
   * (account đầu tiên cho owner này).
   */
  claimAccountUtxo?: UTxO;

  /** Min-ADA cho ClaimAccount UTxO mới (CREATE path). Mặc định 2 ADA. */
  accountLovelace?: bigint;

  /** Danh sách committee key-hash (hex). */
  committeeKeyHashes: string[];
  threshold?:        number;
  signerKeyHashes?:  string[];

  /**
   * POSIX ms cho lower_bound của validity_range (BẮT BUỘC để live tx hợp lệ).
   * Validator get_epoch đọc lower_bound.bound_type = Finite(s); epoch = s / ms_per_epoch
   * phải khớp `currentEpoch` (C-CLAIM-4). Truyền `currentEpoch * ms_per_epoch`.
   * Bỏ trống → KHÔNG set (chỉ dùng cho unit test off-chain; live sẽ fail get_epoch).
   */
  validFromMs?: bigint;
}

export interface ClaimResult {
  tx:              TxSignBuilder;
  claimAddress:    string;
  newDatum:        ClaimAccountDatum;
  mode:            "create" | "update";
  summary:         string;
}

const DEFAULT_ACCOUNT_LOVELACE = 2_000_000n;

/** Strip leading 0x + lowercase (so sánh owner). */
function normHex(hex: string): string {
  return (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();
}

export async function buildClaimTx(params: ClaimParams): Promise<ClaimResult> {
  const {
    lucid, claimScript, network, ownerPkh, amount, currentEpoch,
    claimAccountUtxo, committeeKeyHashes,
  } = params;

  if (amount <= 0n) throw new Error(`CLAIM-001: amount must be > 0 (got ${amount})`); // C-CLAIM-2

  const signers   = params.signerKeyHashes ?? committeeKeyHashes;
  const threshold = assertCommitteeSigners(committeeKeyHashes, signers, params.threshold); // C-CLAIM-1

  const claimAddress = credentialToAddress(
    network,
    scriptHashToCredential(validatorToScriptHash(claimScript)),
  );

  const owner = normHex(ownerPkh);

  let txb = lucid.newTx();
  let newDatum: ClaimAccountDatum;
  let mode: "create" | "update";
  let outAssets: Record<string, bigint>;

  if (claimAccountUtxo) {
    // ── UPDATE path ────────────────────────────────────────────────
    mode = "update";
    if (!claimAccountUtxo.datum) {
      throw new Error("CLAIM-002: claimAccountUtxo has no inline datum");
    }
    const prev = decodeClaimAccountDatum(Data.from(claimAccountUtxo.datum));

    if (normHex(prev.owner) !== owner) {
      throw new Error(
        `CLAIM-003: ownerPkh mismatch — datum owner ${prev.owner} ≠ ${owner}`, // C-CLAIM-3
      );
    }

    newDatum = {
      owner:               prev.owner,                         // C-CLAIM-3
      claimed_cumulative:  prev.claimed_cumulative + amount,   // C-CLAIM-2
      redeemed_cumulative: prev.redeemed_cumulative,           // C-CLAIM-3 (unchanged)
      last_claim_epoch:    currentEpoch,                       // C-CLAIM-4
    };

    // Bảo toàn TẤT CẢ assets (lovelace + bất kỳ dust) — chỉ datum đổi (C-VAL-0).
    outAssets = { ...claimAccountUtxo.assets };

    txb = txb
      .collectFrom([claimAccountUtxo], claimRedeemerToCbor(amount))
      .attach.SpendingValidator(claimScript);
  } else {
    // ── CREATE path ────────────────────────────────────────────────
    mode = "create";
    const accountLovelace = params.accountLovelace ?? DEFAULT_ACCOUNT_LOVELACE;
    newDatum = {
      owner,
      claimed_cumulative:  amount,
      redeemed_cumulative: 0n,
      last_claim_epoch:    currentEpoch,
    };
    outAssets = { lovelace: accountLovelace };
  }

  txb = txb.pay.ToAddressWithData(
    claimAddress,
    { kind: "inline", value: claimAccountDatumToCbor(newDatum) },
    outAssets,
  );

  for (const k of signers) txb = txb.addSignerKey(k);

  // validity_range lower_bound → validator get_epoch (C-CLAIM-4). Live tx bắt buộc.
  if (params.validFromMs !== undefined) {
    txb = txb.validFrom(Number(params.validFromMs));
  }

  const tx = await txb.complete();

  const summary = [
    `═══ Claim (${mode}) ═══`,
    `Owner:        ${owner}`,
    `Amount:       ${amount / 1_000_000n} LAMP (${amount} oil)`,
    `Claimed cum:  ${newDatum.claimed_cumulative} oil`,
    `Redeemed cum: ${newDatum.redeemed_cumulative} oil (unchanged)`,
    `Epoch:        ${currentEpoch}`,
    `Committee:    ${signers.length}/${committeeKeyHashes.length} signers (need ${threshold})`,
    `Claim addr:   ${claimAddress}`,
  ].join("\n");

  return { tx, claimAddress, newDatum, mode, summary };
}
