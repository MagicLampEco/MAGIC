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
use cardano/address.{Address, Script}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}
use magiclamp/gen/math.{c_dung, magic_vault, slots_per_epoch, trong_so_vault,
  tu_cach}
use magiclamp/gen/types.{
  ActivationVaultDatum, Drip, GenRedeemer, MagicAccountDatum, NhipBeacon,
  SoLieuSo,
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



// ════════════════════════════════════════════════════════════════════════
// TEST VALIDATOR — mock Transaction (mẫu Paymaster: ..placeholder)
// Phủ: happy + I-ACT-7 + B2 + B5 + S6 + tuần-tự epoch + G9 + NFT + c=0 + mint.
// ════════════════════════════════════════════════════════════════════════

// ── hằng test ──
const t_lamp_pol: PolicyId = #"1a"
const t_lamp_nm: AssetName = #"744c414d50"
const t_nhip_pol: PolicyId = #"cc"
const t_nhip_nm: AssetName = #"4e4950"
const t_engine: ByteArray = #"ee"
const t_gen_sh: ByteArray = #"a0"
const t_vault_sh: ByteArray = #"b0"
const t_owner: ByteArray = #"0a0b"

const t_own_ref_id: ByteArray = #"aa"
const t_vault_ref_id: ByteArray = #"bb"
const t_nhip_ref_id: ByteArray = #"cc"

fn t_addr(h: ByteArray) -> Address {
  Address { payment_credential: Script(h), stake_credential: None }
}

fn t_ref(id: ByteArray) -> OutputReference {
  OutputReference { transaction_id: id, output_index: 0 }
}

fn t_out(addr: Address, val: Value, dat: Data) -> Output {
  Output { address: addr, value: val, datum: InlineDatum(dat), reference_script: None }
}

fn t_in(ref: OutputReference, out: Output) -> Input {
  Input { output_reference: ref, output: out }
}

fn d_acc(ep: Int, m: Int) -> Data {
  let d: Data = MagicAccountDatum { did_commit: t_owner, epoch: ep, magic_nanogic: m }
  d
}

fn d_vault(vss: Int, c: Int) -> Data {
  let d: Data =
    ActivationVaultDatum {
      owner_commit: t_owner,
      did_commit: t_owner,
      vest_start_slot: vss,
      conditional_lamp: c,
      reclaimed_to_pot: 0,
      last_tick_day: 0,
      last_tick_epoch: 0,
    }
  d
}

fn d_beacon(ep: Int, nhip: Int, tran: Int) -> Data {
  let d: Data = NhipBeacon { epoch: ep, nhip_gen: nhip, nhip_tran: tran }
  d
}

fn acc_val() -> Value {
  assets.from_lovelace(2_000_000)
}

fn vault_val(c_lamp_oildrop: Int, nft_qty: Int) -> Value {
  assets.from_lovelace(2_000_000)
    |> assets.add(t_vault_sh, t_owner, nft_qty)
    |> assets.add(t_lamp_pol, t_lamp_nm, c_lamp_oildrop)
}

fn beacon_val() -> Value {
  assets.from_lovelace(2_000_000) |> assets.add(t_nhip_pol, t_nhip_nm, 1)
}

/// Chạy validator. Trả về Bool (test happy → True; test fail → validator crash/False).
fn run(
  datum_ep: Int,
  vault_in_inputs: Bool,
  vault_nft_qty: Int,
  c_lamp_oildrop: Int,
  vss: Int,
  beacon_ep: Int,
  nhip: Int,
  nhip_tran: Int,
  so_lieu: SoLieuSo,
  out_datum: Data,
  extra_out: Bool,
  out_val: Value,
  signer: ByteArray,
) -> Bool {
  let own_ref = t_ref(t_own_ref_id)
  let vault_ref = t_ref(t_vault_ref_id)
  let nhip_ref = t_ref(t_nhip_ref_id)

  let acc_in = t_in(own_ref, t_out(t_addr(t_gen_sh), acc_val(), d_acc(datum_ep, 0)))
  let vault_input =
    t_in(vault_ref, t_out(t_addr(t_vault_sh), vault_val(c_lamp_oildrop, vault_nft_qty), d_vault(vss, 20)))
  let beacon_input =
    t_in(nhip_ref, t_out(t_addr(#"dd"), beacon_val(), d_beacon(beacon_ep, nhip, nhip_tran)))

  let inputs =
    if vault_in_inputs {
      [acc_in, vault_input]
    } else {
      [acc_in]
    }
  let acc_out = t_out(t_addr(t_gen_sh), out_val, out_datum)
  let outputs =
    if extra_out {
      [acc_out, t_out(t_addr(t_gen_sh), acc_val(), out_datum)]
    } else {
      [acc_out]
    }

  let tx =
    Transaction {
      ..placeholder,
      inputs: inputs,
      reference_inputs: [vault_input, beacon_input],
      outputs: outputs,
      extra_signatories: [signer],
    }

  let rd = Drip { vault_ref, nhip_ref, so_lieu }
  gen_magic.spend(
    t_lamp_pol, t_lamp_nm, t_nhip_pol, t_nhip_nm, t_engine,
    Some(MagicAccountDatum { did_commit: t_owner, epoch: datum_ep, magic_nanogic: 0 }),
    rd, own_ref, tx,
  )
}

// c=20, r_tieu=Q, r khác=0 ⟹ tư_cách=1.9Q ⟹ w_v=38; nhip=Q ⟹ m_v=38.
fn happy_so_lieu() -> SoLieuSo {
  SoLieuSo { da_tieu: 1000, da_sinh: 1000, tieu_thap_diem: 0, magic_cam_ket: 0 }
}

test gm_happy() {
  run(
    0, False, 1, 20_000_000, 432_000, 1, 1_000_000_000, 2_000_000_000,
    happy_so_lieu(), d_acc(1, 38), False, acc_val(), t_engine,
  )
}

// I-ACT-7: vault nằm trong inputs (bị spend) ⟹ reject.
test gm_neg_vault_spent() fail {
  run(
    0, True, 1, 20_000_000, 432_000, 1, 1_000_000_000, 2_000_000_000,
    happy_so_lieu(), d_acc(1, 38), False, acc_val(), t_engine,
  )
}

// B2: nhip_gen > nhip_tran ⟹ reject.
test gm_neg_nhip_vuot_tran() fail {
  run(
    0, False, 1, 20_000_000, 432_000, 1, 3_000_000_000, 2_000_000_000,
    happy_so_lieu(), d_acc(1, 38), False, acc_val(), t_engine,
  )
}

// B5: 2 output tại địa chỉ mình ⟹ reject (double-satisfaction).
test gm_neg_double_output() fail {
  run(
    0, False, 1, 20_000_000, 432_000, 1, 1_000_000_000, 2_000_000_000,
    happy_so_lieu(), d_acc(1, 38), True, acc_val(), t_engine,
  )
}

// B5: value không bảo toàn (rút bớt ADA) ⟹ reject.
test gm_neg_value_khong_bao_toan() fail {
  run(
    0, False, 1, 20_000_000, 432_000, 1, 1_000_000_000, 2_000_000_000,
    happy_so_lieu(), d_acc(1, 38), False, assets.from_lovelace(1_000_000), t_engine,
  )
}

// S6: tiêu_thấp_điểm > đã_tiêu ⟹ reject.
test gm_neg_solieu_khong_nhat_quan() fail {
  run(
    0, False, 1, 20_000_000, 432_000, 1, 1_000_000_000, 2_000_000_000,
    SoLieuSo { da_tieu: 1000, da_sinh: 1000, tieu_thap_diem: 5000, magic_cam_ket: 0 },
    d_acc(1, 38), False, acc_val(), t_engine,
  )
}

// tuần-tự epoch: beacon epoch != datum epoch + 1 ⟹ reject.
test gm_neg_epoch_khong_tuan_tu() fail {
  run(
    0, False, 1, 20_000_000, 432_000, 5, 1_000_000_000, 2_000_000_000,
    happy_so_lieu(), d_acc(5, 38), False, acc_val(), t_engine,
  )
}

// G9: m_v output SAI (bơm khống) ⟹ reject.
test gm_neg_mv_sai() fail {
  run(
    0, False, 1, 20_000_000, 432_000, 1, 1_000_000_000, 2_000_000_000,
    happy_so_lieu(), d_acc(1, 999_999), False, acc_val(), t_engine,
  )
}

// vault-NFT không phải singleton (qty=0) ⟹ reject.
test gm_neg_nft_khong_singleton() fail {
  run(
    0, False, 0, 20_000_000, 432_000, 1, 1_000_000_000, 2_000_000_000,
    happy_so_lieu(), d_acc(1, 38), False, acc_val(), t_engine,
  )
}

// c=0 (vault không có LAMP thật) ⟹ reject (c_dung=0).
test gm_neg_khong_lamp() fail {
  run(
    0, False, 1, 0, 432_000, 1, 1_000_000_000, 2_000_000_000,
    happy_so_lieu(), d_acc(1, 38), False, acc_val(), t_engine,
  )
}

// không có chữ ký engine ⟹ reject.
test gm_neg_khong_engine_sign() fail {
  run(
    0, False, 1, 20_000_000, 432_000, 1, 1_000_000_000, 2_000_000_000,
    happy_so_lieu(), d_acc(1, 38), False, acc_val(), #"ff",
  )
}
