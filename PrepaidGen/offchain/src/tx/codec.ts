// src/tx/codec.ts — mã hoá datum/redeemer và đọc UTxO vault/quỹ cho bộ dựng.
//
// Mọi hàm đọc ở đây NÉM khi hình dạng lạ (thiếu inline datum, sai lược đồ, sai
// địa chỉ, thiếu/thừa NFT). Không có giá trị đệm: một vault đọc hỏng mà trả về
// datum rỗng thì builder dựng ra một tx "hợp lệ" trông có lý và chết trên chuỗi.

import { Constr, Data, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";
import {
  PaidFundDatumSchema,
  PaidFundRedeemerSchema,
  PrepaidVaultDatumSchema,
  PrepaidVaultRedeemerSchema,
  type PaidFundDatum,
  type PaidFundRedeemer,
  type PrepaidVaultDatum,
  type PrepaidVaultRedeemer,
} from "../types.js";
import type { PrepaidScripts } from "./scripts.js";

export class PrepaidTxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "PrepaidTxError";
  }
}

function fail(code: string, message: string): never {
  throw new PrepaidTxError(code, message);
}

const HEX64 = /^[0-9a-f]{64}$/;

// ── datum ────────────────────────────────────────────────────

export function encodeVaultDatum(d: PrepaidVaultDatum): string {
  return Data.to(d, PrepaidVaultDatumSchema as unknown as PrepaidVaultDatum);
}

export function decodeVaultDatum(cbor: string): PrepaidVaultDatum {
  return Data.from(cbor, PrepaidVaultDatumSchema as unknown as PrepaidVaultDatum);
}

/**
 * Plutus Data ↔ CBOR bằng ĐÚNG bản `@lucid-evolution/lucid` của gói này. Bên gọi nạp gói qua `file:` thì giữ
 * `node_modules` riêng, tức một bản lucid KHÁC: `Constr` dựng ở bên gọi không phải `Constr` ở đây, và `Data.to`
 * của gói này ném "Unsupported type" khi gặp nó (đo 2026-10-07, VaultTxAPI). Datum tự do đi VÀO bộ dựng (vd.
 * `beneficiaryDatum` của `planMintPaidFund`) phải dựng bằng `plutusDataFromCbor`; datum đọc RA từ `decodeFundDatum`
 * phải mã hoá lại bằng `plutusDataToCbor`.
 */
export function plutusDataFromCbor(cbor: string): Data {
  return Data.from(cbor);
}

export function plutusDataToCbor(d: Data): string {
  return Data.to(d);
}

export function encodeFundDatum(d: PaidFundDatum): string {
  return Data.to(d, PaidFundDatumSchema as unknown as PaidFundDatum);
}

export function decodeFundDatum(cbor: string): PaidFundDatum {
  return Data.from(cbor, PaidFundDatumSchema as unknown as PaidFundDatum);
}

// ── redeemer ─────────────────────────────────────────────────

function vaultRedeemer(r: PrepaidVaultRedeemer): string {
  return Data.to(r, PrepaidVaultRedeemerSchema as unknown as PrepaidVaultRedeemer);
}

function fundRedeemer(r: PaidFundRedeemer): string {
  return Data.to(r, PaidFundRedeemerSchema as unknown as PaidFundRedeemer);
}

export const lockRedeemer = (fundId: string, amount: bigint): string =>
  vaultRedeemer({ PrepaidLock: { fund_id: fundId, amount_carpdrop: amount } });
export const drawRedeemer = (fundId: string, amount: bigint): string =>
  vaultRedeemer({ PrepaidDraw: { fund_id: fundId, amount_carpdrop: amount } });
export const burnBatchRedeemer = (burns: readonly (readonly [string, bigint])[]): string =>
  vaultRedeemer({ BurnBatch: { burns: burns.map(([b, a]) => [b, a] as [string, bigint]) } });
/** `SetDidCommit { did_commit }` — constr 5, gắn PersonDID MỘT LẦN (`validate_set_did_commit`). */
export const setDidCommitRedeemer = (didCommit: string): string =>
  vaultRedeemer({ SetDidCommit: { did_commit: didCommit } });
export const settleLineRedeemer = (fundId: string): string =>
  vaultRedeemer({ SettleLine: { fund_id: fundId } });
/** `CloseSponsoredLine { fund_id }` — constr 7, thẻ CBOR 1280 ⟹ tiền tố `d90500`. */
export const closeSponsoredLineRedeemer = (fundId: string): string =>
  vaultRedeemer({ CloseSponsoredLine: { fund_id: fundId } });
export const fundLockRedeemer = (): string => fundRedeemer("FundLock");
export const fundSettleRedeemer = (): string => fundRedeemer("FundSettle");
export const fundClaimRedeemer = (amount: bigint): string =>
  fundRedeemer({ FundClaim: { amount_carpdrop: amount } });
/** `FundReclaim` — constr 3, không trường (lượng suy từ datum). CBOR `d87c80`. */
export const fundReclaimRedeemer = (): string => fundRedeemer("FundReclaim");
/** Redeemer `mint` khi đốt NFT quỹ ở nhánh đóng — handler không đọc, dùng `Constr 0 []`. */
export const FUND_BURN_REDEEMER = Data.to(new Constr(0, []));

/** Redeemer `mint` của `paid_fund` — handler nhận `Data` bất kỳ; dùng `Constr 0 []`. */
export const FUND_MINT_REDEEMER = Data.to(new Constr(0, []));

// ── NFT định danh vault ──────────────────────────────────────

export interface SeedRef {
  txHash: string;
  outputIndex: number | bigint;
}

function normSeed(seed: SeedRef): { txHash: string; index: bigint } {
  const txHash = typeof seed.txHash === "string" ? seed.txHash.toLowerCase() : "";
  if (!HEX64.test(txHash)) fail("C-PP-SEED", `seed.txHash phải là 32 byte hex, nhận "${seed.txHash}"`);
  const index = BigInt(seed.outputIndex);
  if (index < 0n) fail("C-PP-SEED", `seed.outputIndex âm: ${index}`);
  return { txHash, index };
}

/** Gương `vault_id_name`: `blake2b_256(cbor.serialise(OutputReference))` — CBOR của CẢ constr, không phải tx hash trần. */
export function vaultIdAssetName(seed: SeedRef): string {
  const { txHash, index } = normSeed(seed);
  const cbor = Data.to(new Constr(0, [txHash, index]));
  return Buffer.from(blake2b(Buffer.from(cbor, "hex"), { dkLen: 32 })).toString("hex");
}

/** Redeemer `MintVaultId { seed }` (constr 0, trường là OutputReference phẳng V3). */
export function mintVaultIdRedeemer(seed: SeedRef): string {
  const { txHash, index } = normSeed(seed);
  return Data.to(new Constr(0, [new Constr(0, [txHash, index])]));
}

// ── đọc UTxO ─────────────────────────────────────────────────

function paymentScriptHash(address: string): string | null {
  const c = getAddressDetails(address).paymentCredential;
  return c?.type === "Script" ? c.hash : null;
}

function inlineDatum(u: UTxO, what: string): string {
  if (typeof u.datum !== "string" || u.datum.length === 0) {
    fail(
      "C-PP-SHAPE",
      `${what} ${u.txHash}#${u.outputIndex} không mang inline datum` +
        (u.datumHash ? ` (chỉ có datum hash ${u.datumHash})` : "") +
        ` — validator đọc InlineDatum, UTxO này không tiêu được bằng nhánh nào.`,
    );
  }
  return u.datum;
}

function tokensUnder(u: UTxO, policy: string): Array<[string, bigint]> {
  return Object.entries(u.assets)
    .filter(([unit]) => unit !== "lovelace" && unit.startsWith(policy))
    .map(([unit, q]) => [unit.slice(policy.length), q]);
}

export interface VaultView {
  utxo: UTxO;
  datum: PrepaidVaultDatum;
  /** `vault_hash ‖ tên NFT` */
  nftUnit: string;
}

/**
 * Đọc một UTxO vault: phải ở script vault, mang ĐÚNG MỘT token dưới policy vault
 * (số lượng 1), inline datum đúng lược đồ, KHÔNG mang CARP. Gương
 * `vault_identity_preserved` + `decode_vault`.
 */
export function readVaultUtxo(scripts: PrepaidScripts, u: UTxO): VaultView {
  if (paymentScriptHash(u.address) !== scripts.vault.hash) {
    fail("C-PP-SHAPE", `UTxO ${u.txHash}#${u.outputIndex} không ở script vault ${scripts.vault.hash}`);
  }
  const nfts = tokensUnder(u, scripts.vault.hash);
  if (nfts.length !== 1 || nfts[0]![1] !== 1n) {
    fail(
      "INV-VAULT-IDENTITY",
      `UTxO ${u.txHash}#${u.outputIndex} mang ${nfts.length} tên dưới policy vault (cần đúng 1 NFT số lượng 1) — vault giả hoặc đã hỏng`,
    );
  }
  if ((u.assets[scripts.carpUnit] ?? 0n) !== 0n) {
    fail("C-PP-SHAPE", `UTxO vault ${u.txHash}#${u.outputIndex} mang CARP — mọi nhánh ép CARP tại vault == 0`);
  }
  if (u.scriptRef) fail("C-PP-SHAPE", `UTxO vault ${u.txHash}#${u.outputIndex} mang reference script`);
  const datum = decodeVaultDatum(inlineDatum(u, "UTxO vault"));
  return { utxo: u, datum, nftUnit: scripts.vault.hash + nfts[0]![0] };
}

export interface FundView {
  utxo: UTxO;
  datum: PaidFundDatum;
  fundId: string;
  nftUnit: string;
  carp: bigint;
}

/**
 * Đọc một UTxO quỹ: ở script `paid_fund`, mang NFT `paid_fund_hash ‖ fund_id` (đúng
 * 1, và là tên DUY NHẤT dưới policy quỹ), CARP thật == `carp_locked`, và quỹ trỏ về
 * ĐÚNG script vault của bộ script này.
 */
export function readFundUtxo(scripts: PrepaidScripts, u: UTxO): FundView {
  if (paymentScriptHash(u.address) !== scripts.paidFund.hash) {
    fail("C-PP-SHAPE", `UTxO ${u.txHash}#${u.outputIndex} không ở script paid_fund ${scripts.paidFund.hash}`);
  }
  const datum = decodeFundDatum(inlineDatum(u, "UTxO quỹ"));
  const nfts = tokensUnder(u, scripts.paidFund.hash);
  if (nfts.length !== 1 || nfts[0]![0] !== datum.fund_id || nfts[0]![1] !== 1n) {
    fail("C-PP-10", `UTxO quỹ ${u.txHash}#${u.outputIndex} không mang đúng một NFT tên fund_id ${datum.fund_id}`);
  }
  if (datum.vault_hash !== scripts.vault.hash) {
    fail(
      "C-PP-SHAPE",
      `quỹ ${datum.fund_id} trỏ vault ${datum.vault_hash}, bộ script đang dùng vault ${scripts.vault.hash}`,
    );
  }
  const carp = u.assets[scripts.carpUnit] ?? 0n;
  if (carp !== datum.carp_locked) {
    fail("C-PP-3", `quỹ ${datum.fund_id}: CARP thật ${carp} ≠ carp_locked ${datum.carp_locked}`);
  }
  return { utxo: u, datum, fundId: datum.fund_id, nftUnit: scripts.paidFund.hash + datum.fund_id, carp };
}
