// VaultReadAPI/tests/fixtures/preview-e5fd34b1.ts
//
// DỮ LIỆU THẬT, GHI LẠI TỪ CHUỖI — không phải mẫu bịa.
//
//   mạng      Preview
//   tx        e5fd34b1b58e291437d419b8a7dbd8f0d508a911e722d91dae76a38cf22ebd76
//   ghi lúc   2026-09-11, đọc bằng Blockfrost `/addresses/<vault>/utxos`
//             và `/blocks/latest`
//   nội dung  8 batch ScheduleGen × 8 000 000 nanogic = 64 000 000 nanogic,
//             sinh ở epoch giao thức 20700, `decay_window = 1`
//
// Vì sao GHI LẠI thay vì gọi mạng trong phép kiểm: phép kiểm phải chạy được trên
// máy không có khoá và không có mạng, và phải cho CÙNG kết quả sau khi UTxO này bị
// tiêu. Đây là bản CHÉP CÓ NHÃN — nguồn + ngày ghi nằm ngay bên trên.
//
// 🔴 Cảnh báo đọc nhầm mà chính dữ liệu này gây ra: `decay_window = 1` nghĩa là 8
// batch chỉ sống ở epoch 20700. Hỏi ở epoch 20700 thì `available = 64 000 000`; hỏi
// ở bất cứ epoch nào sau đó thì `available = 0` còn `accrued = 64 000 000`. Cả hai
// câu đều ĐÚNG, và đó chính là lý do mặt tiền trả HAI con số chứ không một.

import type { ChainTip, ChainUtxo } from "../../src/chain.js";

export const PREVIEW_VAULT_ADDRESS =
  "addr_test1wpm2t24x02y7lkqw3f8yyarz5j844x8a3jzsx9wcrv5900cv2wj6x";

/** Payment credential của địa chỉ trên = script hash của vault = policy id của NFT
 *  danh-tính (`ScheduleGen/onchain/validators/vault.ak:100`). */
export const PREVIEW_VAULT_SCRIPT_HASH =
  "76a5aaa67a89efd80e8a4e427462a48f5a98fd8c850315d81b2857bf";

export const PREVIEW_VAULT_ID_UNIT =
  "76a5aaa67a89efd80e8a4e427462a48f5a98fd8c850315d81b2857bf" +
  "f45cfae55ac7f579420d5758cceb15a35f178486d003c31aaa9391a466f181a6";

export const PREVIEW_LAMP_UNIT =
  "28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4744c414d50";

export const PREVIEW_OWNER_PKH =
  "2e5e1418afd402e48232b143876104cac6188a44b867ffb7538318f4";

/** Epoch giao thức mà 8 batch được sinh ra — epoch DUY NHẤT chúng còn sống. */
export const BATCH_EPOCH = 20700n;

/** Σ current_amount của 8 batch. Con số nghiệm thu. */
export const EXPECTED_NANOGIC = 64_000_000n;

export const PREVIEW_VAULT_DATUM_HEX =
  "d8799f581c2e5e1418afd402e48232b143876104cac6188a44b867ffb7538318f41a3baa0c401a001e84809fd8799f1a3b8b87c01950d3d87980ffd8799f1a001e84801950d3d87a80ffff9fd8799f582021f46e3394e9ce982ac69f87c735698a570ef806e90c79189202038b0014ad43d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f5820e98b7b65d5ce0d2fed1e4a3b8a9414ac7a579c69a6c6a999afc40da8a77903f2d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f58200b4143bdb80572430abead060c3fec1e7af3bb0d6a2c41afc3828841a8a7e9d5d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f58200705a8b704e7ef539595b6d248bc9bcbbb6b70425a8fb508dea7a050fff5c37fd87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f5820be1b0aa4ec2742ed2a3b534e550677fed389ffbdc119a7516f6d68f29627a923d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f582021a91bcc18861c5db5cd44516bcc2abe9acfb84436c9548d402a3d43d4c6643fd87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f58205e3b5e1cbf0d05d56e676781a08b36128f981ede328b9f2c106467f0a221c0e1d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f5820eb746affcf518ce94a9ac74545595035b7c9f25730ea4a5b3bcd13aa47cda9f3d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffff08809fd8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3e1950d31950d51950de0a1a000f42401b00000001dcd650001b000000012a05f2001a5f5e100008d87a80ffffd87a8000d87a801950dcd8799f80d87a800000ffd8799f8000ffd8799f0000ffd87a80d8799f400000ffff";

export const PREVIEW_VAULT_UTXO: ChainUtxo = {
  txHash: "e5fd34b1b58e291437d419b8a7dbd8f0d508a911e722d91dae76a38cf22ebd76",
  outputIndex: 0,
  assets: {
    lovelace: 5_659_030n,
    [PREVIEW_LAMP_UNIT]: 1_001_000_000n,
    [PREVIEW_VAULT_ID_UNIT]: 1n,
  },
  inlineDatumHex: PREVIEW_VAULT_DATUM_HEX,
};

/** Đỉnh chuỗi ghi cùng lúc. `time` của Blockfrost là GIÂY; ở đây đã ×1000.
 *  1 789 100 703 000 ÷ 86 400 000 = 20 707 dư 15 903 000 ⇒ epoch giao thức của lượt ghi. */
export const PREVIEW_TIP_AT_RECORD: ChainTip = {
  blockHeight: 4_651_976,
  blockHash: "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f",
  blockTimePosixMs: 1_789_100_703_000n,
};

/** Epoch giao thức tương ứng với `PREVIEW_TIP_AT_RECORD` trên Preview (ms_per_epoch = 86 400 000).
 *  Cùng lúc đó epoch CARDANO của Preview là 1417 — hai đồng hồ, đừng đem so. */
export const TIP_EPOCH_AT_RECORD = 20_707n;

/** Đỉnh chuỗi GIẢ ĐỊNH đặt vào đúng epoch 20700 — để hỏi "lúc đó tiêu được bao nhiêu".
 *  20 700 × 86 400 000 = 1 788 480 000 000 ms. */
export const PREVIEW_TIP_AT_BATCH_EPOCH: ChainTip = {
  blockHeight: 4_651_976,
  blockHash: "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f",
  blockTimePosixMs: 1_788_480_000_000n,
};
