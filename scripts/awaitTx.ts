// scripts/awaitTx.ts — chờ một giao dịch VÀO KHỐI, có trần thời gian.
//
// Vì sao tệp này tồn tại, và vì sao nó là MỘT nguồn chứ không phải một đoạn chép:
//
// `signed.submit()` trả về một tx hash khi node **nhận tx vào mempool**. Đó KHÔNG phải
// lời hứa rằng tx vào khối. Tx còn rớt được sau đó — phí dưới ngưỡng lúc mempool đông,
// cửa sổ hiệu lực (`validTo`) hết hạn trước khi tới lượt, một nhánh bị bỏ khi chuỗi tái
// tổ chức. Nên một kịch bản in `✅ SUCCESS` ngay sau `submit()` đang phát biểu một điều
// nó chưa đo, và nó phát biểu điều đó với mã thoát 0.
//
// Chiều hỏng cụ thể trong kho này: `run_consume_e2e.sh` chạy [2] `instant_only.ts` rồi đi
// thẳng sang [3] và [4], vốn giả định vault đã có MAGIC mới. Tx ở [2] rớt ⟹ [2] vẫn in
// SUCCESS, thoát 0 ⟹ [4] hỏng với một câu của Lucid về UTxO không tồn tại, trỏ vào [4]
// trong khi hỏng ở [2].
//
// 🔴 Và `lucid.awaitTx` KHÔNG có trần thời gian trên provider Blockfrost: tx rớt khỏi
// mempool thì nó hỏi vòng vô hạn. Một lệnh chờ vô hạn thay một lời khai sai bằng một
// tiến trình treo — đổi một dạng hỏng ồn ào lấy một dạng hỏng câm. Nên phải có trần, và
// hết trần thì trả `false` để nơi gọi ghi **CHƯA ĐO ĐƯỢC**, KHÔNG ghi "xong", cũng KHÔNG
// ghi "hỏng". Ba trạng thái, ba mã thoát — xem `## Mã thoát` ở đầu mỗi runner.
//
// Bản đầu tiên của hàm này sống trong `keeper/keeper.ts`. Nó được đưa ra đây khi runner
// thứ hai cần đúng nó; `keeper.ts` nay nhập từ đây thay vì giữ bản riêng.
//
// ## Mã thoát — NGUỒN cho mọi runner trong `scripts/test/`
//
//   0  xong. Tx đã xác nhận VÀO KHỐI. (Hoặc: lượt phá bị từ chối ĐÚNG như kỳ vọng.)
//   1  hỏng thật.
//   2  CHƯA ĐO ĐƯỢC — tx đã gửi, chưa thấy vào khối trong trần thời gian. KHÔNG phải
//      "đã hỏng", và tuyệt đối KHÔNG chạy lại mù: tx có thể vẫn vào khối sau đó, và
//      lượt chạy thứ hai sẽ làm cùng một việc lần nữa.
//   3  lượt phá LỌT qua — validator không chặn thứ lẽ ra phải chặn.
//
// Bảng này có trước ở `scripts/test/schedule_fire_only.ts`, tệp duy nhất từng cần đủ ba
// trạng thái. Bốn runner còn lại khi ấy dùng `2` cho nghĩa của `3`, nên cùng một con số
// mang hai nghĩa tuỳ tệp — đúng cái bẫy mà chính chú thích trong tệp đó cảnh báo. Đã
// thống nhất về bảng trên; an toàn vì hôm nay KHÔNG nơi gọi nào phân biệt mã thoát:
// `run_consume_e2e.sh` chạy dưới `set -e` (khác 0 là dừng) và `keeper.ts` ▸ `runScript`
// chỉ so `code !== 0`. Ngày có nơi gọi phân biệt, nó đọc bảng này.

import type { LucidEvolution } from "@lucid-evolution/lucid";

/** Trần chờ mặc định (ms). `AWAIT_TX_MS` đổi được cho mọi nơi gọi cùng lúc. */
export const DEFAULT_AWAIT_TX_MS = Number(process.env.AWAIT_TX_MS ?? 300_000);

/**
 * Chờ `txHash` vào khối, tối đa `ms`.
 *
 * @returns `true` tx đã vào khối · `false` HẾT TRẦN — chưa đo được, đừng đọc thành hỏng.
 */
export async function awaitTxBounded(
  lucid: LucidEvolution,
  txHash: string,
  ms: number = DEFAULT_AWAIT_TX_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); });
  try {
    return await Promise.race([lucid.awaitTx(txHash).then(() => true), timeout]);
  } finally {
    // Không dọn thì tiến trình còn một `setTimeout` treo và Node không thoát cho tới khi
    // nó nổ — một kịch bản "đã xong" mà nằm im thêm 5 phút đọc y hệt một kịch bản treo.
    clearTimeout(timer);
  }
}

/**
 * Câu nói chuẩn khi hết trần. Một chuỗi, một chỗ — để mọi runner nói cùng một câu và
 * người đọc log nhận ra nó không phải một lỗi.
 */
export function chuaDoDuocMessage(txHash: string, ms: number = DEFAULT_AWAIT_TX_MS): string {
  return `⚠ CHƯA ĐO ĐƯỢC (KHÔNG phải đã hỏng): tx ${txHash} đã gửi, chưa thấy vào khối sau `
    + `${Math.round(ms / 1000)}s. Soi explorer TRƯỚC khi chạy lại — chạy lại mù có thể tạo `
    + `một giao dịch thứ hai cho cùng một việc.`;
}
