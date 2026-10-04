// MagicSDK/src/lampPolicy.ts — cổng duy nhất cho `lampPolicyId` ở mặt tiền công khai.
//
// VÌ SAO TỆP NÀY TỒN TẠI
//
// Ngày 2026-09-14 kho dựng một cổng chặn policy nhái ở `scripts/config.ts`. Cổng đó
// đúng, và nó KHÔNG với tới đây: `MagicSDK` là gói npm riêng, không import gì từ
// `scripts/`. Nên đường mà người ngoài thật sự đi — `@magiclamp/sdk` — vẫn chỉ kiểm
// đúng một điều là chuỗi có rỗng hay không (`createVault.ts`, bản trước). Một bản vá
// lấy phạm vi bằng phạm vi của triệu chứng là bản vá để lại nguyên nguyên nhân.
//
// TÊN KHÔNG PHẢI ĐỊNH DANH — CHỈ POLICY ID MỚI LÀ
//
// Trên Cardano một tài sản được định danh bằng CẶP (policy id, asset name). Tên hiển
// thị không độc nhất và ai cũng đúc được. Hệ quả phản trực giác, phải viết ra vì nó
// ngược với câu "so cả hai cho chặt": ở dòng mainnet `4c414d50` = "LAMP", vế asset
// name LUÔN đúng với cả hàng nhái — nên nó không mang thông tin nào, và một cổng hiện
// thực câu ấy thành phép so HOẶC vẫn qua được mọi lần thử.
//
//   policy id là điều kiện ĐỦ; asset name KHÔNG BAO GIỜ là điều kiện đủ.
//   asset name chỉ còn vai phân biệt các dòng TRONG một policy đã được xác thực.
//
// DANH SÁCH TỪ CHỐI NÀY CHỐNG ĐƯỢC GÌ, VÀ KHÔNG CHỐNG ĐƯỢC GÌ
//
// Nó chống TÁI PHÁT một sai lầm đã biết: những giá trị dưới đây đã từng đi vào cấu
// hình thật của kho và đã gây hỏng đo được. Nó KHÔNG chống được đối thủ có động cơ —
// đúc dưới một policy chữ-ký-đơn mới từ ví khác là đi qua, và không danh sách chép
// tay nào đuổi kịp. Đừng đọc dòng "đã qua cổng" thành "policy này chính danh": cổng
// chỉ nói "không phải một trong những cái đã biết là sai".
//
// Nguồn chân lý cho giá trị ĐÚNG nằm ở kho LAMP (Genesis ▸ lampPolicies), theo mạng.
// Gói này cố ý KHÔNG chép giá trị đó xuống: một bản sao không có đường về nguồn sẽ
// chết im lặng đúng lúc kho LAMP triển khai lại.

// HAI BẢNG, KHÔNG PHẢI MỘT — và gộp chúng là gộp hai loại sai khác hẳn nhau
//
// "token nhái" và "đời LAMP đã bị thay" đòi hai hành động khác nhau ở người đọc:
// cái đầu bảo đi tìm một kẻ giả mạo, cái sau bảo đi lấy đời ACTIVE. Một câu lỗi
// chung dạy người ta làm sai một trong hai. Bản trước của tệp này xếp
// `7a1a7aed…` — một LAMP THẬT của đời trước, có one-shot proof, có `SupplyState`
// — vào bảng nhái với chú thích "đã bị thay", tức tự mâu thuẫn ngay trong dòng.

/** Policy id đã BIẾT là không phải LAMP, kèm lý do. Danh sách ĐÓNG, chép tay
 *  2026-09-14 — xem đầu tệp về thứ nó chống và thứ nó không chống. */
export const NON_LAMP_LOOKALIKE_POLICIES: Readonly<Record<string, string>> = Object.freeze({
  "28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4":
    "Chính sách chữ-ký-đơn suy từ khoá một ví triển khai — không trần phát hành, " +
    "ai giữ khoá thì đúc thêm tuỳ ý. Nó đã đúc 19 dòng trên Preview và 8 dòng trên " +
    "Preprod, trong đó có cả \"LAMP\", \"tLAMP\", \"CARP\" và \"MAGIC\". Dòng tLAMP " +
    "mang TRỌN 36 tỷ, tức ngược hẳn mô hình lazy-mint của LAMP.",
  "3628b069a032490ca24863f48fe36f902d6cf676e1f5b5d3e7845d44":
    "Mang đúng asset 744c414d50, cung 1.000.000. NGUY hơn hàng nhái thường vì nó " +
    "NẰM SẴN trong UTxO của một ví triển khai đang dùng — một vòng lặp chọn tài sản " +
    "theo TÊN nhặt phải nó mà không cần ai tấn công. Hai sổ trong hệ ghi XUẤT XỨ " +
    "khác nhau cho cùng policy này, nghĩa là ít nhất một sổ đang ghi sai nguồn; cổng " +
    "so policy id chứ không đọc xuất xứ nên chênh đó không đổi hành vi chặn.",
});

// 🔴 Mục `3628b069…` ngay trên thêm 2026-09-22, và lý do nó VẮNG một tuần là thứ
// đáng ghi hơn chính mục đó.
//
// Nó được thêm vào `scripts/config.ts` ngày 2026-09-16 và KHÔNG được thêm vào đây.
// Hai bảng chép tay, không bảng nào trỏ sang bảng kia, nên chúng trôi khỏi nhau mà
// không gì kêu — `grep -rn 3628b069 --include="*.ts" .` trả về đúng MỘT chỗ suốt
// quãng đó. Và mục bị thiếu lại là mục NGUY nhất theo chính lời khai của nó: nó
// không cần ai tấn công.
//
// Chỗ trớ trêu: đầu tệp này khai nó tồn tại vì cổng ở `scripts/` "KHÔNG với tới"
// đường mà người ngoài thật sự đi, và gọi bản vá trước là "một bản vá lấy phạm vi
// bằng phạm vi của triệu chứng". Nó vừa tái diễn đúng điều đó với chính mình.
//
// - [!] Hai bảng vẫn là hai bản chép tay, không đường nhập khẩu — đo bằng:
//     cd scripts && npx tsx test_lamp_policy_gate.ts
//   đọc ở: khối "── hai bản chép tay trùng TẬP KHOÁ", so TỪNG bảng một (nhái · đã bị
//   thay · tập dượt), so tập chứ không so số đếm · 2026-09-27: trùng cả ba bảng.
//   Phép `grep -oE '^  "[0-9a-f]{56}"'` cũ không còn đủ: nó gộp mọi bảng làm một, nên
//   một khoá chuyển nhầm từ bảng này sang bảng kia vẫn cho cùng một tập. Đường sửa
//   tận gốc là SDK xuất các bảng và `scripts/config.ts` nhập — chưa làm vì `scripts/`
//   chưa phụ thuộc gói đó.

/** LAMP THẬT của một đời đã bị thay. Không phải hàng nhái — mọi phép so hình
 *  dạng đều cho chúng đi qua, và một lượt chạy bằng chúng vẫn XANH. Danh sách
 *  ĐÓNG, chép tay 2026-09-16; thêm `8169b76c…` 2026-09-26; thêm `53bc12ad…` và
 *  `7ecbffe2…` 2026-10-03 (thư LAMP `lam1003mg-a`). Phải trùng tập khoá với
 *  `scripts/config.ts` ▸ bảng cùng tên. */
export const SUPERSEDED_LAMP_POLICIES: Readonly<Record<string, string>> = Object.freeze({
  "7a1a7aed5ec47acc37b6fa82695c1219bf76895b505b01161367adf9":
    "Bản diễn tập đời trước, đã bị thay.",
  "d9c09230079b810ab5ed92e8db4c190d42efc42db6aac028656f7e07":
    "Đời `preprod-oneshot-12param`, đã bị thay bởi `8169b76c…` " +
    "(`preprod-oneshot-14param`, đúc 2026-09-14). Đây là thứ ví Preprod có tADA " +
    "đang cầm, nên nó là đời DỄ dùng nhầm nhất, không phải đời khó gặp nhất.",
  "8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd":
    "Đời `preprod-oneshot-14param` (đúc 2026-09-14), đã bị thay bởi `53bc12ad…8743` " +
    "(genesis tx `21f39c9b…a716`, 2026-09-26) — đời đó cũng đã bỏ; đời Preprod CUỐI là " +
    "`493002cc…cfac`. Cụm vault Preprod 23–24/09 dùng đời này.",
  "53bc12ade5ee24d43750b9560f152a54b48b804fab34dab810fb8743":
    "Đời Preprod đúc 2026-09-26 (genesis tx `21f39c9b…a716`), đã bị thay bởi " +
    "`493002cc…cfac` (policy tLAMP Preprod CUỐI, thư LAMP `lam1003mg-a`, 2026-10-03). " +
    "Kho LAMP đã dừng mọi job rót trên cụm này tối 2026-10-02.",
  "7ecbffe2b41f68c917035f52a1053efbd2323dfd85a81cf840089ea2":
    "Policy LAMP tính ra 2026-10-02 rồi HUỶ cùng ngày (thư LAMP `lam1002mg-z`): thiếu " +
    "nhãn marker đọc ra nghĩa. Đã bị thay bởi `493002cc…cfac` (policy tLAMP Preprod " +
    "CUỐI, thư `lam1003mg-a`, 2026-10-03). Chưa từng được nướng vào kho này.",
});

// LỐI MỞ TẬP DƯỢT — một ngoại lệ CÓ XÁC NHẬN THEO GIÁ TRỊ, không phải một cờ bật/tắt
//
// TRẠNG THÁI: ĐÓNG từ 2026-10-04 (bảng `REHEARSAL_LAMP_POLICIES` rỗng). Chủ dự án quyết
// 2026-09-27 dựng một cụm TẬP DƯỢT dùng một lần trên Preprod bằng `8169b76c…`; cụm đó đã
// dừng, và cụm phục vụ chạy trên policy tLAMP Preprod CUỐI `493002cc…cfac`. Phần chú thích
// dưới giữ lại để người mở lại lối này biết ba điều kiện và vì sao xác nhận theo giá trị.
//
// Sự thật "`8169b76c…` đã bị thay" KHÔNG đổi: khoá đó nằm trong `SUPERSEDED_LAMP_POLICIES`
// và nay không còn đường nào cho qua. Bảng tập dượt chỉ nói "được CHO QUA khi người chạy
// xác nhận" — rỗng thì không khoá nào được cho qua.
//
// Vì sao xác nhận là CHÍNH CHUỖI policy chứ không phải `=1`: một cờ `=1` mở cửa cho mọi
// khoá trong bảng, kể cả khoá được thêm về sau mà người bật cờ chưa từng thấy; và một
// cờ `=1` nằm quên trong cấu hình thì cho qua cả đời mà nó không định nói tới. Xác nhận
// bằng giá trị thì chỉ mở đúng cửa nó gọi tên.
//
// Ba điều kiện, ghép bằng VÀ — thiếu một là ném câu lỗi cũ, nguyên văn:
//   1. policy nằm trong `REHEARSAL_LAMP_POLICIES` (bảng ĐÓNG, dưới);
//   2. `rehearsalAck` bằng ĐÚNG chuỗi policy đó;
//   3. mạng là một mạng THỬ đã biết (`Preview` | `Preprod`). Mạng vắng, lạ, hay
//      `Mainnet` ⟹ không được phép. SDK CÓ khái niệm mạng (`ProtocolParams.network`,
//      `WithdrawLampParams.network`), nên điều kiện này áp ở đây như ở `scripts/`;
//      người gọi không truyền mạng thì lối mở đóng — fail-closed.
//
// Hàm cổng KHÔNG in cảnh báo: SDK là thư viện, và cổng chạy nhiều lần trong một lượt
// dựng (`createVault` rồi `buildParamsList`). Lớp ứng dụng in một lần lúc nạp cấu hình
// (`VaultTxAPI` ▸ `parseDeployment`, `scripts/config.ts` ▸ `requireLampPolicyId`).

/** Đời đã bị thay mà được CHO QUA khi có xác nhận theo giá trị. Danh sách ĐÓNG, chép
 *  tay 2026-09-27; phải trùng tập khoá với `scripts/config.ts` ▸ bảng cùng tên.
 *
 *  ĐÃ GỠ 2026-10-04 (cụm tập dượt dừng; cụm phục vụ chạy policy cuối `493002cc…cfac`).
 *  Bảng RỖNG nên lối mở tự đóng — không cần sửa hàm cổng. Thêm lại một khoá là mở lại
 *  lối mở: phải có quyết định mới của chủ dự án và một điều kiện gỡ mới. */
export const REHEARSAL_LAMP_POLICIES: Readonly<Record<string, string>> = Object.freeze({});

/** Mạng được phép chạy lối mở tập dượt. Danh sách ĐÓNG: mạng không nằm đây — kể cả
 *  một chuỗi lạ — là không được phép. */
const REHEARSAL_NETWORKS: ReadonlySet<string> = new Set(["Preview", "Preprod"]);

/** Ba điều kiện của lối mở tập dượt — xem khối chú thích trên `REHEARSAL_LAMP_POLICIES`. */
export function isRehearsalAcknowledged(
  policyId: string,
  rehearsalAck: string | undefined,
  network: string | undefined,
): boolean {
  return Object.hasOwn(REHEARSAL_LAMP_POLICIES, policyId)
    && rehearsalAck === policyId
    && network !== undefined && REHEARSAL_NETWORKS.has(network);
}

const HEX56 = /^[0-9a-f]{56}$/;

/**
 * Chặn ở chỗ `lampPolicyId` đi vào một giao dịch hoặc vào apply-param. Fail-closed:
 * ném thay vì trả về một giá trị đệm.
 *
 * Gọi ở MỌI ranh giới nhận giá trị này từ ngoài. Đắt nhất là đường apply-param —
 * policy id nướng vào bytes lúc biên dịch, nên sai ở đó là sai script hash, sai địa
 * chỉ vault, và không sửa được bằng cách đổi cấu hình về sau.
 *
 * @param policyId     giá trị người gọi đưa vào
 * @param where        tên chỗ gọi, để câu lỗi chỉ đúng đường (vd "applyVaultValidator")
 * @param rehearsalAck xác nhận lối mở tập dượt — phải bằng ĐÚNG `policyId`. Bỏ trống ⟹
 *                     hành vi y hệt trước khi có lối mở.
 * @param network      mạng của lượt dựng. Lối mở chỉ mở trên `Preview` | `Preprod`;
 *                     vắng ⟹ đóng.
 */
export function assertLampPolicyId(
  policyId: string | undefined,
  where: string,
  rehearsalAck?: string,
  network?: string,
): string {
  const v = policyId ?? "";

  const doi = SUPERSEDED_LAMP_POLICIES[v];
  if (doi && !isRehearsalAcknowledged(v, rehearsalAck, network)) {
    throw new Error(
      `[${where}] lampPolicyId trỏ vào một đời LAMP ĐÃ BỊ THAY: ${v}\n` +
      `  ${doi}\n` +
      `  Đây KHÔNG phải token nhái — đừng đi tìm một kẻ giả mạo. Nó là LAMP thật ` +
      `của một đời đã chết, nên mọi phép so hình dạng đều cho nó đi qua và một ` +
      `lượt chạy bằng nó vẫn XANH.\n` +
      `  Policy id nướng vào bytes lúc biên dịch ⟹ vault sinh ra ở một script hash ` +
      `không ai dùng nữa. Lấy đời ACTIVE theo mạng từ kho LAMP (Genesis ▸ lampPolicies).`,
    );
  }

  const why = NON_LAMP_LOOKALIKE_POLICIES[v];
  if (why) {
    throw new Error(
      `[${where}] lampPolicyId trỏ vào một token KHÔNG PHẢI LAMP: ${v}\n` +
      `  ${why}\n` +
      `  Lấy policy canonical theo mạng từ kho LAMP (Genesis ▸ lampPolicies). ` +
      `Chữ "LAMP"/"tLAMP" hiện ra trong ví hay explorer KHÔNG đủ để kết luận — ` +
      `chỉ policy id mới định danh.`,
    );
  }

  if (!HEX56.test(v)) {
    throw new Error(
      `[${where}] lampPolicyId thiếu hoặc sai hình dạng: ${JSON.stringify(policyId)}\n` +
      `  Cần đúng 56 ký tự hex thường (blake2b-224 của policy script).\n` +
      `  Đây chỉ là cổng HÌNH DẠNG: qua được nó không có nghĩa là đúng policy.`,
    );
  }

  return v;
}
