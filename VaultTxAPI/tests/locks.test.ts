// VaultTxAPI/tests/locks.test.ts — khoá mềm theo chủ vault.
//
// Ba tính chất đáng kiểm, và chúng khác nhau:
//   1. bận thì NÉM 409, không trả một giá trị mà người gọi có thể bỏ qua;
//   2. khoá sống tới lúc NỘP, không nhả ngay sau khi dựng;
//   3. hết hạn thì tự mở — người dùng đóng app giữa chừng không được khoá vĩnh viễn.

import { describe, expect, it } from "vitest";

import { OwnerTxInFlightError } from "../src/errors.js";
import { OwnerLockTable, PENDING_TX_HASH } from "../src/locks.js";

const OWNER = "2e5e1418afd402e48232b143876104cac6188a44b867ffb7538318f4";
const OTHER = "11".repeat(28);
const TX_HASH = "ab".repeat(32);
const TTL = 180_000;

describe("OwnerLockTable", () => {
  it("chủ thứ hai KHÔNG bị chặn vì chủ thứ nhất đang giữ khoá", () => {
    const t = new OwnerLockTable(TTL);
    t.acquire(OWNER, 1_000);
    expect(() => t.acquire(OTHER, 1_000)).not.toThrow();
  });

  it("cùng một chủ, lượt thứ hai NÉM 409 kèm mốc hết hạn", () => {
    const t = new OwnerLockTable(TTL);
    t.acquire(OWNER, 1_000);
    t.bindTxHash(OWNER, TX_HASH);
    try {
      t.acquire(OWNER, 2_000);
      throw new Error("lẽ ra phải ném");
    } catch (e) {
      expect(e).toBeInstanceOf(OwnerTxInFlightError);
      const err = e as OwnerTxInFlightError;
      expect(err.httpStatus).toBe(409);
      expect(err.details.held_tx_hash).toBe(TX_HASH);
      expect(err.details.lock_expires_at).toBe(new Date(1_000 + TTL).toISOString());
    }
  });

  it("giữ chỗ TRƯỚC khi biết hash — khe đua nằm giữa hai lượt, không sau lúc dựng", () => {
    const t = new OwnerLockTable(TTL);
    t.acquire(OWNER, 0);
    expect(t.peek(OWNER, 0)?.txHash).toBe(PENDING_TX_HASH);
    // Chỗ giữ chỗ không bao giờ khớp một hash thật, nên nó không nhả nhầm.
    expect(t.releaseByTxHash(TX_HASH)).toBeNull();
  });

  it("hết hạn thì tự mở", () => {
    const t = new OwnerLockTable(TTL);
    t.acquire(OWNER, 1_000);
    expect(() => t.acquire(OWNER, 1_000 + TTL - 1)).toThrow(OwnerTxInFlightError);
    expect(() => t.acquire(OWNER, 1_000 + TTL)).not.toThrow();
  });

  it("nhả theo hash giao dịch đã nộp, và trả về chủ vừa nhả", () => {
    const t = new OwnerLockTable(TTL);
    t.acquire(OWNER, 0);
    t.bindTxHash(OWNER, TX_HASH);
    expect(t.releaseByTxHash(TX_HASH)).toBe(OWNER);
    expect(t.peek(OWNER, 0)).toBeNull();
    // Nộp lại lần nữa: `null` là câu trả lời THẬT, không phải một lỗi bị nuốt.
    expect(t.releaseByTxHash(TX_HASH)).toBeNull();
  });

  it("nhả khi dựng HỎNG — một lần lỗi không được khoá chủ đó suốt thời hạn", () => {
    const t = new OwnerLockTable(TTL);
    t.acquire(OWNER, 0);
    t.release(OWNER);
    expect(() => t.acquire(OWNER, 1)).not.toThrow();
  });

  it("sweep chỉ dọn khoá đã hết hạn", () => {
    const t = new OwnerLockTable(TTL);
    t.acquire(OWNER, 0);
    t.acquire(OTHER, TTL);
    expect(t.sweep(TTL)).toBe(1);
    expect(t.size()).toBe(1);
    expect(t.peek(OTHER, TTL)).not.toBeNull();
  });
});
