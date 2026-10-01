import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    // e2e Emulator chạy đánh giá UPLC cục bộ cho mỗi giao dịch — chậm hơn mặc định 5 s.
    testTimeout: 120_000,
  },
});
