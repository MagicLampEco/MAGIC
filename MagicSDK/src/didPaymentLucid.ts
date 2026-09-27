// MagicSDK/src/didPaymentLucid.ts — nối cổng Lucid cho việc nạp tài sản từ ví Phoenix
// (script `did_payment`).
//
// Chính sách (so hash, chọn UTxO, phần thối) nằm ở `@magiclamp/protocol-utils` ▸
// `didPaymentFunding`. Tệp này chỉ cấp ba phép tính cần Lucid: băm script PlutusV3, đọc
// payment credential của địa chỉ, và min-ADA của output thối.
//
// min-ADA tính ĐÚNG cách `pay.ToAddress` của Lucid Evolution 0.4.30 tính (dựng output bằng
// `with_asset_and_min_required_coin`). Lý do đo được, không phải sở thích: `pay.ToAddress`
// nhận một lượng lovelace THẤP hơn mức nó tính thì âm thầm NÂNG lên, và phần nâng lấy từ ví
// đang chọn — tức ví trả phí. Tính cùng một công thức thì không có phần nâng nào.

import {
  CML, assetsToValue, getAddressDetails, validatorToScriptHash, type UTxO,
} from "@lucid-evolution/lucid";
import type { DidPaymentPorts } from "@magiclamp/protocol-utils";

export function didPaymentLucidPorts(coinsPerUtxoByte: bigint): DidPaymentPorts {
  if (typeof coinsPerUtxoByte !== "bigint" || coinsPerUtxoByte <= 0n) {
    throw new Error(`didPaymentLucidPorts: coinsPerUtxoByte phải là bigint > 0 (nhận ${String(coinsPerUtxoByte)}).`);
  }
  return {
    scriptHashOf: (cbor) => validatorToScriptHash({ type: "PlutusV3", script: cbor }),
    paymentCredentialOf: (address) => {
      const c = getAddressDetails(address).paymentCredential;
      if (c === undefined) throw new Error("địa chỉ không có payment credential");
      return { type: c.type, hash: c.hash };
    },
    minLovelaceFor: (address, assets) =>
      CML.TransactionOutputBuilder.new()
        .with_address(CML.Address.from_bech32(address))
        .next()
        .with_asset_and_min_required_coin(assetsToValue(assets).multi_asset(), coinsPerUtxoByte)
        .build()
        .output()
        .amount()
        .coin(),
  };
}

/**
 * Nguồn nạp `did_payment` cho `createVault`. Ví đang chọn trên `lucid` là VÍ TRẢ PHÍ (khoá
 * ký): nó trả phí, làm tài sản thế chấp và nhận tiền thối ADA của CHÍNH nó. LAMP + min-ADA
 * của output vault lấy từ `utxos` ở `address`; phần thối của chúng về lại `address`.
 */
export interface DidPaymentFundingInput {
  /** CBOR `did_payment` ĐÃ apply `(anchor_nft_policy, blake2b_256(utf8(did)))`. */
  didPaymentScriptCbor: string;
  /** Địa chỉ ví Phoenix (payment credential `Script(h)`). */
  address: string;
  /** Mọi UTxO đang ở `address` — bộ dựng chọn tối thiểu từ đây. */
  utxos: UTxO[];
  /** UTxO anchor DID — reference input của `did_payment`. */
  anchorRefUtxo: UTxO;
  controllerPkh: string;
  deviceKeyHash: string;
  /**
   * Ai trả phí. Vắng hoặc `"wallet"` ⟹ hành vi cũ: ví đang chọn trả phí, làm thế chấp, làm
   * seed, nhận tiền thối ADA của chính nó.
   *
   * `"did_payment"` (opt-in) ⟹ ví Phoenix trả TẤT CẢ: LAMP, min-ADA vault và PHÍ; tiền thối về
   * `address`. Seed NFT két là một UTxO `did_payment` trong tập đã chọn. Ví đang chọn chỉ làm
   * THẾ CHẤP bằng đúng `collateralUtxo`, `collateral_return` về lại địa chỉ ví đó; nó không
   * góp input tiêu nào, không nhận output nào.
   */
  feeSource?: "wallet" | "did_payment";
  /** BẮT BUỘC khi `feeSource = "did_payment"`, CẤM ở chế độ khác: UTxO thuần ADA của ví đang
   *  chọn, dành riêng làm thế chấp. */
  collateralUtxo?: UTxO;
  /** Chỉ ở `feeSource = "did_payment"`: lovelace giữ chỗ cho phí lúc CHỌN UTxO did_payment.
   *  Phí thật đo sau khi dựng; nó vượt phần giữ chỗ ⟹ `FUNDING_INSUFFICIENT`. Mặc định
   *  `DID_PAYMENT_FEE_HEADROOM_LOVELACE`. */
  feeHeadroomLovelace?: bigint;
}

/**
 * Phần giữ chỗ phí mặc định khi ví Phoenix tự trả phí. Nó chỉ ảnh hưởng việc CHỌN UTxO (kéo thêm
 * UTxO nếu tập đang chọn không đủ phí + min-ADA phần thối); phí thật vẫn là phí đo được, phần dư
 * về lại ví Phoenix. Giao dịch tạo vault đính inline hai script (vault + did_payment) nên phí cỡ
 * 1 ADA; 3 ADA là biên an toàn, không phải một con số đo.
 */
export const DID_PAYMENT_FEE_HEADROOM_LOVELACE = 3_000_000n;
