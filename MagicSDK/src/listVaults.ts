// MagicSDK/src/listVaults.ts — discover all vaults owned by a given PKH.
//
// Cardano native: nhiều UTxO có thể nằm cùng 1 script address. Vault validator
// (`expect list.count(inputs at vault_addr) == 1`) chỉ chặn double-spend trong
// 1 tx — KHÔNG giới hạn "1 vault per owner". User có thể có N vault SnapshotGen,
// mỗi vault với 1 khoản LAMP khác nhau (ngắn / trung / dài hạn). Mỗi vault có
// tuổi loyalty độc lập → tiêu LAMP của vault ngắn hạn KHÔNG ảnh hưởng tới LF
// của vault dài hạn. Đây là feature có sẵn — không cần thay đổi onchain.

import { Data, type LucidEvolution, type UTxO } from "@lucid-evolution/lucid";
import { applyVaultValidator } from "./validatorScripts.js";
import { VaultDatumSchema, type VaultDatum } from "./schemas.js";
import type { ProtocolParams, ValidatorBundle, VaultType } from "./types.js";

export interface VaultRecord {
  /** Unique tx-level identifier: `<txHash>#<outputIndex>`. */
  vaultId:        string;
  /** The raw UTxO (for downstream tx builders). */
  utxo:           UTxO;
  /** Decoded datum. */
  datum:          VaultDatum;
  /** Network-derived vault address (same for all vaults of this type). */
  vaultAddress:   string;
  /** LAMP balance in oildrop (lamp_balance from datum). */
  lampBalanceOildrop: bigint;
  /** Oldest holding's acquired_epoch — lower bound on this vault's age. */
  oldestEpoch:    bigint;
  /** Profile of this vault. */
  profile:        VaultDatum["profile"];
}

export interface ListVaultsParams {
  lucid:      LucidEvolution;
  vaultType:  VaultType;
  protocol:   ProtocolParams;
  validators: ValidatorBundle;
  /** 28-byte hex PKH to filter by. Returns ONLY vaults whose datum.owner matches. */
  ownerPkh:   string;
}

/**
 * Query all vaults at the per-network vault address whose `datum.owner` matches
 * `ownerPkh`. Returns one entry per UTxO — a user can have multiple SnapshotGen
 * vaults (different time horizons / profiles), each independent.
 *
 * UX hint: sort by `oldestEpoch` ascending = oldest vault first = highest LF.
 * Caller can label them off-chain ("long-term" / "mid-term" / "short-term")
 * however they want.
 */
export async function listVaultsForOwner(params: ListVaultsParams): Promise<VaultRecord[]> {
  const { lucid, vaultType, protocol, validators, ownerPkh } = params;

  const { vaultAddress } = applyVaultValidator(vaultType, validators, protocol);

  const allUtxos = await lucid.utxosAt(vaultAddress);

  const records: VaultRecord[] = [];
  for (const u of allUtxos) {
    if (!u.datum) continue;   // skip UTxOs without inline datum (not our vault)
    let datum: VaultDatum;
    try {
      datum = Data.from(u.datum, VaultDatumSchema);
    } catch {
      continue;   // not a vault datum — skip
    }
    if (datum.owner !== ownerPkh) continue;

    const holdings = datum.loyalty_holdings as { amount: bigint; acquired_epoch: bigint; is_locked: boolean }[];
    const oldestEpoch = holdings.length === 0
      ? datum.last_updated_epoch
      : holdings.map(h => h.acquired_epoch).reduce((min, e) => e < min ? e : min);

    records.push({
      vaultId:        `${u.txHash}#${u.outputIndex}`,
      utxo:           u,
      datum,
      vaultAddress,
      lampBalanceOildrop: datum.lamp_balance,
      oldestEpoch,
      profile:        datum.profile,
    });
  }

  return records;
}
