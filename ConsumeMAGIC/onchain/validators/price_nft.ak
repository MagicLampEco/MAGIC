// PriceParam authenticity NFT — minting policy ONE-SHOT (CONTRACT.md §B1).
//
// Beacon UTxO PriceParam cần đúng 1 authenticity NFT để chống datum hijacking:
// kẻ tấn công tạo UTxO giả tại beacon address với datum giá bịa, nhưng KHÔNG
// mint được NFT này → consume validator chỉ tin UTxO mang NFT (xác thực policy).
//
// FIRST-PRINCIPLES one-shot: policy parameterized bởi 1 genesis OutputReference.
// 1 UTxO spend tối đa 1 lần → policy chạy tối đa 1 lần → supply NFT cố định, KHÔNG
// re-mint, KHÔNG burn (else(_) fail chặn mọi mint âm + purpose khác).

use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}
use magiclamp/consume/pricing
use magiclamp/consume/types.{MintGenesis, NftRedeemer, OpPrice, PriceParam}
use magiclamp/consume/util

/// Asset name của PriceParam beacon NFT = "PRICE".
pub const price_nft_name: ByteArray = #"5052494345"

validator price_nft(genesis_ref: OutputReference) {
  mint(_redeemer: NftRedeemer, policy_id: PolicyId, tx: Transaction) {
    // ONE-SHOT: phải consume đúng UTxO genesis.
    expect list.any(tx.inputs, fn(i) { i.output_reference == genesis_ref })

    // Mint chứa ĐÚNG 1 asset name của policy này, qty +1 (không thừa, không âm).
    let own_tokens = assets.tokens(tx.mint, policy_id)
    expect dict.size(own_tokens) == 1
    expect assets.quantity_of(tx.mint, policy_id, price_nft_name) == 1

    // ── CỔNG GENESIS CỦA BẢNG GIÁ (thêm 2026-09-25) ───────────────────────────
    //    LỖ ĐÃ VÁ: `price_param` chỉ chạy khi beacon bị TIÊU (PostPrice). Bảng giá
    //    ĐẦU TIÊN chưa bao giờ đi qua validator nào — Cardano không chạy validator
    //    lúc TẠO UTxO — nên `valid_param` không hề canh nó. Beacon genesis đặt được
    //    `m_max` khổng lồ, `base_price` = 0 (drain miễn phí), hoặc dòng `op_type = 7`
    //    có `demand_mult != q`, và mọi `consume` sau đó đọc bảng ấy như bảng có thẩm
    //    quyền. Đây là ĐÚNG khoảnh khắc duy nhất ép được, cùng lý lẽ với
    //    `validate_mint_engage_id` bên `consume.ak`.
    //
    //    KHÔNG ép ĐỊA CHỈ của output này — có chủ ý, và đây là ràng buộc cứng chứ
    //    không phải lựa chọn phong cách: `price_param` nhận policy của `price_nft`
    //    làm apply-param, nên `price_nft` mà nhận `price_param_script_hash` ngược lại
    //    là một vòng apply-param (fixed-point blake2b) ⇒ KHÔNG deploy được. Chuỗi
    //    phải giữ TUYẾN TÍNH: price_nft → price_param → consume. Vế địa chỉ đã được
    //    `consume.ak` ▸ `read_price_param` giữ ở phía ĐỌC, nên nó không bị bỏ trống.
    //
    //    Hiệu lực: chỉ cho beacon đúc MỚI. Beacon cũ không bị (và không thể) hồi tố —
    //    nhưng lược đồ `PriceParam` vừa đổi (`OpPrice` 3 trường) nên mọi beacon đang
    //    sống đằng nào cũng phải đúc lại, và hash `price_nft` đổi theo không tốn thêm.
    expect [beacon_out] =
      list.filter(
        tx.outputs,
        fn(o) { assets.quantity_of(o.value, policy_id, price_nft_name) == 1 },
      )
    expect InlineDatum(beacon_data) = beacon_out.datum
    expect pp: PriceParam = beacon_data
    pricing.valid_param(pp)
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

const pn_policy: PolicyId = #"9999"

fn pn_genesis_ref() -> OutputReference {
  util.mk_ref_id(#"aa", 3)
}

fn pn_genesis_input() {
  util.mk_input(
    pn_genesis_ref(),
    util.mk_output_no_datum(util.vk_address(#"a0"), assets.from_lovelace(2_000_000)),
  )
}

/// Bảng giá HỢP LỆ tối thiểu: hai dòng op_type TĂNG NGẶT, `base_price × m_min ≥ q`,
/// `demand_mult` trong band. Không có dòng `op_type = 7` nên luật giá-cố-định không
/// nói gì ở đây — ca đó có bài riêng bên `pricing.ak`.
fn pn_pp_ok() -> PriceParam {
  PriceParam {
    op_prices: [
      OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: 1_000_000_000 },
      OpPrice { op_type: 2, base_price: 1_000_000, demand_mult: 1_200_000_000 },
    ],
    m_min: 500_000_000,
    m_max: 2_000_000_000,
    epoch: 0,
  }
}

/// Output mang beacon NFT với datum tuỳ ý (Data — để dựng được cả ca không decode được).
fn pn_beacon_out(d: Data) -> Output {
  util.mk_output(
    util.script_address(#"feed"),
    assets.add(assets.from_lovelace(2_000_000), pn_policy, price_nft_name, 1),
    d,
  )
}

fn pn_run(inputs: List<Input>, mint_v: Value, outputs: List<Output>) -> Bool {
  let tx = Transaction { ..placeholder, inputs: inputs, mint: mint_v, outputs: outputs }
  price_nft.mint(pn_genesis_ref(), MintGenesis, pn_policy, tx)
}

test price_nft_happy() {
  pn_run(
    [pn_genesis_input()],
    assets.from_asset(pn_policy, price_nft_name, 1),
    [pn_beacon_out(pn_pp_ok())],
  )
}

test price_nft_no_genesis() fail {
  pn_run(
    [
      util.mk_input(
        util.mk_ref(0),
        util.mk_output_no_datum(util.vk_address(#"a0"), assets.from_lovelace(2_000_000)),
      ),
    ],
    assets.from_asset(pn_policy, price_nft_name, 1),
    [pn_beacon_out(pn_pp_ok())],
  )
}

test price_nft_wrong_qty() fail {
  pn_run(
    [pn_genesis_input()],
    assets.from_asset(pn_policy, price_nft_name, 2),
    [pn_beacon_out(pn_pp_ok())],
  )
}

// ══════════════════════════════════════════════════════════════
// CỔNG GENESIS BẢNG GIÁ (2026-09-25) — cặp dương/âm cho từng chốt
// ══════════════════════════════════════════════════════════════

// ── ÂM: band ESCAPE ở chính beacon ĐẦU TIÊN ───────────────────────────────────
//    `m_max` khổng lồ. Trước cổng này ca đó PASS, và mọi `consume` sau đó đọc bảng ấy
//    như bảng có thẩm quyền — `pricing.valid_param` chỉ chạy ở đường TIÊU beacon, mà
//    beacon genesis chưa từng bị tiêu lần nào.
test price_nft_datum_band_escape_fail() fail {
  let pp = PriceParam { ..pn_pp_ok(), m_max: 999_000_000_000 }
  pn_run(
    [pn_genesis_input()],
    assets.from_asset(pn_policy, price_nft_name, 1),
    [pn_beacon_out(pp)],
  )
}

// ── ÂM: `demand_mult` của MỘT DÒNG nằm ngoài band ─────────────────────────────
//    Band vẫn ghim đúng hằng; chỗ hỏng nằm ở dòng. Ca này phân biệt được cổng
//    "pin m_min/m_max" với cổng "band theo từng dòng" — hai chốt khác nhau.
test price_nft_datum_line_out_of_band_fail() fail {
  let pp =
    PriceParam {
      ..pn_pp_ok(),
      op_prices: [
        OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: 3_000_000_000 },
      ],
    }
  pn_run(
    [pn_genesis_input()],
    assets.from_asset(pn_policy, price_nft_name, 1),
    [pn_beacon_out(pp)],
  )
}

// ── ÂM: datum KHÔNG decode được thành PriceParam ──────────────────────────────
//    Fail-closed. Beacon với datum rác vẫn mang NFT thật, nên mọi bên đọc theo NFT
//    sẽ tin nó — và `read_price_param` phía consume chết ở `expect pp: PriceParam`,
//    tức bảng giá hỏng biến thành DoS cho toàn bộ đường tiêu thay vì bị chặn tại nguồn.
test price_nft_datum_not_decodable_fail() fail {
  pn_run(
    [pn_genesis_input()],
    assets.from_asset(pn_policy, price_nft_name, 1),
    [pn_beacon_out(42)],
  )
}

// ── ÂM: NFT đúc ra KHÔNG neo vào output nào (đi đâu không rõ) ─────────────────
//    `expect [beacon_out]` fail-closed trên list rỗng: không có output mang NFT thì
//    không có datum nào để kiểm, và một beacon "sẽ đặt sau" là beacon chưa bao giờ
//    qua cổng.
test price_nft_no_carrier_output_fail() fail {
  pn_run(
    [pn_genesis_input()],
    assets.from_asset(pn_policy, price_nft_name, 1),
    [],
  )
}

// ── ÂM: datum KHÔNG inline (chỉ có hash / không có) ───────────────────────────
test price_nft_no_inline_datum_fail() fail {
  pn_run(
    [pn_genesis_input()],
    assets.from_asset(pn_policy, price_nft_name, 1),
    [
      util.mk_output_no_datum(
        util.script_address(#"feed"),
        assets.add(assets.from_lovelace(2_000_000), pn_policy, price_nft_name, 1),
      ),
    ],
  )
}
