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

import { Constr, Data } from "@lucid-evolution/lucid";
import { VAULT_DATUM_FIELD_COUNTS } from "@magiclamp/sdk";

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

/** ⚠ Đây KHÔNG phải LAMP, dù asset name hex `744c414d50` hiện ra chữ `tLAMP`.
 *
 * Policy `28e916b0…` là chính sách chữ-ký-đơn suy từ khoá ví deploy — không trần
 * phát hành, không `SupplyState`, đã có lúc cung lên gấp đôi mức hiến định 36 tỷ.
 * Giữ nguyên ở đây vì đây là ẢNH CHỤP một UTxO CÓ THẬT trên Preview: đổi giá trị
 * này là làm fixture không còn khớp thứ nó chụp. Nhưng đừng chép nó sang chỗ khác,
 * và đừng đọc một bài kiểm xanh ở đây thành "đường LAMP đã thông".
 */
export const PREVIEW_LAMP_UNIT =
  "28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4744c414d50";

export const PREVIEW_OWNER_PKH =
  "2e5e1418afd402e48232b143876104cac6188a44b867ffb7538318f4";

/** Epoch giao thức mà 8 batch được sinh ra — epoch DUY NHẤT chúng còn sống. */
export const BATCH_EPOCH = 20700n;

/** Σ current_amount của 8 batch. Con số nghiệm thu. */
export const EXPECTED_NANOGIC = 64_000_000n;

/** Datum NGUYÊN VĂN như ghi từ chuỗi 2026-09-11 — lược đồ CŨ (trường 0 = pkh trần).
 *  Validator hiện hành (`owner: Credential`) không đọc được hình dạng này; bài kiểm dùng
 *  nó làm ca ÂM. Đừng sửa chuỗi này: nó là bằng chứng, không phải mẫu. */
export const PREVIEW_VAULT_DATUM_HEX_RECORDED =
  "d8799f581c2e5e1418afd402e48232b143876104cac6188a44b867ffb7538318f41a3baa0c401a001e84809fd8799f1a3b8b87c01950d3d87980ffd8799f1a001e84801950d3d87a80ffff9fd8799f582021f46e3394e9ce982ac69f87c735698a570ef806e90c79189202038b0014ad43d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f5820e98b7b65d5ce0d2fed1e4a3b8a9414ac7a579c69a6c6a999afc40da8a77903f2d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f58200b4143bdb80572430abead060c3fec1e7af3bb0d6a2c41afc3828841a8a7e9d5d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f58200705a8b704e7ef539595b6d248bc9bcbbb6b70425a8fb508dea7a050fff5c37fd87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f5820be1b0aa4ec2742ed2a3b534e550677fed389ffbdc119a7516f6d68f29627a923d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f582021a91bcc18861c5db5cd44516bcc2abe9acfb84436c9548d402a3d43d4c6643fd87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f58205e3b5e1cbf0d05d56e676781a08b36128f981ede328b9f2c106467f0a221c0e1d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffd8799f5820eb746affcf518ce94a9ac74545595035b7c9f25730ea4a5b3bcd13aa47cda9f3d87c801950dc1a007a12001a007a120001d87a80d8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3effd87980ffff08809fd8799f582088ab4f79e9c05447ae3ec31eb6ae1dd0bc7fd1f9fe5b4cfbb91c85132e5b8a3e1950d31950d51950de0a1a000f42401b00000001dcd650001b000000012a05f2001a5f5e100008d87a80ffffd87a8000d87a801950dcd8799f80d87a800000ffd8799f8000ffd8799f0000ffd87a80d8799f400000ffff";

/**
 * Di trú ĐÚNG MỘT trường: bọc trường 0 (`owner`) từ `bytes 28` thành
 * `VerificationKey(bytes 28)` = `d8799f 581c<h> ff`. Mọi byte còn lại giữ nguyên, nên
 * mọi con số nghiệm thu (8 batch, 64 000 000 nanogic, epoch 20700) vẫn đến từ chuỗi.
 * Tiền tố không khớp ⟹ NÉM: không đoán vị trí trường.
 */
function wrapOwnerAsKeyCredential(hex: string, pkh: string): string {
  const oldHead = `d8799f581c${pkh}`;
  if (!hex.startsWith(oldHead)) {
    throw new Error(`fixture: datum không bắt đầu bằng Constr0[bytes28 = ${pkh}] — không di trú được`);
  }
  return `d8799fd8799f581c${pkh}ff` + hex.slice(oldHead.length);
}

/** Datum `owner = VerificationKey(pkh)` nhưng VẪN 17 trường — két ScheduleGen ĐỜI v1.
 *  Suy từ bản ghi bằng `wrapOwnerAsKeyCredential`, không gõ tay. Bài kiểm dùng nó làm ca
 *  ÂM của cổng `VAULT_DATUM_V1`: chỉ khác bản v2 dưới đây ở số trường. */
export const PREVIEW_VAULT_DATUM_HEX_V1 = wrapOwnerAsKeyCredential(
  PREVIEW_VAULT_DATUM_HEX_RECORDED,
  "2e5e1418afd402e48232b143876104cac6188a44b867ffb7538318f4",
);

// ── Hình dạng Gen v2.0 (19 trường) — DI TRÚ CHO BÀI KIỂM, không phải ảnh chụp ────────
//
// 🔴 UTxO này KHÔNG THỂ tồn tại ở Gen v2.0: v2.0 là hash két mới và không di trú UTxO v1.
// Bản dưới đây giữ nguyên MỌI byte chụp từ chuỗi (8 batch, 64 000 000 nanogic, lịch,
// LAMP) và chỉ NỐI ĐÚNG các ô mà v2.0 thêm vào, với giá trị bài kiểm:
//   · mỗi `GenSchedule` nối `m_per_epoch`, `usage_factor_locked_q` (ScheduleGen types.ak);
//   · datum nối #17 `usage_window` (7 ô), #18 `usage_window_epoch`.
// Mọi con số nghiệm thu cũ vẫn đến từ chuỗi; bốn ô nối thêm là giá trị bài kiểm.

/** `M_i` nối vào lịch — 8 000 000 nanogic, bằng lượng mỗi lượt fire đã thấy trên chuỗi. */
export const PREVIEW_V2_M_PER_EPOCH = 8_000_000n;
/** `usage_factor_locked_q` nối vào lịch — 1,0 (Q = 10⁹). */
export const PREVIEW_V2_USAGE_FACTOR_LOCKED_Q = 1_000_000_000n;
/** `usage_window_epoch` nối vào datum — epoch giao thức của 8 batch. */
export const PREVIEW_V2_USAGE_WINDOW_EPOCH = 20_700n;
/** Ô 0 của `usage_window`: 64 000 000 đã sinh, 0 đã tiêu; ô 1..6 bằng 0. */
export const PREVIEW_V2_USAGE_WINDOW: readonly (readonly [bigint, bigint])[] = [
  [64_000_000n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n],
];

/** Số trường `GenSchedule` ScheduleGen v1 — đếm tại `ScheduleGen/offchain/src/types.ts` ▸
 *  `GenScheduleSchema` (11 trường trước khối "Gen v2.0"). Lệch ⟹ NÉM dưới đây. */
const GEN_SCHEDULE_FIELDS_V1 = 11;

function migrateScheduleDatumToV2(hexV1: string): string {
  const d = Data.from(hexV1);
  if (!(d instanceof Constr) || d.index !== 0 || d.fields.length !== VAULT_DATUM_FIELD_COUNTS.Schedule.v1) {
    throw new Error("fixture: datum không phải VaultDatum ScheduleGen v1 — không di trú được");
  }
  const schedules = d.fields[7];
  if (!Array.isArray(schedules)) throw new Error("fixture: trường 7 không phải danh sách lịch");
  const schedulesV2 = schedules.map((sc) => {
    if (!(sc instanceof Constr) || sc.fields.length !== GEN_SCHEDULE_FIELDS_V1) {
      throw new Error("fixture: GenSchedule không đúng 11 trường v1");
    }
    return new Constr(0, [...sc.fields, PREVIEW_V2_M_PER_EPOCH, PREVIEW_V2_USAGE_FACTOR_LOCKED_Q]);
  });
  const window = PREVIEW_V2_USAGE_WINDOW.map(([g, c]) => new Constr(0, [g, c]));
  return Data.to(new Constr(0, [
    ...d.fields.slice(0, 7), schedulesV2, ...d.fields.slice(8), window, PREVIEW_V2_USAGE_WINDOW_EPOCH,
  ]));
}

/** Datum ở lược đồ HIỆN HÀNH (Gen v2.0, 19 trường, `owner = VerificationKey(pkh)`), suy từ
 *  bản ghi — không gõ tay. */
export const PREVIEW_VAULT_DATUM_HEX = migrateScheduleDatumToV2(PREVIEW_VAULT_DATUM_HEX_V1);

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
