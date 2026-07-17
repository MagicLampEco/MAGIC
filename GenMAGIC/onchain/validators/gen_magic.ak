//// GenMAGIC — engine Gen (v0.2)
//// Giải blocker Wakeme §3.7-1 / B1: "engine Gen ĐỌC số dư on-chain
//// (đọc VaultDatum reference-input → drip MAGIC → KHÔNG-spend UTXO-LAMP)".
////
//// BẤT BIẾN CỐT LÕI ÉP Ở ĐÂY (G5 / I-ACT-7): vault CHỈ được đọc qua reference_input,
//// TUYỆT ĐỐI không có trong inputs ⟹ LAMP không thể rời vault qua đường gen.
//// Mẫu fire-LAMP→Treasury của thiết kế cũ LỖI THỜI (Wakeme-Math.md:300) — không tái dùng.
////
//// RANH GIỚI on-chain / off-chain (nói thẳng, không giấu):
////  - ÉP Ở ĐÂY: vault-không-bị-spend · NFT singleton · TỰ ĐO LAMP từ value (không tin datum)
////    · biên c · toàn bộ math tư-cách · tuần-tự epoch · G9 reset · G6 không-token.
////  - ÉP Ở OFF-CHAIN (§3 spec, engine): script-hash apply-param canonical H_did per-DID
////    (on-chain không hash lại script được) · khử trùng đa-vault cùng did_commit
////    (I-ACT-10 KHÔNG tồn tại on-chain — hội đồng xác minh) · Merkle-anchor sổ.

use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use magiclamp/gen/math.{c_dung, magic_vault, slots_per_epoch, trong_so_vault,
  tu_cach}
use magiclamp/gen/types.{
  ActivationVaultDatum, Drip, GenRedeemer, MagicAccountDatum, NhipBeacon,
}

validator gen_magic(
  /// LAMP canonical — apply-param HẰNG HỆ (không phải per-DID) ⟹ chống param-substitution
  /// ở tầng LAMP: attacker không thể trỏ lamp_policy sang token rác tự mint.
  lamp_policy: PolicyId,
  lamp_name: AssetName,
  /// beacon nhịp-gen do engine công bố đầu epoch
  nhip_nft_policy: PolicyId,
  nhip_nft_name: AssetName,
  /// khoá engine — ký số liệu sổ off-chain (§6). Ranh giới tin cậy ghi rõ ở spec §6.
  engine_key: ByteArray,
) {
  spend(
    datum_opt: Option<MagicAccountDatum>,
    redeemer: GenRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(d_in) = datum_opt
    let Drip { vault_ref, nhip_ref, so_lieu } = redeemer

    // ── (1) I-ACT-7 — LAMP ĐỨNG YÊN. Bất biến số một của cả thiết kế. ──────
    // vault PHẢI KHÔNG nằm trong inputs. Nếu nó bị spend, tx này phải fail.
    let vault_khong_bi_spend =
      !list.any(self.inputs, fn(i) { i.output_reference == vault_ref })
    expect vault_khong_bi_spend

    // ── (2) đọc vault qua reference_input ─────────────────────────────────
    expect Some(vault_ri) =
      list.find(self.reference_inputs, fn(i) { i.output_reference == vault_ref })
    let vault_out = vault_ri.output
    expect InlineDatum(vd_raw) = vault_out.datum
    expect vd: ActivationVaultDatum = vd_raw

    // vault-NFT singleton. policy NFT = own_hash của script vault (per-DID),
    // name = owner_commit. On-chain kiểm được tính singleton + khớp did_commit.
    expect Some(nft_policy) = policy_vault_nft(vault_out, vd.owner_commit)
    expect assets.quantity_of(vault_out.value, nft_policy, vd.owner_commit) == 1

    // did_commit phải khớp tài-khoản đang drip — chống drip vault người khác
    expect vd.did_commit == d_in.did_commit
    expect vd.did_commit != #""

    // ── (3) TỰ ĐO LAMP từ value — KHÔNG BAO GIỜ tin c trong datum ─────────
    // v0.1 tin datum ⟹ UTxO 2 ADA datum bịa c=10^12 nuốt 99,98% ngân sách (PoC PASS).
    let lamp_do = assets.quantity_of(vault_out.value, lamp_policy, lamp_name)
    let c = c_dung(vd.conditional_lamp, lamp_do)
    expect c > 0

    // ── (4) beacon nhịp-gen ───────────────────────────────────────────────
    expect Some(beacon) =
      list.find(self.reference_inputs, fn(i) { i.output_reference == nhip_ref })
    expect assets.quantity_of(beacon.output.value, nhip_nft_policy, nhip_nft_name) == 1
    expect InlineDatum(nb_raw) = beacon.output.datum
    expect nb: NhipBeacon = nb_raw

    // B2 (hội đồng 17/7, 5/5 trục) — TRẦN TUYỆT ĐỐI phải ép ON-CHAIN.
    // van tran_tang (trong nhip_gen) chỉ chặn TỐC ĐỘ; nếu engine_key lộ + beacon
    // nhip_gen=10^30 thì không lớp nào chặn MỨC. Đây là bộ-ngắt độc-lập-với-tốc-độ.
    expect nb.nhip_gen <= nb.nhip_tran

    // ── (5) tuần-tự epoch nghiêm — chống drip 2 lần/epoch ─────────────────
    expect nb.epoch == d_in.epoch + 1

    // ── (6) số liệu sổ off-chain phải do engine ký (§6 ranh giới tin cậy) ──
    expect list.has(self.extra_signatories, engine_key)

    // S6 (hội đồng 17/7) — số liệu sổ phải nhất quán nội tại (chặn engine cẩu thả
    // gán tiêu-thấp-điểm > tổng-tiêu để bơm r_thap). Rẻ, ExUnit không đáng kể.
    expect so_lieu.tieu_thap_diem <= so_lieu.da_tieu

    // ── (7) tính tư-cách + M_v (math bit-identical với TypeScript — P8) ────
    let slot_now = nb.epoch * slots_per_epoch
    let tc =
      tu_cach(
        slot_now,
        vd.vest_start_slot,
        so_lieu.da_tieu,
        so_lieu.da_sinh,
        so_lieu.tieu_thap_diem,
        so_lieu.magic_cam_ket,
      )
    let w_v = trong_so_vault(c, tc)
    let m_v = magic_vault(w_v, nb.nhip_gen)

    // ── (8) output tài-khoản — B5 (hội đồng 17/7): chống double-satisfaction ─
    // Cũ: khớp first-match theo address ⟹ 2 account cùng addr+m_v → 1 output thoả
    // cả hai spend (bỏ túi min-ADA account thứ 2); value không bảo toàn.
    // Mới: ĐÚNG 1 input + ĐÚNG 1 output tại địa chỉ mình + value bảo toàn.
    expect Some(own_in) =
      list.find(self.inputs, fn(i) { i.output_reference == own_ref })
    let own_addr = own_in.output.address
    expect list.count(self.inputs, fn(i) { i.output.address == own_addr }) == 1
    let acc_outs = list.filter(self.outputs, fn(o) { o.address == own_addr })
    expect [acc_out] = acc_outs
    expect InlineDatum(do_raw) = acc_out.datum
    expect d_out: MagicAccountDatum = do_raw

    // MAGIC là datum (KHÔNG token rời) ⟹ value account giữ NGUYÊN (chỉ min-ADA).
    expect acc_out.value == own_in.output.value

    // G9 — dùng-hay-mất: RESET, KHÔNG cộng dồn suất cũ
    expect d_out.magic_nanogic == m_v
    expect d_out.epoch == nb.epoch
    expect d_out.did_commit == d_in.did_commit

    // G6 — MAGIC không token, không policy-id ⟹ tx này KHÔNG được mint/đốt gì
    expect assets.flatten(self.mint) == []

    True
  }

  else(_) {
    fail
  }
}

/// Suy policy vault-NFT từ payment credential của chính vault output.
/// (policy NFT vault = own_hash script vault — Wakeme-Tech.md:72)
fn policy_vault_nft(vault_out: Output, _owner_commit: ByteArray) -> Option<PolicyId> {
  when vault_out.address.payment_credential is {
    Script(h) -> Some(h)
    _ -> None
  }
}


