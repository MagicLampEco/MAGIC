//// Kiểu datum/redeemer của ba beacon Gen v2.0 (SPEC v2.4 §6.1.3, §13 `INV-RATE-GOVERNED`,
//// `INV-SURPLUS-RATION`).
////
//// 🔴 HỢP ĐỒNG NHỊ PHÂN. Các kiểu này sẽ được chép sang InstantGen/ScheduleGen để két đọc
//// beacon qua reference input. Thứ tự trường và chỉ số constructor là cách mã hoá Plutus
//// Data: đổi thứ tự, thêm, bớt một trường ⟹ mọi UTxO beacon đã tạo không đọc được nữa
//// (giải mã Aiken nghiêm ngặt số trường CẢ HAI chiều — BOUNDARIES.md §2). Sửa ở đây thì
//// sửa bản chép bên két trong CÙNG commit.

/// Beacon suất sinh ρ (Q-format, `Q = 10⁹`).
///
/// `rho_q` có hiệu lực từ `effective_epoch`; trước mốc đó giá trị hiệu lực là
/// `prev_rho_q`. Đọc bằng `genbeacons/rate.rho_at`, KHÔNG đọc thẳng `rho_q`.
pub type RateParam {
  rho_q: Int,
  prev_rho_q: Int,
  effective_epoch: Int,
}

/// Beacon thặng dư GreenBack. `gb_nanogic` là THẶNG DƯ CÒN LẠI toàn mạng (nanogic) —
/// shard đặt lại về `min(⌊gb_nanogic / 16⌋, cap)`. `seq` tăng đúng 1 mỗi lần ghi;
/// `epoch` = epoch thời gian thật của giao dịch ghi (validator ép, bên ghi không tự khai).
pub type GreenBackBeacon {
  gb_nanogic: Int,
  seq: Int,
  epoch: Int,
  depeg: Bool,
}

/// Một shard của bộ đếm `GB_available` (16 shard, `SHARD_COUNT`).
///   seq          : `seq` của beacon ở lần đặt lại gần nhất.
///   reset_amount : lượng đặt lại ở lần đó = `min(⌊GB/16⌋, cap)` — két dùng nó cho trần
///                  mỗi-vault-mỗi-epoch (`gb_vault_share_q`, §6.1.3).
///   remaining    : lượng còn rút được.
pub type GbShard {
  shard_id: Int,
  seq: Int,
  reset_amount: Int,
  remaining: Int,
}

/// Redeemer của shard: lượng két khai rút. Két đọc redeemer này (purpose `Spend(shard_ref)`)
/// để ép lượng nó sinh khớp `amount` — nên constructor index 0 cũng là hợp đồng nhị phân.
pub type GbShardRedeemer {
  Draw { amount: Int }
}
