// lib/magiclamp/protocol/datum_cbor_vectors.ak — vector CBOR Gen v2.0 của két ScheduleGen.
//
// Tệp CHỈ chứa bài kiểm. Mỗi hằng `tv_cbor_*_hex` là bytes `cbor.serialise` của một giá trị
// dựng ở đây bằng kiểu Aiken THẬT (`types.ak`); bài kiểm ghim bytes đó. Phía TypeScript,
// `ScheduleGen/tests/datumV2.test.ts` ĐỌC CHÍNH các hằng này từ tệp (không chép lại) và
// ép `Data.to(…, lược đồ Lucid) == hex` + `Data.from(hex, lược đồ) == giá trị`. Hai phía
// cùng trỏ vào một nguồn bytes, nên lệch thứ tự trường hay chỉ số constructor ở bên nào
// cũng đỏ ở bên đó.
//
// Datum "một hợp đồng" là kết quả ký L = 10, λ = 1 000 LAMP ở epoch 100 trên két genesis,
// ρ = 4·10⁹, cửa sổ trống (khởi động lạnh). Ba bài `tv_cbor_one_schedule_*` tính lại các
// trường đó bằng hàm on-chain (`amount_by_lamp`, `usage_factor_q`, `compute_schedule_id`)
// — tức vector không phải số gõ tay mà là đầu ra của đúng công thức validator dùng.

use aiken/cbor
use cardano/address.{VerificationKey}
use magiclamp/protocol/constants.{snapshot_base_rate_q}
use magiclamp/protocol/gen_formula.{amount_by_lamp, usage_factor_q}
use magiclamp/protocol/math.{compute_rate_locked_q, compute_schedule_id, min2}
use magiclamp/protocol/types.{
  ActivityState, DelegationCertificate, Draw, EpochUsage, Flame, GbShardRedeemer,
  GenSchedule, LoyaltyHolding, ScheduleAggregateShardDatum, StreakState,
  VaultAttribution, VaultDatum,
}

const tv_owner_pkh: ByteArray =
  #"0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"

const tv_vault_tx: ByteArray =
  #"3333333333333333333333333333333333333333333333333333333333333333"

fn tv_zw() -> List<EpochUsage> {
  [
    EpochUsage { generated: 0, consumed: 0 },
    EpochUsage { generated: 0, consumed: 0 },
    EpochUsage { generated: 0, consumed: 0 },
    EpochUsage { generated: 0, consumed: 0 },
    EpochUsage { generated: 0, consumed: 0 },
    EpochUsage { generated: 0, consumed: 0 },
    EpochUsage { generated: 0, consumed: 0 },
  ]
}

/// Két genesis sạch — đúng các vế `validate_mint_vault_id` ép (19 trường).
fn tv_genesis() -> VaultDatum {
  VaultDatum {
    owner: VerificationKey(tv_owner_pkh),
    lamp_balance: 100_000_000_000,
    lamp_locked: 0,
    loyalty_holdings: [
      LoyaltyHolding { amount: 100_000_000_000, acquired_epoch: 0, is_locked: False },
    ],
    magic_batches: [],
    next_batch_index: 0,
    vacuum_orders: [],
    gen_schedules: [],
    profile: Flame,
    profile_changed_epoch: 0,
    pending_profile: None,
    last_updated_epoch: 0,
    delegation_cert: DelegationCertificate {
      current: [],
      pending: None,
      current_effective_epoch: 0,
      last_changed_epoch: 0,
    },
    activity_state: ActivityState { recent_burn_epochs: [], consumed_credit: 0 },
    streak_state: StreakState { current_streak: 0, last_active_epoch: 0 },
    personal_delegate: None,
    attribution: VaultAttribution {
      attribution_root: #"",
      last_event_epoch: 0,
      total_events: 0,
    },
    usage_window: tv_zw(),
    usage_window_epoch: 0,
  }
}

fn tv_schedule() -> GenSchedule {
  GenSchedule {
    schedule_id: #"8b2bec92d46c952fa96783379c0188e146587fde83ea5db1fad4696160e231b2",
    commit_epoch: 100,
    start_fire_epoch: 102,
    end_fire_epoch: 111,
    schedule_length: 10,
    lamp_per_epoch: 1_000_000_000,
    rate_locked_q: 8_000_000_000,
    baseline_at_commit_q: 5_000_000_000,
    multiplier_at_commit_q: 1_600_000_000,
    fired_count: 0,
    auto_burn_target: None,
    m_per_epoch: 3_000_000_000,
    usage_factor_locked_q: 750_000_000,
  }
}

/// Két sau MỘT lượt ký (datum ra của `validate_commit`).
fn tv_one_schedule() -> VaultDatum {
  VaultDatum {
    ..tv_genesis(),
    lamp_locked: 10_000_000_000,
    loyalty_holdings: [
      LoyaltyHolding { amount: 10_000_000_000, acquired_epoch: 0, is_locked: True },
      LoyaltyHolding { amount: 90_000_000_000, acquired_epoch: 0, is_locked: False },
    ],
    gen_schedules: [tv_schedule()],
    last_updated_epoch: 100,
    usage_window: tv_zw(),
    usage_window_epoch: 100,
  }
}

const tv_cbor_vault_genesis_hex: ByteArray =
  #"d8799fd8799f581c0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0aff1b000000174876e800009fd8799f1b000000174876e80000d87980ffff80008080d87a8000d87a8000d8799f80d87a800000ffd8799f8000ffd8799f0000ffd87a80d8799f400000ff9fd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffff00ff"

const tv_cbor_vault_one_schedule_hex: ByteArray =
  #"d8799fd8799f581c0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0aff1b000000174876e8001b00000002540be4009fd8799f1b00000002540be40000d87a80ffd8799f1b00000014f46b040000d87980ffff8000809fd8799f58208b2bec92d46c952fa96783379c0188e146587fde83ea5db1fad4696160e231b218641866186f0a1a3b9aca001b00000001dcd650001b000000012a05f2001a5f5e100000d87a801ab2d05e001a2cb41780ffffd87a8000d87a801864d8799f80d87a800000ffd8799f8000ffd8799f0000ffd87a80d8799f400000ff9fd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffff1864ff"

const tv_cbor_shard_one_schedule_hex: ByteArray =
  #"d8799f0a1b00000002540be400011b00000002540be4000018641b00019945ca2620001b00000006fc23ac00ff"

const tv_cbor_gb_draw_hex: ByteArray = #"d8799f1b0000000165a0bc00ff"

test tv_cbor_vault_genesis() {
  cbor.serialise(tv_genesis()) == tv_cbor_vault_genesis_hex
}

test tv_cbor_vault_one_schedule() {
  cbor.serialise(tv_one_schedule()) == tv_cbor_vault_one_schedule_hex
}

test tv_cbor_shard_one_schedule() {
  let s =
    ScheduleAggregateShardDatum {
      shard_id: 10,
      shard_locked_lamp: 10_000_000_000,
      shard_active_count: 1,
      shard_cumulative_committed: 10_000_000_000,
      shard_cumulative_fired: 0,
      last_updated_epoch: 100,
      shard_cap: 450_000_000_000_000,
      shard_obligation_nanogic: 30_000_000_000,
    }
  cbor.serialise(s) == tv_cbor_shard_one_schedule_hex
}

test tv_cbor_gb_draw() {
  let r: GbShardRedeemer = Draw { amount: 6_000_000_000 }
  cbor.serialise(r) == tv_cbor_gb_draw_hex
}

// ── Các trường của hợp đồng trong vector là đầu ra của công thức on-chain ─────
test tv_cbor_one_schedule_m_matches_formula() {
  let rate = compute_rate_locked_q(snapshot_base_rate_q, 10)
  and {
    rate == tv_schedule().rate_locked_q,
    amount_by_lamp(1_000_000_000, 0, tv_zw(), min2(rate, 4_000_000_000), 6) == tv_schedule().m_per_epoch,
  }
}

test tv_cbor_one_schedule_uf_matches_formula() {
  usage_factor_q(tv_zw()) == tv_schedule().usage_factor_locked_q
}

test tv_cbor_one_schedule_id_matches_formula() {
  compute_schedule_id(tv_vault_tx, 0, 0) == tv_schedule().schedule_id
}

// Obligation = M × N; draw = M × min(N, buffer_ep) — hai số trong vector shard/draw.
test tv_cbor_one_schedule_obligation_and_draw() {
  let m = tv_schedule().m_per_epoch
  and {
    m * 10 == 30_000_000_000,
    m * 2 == 6_000_000_000,
  }
}
