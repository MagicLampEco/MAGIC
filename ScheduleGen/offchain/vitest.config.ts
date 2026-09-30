import { defineConfig } from "vitest/config";
export default defineConfig({
  // `tests/e2eEmulator.test.ts` import thẳng `GenBeacons/offchain/src`. Không có `dedupe`, tệp
  // của GenBeacons tìm `@lucid-evolution/lucid` trong `GenBeacons/offchain/node_modules` — thư
  // mục CI không cài khi job chỉ chạy gói ScheduleGen, và nếu có thì là một BẢN THỨ HAI của
  // Lucid (hai lớp `Constr` khác nhau trong cùng một giao dịch). `dedupe` ép mọi lần import
  // về đúng bản của gói này.
  resolve: { dedupe: ["@lucid-evolution/lucid"] },
  test: {
    include: ["../tests/**/*.test.ts", "tests/**/*.test.ts"],
    globals: false,
  },
});
