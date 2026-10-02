// scripts/state_book_path_cli.ts — in đường sổ trạng thái của một mạng, cho kịch bản bash.
//
// `run_keeper.sh` gọi tệp này thay vì tự chép ba cổng của `stateBookPath.ts` sang bash: hai bản
// của cùng ba cổng sẽ trôi khỏi nhau mà không gì báo.
//
//   npx tsx state_book_path_cli.ts <Preview|Preprod>
//     stdout: đường tuyệt đối của sổ · cổng hỏng: câu lỗi ra stderr, mã thoát 1 · thiếu tham số: mã 2
import { stateBookPath } from "./stateBookPath.js";

const net = process.argv[2];
if (!net) {
  console.error("✗ thiếu tham số mạng (Preview|Preprod).");
  process.exit(2);
}
try {
  console.log(stateBookPath(net));
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}
