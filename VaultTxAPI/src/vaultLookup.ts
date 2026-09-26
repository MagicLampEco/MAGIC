// VaultTxAPI/src/vaultLookup.ts — chọn UTxO vault làm INPUT. Sai ở đây là sai cả tx.
//
// ── VÌ SAO LỌC THEO `datum.owner` LÀ KHÔNG ĐỦ ──────────────────────────────────
// Địa chỉ script là công cộng: ai cũng đặt được một UTxO ở đó với datum tự soạn, khai
// `owner` là PKH của người khác và khai bao nhiêu MAGIC tuỳ thích. Validator từ chối
// đúng những UTxO ấy (`ScheduleGen/onchain/validators/vault.ak` ▸ `validate_vault_value`
// và ▸ `has_vault_id_nft`), nên bên dựng tx phải từ chối y hệt. Không từ chối thì ta
// dựng một giao dịch lấy input là rác của người lạ, người dùng ký, rồi chuỗi từ chối
// bằng một câu không nhắc gì tới NFT.
//
// Neo ở đây cố ý là TÊN HÀM, không phải số dòng — số dòng chết im lặng qua mỗi lần hoà.
//
// ── INV-VAULT-IDENTITY ─────────────────────────────────────────────────────────
// Vault nào cũng mang một NFT one-shot sinh cùng lúc với vault: `policy = chính script
// hash của vault`, `asset_name = blake2b_256(cbor(seed))`, số lượng 1.

import type { UTxO } from "@lucid-evolution/lucid";

import type { VaultScope } from "./config.js";
import {
  VaultAmbiguousError, VaultDatumUndecodableError, VaultIdentityDuplicateError, VaultNotFoundError,
} from "./errors.js";
import { decodeVaultDatumOrThrow, type DecodedVaultDatum } from "./vaultDatumShape.js";
import { sameOwner, type OwnerRef } from "@magiclamp/protocol-utils";

export interface FoundVault {
  utxo: UTxO;
  datum: DecodedVaultDatum;
  /** `policyId + assetNameHex` của NFT danh-tính. */
  vaultIdUnit: string;
  scope: VaultScope;
}

export interface IgnoredUtxo {
  utxoRef: string;
  reason: "NO_VAULT_ID_NFT" | "NO_INLINE_DATUM" | "OWNER_MISMATCH";
}

/**
 * Mọi vault hợp lệ của một chủ ở MỘT địa chỉ.
 *
 * UTxO bị bỏ được ĐẾM và khai ở `ignored` kèm lý do — đếm, không nuốt. Nhưng một UTxO
 * MANG NFT danh-tính mà datum không giải mã được thì NÉM: lúc đó lược đồ của kho đã
 * trôi khỏi thứ đang nằm trên chuỗi, và mọi giao dịch dựng tiếp đều dựng trên hiểu nhầm.
 */
export function findVaultsAtScope(
  utxos: UTxO[],
  scope: VaultScope,
  owner: OwnerRef,
): { vaults: FoundVault[]; ignored: IgnoredUtxo[] } {
  const vaults: FoundVault[] = [];
  const ignored: IgnoredUtxo[] = [];
  const byIdUnit = new Map<string, string[]>();

  for (const u of utxos) {
    const ref = `${u.txHash}#${u.outputIndex}`;
    const idUnit = vaultIdUnitOf(u, scope.scriptHash);
    if (idUnit === null) { ignored.push({ utxoRef: ref, reason: "NO_VAULT_ID_NFT" }); continue; }
    if (typeof u.datum !== "string" || u.datum === "") {
      ignored.push({ utxoRef: ref, reason: "NO_INLINE_DATUM" });
      continue;
    }

    let datum: DecodedVaultDatum;
    try {
      datum = decodeVaultDatumOrThrow(u.datum);
    } catch (e) {
      throw new VaultDatumUndecodableError(ref, (e as Error).message);
    }

    byIdUnit.set(idUnit, [...(byIdUnit.get(idUnit) ?? []), ref]);
    // So CẢ tag lẫn hash: két chủ-script cùng 28 byte với một pkh là chủ KHÁC.
    if (!sameOwner(datum.owner, owner)) { ignored.push({ utxoRef: ref, reason: "OWNER_MISMATCH" }); continue; }
    vaults.push({ utxo: u, datum, vaultIdUnit: idUnit, scope });
  }

  for (const [unit, refs] of byIdUnit) {
    if (refs.length > 1) throw new VaultIdentityDuplicateError(unit, refs);
  }

  return { vaults, ignored };
}

/**
 * ĐÚNG MỘT vault để làm input, hoặc ném.
 *
 * Không có → `VAULT_NOT_FOUND` (404). Nhiều hơn một → `VAULT_AMBIGUOUS` (409). Cả hai
 * đều là câu trả lời dứt khoát; không ca nào rơi vào một giá trị mặc định.
 */
export function pickSingleVault(found: FoundVault[], ownerLabel: string, vaultType: string, addresses: string[]): FoundVault {
  if (found.length === 0) throw new VaultNotFoundError(ownerLabel, addresses);
  if (found.length > 1) {
    throw new VaultAmbiguousError(ownerLabel, vaultType, found.map(f => `${f.utxo.txHash}#${f.utxo.outputIndex}`));
  }
  return found[0]!;
}

/**
 * NFT danh-tính của một UTxO, hoặc `null`.
 *
 * Yêu cầu ĐÚNG MỘT tài sản dưới policy bằng script hash của vault, số lượng đúng 1.
 * Hai tài sản dưới cùng policy trong một UTxO không phải "chọn cái đầu" — đó là một
 * UTxO không phải vault.
 */
export function vaultIdUnitOf(utxo: UTxO, vaultScriptHash: string): string | null {
  const hits = Object.entries(utxo.assets).filter(([unit]) => unit.startsWith(vaultScriptHash) && unit.length > vaultScriptHash.length);
  if (hits.length !== 1) return null;
  const [unit, qty] = hits[0]!;
  if (qty !== 1n) return null;
  return unit;
}
