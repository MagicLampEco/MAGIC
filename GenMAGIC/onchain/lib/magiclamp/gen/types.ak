//// GenMAGIC — types (v0.2)
//// CẢNH BÁO CBOR: thứ tự field LÀ thứ tự constructor. Đổi thứ tự = vỡ decode hai phía.

use cardano/transaction.{OutputReference}

/// Vault Wakeme — 7 field, ĐÚNG thứ tự (neo: PhoenixKey-Wakeme-Tech.md:119-125).
/// GenMAGIC chỉ ĐỌC. KHÔNG BAO GIỜ dựng/sửa datum này.
/// [NEEDS-EVIDENCE] plutus.json Wakeme đang commit là datum 9-field (hội đồng xác minh) —
/// 7-field chỉ có ở nhánh `claude/wakeme-closed-loop-pot` @3d5fdce, CHƯA vào main.
pub type ActivationVaultDatum {
  owner_commit: ByteArray,
  did_commit: ByteArray,
  vest_start_slot: Int,
  conditional_lamp: Int,
  reclaimed_to_pot: Int,
  last_tick_day: Int,
  last_tick_epoch: Int,
}

/// Tài-khoản MAGIC. G6: KHÔNG token, KHÔNG policy-id. G9: reset mỗi epoch (dùng-hay-mất).
pub type MagicAccountDatum {
  did_commit: ByteArray,
  /// epoch đã drip gần nhất — tuần tự nghiêm, chống drip 2 lần/epoch
  epoch: Int,
  /// suất MAGIC của epoch này (nanogic). KHÔNG cộng dồn — G9.
  magic_nanogic: Int,
}

/// Số liệu sổ kế-toán off-chain (§6) — cửa sổ [e−6, e), CÙNG cửa sổ (INV-cửa-sổ-đối-xứng).
pub type SoLieuSo {
  da_tieu: Int,
  da_sinh: Int,
  tieu_thap_diem: Int,
  magic_cam_ket: Int,
}

/// Beacon nhịp-gen — engine công bố ĐẦU epoch (§5) ⟹ user tự tính chính xác M_v của mình.
pub type NhipBeacon {
  epoch: Int,
  nhip_gen: Int,
  /// trần tuyệt đối — van tran_tang chỉ chặn TỐC ĐỘ, không chặn MỨC
  nhip_tran: Int,
}

pub type GenRedeemer {
  /// Drip: đọc vault qua reference_input → drip MAGIC. LAMP ĐỨNG YÊN (I-ACT-7).
  Drip {
    /// trỏ vault trong reference_inputs — PHẢI KHÔNG có trong inputs
    vault_ref: OutputReference,
    /// trỏ beacon nhịp-gen trong reference_inputs
    nhip_ref: OutputReference,
    so_lieu: SoLieuSo,
  }
}
