// tests/genV2Fixtures.ts — fixture Gen v2.0 dùng chung cho các bài ScheduleGen.
//
// Datum két 19 trường, shard LAMP 8 trường, beacon ρ / GreenBack, shard GB, sổ két —
// kèm địa chỉ THẬT (suy từ script hash) để bộ dựng kiểm được neo hai lớp của beacon.

import { Data, credentialToAddress, scriptHashToCredential, validatorToScriptHash, toUnit } from "@lucid-evolution/lucid";
import {
  VaultDatum, ScheduleShardDatum, RateParam, GreenBackBeacon, GbShard,
  type VaultDatum as TVaultDatum, type ScheduleShardDatum as TShardDatum,
  type GreenBackBeacon as TGreenBackBeacon, type GbShard as TGbShard,
  type RateParam as TRateParam,
} from "../offchain/src/types.js";
import { gbShardNftName } from "../offchain/src/genPlan.js";

export const NETWORK = "Preprod" as const;

export const OWNER_PKH = "0a".repeat(28);     // rơi shard 10 (TV-SCH-SHARD-CRED)
export const OWNER = { VerificationKey: [OWNER_PKH] } as TVaultDatum["owner"];

// Script tối giản KHÁC NHAU — chỉ để suy hash/địa chỉ, không bao giờ được chạy.
export const VAULT_SCRIPT    = { type: "PlutusV3" as const, script: "49480100002221200101" };
export const SHARD_SCRIPT    = { type: "PlutusV3" as const, script: "4746010000222601" };
export const GB_SHARD_SCRIPT = { type: "PlutusV3" as const, script: "4746010000222602" };

export const GB_SHARD_POLICY   = validatorToScriptHash(GB_SHARD_SCRIPT);
export const GBB_POLICY        = "67".repeat(28);
export const GBB_SCRIPT_HASH   = "68".repeat(28);
export const RATE_POLICY       = "69".repeat(28);
export const RATE_SCRIPT_HASH  = "6a".repeat(28);
export const REGISTRY_POLICY   = "6b".repeat(28);

export const GEN = {
  gbBeaconNftPolicy:  GBB_POLICY,
  gbBeaconScriptHash: GBB_SCRIPT_HASH,
  gbShardPolicyId:    GB_SHARD_POLICY,
  rateNftPolicy:      RATE_POLICY,
  rateScriptHash:     RATE_SCRIPT_HASH,
};

export function scriptAddr(hash: string): string {
  return credentialToAddress(NETWORK, scriptHashToCredential(hash));
}

export const ZW = () => Array.from({ length: 7 }, () => ({ generated: 0n, consumed: 0n }));

export function makeVaultV2(overrides: Partial<TVaultDatum> = {}): TVaultDatum {
  return {
    owner:                 OWNER,
    lamp_balance:          100_000_000_000n,
    lamp_locked:           0n,
    loyalty_holdings:      [{ amount: 100_000_000_000n, acquired_epoch: 50n, is_locked: false }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [],
    profile:               "Flame",
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    99n,
    delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state:        { recent_burn_epochs: [], consumed_credit: 0n },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution:           { attribution_root: "00".repeat(32), last_event_epoch: 0n, total_events: 0n },
    usage_window:          ZW(),
    usage_window_epoch:    99n,
    ...overrides,
  } as TVaultDatum;
}

export function makeShardV2(shardId: number, overrides: Partial<TShardDatum> = {}): TShardDatum {
  return {
    shard_id:                   BigInt(shardId),
    shard_locked_lamp:          10_000_000_000n,
    shard_active_count:         1n,
    shard_cumulative_committed: 10_000_000_000n,
    shard_cumulative_fired:     0n,
    last_updated_epoch:         99n,
    shard_cap:                  450_000_000_000_000n,
    shard_obligation_nanogic:   100_000_000_000n,
    ...overrides,
  };
}

export const GB_RESET = 1_000_000_000_000_000n;   // ⌊GB/16⌋ với GB = 16·10¹⁵

export function makeBeacon(epoch: bigint, overrides: Partial<TGreenBackBeacon> = {}): TGreenBackBeacon {
  return { gb_nanogic: 16n * GB_RESET, seq: 1n, epoch, depeg: false, ...overrides };
}

export function makeGbShard(shardId: number, overrides: Partial<TGbShard> = {}): TGbShard {
  return { shard_id: BigInt(shardId), seq: 1n, reset_amount: GB_RESET, remaining: GB_RESET, ...overrides };
}

export const RHO = 4_000_000_000n;
export function makeRate(overrides: Partial<TRateParam> = {}): TRateParam {
  return { rho_q: RHO, prev_rho_q: RHO, effective_epoch: 0n, ...overrides };
}

export function utxo(
  datumHex: string | null, assets: Record<string, bigint>, ix = 0,
  txHash = "ab".repeat(32), address = "addr_test1wq" + "q".repeat(50),
) {
  return { txHash, outputIndex: ix, address, assets, datum: datumHex, datumHash: null, scriptRef: null } as any;
}

export function vaultUtxoV2(d: TVaultDatum, assets: Record<string, bigint>) {
  return utxo(Data.to(d, VaultDatum), assets, 0, "33".repeat(32));
}

export function shardUtxosV2(over: (i: number) => Partial<TShardDatum> = () => ({})) {
  return Array.from({ length: 16 }, (_, i) =>
    utxo(Data.to(makeShardV2(i, over(i)), ScheduleShardDatum), { lovelace: 2_000_000n }, i, "cd".repeat(32)));
}

export function gbShardUtxos(over: (i: number) => Partial<TGbShard> = () => ({})) {
  return Array.from({ length: 16 }, (_, i) =>
    utxo(
      Data.to(makeGbShard(i, over(i)), GbShard),
      { lovelace: 2_000_000n, [toUnit(GB_SHARD_POLICY, gbShardNftName(i))]: 1n },
      i, "ce".repeat(32), scriptAddr(GB_SHARD_POLICY),
    ));
}

export function rateBeaconUtxo(rp: TRateParam = makeRate(), address = scriptAddr(RATE_SCRIPT_HASH)) {
  return utxo(Data.to(rp, RateParam), { lovelace: 2_000_000n, [toUnit(RATE_POLICY, "52484f")]: 1n },
    20, "ef".repeat(32), address);
}

export function gbBeaconUtxo(b: TGreenBackBeacon, address = scriptAddr(GBB_SCRIPT_HASH)) {
  return utxo(Data.to(b, GreenBackBeacon), { lovelace: 2_000_000n, [toUnit(GBB_POLICY, "474242")]: 1n },
    21, "ef".repeat(32), address);
}

export function registryUtxo() {
  return utxo("d8799f80ff", { lovelace: 2_000_000n, [toUnit(REGISTRY_POLICY, "565247")]: 1n },
    22, "ef".repeat(32), scriptAddr(REGISTRY_POLICY));
}
