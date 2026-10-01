// tests/instantFixtures.ts — bối cảnh dùng chung cho bài kiểm két InstantGen Gen v2.0
// (`instantGates.test.ts` chạy hàm thuần, `instantTxWindow.test.ts` chạy bộ dựng thật trên
// Lucid giả). Không phải tệp kiểm — vitest chỉ nạp `*.test.ts`.
//
// Mặc định dựng một két ĐÃ làm mới checkpoint trong epoch `E` (`cap_epoch == E`) ⟹ lượt
// sinh không đọc ρ, không đọc két Wakeme. Bốn trần của lượt sinh mặc định khác nhau để
// bài kiểm biết trần nào đang ràng buộc:
//   cap_nanogic 1e12 · trần LAMP 4·L_avail = 4e11 · shard còn 1e13 · phần GB mỗi két 5e11.

import {
  Data, Constr, credentialToAddress, validatorToScriptHash, type UTxO,
} from "@lucid-evolution/lucid";
import { msPerEpoch } from "@magiclamp/protocol-utils";
import {
  VaultDatum, GbShard, GreenBackBeacon, RateParam, VaultRegistry,
  type VaultDatum as TVaultDatum,
  type GbShard as TGbShard,
  type GreenBackBeacon as TGreenBackBeacon,
  type RateParam as TRateParam,
  type MagicBatch,
} from "../offchain/src/types.js";
import type { InstantVaultParams } from "../offchain/src/vaultScript.js";
import type { InstantGenContext } from "../offchain/src/instant.js";
import { shardNftName, vaultShardId } from "../offchain/src/greenback.js";
import {
  RATE_NFT_NAME, GREENBACK_NFT_NAME, VAULT_REGISTRY_NFT_NAME,
} from "../offchain/src/constants.js";

export const NETWORK = "Preprod" as const;
export const P       = msPerEpoch(NETWORK);          // 432_000_000 ms
export const E       = 100n;
export const SLOT    = 1_000n;

export const LAMP_POLICY = "aa".repeat(28);
export const LAMP_NAME   = "744c414d50";             // "tLAMP"
export const LAMP_UNIT   = LAMP_POLICY + LAMP_NAME;
export const OWNER_PKH   = "0a".repeat(28);

// Script tối giản hợp lệ — chỉ để suy ra hash/địa chỉ, không bao giờ được chạy.
export const VAULT_SCRIPT = { type: "PlutusV3" as const, script: "49480100002221200101" };
export const SHARD_SCRIPT = { type: "PlutusV3" as const, script: "49480100002221200102" };
export const VAULT_HASH   = validatorToScriptHash(VAULT_SCRIPT);
export const SHARD_HASH   = validatorToScriptHash(SHARD_SCRIPT);
/** NFT vault-id: policy = hash script két (INV-VAULT-IDENTITY). */
export const VAULT_ID_NAME = "cc".repeat(32);
export const VAULT_ID_UNIT = VAULT_HASH + VAULT_ID_NAME;

export const VP: InstantVaultParams = {
  lampPolicyId      : LAMP_POLICY,
  lampAssetName     : LAMP_NAME,
  gbBeaconNftPolicy : "b1".repeat(28),
  gbBeaconScriptHash: "b2".repeat(28),
  gbShardPolicyId   : SHARD_HASH,
  rateNftPolicy     : "b3".repeat(28),
  rateScriptHash    : "b4".repeat(28),
  wakemeVaultHash   : "b5".repeat(28),
  msPerEpoch        : P,
};
export const REGISTRY_POLICY = "b6".repeat(28);

export const LAMP_BALANCE = 100_000_000_000n;          // 100 000 LAMP ⟹ trần LAMP 4e11
export const CAP_NANOGIC  = 1_000_000_000_000n;
export const GB_SEQ       = 5n;
export const SHARD_RESET  = 10_000_000_000_000n;       // ⟹ phần GB mỗi két 5e11

export function scriptAddr(hash: string): string {
  return credentialToAddress(NETWORK, { type: "Script", hash });
}

export function zeroWindow(): { generated: bigint; consumed: bigint }[] {
  return Array.from({ length: 7 }, () => ({ generated: 0n, consumed: 0n }));
}

export function makeVault(overrides: Partial<TVaultDatum> = {}): TVaultDatum {
  return {
    owner                 : { VerificationKey: [OWNER_PKH] },
    lamp_balance          : LAMP_BALANCE,
    lamp_locked           : 0n,
    loyalty_holdings      : [{ amount: LAMP_BALANCE, acquired_epoch: 50n, is_locked: false }],
    magic_batches         : [],
    next_batch_index      : 0n,
    wakeme_link           : "",
    gen_schedules         : [],
    profile               : "Flame",
    profile_changed_epoch : 0n,
    pending_profile       : null,
    last_updated_epoch    : 99n,
    cap_epoch             : E,
    activity_state        : { recent_burn_epochs: [], consumed_credit: 1_001_000_000_000n },
    cap_nanogic           : CAP_NANOGIC,
    personal_delegate     : null,
    attribution           : { attribution_root: "00".repeat(32), last_event_epoch: 0n, total_events: 0n },
    instant_unlock_ms     : 0n,
    usage_window          : zeroWindow(),
    usage_window_epoch    : E,
    ...overrides,
  } as TVaultDatum;
}

export function instantBatch(initial: bigint, epoch = E, decayWindow = 1n, id = "e1"): MagicBatch {
  return {
    batch_id: id.repeat(32), source: "Instant", created_epoch: epoch,
    initial_amount: initial, current_amount: initial, decay_window: decayWindow,
    profile_at_creation: null, contract_id: null, halved: false,
  } as MagicBatch;
}

export const SHARD_ID = vaultShardId({ VerificationKey: [OWNER_PKH] });

export function makeGreenback(o: Partial<TGreenBackBeacon> = {}): TGreenBackBeacon {
  return { gb_nanogic: SHARD_RESET * 16n, seq: GB_SEQ, epoch: E, depeg: false, ...o };
}

export function makeShard(o: Partial<TGbShard> = {}): TGbShard {
  return { shard_id: SHARD_ID, seq: GB_SEQ, reset_amount: SHARD_RESET, remaining: SHARD_RESET, ...o };
}

export function makeRate(o: Partial<TRateParam> = {}): TRateParam {
  return { rho_q: 1_000_000_000n, prev_rho_q: 500_000_000n, effective_epoch: E, ...o };
}

/** Bối cảnh hàm thuần. `datum` là phần GHI ĐÈ lên `makeVault()`. */
export function makeCtx(o: {
  datum?: Partial<TVaultDatum>;
  rate?: TRateParam | null;
  wakeme?: { ownerCommit: string; lent: bigint } | null;
  greenback?: Partial<TGreenBackBeacon>;
  shardIn?: Partial<TGbShard>;
  gbShardCapNanogic?: bigint;
  epoch?: bigint;
} = {}): InstantGenContext {
  return {
    vaultDatum       : makeVault(o.datum),
    vaultOutRef      : { txHash: "ab".repeat(32), outputIndex: 0 },
    currentEpoch     : o.epoch ?? E,
    rate             : o.rate === undefined ? null : o.rate,
    wakeme           : o.wakeme === undefined ? null : o.wakeme,
    greenback        : makeGreenback(o.greenback),
    shardIn          : makeShard(o.shardIn),
    gbShardCapNanogic: o.gbShardCapNanogic ?? 1_800_000_000_000_000n,
  };
}

// ── UTxO giả trên địa chỉ bech32 THẬT (bộ dựng soát payment credential) ─────

function mk(address: string, assets: Record<string, bigint>, datum: string | null, ix: number): UTxO {
  return {
    txHash: "ab".repeat(32), outputIndex: ix, address, assets,
    datum: datum ?? undefined, datumHash: undefined, scriptRef: undefined,
  } as unknown as UTxO;
}

export function vaultUtxo(datum: TVaultDatum | string = makeVault(), extra: Record<string, bigint> = {}): UTxO {
  const cbor = typeof datum === "string" ? datum : Data.to(datum, VaultDatum);
  const lamp = typeof datum === "string" ? LAMP_BALANCE : datum.lamp_balance;
  return mk(scriptAddr(VAULT_HASH), { lovelace: 5_000_000n, [LAMP_UNIT]: lamp, [VAULT_ID_UNIT]: 1n, ...extra }, cbor, 0);
}

export function greenbackUtxo(g: TGreenBackBeacon = makeGreenback()): UTxO {
  return mk(scriptAddr(VP.gbBeaconScriptHash),
    { lovelace: 2_000_000n, [VP.gbBeaconNftPolicy + GREENBACK_NFT_NAME]: 1n },
    Data.to(g, GreenBackBeacon), 1);
}

export function shardUtxo(s: TGbShard = makeShard(), nftId = s.shard_id): UTxO {
  return mk(scriptAddr(SHARD_HASH),
    { lovelace: 2_000_000n, [SHARD_HASH + shardNftName(nftId)]: 1n },
    Data.to(s, GbShard), 2);
}

export function registryUtxo(hashes: string[] = [VAULT_HASH]): UTxO {
  return mk(scriptAddr(REGISTRY_POLICY),
    { lovelace: 2_000_000n, [REGISTRY_POLICY + VAULT_REGISTRY_NFT_NAME]: 1n },
    Data.to({ vault_script_hashes: hashes }, VaultRegistry), 3);
}

export function rateUtxo(r: TRateParam = makeRate()): UTxO {
  return mk(scriptAddr(VP.rateScriptHash),
    { lovelace: 2_000_000n, [VP.rateNftPolicy + RATE_NFT_NAME]: 1n },
    Data.to(r, RateParam), 4);
}

export const WAKEME_COMMIT = "c3".repeat(32);

/** Két Wakeme ghim két IG này, ≥ 13 trường (gương `lentRead.test.ts`). */
export function wakemeUtxo(o: { commit?: string; conditional?: bigint; owned?: bigint; pinPeriod?: bigint } = {}): UTxO {
  const commit = o.commit ?? WAKEME_COMMIT;
  const cond = o.conditional ?? 700_000_000n;
  const owned = o.owned ?? 300_000_000n;
  const pin = new Constr(0, [new Constr(0, [VAULT_HASH, VAULT_ID_NAME])]);
  const fs: Data[] = [commit, "e5e5", 0n, cond, 0n, 50n, 49n, owned, 0n, 0n, "f6f6", pin, o.pinPeriod ?? E - 1n];
  return mk(scriptAddr(VP.wakemeVaultHash),
    { lovelace: 2_000_000n, [VP.wakemeVaultHash + commit]: 1n, [LAMP_UNIT]: cond + owned },
    Data.to(new Constr(0, fs)), 5);
}
