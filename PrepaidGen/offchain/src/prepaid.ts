// src/prepaid.ts — máy trạng thái PrepaidGen phía off-chain.
//
// Đây là bản mô phỏng ĐÚNG luật của validator (prepaid.ak): mỗi hàm dựng lại
// datum kết quả mà on-chain sẽ chấp nhận, và ném lỗi ở đúng những chỗ on-chain
// từ chối. Ví ứng dụng dựng giao dịch bằng các hàm này rồi mới ký — nhờ vậy
// không phải đoán validator sẽ nghĩ gì.
//
// BigInt tuyệt đối cho mọi số lượng (C-OVERFLOW).

import {
  BATCH_SOURCE_PREPAID,
  MAX_BATCHES_PER_VAULT,
  MAX_PREPAID_CREDITS,
  MIN_DRAW_CARPDROP,
  MIN_LOCK_CARPDROP,
  PREPAID_DECAY_WINDOW,
  PREPAID_PROFILE,
} from "./constants.js";
import {
  bufferFloor,
  claimCeiling,
  computeBatchId,
  outstandingOf,
  parCarpFromMagic,
  parMagicFromCarp,
} from "./math.js";
import { Data } from "@lucid-evolution/lucid";
import { AddressSchema } from "./types.js";
import type {
  MagicBatch,
  PaidFundDatum,
  PlutusAddress,
  PrepaidCredit,
  PrepaidVaultDatum,
} from "./types.js";

/** Lỗi mang mã bất biến C-PP-* để gọi ra đúng luật bị vi phạm. */
export class PrepaidRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "PrepaidRuleError";
  }
}

function reject(code: string, message: string): never {
  throw new PrepaidRuleError(code, message);
}

export interface OutRef {
  txHash: string;
  outputIndex: bigint;
}

// ══════════════════════════════════════════════════════════════
// PrepaidLock
// ══════════════════════════════════════════════════════════════

/**
 * Vault đã có dòng hạn-mức cho `fundId` chưa. Cùng vị từ `has_credit_line` bên
 * Aiken — dùng cho cả rẽ gộp/thêm lẫn cổng chữ ký C-PP-9.
 */
export function hasCreditLine(
  credits: readonly PrepaidCredit[],
  fundId: string,
): boolean {
  return credits.some((c) => c.fund_id === fundId);
}

/**
 * C-PP-9 (siết 2026-09-26): pkh BẮT BUỘC có trong `extra_signatories` của một
 * lượt `PrepaidLock`. Builder gọi hàm này rồi `addSignerKey` đúng giá trị trả về.
 *
 *   · MỞ DÒNG MỚI (vault chưa có dòng cho `fundId`) ⟹ CHỈ `owner`. Gọi với
 *     `by = "platform"` ở ca này là NÉM — không lặng lẽ đổi sang owner, vì người
 *     gọi đang dựng một giao dịch mà khoá họ cầm không ký được.
 *   · NẠP THÊM vào dòng đã có ⟹ `platform` (app khoá hộ) hoặc `owner`.
 */
export function lockRequiredSigner(
  vault: PrepaidVaultDatum,
  fund: PaidFundDatum,
  fundId: string,
  by: "owner" | "platform",
): string {
  const opensNewLine = !hasCreditLine(vault.prepaid_credits, fundId);
  if (by === "owner") return vault.owner;
  if (opensNewLine) {
    reject(
      "C-PP-9",
      `lượt khoá MỞ DÒNG MỚI cho quỹ ${fundId} cần chữ ký owner ${vault.owner}; ` +
        `chữ ký platform chỉ đủ khi nạp thêm vào dòng đã có`,
    );
  }
  return fund.platform;
}

/** Hạn-mức sau khi khoá thêm `amount` vào quỹ `fundId` (C-PP-12). */
export function creditsAfterLock(
  credits: readonly PrepaidCredit[],
  fundId: string,
  amount: bigint,
  epoch: bigint,
): PrepaidCredit[] {
  if (amount < MIN_LOCK_CARPDROP) {
    reject("C-PP-12", `khoá ${amount} < sàn ${MIN_LOCK_CARPDROP} carpdrop`);
  }
  const hits = credits.filter((c) => c.fund_id === fundId);
  if (hits.length > 1) reject("C-PP-2", `hạn-mức trùng cho quỹ ${fundId}`);
  if (hits.length === 1) {
    return credits.map((c) =>
      c.fund_id === fundId ? { ...c, remaining: c.remaining + amount } : c,
    );
  }
  const next: PrepaidCredit[] = [
    ...credits,
    {
      fund_id: fundId,
      remaining: amount,
      issued_epoch: epoch,
      last_draw_epoch: epoch,
    },
  ];
  if (next.length > MAX_PREPAID_CREDITS) {
    reject("C-PP-12", `vượt trần ${MAX_PREPAID_CREDITS} quỹ / vault`);
  }
  return next;
}

/** Sổ quỹ sau khi nhận thêm `amount` CARP thật (C-PP-2, C-PP-3). */
export function fundAfterLock(
  fund: PaidFundDatum,
  amount: bigint,
  epoch: bigint,
): PaidFundDatum {
  if (amount < MIN_LOCK_CARPDROP) {
    reject("C-PP-12", `khoá ${amount} < sàn ${MIN_LOCK_CARPDROP} carpdrop`);
  }
  return {
    ...fund,
    carp_locked: fund.carp_locked + amount,
    credit_issued: fund.credit_issued + amount,
    last_updated_epoch: epoch,
  };
}

// ══════════════════════════════════════════════════════════════
// PrepaidDraw
// ══════════════════════════════════════════════════════════════

/**
 * Rút hạn-mức thành một `MagicBatch` của epoch hiện tại (par 1:1, cliff = 1).
 * `ownRef` là UTxO vault đang tiêu — batch_id dẫn xuất từ nó, y hệt on-chain.
 */
export function drawMagic(
  vault: PrepaidVaultDatum,
  fundId: string,
  amount: bigint,
  epoch: bigint,
  ownRef: OutRef,
): PrepaidVaultDatum {
  if (amount < MIN_DRAW_CARPDROP) {
    reject("C-PP-12", `rút ${amount} < sàn ${MIN_DRAW_CARPDROP} carpdrop`);
  }
  const hits = vault.prepaid_credits.filter((c) => c.fund_id === fundId);
  if (hits.length !== 1) {
    reject("C-PP-2", `không có hạn-mức nào cho quỹ ${fundId} — sinh MAGIC từ hư không`);
  }
  const credit = hits[0]!;
  if (amount > credit.remaining) {
    reject("C-PP-2", `rút ${amount} > hạn-mức còn lại ${credit.remaining}`);
  }

  const credits = vault.prepaid_credits.map((c) =>
    c.fund_id === fundId
      ? { ...c, remaining: c.remaining - amount, last_draw_epoch: epoch }
      : c,
  );

  const batch: MagicBatch = {
    batch_id: computeBatchId(ownRef.txHash, ownRef.outputIndex, vault.next_batch_index),
    source: BATCH_SOURCE_PREPAID,
    created_epoch: epoch,
    current_amount: parMagicFromCarp(amount), // C-PP-1
    decay_window: PREPAID_DECAY_WINDOW, // C-PP-5
    profile_at_creation: PREPAID_PROFILE,
    contract_id: fundId,
  };

  const batches = [...vault.magic_batches, batch];
  if (batches.length > MAX_BATCHES_PER_VAULT) {
    reject("C-PP-12", `vượt trần ${MAX_BATCHES_PER_VAULT} batch / vault`);
  }

  return {
    ...vault,
    prepaid_credits: credits,
    magic_batches: batches,
    next_batch_index: vault.next_batch_index + 1n,
    last_updated_epoch: epoch,
  };
}

// ══════════════════════════════════════════════════════════════
// BurnBatch
// ══════════════════════════════════════════════════════════════

/** Tiêu MAGIC dạng kế toán. Batch của epoch đã chết KHÔNG tiêu được (C-PP-5). */
export function burnBatches(
  vault: PrepaidVaultDatum,
  burns: readonly (readonly [string, bigint])[],
  epoch: bigint,
): PrepaidVaultDatum {
  if (burns.length === 0) reject("C-PP-9", "danh sách burns rỗng");

  let batches: MagicBatch[] = [...vault.magic_batches];
  for (const [batchId, amount] of burns) {
    if (amount <= 0n) reject("C-PP-9", `lượng tiêu ${amount} phải > 0`);
    const hits = batches.filter((b) => b.batch_id === batchId);
    if (hits.length !== 1) reject("C-PP-9", `không tìm thấy batch ${batchId}`);
    const target = hits[0]!;
    if (target.created_epoch !== epoch) {
      reject(
        "C-PP-5",
        `batch ${batchId} sinh ở epoch ${target.created_epoch}, epoch hiện tại ${epoch} — đã chết`,
      );
    }
    if (amount > target.current_amount) {
      reject("C-PP-9", `tiêu ${amount} > số dư batch ${target.current_amount}`);
    }
    const left = target.current_amount - amount;
    batches = batches.flatMap((b) => {
      if (b.batch_id !== batchId) return [b];
      return left === 0n ? [] : [{ ...b, current_amount: left }];
    });
  }

  return {
    ...vault,
    magic_batches: batches,
    last_updated_epoch: epoch,
    attribution: {
      ...vault.attribution,
      last_event_epoch: epoch,
      total_events: vault.attribution.total_events + 1n,
    },
  };
}

// ══════════════════════════════════════════════════════════════
// PrunePrepaid
// ══════════════════════════════════════════════════════════════

/**
 * Dọn batch chết và TRẢ LẠI hạn-mức tương ứng (DESIGN.md §1.3).
 * Không có gì để dọn → từ chối (reject-noop, §7.4).
 */
export function pruneExpired(
  vault: PrepaidVaultDatum,
  epoch: bigint,
): PrepaidVaultDatum {
  const dead = vault.magic_batches.filter((b) => b.created_epoch < epoch);
  const live = vault.magic_batches.filter((b) => b.created_epoch >= epoch);
  if (dead.length === 0) reject("C-PP-9", "không có batch chết để dọn (noop)");

  let credits: PrepaidCredit[] = [...vault.prepaid_credits];
  for (const b of dead) {
    if (b.source !== BATCH_SOURCE_PREPAID) {
      reject("C-PP-7", `batch ${b.batch_id} không phải nguồn Prepaid`);
    }
    const hits = credits.filter((c) => c.fund_id === b.contract_id);
    if (hits.length !== 1) {
      reject("C-PP-2", `không có dòng hạn-mức cho quỹ ${b.contract_id}`);
    }
    const back = parCarpFromMagic(b.current_amount);
    credits = credits.map((c) =>
      c.fund_id === b.contract_id ? { ...c, remaining: c.remaining + back } : c,
    );
  }

  return {
    ...vault,
    prepaid_credits: credits,
    magic_batches: live,
    last_updated_epoch: epoch,
  };
}

// ══════════════════════════════════════════════════════════════
// FundSettle
// ══════════════════════════════════════════════════════════════

/**
 * Σ phần `current_amount` GIẢM trên các batch của đúng quỹ này và CÒN SỐNG.
 * Batch hết hạn không bao giờ được tính — INV-MAGIC-CITIZEN (C-PP-7).
 */
export function settleDelta(
  vaultIn: PrepaidVaultDatum,
  vaultOut: PrepaidVaultDatum,
  fundId: string,
  epoch: bigint,
): bigint {
  let acc = 0n;
  for (const b of vaultIn.magic_batches) {
    const relevant =
      b.contract_id === fundId &&
      b.source === BATCH_SOURCE_PREPAID &&
      b.created_epoch === epoch;
    if (!relevant) continue;
    const after = vaultOut.magic_batches.find((o) => o.batch_id === b.batch_id);
    const left = after ? after.current_amount : 0n;
    if (left > b.current_amount) {
      reject("C-PP-7", `batch ${b.batch_id} tăng số dư khi tiêu — không hợp lệ`);
    }
    acc += b.current_amount - left;
  }
  return acc;
}

export function fundAfterSettle(
  fund: PaidFundDatum,
  delta: bigint,
  epoch: bigint,
): PaidFundDatum {
  if (delta <= 0n) reject("C-PP-7", "không có MAGIC nào được tiêu thật để quyết toán");
  const next: PaidFundDatum = {
    ...fund,
    magic_settled: fund.magic_settled + delta,
    last_updated_epoch: epoch,
  };
  if (parCarpFromMagic(next.magic_settled) > next.credit_issued) {
    reject("C-PP-7", "quyết toán vượt tổng hạn-mức đã cấp");
  }
  return next;
}

// ══════════════════════════════════════════════════════════════
// FundClaim (C-PP-6 = F2)
// ══════════════════════════════════════════════════════════════

/** Số CARP tối đa provider rút được ngay bây giờ (0 nếu chưa được gì). */
export function maxClaimable(fund: PaidFundDatum): bigint {
  const byF2 = claimCeiling(fund.magic_settled, fund.provider_claimed);
  const outstanding = outstandingOf(fund.credit_issued, fund.magic_settled);
  const byBuffer = fund.carp_locked - bufferFloor(outstanding, fund.buffer_bps);
  const cap = byF2 < byBuffer ? byF2 : byBuffer;
  return cap > 0n ? cap : 0n;
}

export function fundAfterClaim(
  fund: PaidFundDatum,
  amount: bigint,
  epoch: bigint,
): PaidFundDatum {
  if (amount <= 0n) reject("C-PP-6", `lượng rút ${amount} phải > 0`);
  const next: PaidFundDatum = {
    ...fund,
    carp_locked: fund.carp_locked - amount,
    provider_claimed: fund.provider_claimed + amount,
    last_updated_epoch: epoch,
  };
  if (next.provider_claimed > parCarpFromMagic(next.magic_settled)) {
    reject("C-PP-6", "rút quá phần MAGIC đã tiêu thật (F2)");
  }
  const outstanding = outstandingOf(next.credit_issued, next.magic_settled);
  const floor = bufferFloor(outstanding, next.buffer_bps);
  if (next.carp_locked < floor) {
    reject("C-PP-6", `còn ${next.carp_locked} CARP < sàn đệm buffer-Paid ${floor}`);
  }
  assertFundInvariant(next);
  return next;
}

/** C-PP-3: carp_locked == credit_issued − provider_claimed, luôn đúng. */
export function assertFundInvariant(fund: PaidFundDatum): void {
  const expected = fund.credit_issued - fund.provider_claimed;
  if (fund.carp_locked !== expected) {
    reject(
      "C-PP-3",
      `carp_locked ${fund.carp_locked} ≠ credit_issued − provider_claimed ${expected}`,
    );
  }
}

/** Tổng MAGIC còn sống của một vault ở epoch cho trước (nanogic). */
export function liveMagic(vault: PrepaidVaultDatum, epoch: bigint): bigint {
  return vault.magic_batches
    .filter((b) => b.created_epoch === epoch)
    .reduce((acc, b) => acc + b.current_amount, 0n);
}

// ══════════════════════════════════════════════════════════════
// Đích nhận CARP của FundClaim (L1'', 2026-09-26)
// ══════════════════════════════════════════════════════════════

const HASH28_HEX = /^[0-9a-f]{56}$/;

function addressKey(a: PlutusAddress): string {
  return Data.to(a, AddressSchema as unknown as PlutusAddress);
}

function credentialHash(a: PlutusAddress): { kind: "Key" | "Script"; hash: string } {
  const pc = a.payment_credential;
  if ("VerificationKey" in pc) return { kind: "Key", hash: pc.VerificationKey[0] };
  return { kind: "Script", hash: pc.Script[0] };
}

/**
 * Gương cổng genesis quỹ (`validate_mint_fund_nft`) cho phần L1''. Trả về danh
 * sách pkh BẮT BUỘC ký giao dịch genesis (hiện là `[platform]`). Ném ở đúng những
 * chỗ on-chain từ chối — builder gọi trước khi dựng tx để chết ở chỗ rẻ nhất.
 *
 * `fundScriptHash` = script hash của `paid_fund` đã apply (= policy NFT quỹ).
 */
export function assertFundGenesis(
  fund: PaidFundDatum,
  fundScriptHash: string,
): string[] {
  if (!HASH28_HEX.test(fund.platform)) {
    reject("C-PP-15", `platform phải là pkh 28 byte, nhận "${fund.platform}"`);
  }
  if (!HASH28_HEX.test(fund.vault_hash)) {
    reject("C-PP-15", `vault_hash phải là script hash 28 byte, nhận "${fund.vault_hash}"`);
  }
  const ben = fund.beneficiary;
  if (ben.stake_credential !== null) {
    reject("C-PP-15", "beneficiary không được mang stake credential (claim so địa chỉ đầy đủ)");
  }
  const { kind, hash } = credentialHash(ben);
  if (!HASH28_HEX.test(hash)) {
    reject("C-PP-15", `hash của beneficiary phải 28 byte, nhận "${hash}"`);
  }
  if (kind === "Script" && hash === fundScriptHash) {
    reject("C-PP-15", "beneficiary trùng script quỹ — mọi claim chết, CARP kẹt");
  }
  if (kind === "Script" && hash === fund.vault_hash) {
    reject("C-PP-15", "beneficiary trùng script vault — output không NFT vault, CARP chết");
  }
  if (kind === "Script" && fund.beneficiary_datum === null) {
    reject(
      "C-PP-15",
      "beneficiary là script thì BẮT BUỘC ghim beneficiary_datum (rót đúng địa chỉ ≠ rót vào sổ)",
    );
  }
  return [fund.platform];
}

/** Hình dạng output tới bên hưởng mà `validate_fund_claim` đòi. */
export interface BeneficiaryPayout {
  address: PlutusAddress;
  paymentCredential: { kind: "Key" | "Script"; hash: string };
  carp: bigint;
  /** CBOR hex của inline datum; `null` ⟹ output KHÔNG datum. */
  inlineDatumCbor: string | null;
}

/**
 * Output DUY NHẤT tới bên hưởng cho một lượt `FundClaim { amount }`. Builder đặt
 * đúng `carp` CARP (cộng min-ADA), đúng datum, ở địa chỉ enterprise của
 * `paymentCredential` — và KHÔNG tiêu input nào ở địa chỉ đó (phí + tiền thừa đi
 * từ địa chỉ khác, vd địa chỉ base của cùng khoá).
 */
export function claimBeneficiaryOutput(
  fund: PaidFundDatum,
  amount: bigint,
): BeneficiaryPayout {
  if (amount <= 0n) reject("C-PP-6", `lượng rút ${amount} phải > 0`);
  return {
    address: fund.beneficiary,
    paymentCredential: credentialHash(fund.beneficiary),
    carp: amount,
    inlineDatumCbor:
      fund.beneficiary_datum === null ? null : Data.to(fund.beneficiary_datum),
  };
}

/** Một output của tx claim, dạng đủ để đối chiếu cổng đích. */
export interface ClaimOutputView {
  address: PlutusAddress;
  carp: bigint;
  inlineDatumCbor: string | null;
}

/**
 * Gương cổng đích của `validate_fund_claim`: không input tại bên hưởng · đúng MỘT
 * output tại bên hưởng · CARP == amount · datum khớp. So địa chỉ ĐẦY ĐỦ.
 */
export function assertClaimDestination(
  fund: PaidFundDatum,
  amount: bigint,
  inputAddresses: readonly PlutusAddress[],
  outputs: readonly ClaimOutputView[],
): void {
  const ben = addressKey(fund.beneficiary);
  if (inputAddresses.some((a) => addressKey(a) === ben)) {
    reject("C-PP-6", "tx claim có input tại beneficiary — phí/tiền thừa phải đi từ địa chỉ khác");
  }
  const hits = outputs.filter((o) => addressKey(o.address) === ben);
  if (hits.length !== 1) {
    reject("C-PP-6", `cần ĐÚNG MỘT output tại beneficiary, có ${hits.length}`);
  }
  const paid = hits[0]!;
  if (paid.carp !== amount) {
    reject("C-PP-6", `output tới beneficiary mang ${paid.carp} CARP ≠ amount ${amount}`);
  }
  const want =
    fund.beneficiary_datum === null ? null : Data.to(fund.beneficiary_datum);
  if (paid.inlineDatumCbor !== want) {
    reject("C-PP-6", "datum output tới beneficiary không khớp beneficiary_datum đã ghim");
  }
}
