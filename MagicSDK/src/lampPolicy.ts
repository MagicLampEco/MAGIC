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

/** Policy id đã BIẾT là không phải LAMP, kèm lý do. Danh sách ĐÓNG, chép tay
 *  2026-09-14 — xem đầu tệp về thứ nó chống và thứ nó không chống. */
export const NON_LAMP_LOOKALIKE_POLICIES: Readonly<Record<string, string>> = Object.freeze({
  "28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4":
    "Chính sách chữ-ký-đơn suy từ khoá một ví triển khai — không trần phát hành, " +
    "ai giữ khoá thì đúc thêm tuỳ ý. Nó đã đúc 19 dòng trên Preview và 8 dòng trên " +
    "Preprod, trong đó có cả \"LAMP\", \"tLAMP\", \"CARP\" và \"MAGIC\". Dòng tLAMP " +
    "mang TRỌN 36 tỷ, tức ngược hẳn mô hình lazy-mint của LAMP.",
  "7a1a7aed5ec47acc37b6fa82695c1219bf76895b505b01161367adf9":
    "Bản diễn tập đời trước, đã bị thay (SUPERSEDED).",
});

const HEX56 = /^[0-9a-f]{56}$/;

/**
 * Chặn ở chỗ `lampPolicyId` đi vào một giao dịch hoặc vào apply-param. Fail-closed:
 * ném thay vì trả về một giá trị đệm.
 *
 * Gọi ở MỌI ranh giới nhận giá trị này từ ngoài. Đắt nhất là đường apply-param —
 * policy id nướng vào bytes lúc biên dịch, nên sai ở đó là sai script hash, sai địa
 * chỉ vault, và không sửa được bằng cách đổi cấu hình về sau.
 *
 * @param policyId giá trị người gọi đưa vào
 * @param where    tên chỗ gọi, để câu lỗi chỉ đúng đường (vd "applyVaultValidator")
 */
export function assertLampPolicyId(policyId: string | undefined, where: string): string {
  const v = policyId ?? "";

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
