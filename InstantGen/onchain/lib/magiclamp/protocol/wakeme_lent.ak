// lib/magiclamp/protocol/wakeme_lent.ak — đọc L_lent (LAMP-mượn) từ ĐÚNG MỘT két Wakeme
//
// Hàm thuần, CHƯA nối vào validator. Két InstantGen đang sinh đọc két Wakeme của
// chính chủ qua reference input để biết phần LAMP đang nằm ở két Wakeme mà két IG
// được tính như của mình. API chỉ nhận thứ validator đã có trong tay (danh sách
// reference input + apply-param + tên NFT của chính nó + kỳ hiện tại), nên nối vào
// `validators/vault.ak` không phải đổi gì thêm.
//
// ═══ HỢP ĐỒNG NHỊ PHÂN CỦA NHÀ KHÁC — chỉ ĐỌC ═════════════════════════════════
// Nguồn: PhoenixKeyDID/Wakeme ▸ `onchain/lib/phoenixkey/wakeme_logic.ak` ▸
// `pub type WakemeVaultDatum` (13 trường) và `wakeme_src_types.ak` ▸ `pub type GenPin`
// — đối chiếu tại PhoenixKeyDID/Wakeme@4512fe6 (main).
//   [0]  owner_commit      ByteArray 32 byte = tên NFT định danh két
//   [3]  conditional_lamp  Int, oildrop — phần CHƯA chốt, chỉ giảm
//   [7]  owned_lamp        Int, oildrop — phần ĐÃ chốt, chỉ tăng
//   [11] gen_vault         Option<GenPin>: Some = Constr 0 [pin], None = Constr 1 []
//                          GenPin = Constr 0 [hash, name]
//   [12] gen_pin_period    Int — `period(hi)` của lượt Repin/genesis gần nhất
//
// Đọc THEO VỊ TRÍ bằng `un_constr_data`, KHÔNG giải mã bằng một record Aiken: giải mã
// record của Aiken nghiêm ngặt về số trường (BOUNDARIES §2 "Thêm trường ở cuối"),
// mà Wakeme được phép NỐI trường cuối. Chỉ đòi ≥ 13 trường. Cùng khuôn với
// `ConsumeMAGIC/onchain/validators/consume.ak` ▸ `all_vault_owners_are`.
//
// Giá phải biết của cách đọc này: chỉ số trường là cứng. Wakeme mà CHÈN hay BỎ một
// trường đứng trước [12] thì hàm này đọc nhầm ô mà không lệnh nào kêu — mọi đổi
// hình datum bên đó phải kéo theo một lượt soát ở đây.
//
// ═══ LUẬT (fail-closed) ═══════════════════════════════════════════════════════
// 1. Lọc reference input có payment credential == Script(wakeme_vault_hash).
//    Không có ⟹ 0: két IG không ghim Wakeme vẫn sinh, chỉ không có phần mượn.
// 2. ≥ 2 cái ⟹ FAIL: đọc nhiều két là cộng N lần trần.
// 3. Đúng 1 cái ⟹ phải thoả HẾT (a)(b)(c)(e), sai ⟹ FAIL; vế (d) là ngoại lệ:
//    (a) InlineDatum, Constr tag 0, ≥ 13 trường;
//    (b) đúng 1 token dưới policy `wakeme_vault_hash`, số lượng 1, tên == [0],
//        và [0] dài 32 byte;
//    (c) [11] == Some(GenPin{ own_script_hash, own_vault_name });
//    (e) [3] ≥ 0 và [7] ≥ 0;
//    (d) [12] < current_period — sai vế này ⟹ trả 0, KHÔNG fail;
//    (f) lượng LAMP `(lamp_policy, lamp_asset_name)` THẬT trong value của két
//        ≥ [3] + [7] — sai vế này ⟹ trả 0, KHÔNG fail.
//    (d) và (f) là hai ngoại lệ trả 0, cả hai đứng SAU mọi vế fail, nên nhánh 0
//    chỉ đạt được khi mọi vế (a)(b)(c)(e) đã đúng.
// 4. Trả [3] + [7].

use aiken/builtin
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference,
}

/// Số trường tối thiểu của datum két Wakeme v3 (chỉ số cao nhất được đọc là 12).
const wakeme_min_fields: Int = 13

/// Độ dài `owner_commit` = blake2b_256(UTF8(did)).
const owner_commit_len: Int = 32

/// L_lent của két IG `(own_script_hash, own_vault_name)` trong kỳ `current_period`.
///
/// `wakeme_vault_hash` phải là apply-param của validator gọi hàm này, KHÔNG BAO GIỜ lấy
/// từ redeemer hay datum: chọn được hash là chọn được két (một instance Wakeme tự
/// dựng thì NFT, datum, tên đều tự nhất quán theo tham số của nó — chỉ hash CHUẨN mới
/// phân biệt được két thật).
///
/// `current_period` phải cùng thang với `gen_pin_period` bên Wakeme, tức
/// `t / ms_per_epoch` với cùng `ms_per_epoch` của mạng. Phía IG hiện tính
/// `lower_ms / ms_per_epoch` (`get_current_epoch`), phía Wakeme ghi `period(hi)`; cùng
/// độ dài kỳ thì hai bên cùng thang, lệch nhau tối đa ở ranh giới kỳ — và chiều lệch đó
/// chỉ làm vế (d) khó đạt hơn (trả 0), không làm nó dễ hơn.
///
/// `lamp_policy`, `lamp_asset_name` là apply-param #1, #2 của validator gọi hàm này
/// (LAMP của đúng mạng) — dùng cho vế (f), đối chiếu datum với value thật.
pub fn lent_lamp(
  reference_inputs: List<Input>,
  wakeme_vault_hash: ScriptHash,
  own_script_hash: ScriptHash,
  own_vault_name: AssetName,
  current_period: Int,
  lamp_policy: PolicyId,
  lamp_asset_name: AssetName,
) -> Int {
  // Luật 1 — lọc theo payment credential. Phần stake của địa chỉ KHÔNG xét: nó không
  // do validator Wakeme giữ, và không đổi được ai tiêu được UTxO.
  let wakeme_refs =
    list.filter(
      reference_inputs,
      fn(input) {
        input.output.address.payment_credential == Script(wakeme_vault_hash)
      },
    )
  when wakeme_refs is {
    [] -> 0
    [wakeme_ref] ->
      read_one_vault(
        wakeme_ref.output,
        wakeme_vault_hash,
        own_script_hash,
        own_vault_name,
        current_period,
        lamp_policy,
        lamp_asset_name,
      )
    // Luật 2 — hai két trở lên: fail thay vì chọn một, vì "chọn cái đầu" để người dựng
    // tx quyết két nào được đọc bằng thứ tự input.
    _ -> fail @"wakeme_lent: >= 2 wakeme vaults in reference inputs"
  }
}

/// Luật 3 + 4 trên MỘT két đã lọc đúng địa chỉ.
fn read_one_vault(
  vault: Output,
  wakeme_vault_hash: ScriptHash,
  own_script_hash: ScriptHash,
  own_vault_name: AssetName,
  current_period: Int,
  lamp_policy: PolicyId,
  lamp_asset_name: AssetName,
) -> Int {
  // (a) datum inline, Constr 0, ≥ 13 trường. Datum hash / không datum ⟹ fail ở `expect`.
  expect InlineDatum(raw) = vault.datum
  let Pair(tag, fields) = builtin.un_constr_data(raw)
  expect tag == 0
  expect list.length(fields) >= wakeme_min_fields
  expect Some(owner_commit_data) = list.at(fields, 0)
  expect Some(conditional_data) = list.at(fields, 3)
  expect Some(owned_data) = list.at(fields, 7)
  expect Some(gen_vault_data) = list.at(fields, 11)
  expect Some(gen_pin_period_data) = list.at(fields, 12)
  let owner_commit = builtin.un_b_data(owner_commit_data)
  let conditional_lamp = builtin.un_i_data(conditional_data)
  let owned_lamp = builtin.un_i_data(owned_data)
  let gen_pin_period = builtin.un_i_data(gen_pin_period_data)

  // (b) đúng MỘT token dưới policy két, số lượng 1, tên == owner_commit (32 byte).
  // Mẫu `[Pair(name, 1)]` chặn cùng lúc: thiếu NFT, số lượng ≠ 1, và tên thứ hai dưới
  // cùng policy. NFT dưới policy CHUẨN là thứ phân biệt két thật với output ai cũng
  // gửi được tới địa chỉ script kèm datum bịa (không validator nào chạy lúc tạo UTxO).
  expect [Pair(nft_name, 1)] =
    dict.to_pairs(assets.tokens(vault.value, wakeme_vault_hash))
  expect builtin.length_of_bytearray(owner_commit) == owner_commit_len
  expect nft_name == owner_commit

  // (c) két Wakeme ghim ĐÚNG két IG này. Chỉ chính chủ DID đổi được ghim (Repin ký
  // 2-of-2 qua anchor), nên đây là chỗ chủ két Wakeme đồng ý cho két IG này mượn.
  // So nguyên khối Data: GenPin mà đổi hình (thêm trường) thì fail thay vì đọc lệch.
  let expected_pin: Data =
    builtin.constr_data(
      0,
      [
        builtin.constr_data(
          0,
          [builtin.b_data(own_script_hash), builtin.b_data(own_vault_name)],
        ),
      ],
    )
  expect builtin.equals_data(gen_vault_data, expected_pin)

  // (e) hai lượng không âm.
  expect conditional_lamp >= 0
  expect owned_lamp >= 0

  // (d) ghim trong CHÍNH kỳ đang sinh thì kỳ đó không được tính — chặn Repin xoay
  // vòng một két Wakeme qua nhiều két IG trong một kỳ (Wakeme giới hạn Repin một lần
  // mỗi kỳ, nhưng ghim kỳ e rồi sinh ở kỳ e vẫn cho két IG MỚI ăn trọn kỳ e).
  // Sai vế này thì trả 0, KHÔNG fail: người dùng vừa Repin vẫn phải sinh được phần
  // LAMP riêng của két IG trong kỳ đó. Mọi vế khác đã kiểm ở trên, nên nhánh 0 này
  // chỉ đạt được khi mọi vế fail đều đúng.
  let lent = conditional_lamp + owned_lamp
  if gen_pin_period >= current_period {
    0
  } else {
    // (f) datum phải được value THẬT của két đỡ. Bất biến "datum khớp value" là lời
    // hứa của MỘT hash két Wakeme — validator sau hash đó giữ lời hứa, không ai khác.
    // Hash két đổi sau một lượt di trú thì hàm đọc này không còn biết bản mới có giữ
    // lời hứa ấy không; vế này giữ cho con số trả về không bao giờ vượt LAMP đang nằm
    // THẬT trong két, bất kể bên kia ghi gì vào datum.
    // Thiếu ⟹ trả 0, KHÔNG fail: két IG vẫn sinh được phần LAMP riêng của nó. Dư ⟹
    // trả đúng số datum khai, KHÔNG trả phần dư (ai cũng gửi thêm LAMP vào két được).
    let lamp_held = assets.quantity_of(vault.value, lamp_policy, lamp_asset_name)
    if lamp_held < lent {
      0
    } else {
      lent
    }
  }
}

// ═══ BÀI KIỂM ═════════════════════════════════════════════════════════════════
// Mọi ca dựng từ `vault_input(vault_fields(..), ..)` và đổi ĐÚNG MỘT vế so với ca
// dương `t_one_valid_vault`. Hai lượng dùng số khác nhau (700_000_000 và
// 301_000_000) để ca "chỉ đọc một trường" không trùng kết quả với ca đúng.

/// Hash thật của két Wakeme trên Preprod.
const t_wakeme_hash: ByteArray =
  #"cc62732565af6be1e0874975ad3b3e2afdb0abafb3f5bc4b3008f4e1"

/// Script khác (dùng cho ca "két ở script khác").
const t_other_hash: ByteArray =
  #"dd62732565af6be1e0874975ad3b3e2afdb0abafb3f5bc4b3008f4e1"

/// Hash script két IG đang sinh (== policy NFT vault-id).
const t_ig_hash: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

/// Tên NFT vault-id của két IG đang sinh.
const t_ig_name: ByteArray =
  #"b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"

/// owner_commit (32 byte) = tên NFT két Wakeme.
const t_owner_commit: ByteArray =
  #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"

/// owner_commit thứ hai, dùng cho ca "hai két hợp lệ".
const t_owner_commit_2: ByteArray =
  #"c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4"

const t_conditional: Int = 700_000_000

const t_owned: Int = 301_000_000

const t_current_period: Int = 100

/// LAMP của mạng kiểm thử (apply-param #1, #2 của validator gọi).
const t_lamp_policy: ByteArray =
  #"e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1"

const t_lamp_name: ByteArray = #"744c414d50"

fn t_pin(hash: ByteArray, name: ByteArray) -> Data {
  builtin.constr_data(
    0,
    [builtin.constr_data(0, [builtin.b_data(hash), builtin.b_data(name)])],
  )
}

fn t_none() -> Data {
  builtin.constr_data(1, [])
}

/// 13 trường datum két Wakeme v3, theo đúng thứ tự `WakemeVaultDatum`.
fn vault_fields(
  owner_commit: ByteArray,
  conditional_lamp: Int,
  owned_lamp: Int,
  gen_vault: Data,
  gen_pin_period: Int,
) -> List<Data> {
  [
    builtin.b_data(owner_commit),
    // [1] usage_thread
    builtin.b_data(#"e5e5"),
    // [2] vest_start_ms
    builtin.i_data(1_700_000_000_000),
    // [3] conditional_lamp
    builtin.i_data(conditional_lamp),
    // [4] reclaimed_to_pot
    builtin.i_data(0),
    // [5] epochy_start
    builtin.i_data(50),
    // [6] last_used_period
    builtin.i_data(49),
    // [7] owned_lamp
    builtin.i_data(owned_lamp),
    // [8] d_unit
    builtin.i_data(1_000_000),
    // [9] seen_nanogic
    builtin.i_data(0),
    // [10] usage_consume_hash
    builtin.b_data(#"f6f6"),
    // [11] gen_vault
    gen_vault,
    // [12] gen_pin_period
    builtin.i_data(gen_pin_period),
  ]
}

fn good_fields() -> List<Data> {
  vault_fields(
    t_owner_commit,
    t_conditional,
    t_owned,
    t_pin(t_ig_hash, t_ig_name),
    t_current_period - 1,
  )
}

fn vault_input(
  index: Int,
  script_hash: ByteArray,
  datum: transaction.Datum,
  value: assets.Value,
) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"0000000000000000000000000000000000000000000000000000000000000009",
      output_index: index,
    },
    output: Output {
      address: Address {
        payment_credential: Script(script_hash),
        stake_credential: None,
      },
      value,
      datum,
      reference_script: None,
    },
  }
}

/// Value két mặc định: NFT + ĐÚNG `t_conditional + t_owned` LAMP (vế f đạt vừa khít).
fn nft_value(policy: ByteArray, name: ByteArray, quantity: Int) -> assets.Value {
  lamp_value(policy, name, quantity, t_conditional + t_owned)
}

fn lamp_value(
  policy: ByteArray,
  name: ByteArray,
  quantity: Int,
  lamp: Int,
) -> assets.Value {
  assets.from_lovelace(5_000_000)
    |> assets.add(policy, name, quantity)
    |> assets.add(t_lamp_policy, t_lamp_name, lamp)
}

fn inline(tag: Int, fields: List<Data>) -> transaction.Datum {
  InlineDatum(builtin.constr_data(tag, fields))
}

fn good_input() -> Input {
  vault_input(
    0,
    t_wakeme_hash,
    inline(0, good_fields()),
    nft_value(t_wakeme_hash, t_owner_commit, 1),
  )
}

fn run(refs: List<Input>) -> Int {
  lent_lamp(
    refs,
    t_wakeme_hash,
    t_ig_hash,
    t_ig_name,
    t_current_period,
    t_lamp_policy,
    t_lamp_name,
  )
}

// ── Vế (f): datum phải được value THẬT đỡ ───────────────────────────────────────
// Các ca chỉ khác lượng / policy LAMP trong value két; datum giữ nguyên `good_fields()`.

fn lamp_input(lamp: Int) -> Input {
  vault_input(
    0,
    t_wakeme_hash,
    inline(0, good_fields()),
    lamp_value(t_wakeme_hash, t_owner_commit, 1, lamp),
  )
}

test t_value_equals_sum_counts() {
  run([lamp_input(t_conditional + t_owned)]) == t_conditional + t_owned
}

test t_value_short_one_oildrop_is_zero() {
  run([lamp_input(t_conditional + t_owned - 1)]) == 0
}

// Dư LAMP ⟹ trả số DATUM khai, không trả số trong value.
test t_value_excess_counts_datum_only() {
  run([lamp_input(t_conditional + t_owned + 5_000_000)]) == t_conditional + t_owned
}

// LAMP dưới policy KHÁC (cùng tên) không được tính: vế (f) so cặp (policy, tên).
test t_value_lamp_wrong_policy_is_zero() {
  let v =
    assets.from_lovelace(5_000_000)
      |> assets.add(t_wakeme_hash, t_owner_commit, 1)
      |> assets.add(t_other_hash, t_lamp_name, t_conditional + t_owned)
  run([vault_input(0, t_wakeme_hash, inline(0, good_fields()), v)]) == 0
}

// Vế (f) là ngoại lệ trả 0, KHÔNG che vế fail: thiếu LAMP + ghim két khác ⟹ fail.
test t_value_short_and_wrong_pin_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit,
          t_conditional,
          t_owned,
          t_pin(t_other_hash, t_ig_name),
          t_current_period - 1,
        ),
      ),
      lamp_value(t_wakeme_hash, t_owner_commit, 1, 0),
    )
  run([input]) == 0
}

/// Input không liên quan (ví thường) — để danh sách reference input không chỉ có két.
fn noise_input() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"0000000000000000000000000000000000000000000000000000000000000008",
      output_index: 0,
    },
    output: Output {
      address: Address {
        payment_credential: VerificationKey(
          #"0101010101010101010101010101010101010101010101010101010101",
        ),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// ── Luật 1: không két ⟹ 0; một két hợp lệ ⟹ conditional + owned ─────────────────

test t_no_vault_is_zero() {
  run([noise_input()]) == 0
}

test t_empty_reference_inputs_is_zero() {
  run([]) == 0
}

test t_one_valid_vault() {
  run([noise_input(), good_input()]) == t_conditional + t_owned
}

// Hành vi LỌC, không phải từ chối: két mang đúng NFT Wakeme nhưng nằm ở script khác
// không phải két Wakeme ⟹ không được đếm. Cặp với `t_one_valid_vault`: chỉ khác hash
// địa chỉ.
test t_vault_at_other_script_not_counted() {
  let decoy =
    vault_input(
      0,
      t_other_hash,
      inline(0, good_fields()),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([decoy]) == 0
}

// Két lạc ở script khác KHÔNG tính vào phép đếm ≥ 2 của luật 2.
test t_other_script_does_not_count_toward_two() {
  let decoy =
    vault_input(
      1,
      t_other_hash,
      inline(0, good_fields()),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([good_input(), decoy]) == t_conditional + t_owned
}

// ── Luật 2: hai két hợp lệ ⟹ fail ───────────────────────────────────────────────

test t_two_valid_vaults_fail() fail {
  let second =
    vault_input(
      1,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit_2,
          t_conditional,
          t_owned,
          t_pin(t_ig_hash, t_ig_name),
          t_current_period - 1,
        ),
      ),
      nft_value(t_wakeme_hash, t_owner_commit_2, 1),
    )
  run([good_input(), second]) > 0
}

// ── Vế (b): NFT ────────────────────────────────────────────────────────────────

test t_nft_wrong_policy_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(0, good_fields()),
      nft_value(t_other_hash, t_owner_commit, 1),
    )
  run([input]) > 0
}

test t_nft_name_not_owner_commit_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(0, good_fields()),
      nft_value(t_wakeme_hash, t_owner_commit_2, 1),
    )
  run([input]) > 0
}

test t_nft_quantity_two_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(0, good_fields()),
      nft_value(t_wakeme_hash, t_owner_commit, 2),
    )
  run([input]) > 0
}

test t_nft_missing_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(0, good_fields()),
      assets.from_lovelace(5_000_000),
    )
  run([input]) > 0
}

// Tên hợp lệ ĐỨNG TRƯỚC (c3.. < c4..) rồi thêm một tên thứ hai dưới cùng policy: ca
// này mới ghim được "đúng MỘT token", vì bản đọc "lấy tên đầu" vẫn trúng tên hợp lệ.
test t_nft_second_name_same_policy_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(0, good_fields()),
      nft_value(t_wakeme_hash, t_owner_commit, 1)
        |> assets.add(t_wakeme_hash, t_owner_commit_2, 1),
    )
  run([input]) > 0
}

// owner_commit 31 byte, NFT cùng tên 31 byte: chỉ vế độ dài chặn.
test t_owner_commit_not_32_bytes_fail() fail {
  let short = #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          short,
          t_conditional,
          t_owned,
          t_pin(t_ig_hash, t_ig_name),
          t_current_period - 1,
        ),
      ),
      nft_value(t_wakeme_hash, short, 1),
    )
  run([input]) > 0
}

// ── Vế (c): ghim két IG ────────────────────────────────────────────────────────

test t_gen_vault_none_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit,
          t_conditional,
          t_owned,
          t_none(),
          t_current_period - 1,
        ),
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) > 0
}

test t_gen_vault_other_hash_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit,
          t_conditional,
          t_owned,
          t_pin(t_other_hash, t_ig_name),
          t_current_period - 1,
        ),
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) > 0
}

test t_gen_vault_other_name_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit,
          t_conditional,
          t_owned,
          t_pin(t_ig_hash, t_owner_commit_2),
          t_current_period - 1,
        ),
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) > 0
}

// ── Vế (d): kỳ ghim ────────────────────────────────────────────────────────────

test t_pinned_this_period_is_zero() {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit,
          t_conditional,
          t_owned,
          t_pin(t_ig_hash, t_ig_name),
          t_current_period,
        ),
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) == 0
}

test t_pinned_previous_period_counts() {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit,
          t_conditional,
          t_owned,
          t_pin(t_ig_hash, t_ig_name),
          t_current_period - 1,
        ),
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) == t_conditional + t_owned
}

// Ngoại lệ (d) chỉ áp khi CHỈ vế (d) sai: (d) sai cộng (c) sai ⟹ vẫn fail, không 0.
test t_pinned_this_period_and_wrong_pin_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit,
          t_conditional,
          t_owned,
          t_pin(t_other_hash, t_ig_name),
          t_current_period,
        ),
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) >= 0
}

// ── Vế (a): hình datum ─────────────────────────────────────────────────────────

test t_datum_not_inline_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      transaction.DatumHash(
        #"0000000000000000000000000000000000000000000000000000000000000007",
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) > 0
}

test t_datum_constr_tag_1_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(1, good_fields()),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) > 0
}

test t_datum_12_fields_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(0, list.take(good_fields(), 12)),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) > 0
}

// Wakeme nối thêm trường cuối ⟹ vẫn đọc đúng.
test t_datum_15_fields_ok() {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        list.concat(good_fields(), [builtin.i_data(42), builtin.b_data(#"ab")]),
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) == t_conditional + t_owned
}

// ── Vế (e): lượng không âm ─────────────────────────────────────────────────────

test t_conditional_negative_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit,
          -1,
          t_owned,
          t_pin(t_ig_hash, t_ig_name),
          t_current_period - 1,
        ),
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) != 0
}

test t_owned_negative_fail() fail {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit,
          t_conditional,
          -1,
          t_pin(t_ig_hash, t_ig_name),
          t_current_period - 1,
        ),
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) != 0
}

// Hai lượng bằng 0 là hợp lệ (biên của vế e): cặp dương của hai ca âm trên.
test t_zero_amounts_ok() {
  let input =
    vault_input(
      0,
      t_wakeme_hash,
      inline(
        0,
        vault_fields(
          t_owner_commit,
          0,
          0,
          t_pin(t_ig_hash, t_ig_name),
          t_current_period - 1,
        ),
      ),
      nft_value(t_wakeme_hash, t_owner_commit, 1),
    )
  run([input]) == 0
}

// ── Đối chiếu mã hoá: record Aiken cùng hình `WakemeVaultDatum` ─────────────────
// Dựng datum bằng một record có kiểu (Option<GenPin> thật) thay vì bằng tay, để chứng
// minh cách đọc theo vị trí khớp với cách Aiken mã hoá record + Option ở phía Wakeme.

type MirrorGenPin {
  hash: ByteArray,
  name: ByteArray,
}

type MirrorWakemeVaultDatum {
  owner_commit: ByteArray,
  usage_thread: ByteArray,
  vest_start_ms: Int,
  conditional_lamp: Int,
  reclaimed_to_pot: Int,
  epochy_start: Int,
  last_used_period: Int,
  owned_lamp: Int,
  d_unit: Int,
  seen_nanogic: Int,
  usage_consume_hash: ByteArray,
  gen_vault: Option<MirrorGenPin>,
  gen_pin_period: Int,
}

fn mirror_input(gen_vault: Option<MirrorGenPin>) -> Input {
  let d: Data =
    MirrorWakemeVaultDatum {
      owner_commit: t_owner_commit,
      usage_thread: #"e5e5",
      vest_start_ms: 1_700_000_000_000,
      conditional_lamp: t_conditional,
      reclaimed_to_pot: 0,
      epochy_start: 50,
      last_used_period: 49,
      owned_lamp: t_owned,
      d_unit: 1_000_000,
      seen_nanogic: 0,
      usage_consume_hash: #"f6f6",
      gen_vault,
      gen_pin_period: t_current_period - 1,
    }
  vault_input(
    0,
    t_wakeme_hash,
    InlineDatum(d),
    nft_value(t_wakeme_hash, t_owner_commit, 1),
  )
}

test t_typed_record_encoding_ok() {
  run([mirror_input(Some(MirrorGenPin { hash: t_ig_hash, name: t_ig_name }))]) == t_conditional + t_owned
}

test t_typed_record_none_fail() fail {
  run([mirror_input(None)]) > 0
}
