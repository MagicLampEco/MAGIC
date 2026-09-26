// tests/ownerApiError.test.ts — ánh xạ mã lỗi chủ (`OwnerAuthError.code`) sang mã HTTP.
// Mã giữ nguyên; chỉ status theo loại lỗi: bên gọi gửi sai → 400, trạng thái chuỗi → 422,
// nhân chứng phía dịch vụ hỏng → 500.

import { describe, expect, it } from "vitest";
import { ownerApiErrorOf } from "../src/errors.js";

describe("ownerApiErrorOf", () => {
  it.each([
    ["OWNER_STAKE_NOT_REGISTERED", 422],
    ["OWNER_STAKE_REWARDS_PENDING", 422],
    ["OWNER_WITHDRAW_RETURNED_NOTHING", 500],
    ["OWNER_AUTH_MISMATCH", 400],
    ["OWNER_HASH_INVALID", 400],
  ])("%s → %i, giữ nguyên mã", (code, status) => {
    const e = ownerApiErrorOf({ code, message: `${code}: x` });
    expect(e.httpStatus).toBe(status);
    expect(e.code).toBe(code);
  });
});
