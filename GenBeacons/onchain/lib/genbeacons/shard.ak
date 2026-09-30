//// Đặt lại lười của shard `GB_available` (SPEC §6.1.3, `INV-SURPLUS-RATION`).

use genbeacons/constants
use genbeacons/types.{GbShard, GreenBackBeacon}

/// Trạng thái HIỆU LỰC của shard trước khi trừ lượng rút.
///
/// Mỗi lần ghi beacon về lý thuyết đặt lại MỌI shard, nhưng ghi 16 UTxO mỗi lần là
/// không cần: shard tự đặt lại lần đầu nó bị tiêu sau lượt ghi — nhận ra qua
/// `beacon.seq > shard.seq`. Đặt lại (KHÔNG cộng dồn) về `min(⌊GB/16⌋, cap)`.
///
/// `beacon.seq < shard.seq` là trạng thái không tới được (shard chỉ nhận `seq` từ beacon,
/// beacon tăng đúng 1 mỗi lần ghi) ⟹ từ chối thay vì đoán.
pub fn lazy_reset(shard: GbShard, beacon: GreenBackBeacon, cap: Int) -> GbShard {
  if beacon.seq > shard.seq {
    let per_shard = beacon.gb_nanogic / constants.shard_count
    let amount =
      if per_shard < cap {
        per_shard
      } else {
        cap
      }
    GbShard {
      shard_id: shard.shard_id,
      seq: beacon.seq,
      reset_amount: amount,
      remaining: amount,
    }
  } else {
    expect beacon.seq == shard.seq
    shard
  }
}

test lazy_reset_newer_beacon_resets() {
  let s = GbShard { shard_id: 2, seq: 4, reset_amount: 50, remaining: 1 }
  let b = GreenBackBeacon { gb_nanogic: 1600, seq: 5, epoch: 9, depeg: False }
  lazy_reset(s, b, 1_000) == GbShard {
    shard_id: 2,
    seq: 5,
    reset_amount: 100,
    remaining: 100,
  }
}

test lazy_reset_caps_at_cap() {
  let s = GbShard { shard_id: 2, seq: 4, reset_amount: 50, remaining: 1 }
  let b = GreenBackBeacon { gb_nanogic: 1_600_000, seq: 5, epoch: 9, depeg: False }
  lazy_reset(s, b, 1_000).remaining == 1_000
}

test lazy_reset_same_seq_keeps() {
  let s = GbShard { shard_id: 2, seq: 5, reset_amount: 50, remaining: 1 }
  let b = GreenBackBeacon { gb_nanogic: 1_600_000, seq: 5, epoch: 9, depeg: False }
  lazy_reset(s, b, 1_000) == s
}

test lazy_reset_older_beacon_rejected() fail {
  let s = GbShard { shard_id: 2, seq: 6, reset_amount: 50, remaining: 1 }
  let b = GreenBackBeacon { gb_nanogic: 1_600_000, seq: 5, epoch: 9, depeg: False }
  lazy_reset(s, b, 1_000) == s
}
