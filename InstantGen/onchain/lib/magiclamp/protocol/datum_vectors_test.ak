// lib/magiclamp/protocol/datum_vectors_test.ak — TV-DATUM-V2-*: CBOR của VaultDatum
// InstantGen Gen v2.0 (20 trường), ghim từ phía Aiken.
//
// Cùng hai giá trị + cùng hai chuỗi hex với `InstantGen/tests/vectors.ts`
// (`TV_DATUM_V2_GENESIS`, `TV_DATUM_V2_FULL`); bài TS `tests/datumV2.test.ts` ghim
// chiều `Data.to` của Lucid. Hai phía cùng một chuỗi ⟹ lược đồ TS và kiểu Aiken trùng
// thứ tự trường + chỉ số constructor tới từng byte. Đổi một ô ở một bên mà không đổi bên
// kia ⟹ một trong hai đỏ.
//
// Tệp CHỈ chứa bài kiểm, không có hàm nào được validator dùng — không đổi hash két.

use aiken/builtin
use aiken/cbor
use aiken/collection/list
use cardano/address.{Script, VerificationKey}
use magiclamp/protocol/types.{
  ActivityState, AutoBurnConfig, Ember, EpochUsage, Flame, GenSchedule, Instant,
  Lantern, LoyaltyHolding, MagicBatch, PendingProfile, Schedule,
  VaultAttribution, VaultDatum,
}

const tv_genesis_cbor: ByteArray =
  #"d8799fd8799f581c11111111111111111111111111111111111111111111111111111111ff1a05f5e100009fd8799f1a05f5e10000d87980ffff80004080d87a8000d87a800000d8799f801b000000e9103fda00ff00d87a80d8799f400000ff009fd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffd8799f0000ffff00ff"

const tv_full_cbor: ByteArray =
  #"d8799fd87a9f581c22222222222222222222222222222222222222222222222222222222ff1b000000012a05f2001a3b9aca009fd8799f1aee6b28000ad87980ffd8799f1a3b9aca000cd87a80ffff9fd8799f5820ababababababababababababababababababababababababababababababababd87a80141b00000001a13b86001ab2d05e0001d87a80d87a80d87980ffd8799f5820cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdd87c8014020101d8799fd87b80ffd8799f44cdcdcdcdffd87a80ffff025820efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef9fd8799f489999999999999999030509051a000f42401a3e95ba801a3b9aca001a47868c0002d8799fd8799f581c33333333333333333333333333333333333333333333333333333333d8799f4444444444ff05ffffffffd87b800fd8799fd8799fd8798016ffff1414d8799f9f9f445555555513ffff1b000000e9103fda00ff1b0000001cbe991a14d8799f581c66666666666666666666666666666666666666666666666666666666ffd8799f582077777777777777777777777777777777777777777777777777777777777777771409ff1b00000192cc0914009fd8799f1b00000001a13b86001ab2d05e00ffd8799f0102ffd8799f0304ffd8799f0000ffd8799f0500ffd8799f0006ffd8799f0809ffff14ff"

fn zero_window() -> List<EpochUsage> {
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

fn tv_genesis() -> VaultDatum {
  VaultDatum {
    owner: VerificationKey(
      #"11111111111111111111111111111111111111111111111111111111",
    ),
    lamp_balance: 100_000_000,
    lamp_locked: 0,
    loyalty_holdings: [
      LoyaltyHolding {
        amount: 100_000_000,
        acquired_epoch: 0,
        is_locked: False,
      },
    ],
    magic_batches: [],
    next_batch_index: 0,
    wakeme_link: #"",
    gen_schedules: [],
    profile: Flame,
    profile_changed_epoch: 0,
    pending_profile: None,
    last_updated_epoch: 0,
    cap_epoch: 0,
    activity_state: ActivityState {
      recent_burn_epochs: [],
      consumed_credit: 1_001_000_000_000,
    },
    cap_nanogic: 0,
    personal_delegate: None,
    attribution: VaultAttribution {
      attribution_root: #"",
      last_event_epoch: 0,
      total_events: 0,
    },
    instant_unlock_ms: 0,
    usage_window: zero_window(),
    usage_window_epoch: 0,
  }
}

fn tv_full() -> VaultDatum {
  VaultDatum {
    owner: Script(#"22222222222222222222222222222222222222222222222222222222"),
    lamp_balance: 5_000_000_000,
    lamp_locked: 1_000_000_000,
    loyalty_holdings: [
      LoyaltyHolding {
        amount: 4_000_000_000,
        acquired_epoch: 10,
        is_locked: False,
      },
      LoyaltyHolding {
        amount: 1_000_000_000,
        acquired_epoch: 12,
        is_locked: True,
      },
    ],
    magic_batches: [
      MagicBatch {
        batch_id: #"abababababababababababababababababababababababababababababababab",
        source: Instant,
        created_epoch: 20,
        initial_amount: 7_000_000_000,
        current_amount: 3_000_000_000,
        decay_window: 1,
        profile_at_creation: None,
        contract_id: None,
        halved: False,
      },
      MagicBatch {
        batch_id: #"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
        source: Schedule,
        created_epoch: 20,
        initial_amount: 2,
        current_amount: 1,
        decay_window: 1,
        profile_at_creation: Some(Lantern),
        contract_id: Some(#"cdcdcdcd"),
        halved: True,
      },
    ],
    next_batch_index: 2,
    wakeme_link: #"efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
    gen_schedules: [
      GenSchedule {
        schedule_id: #"9999999999999999",
        commit_epoch: 3,
        start_fire_epoch: 5,
        end_fire_epoch: 9,
        schedule_length: 5,
        lamp_per_epoch: 1_000_000,
        rate_locked_q: 1_050_000_000,
        baseline_at_commit_q: 1_000_000_000,
        multiplier_at_commit_q: 1_200_000_000,
        fired_count: 2,
        auto_burn_target: Some(
          AutoBurnConfig {
            delegate: #"33333333333333333333333333333333333333333333333333333333",
            target_app_id: Some(#"44444444"),
            max_burn_per_fire: 5,
          },
        ),
      },
    ],
    profile: Lantern,
    profile_changed_epoch: 15,
    pending_profile: Some(
      PendingProfile { new_profile: Ember, effective_epoch: 22 },
    ),
    last_updated_epoch: 20,
    cap_epoch: 20,
    activity_state: ActivityState {
      recent_burn_epochs: [(#"55555555", 19)],
      consumed_credit: 1_001_000_000_000,
    },
    cap_nanogic: 123_456_789_012,
    personal_delegate: Some(
      #"66666666666666666666666666666666666666666666666666666666",
    ),
    attribution: VaultAttribution {
      attribution_root: #"7777777777777777777777777777777777777777777777777777777777777777",
      last_event_epoch: 20,
      total_events: 9,
    },
    instant_unlock_ms: 1_730_000_000_000,
    usage_window: [
      EpochUsage { generated: 7_000_000_000, consumed: 3_000_000_000 },
      EpochUsage { generated: 1, consumed: 2 },
      EpochUsage { generated: 3, consumed: 4 },
      EpochUsage { generated: 0, consumed: 0 },
      EpochUsage { generated: 5, consumed: 0 },
      EpochUsage { generated: 0, consumed: 6 },
      EpochUsage { generated: 8, consumed: 9 },
    ],
    usage_window_epoch: 20,
  }
}

test tv_datum_v2_genesis_serialise() {
  cbor.serialise(tv_genesis()) == tv_genesis_cbor
}

test tv_datum_v2_genesis_deserialise() {
  expect Some(raw) = cbor.deserialise(tv_genesis_cbor)
  expect d: VaultDatum = raw
  d == tv_genesis()
}

test tv_datum_v2_full_serialise() {
  cbor.serialise(tv_full()) == tv_full_cbor
}

test tv_datum_v2_full_deserialise() {
  expect Some(raw) = cbor.deserialise(tv_full_cbor)
  expect d: VaultDatum = raw
  d == tv_full()
}

// Ca âm cho chiều giải mã: datum 18 trường (két Gen v1) KHÔNG giải được thành
// VaultDatum v2.0 — Aiken nghiêm về số trường (BOUNDARIES §2).
// Cặp: cùng phép dựng lại với ĐỦ 20 trường thì giải được — ca âm chỉ khác số trường.
fn rebuilt_with(n: Int) -> Data {
  expect Some(raw) = cbor.deserialise(tv_full_cbor)
  let fields = builtin.snd_pair(builtin.un_constr_data(raw))
  builtin.constr_data(0, list.take(fields, n))
}

test tv_datum_v2_rebuilt_20_ok() {
  expect d: VaultDatum = rebuilt_with(20)
  d == tv_full()
}

test tv_datum_v1_shape_rejected() fail {
  expect _d: VaultDatum = rebuilt_with(18)
  True
}
