// VaultTxAPI/tests/locks.test.ts — khoá mềm theo chủ vault.
//
// Tính chất đáng kiểm (luật 2026-10-03, `locks.ts` đầu tệp):
//   1. lượt dựng mới KHÔNG BAO GIỜ nhận 409 vì một lượt dựng khác — nó THAY lượt cũ;
//   2. lượt cũ đã dựng xong thì mọi khoá phụ của nó nhả ngay khi bị thay;
//   3. thẻ thế hệ: lượt cũ chậm không đụng được khoá của lượt mới;
//   4. "bị thay" ở SỔ chỉ xảy ra khi một tx chung khoá được NỘP, không khi được DỰNG.

import { describe, expect, it } from "vitest";

import { IssuedTxRegistry, OwnerLockTable, PENDING_TX_HASH, PendingSpends, submissionStateOf } from "../src/locks.js";

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

  it("cùng một chủ, lượt thứ hai KHÔNG ném — nó THAY lượt đầu (đổi từ 409 OWNER_TX_IN_FLIGHT, 2026-10-03)", () => {
    const t = new OwnerLockTable(TTL);
    const g1 = t.acquire(OWNER, 1_000);
    t.bindTxHash(OWNER, TX_HASH, g1);
    let g2 = 0;
    expect(() => { g2 = t.acquire(OWNER, 2_000); }).not.toThrow();
    expect(g2).not.toBe(g1);
    const rec = t.peek(OWNER, 2_000)!;
    expect(rec.gen).toBe(g2);
    expect(rec.txHash).toBe(PENDING_TX_HASH);
    expect(rec.expiresAtMs).toBe(2_000 + TTL);
  });

  it("bị thay ⟹ khoá PHỤ của lượt cũ (UTxO phí / quỹ) nhả ngay; CẶP: khoá phụ của tx KHÁC không bị đụng", () => {
    const t = new OwnerLockTable(TTL);
    const FEE_KEY = `utxo:${"fe".repeat(32)}#0`;
    const OTHER_FEE_KEY = `utxo:${"fd".repeat(32)}#0`;
    const gOwner = t.acquire(OWNER, 0);
    const gFee = t.acquire(FEE_KEY, 0);
    t.bindTxHash(OWNER, TX_HASH, gOwner);
    t.bindTxHash(FEE_KEY, TX_HASH, gFee);
    const gOther = t.acquire(OTHER_FEE_KEY, 0);
    t.bindTxHash(OTHER_FEE_KEY, "cd".repeat(32), gOther);
    t.acquire(OWNER, 1);
    expect(t.peek(FEE_KEY, 1)).toBeNull();
    expect(t.peek(OTHER_FEE_KEY, 1)?.txHash).toBe("cd".repeat(32));
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
    expect(t.peek(OWNER, 1_000 + TTL - 1)).not.toBeNull();
    expect(t.peek(OWNER, 1_000 + TTL)).toBeNull();
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

// ── Thẻ thế hệ: lượt dựng chậm quá TTL không được đụng khoá của lượt SAU ──────────

describe("OwnerLockTable — thẻ thế hệ", () => {
  it("lượt A quá hạn, lượt B giành lại; A hỏng rồi release(gen A) ⟹ khoá B CÒN", () => {
    const t = new OwnerLockTable(TTL);
    const genA = t.acquire(OWNER, 0);
    const genB = t.acquire(OWNER, TTL);            // A đã hết hạn
    t.release(OWNER, genA);
    expect(t.peek(OWNER, TTL)?.gen).toBe(genB);
    t.release(OWNER, genB);
    expect(t.peek(OWNER, TTL)).toBeNull();
  });
  it("CỰC ĐỐI: bindTxHash(gen A) không đè hash lên khoá của B; bindTxHash(gen B) thì có", () => {
    const t = new OwnerLockTable(TTL);
    const genA = t.acquire(OWNER, 0);
    const genB = t.acquire(OWNER, TTL);
    t.bindTxHash(OWNER, "aa".repeat(32), genA);
    expect(t.peek(OWNER, TTL)!.txHash).toBe(PENDING_TX_HASH);
    t.bindTxHash(OWNER, TX_HASH, genB);
    expect(t.peek(OWNER, TTL)!.txHash).toBe(TX_HASH);
  });
});

describe("OwnerLockTable — thẻ thế hệ khi bị THAY (chưa hết hạn)", () => {
  it("A đang dựng, B thay A; A dựng xong bindTxHash(gen A) / A hỏng release(gen A) ⟹ khoá B nguyên vẹn", () => {
    const t = new OwnerLockTable(TTL);
    const genA = t.acquire(OWNER, 0);
    const genB = t.acquire(OWNER, 1);              // A CHƯA hết hạn
    t.bindTxHash(OWNER, "aa".repeat(32), genA);
    t.release(OWNER, genA);
    expect(t.peek(OWNER, 1)).toMatchObject({ gen: genB, txHash: PENDING_TX_HASH });
  });
});

describe("PendingSpends — xung đột theo hash tx", () => {
  const REF = `${"ab".repeat(32)}#0`;
  it("input bị tx KHÁC tiêu ⟹ xung đột; CẶP: chính tx đó nộp lại ⟹ không xung đột", () => {
    const p = new PendingSpends(TTL);
    p.note([REF], 0, "11".repeat(32));
    expect(p.conflicts([REF, `${"ab".repeat(32)}#1`], 1, "22".repeat(32))).toEqual([REF]);
    expect(p.conflicts([REF], 1, "11".repeat(32))).toEqual([]);
  });
  it("dòng ghi không kèm hash ⟹ tính là xung đột (không đoán là chính nó); hết hạn ⟹ hết xung đột", () => {
    const p = new PendingSpends(TTL);
    p.note([REF], 0);
    expect(p.conflicts([REF], 1, "11".repeat(32))).toEqual([REF]);
    expect(p.conflicts([REF], TTL, "11".repeat(32))).toEqual([]);
  });
});

describe("IssuedTxRegistry.markSubmitted — bị thay khi một tx chung khoá được NỘP", () => {
  const T1 = "a1".repeat(32), T2 = "a2".repeat(32), T3 = "a3".repeat(32), T4 = "a4".repeat(32);
  it("T1, T2 cùng chủ; nộp T2 ⟹ T1 bị thay bởi T2; tx chủ khác + tx không khai khoá không bị đụng", () => {
    const r = new IssuedTxRegistry(TTL);
    r.record(T1, 0, { route: "consume", lockKeys: [OWNER] });
    r.record(T2, 1, { route: "consume", lockKeys: [OWNER] });
    r.record(T3, 1, { route: "consume", lockKeys: [OTHER] });
    r.record(T4, 1, { route: "consume" });
    expect(r.markSubmitted(T2, 2)).toBe(1);
    expect(r.lookup(T1, 2)?.supersededBy).toBe(T2);
    expect(r.lookup(T2, 2)?.supersededBy).toBeUndefined();
    expect(r.lookup(T3, 2)?.supersededBy).toBeUndefined();
    expect(r.lookup(T4, 2)?.supersededBy).toBeUndefined();
  });
  it("tx dựng SAU lượt nộp không bị thay; dựng KHÔNG nộp thì không thay gì", () => {
    const r = new IssuedTxRegistry(TTL);
    r.record(T1, 0, { route: "consume", lockKeys: [OWNER] });
    r.record(T2, 1, { route: "consume", lockKeys: [OWNER] });   // T2 chỉ được DỰNG
    expect(r.lookup(T1, 2)?.supersededBy).toBeUndefined();
    r.markSubmitted(T1, 3);
    r.record(T3, 4, { route: "consume", lockKeys: [OWNER] });
    expect(r.lookup(T2, 4)?.supersededBy).toBe(T1);
    expect(r.lookup(T3, 4)?.supersededBy).toBeUndefined();
  });
  it("HỒI QUY hai lượt tạo két từ hai ví: T1 (ví A) đã NỘP vẫn bị thay khi T2 (ví B) chung khoá chủ nộp sau; CẶP: T2 khoá chủ KHÁC ⟹ không thay", () => {
    // T1 nộp rồi rơi khỏi mempool; T2 nộp, lên chuỗi. Không bị thay ⟹ nộp lại T1 đi qua ⟹ hai két
    // cùng chủ (validator chưa ép mỗi DID một két). Hai tx KHÔNG chung input — chỉ chung khoá chủ.
    const r = new IssuedTxRegistry(TTL);
    r.record(T1, 0, { route: "create-vault", lockKeys: [OWNER], feePayerUtxo: `${"fa".repeat(32)}#0` });
    expect(r.markSubmitted(T1, 1)).toBe(0);
    r.record(T2, 2, { route: "create-vault", lockKeys: [OWNER], feePayerUtxo: `${"fb".repeat(32)}#0` });
    expect(r.markSubmitted(T2, 3)).toBe(1);
    expect(r.lookup(T1, 3)?.supersededBy).toBe(T2);
    expect(submissionStateOf(r.lookup(T1, 3)!)).toBe("accepted");

    const c = new IssuedTxRegistry(TTL);
    c.record(T1, 0, { route: "create-vault", lockKeys: [OWNER], feePayerUtxo: `${"fa".repeat(32)}#0` });
    c.markSubmitted(T1, 1);
    c.record(T2, 2, { route: "create-vault", lockKeys: [OTHER], feePayerUtxo: `${"fb".repeat(32)}#0` });
    expect(c.markSubmitted(T2, 3)).toBe(0);
    expect(c.lookup(T1, 3)?.supersededBy).toBeUndefined();
  });
  it("NỘP LẠI một tx đã nộp không thay tx dựng sau lượt nộp đầu; CẶP: lượt nộp ĐẦU thì có thay", () => {
    const r = new IssuedTxRegistry(TTL);
    r.record(T1, 0, { route: "consume", lockKeys: [OWNER] });
    r.markSubmitted(T1, 1, "accepted", { lockReleasedFor: "pk" });
    r.record(T2, 2, { route: "consume", lockKeys: [OWNER] });   // lượt kế tiếp hợp lệ của chủ
    expect(r.markSubmitted(T1, 3)).toBe(0);                       // rớt mạng, nộp lại T1
    expect(r.lookup(T2, 3)?.supersededBy).toBeUndefined();
    expect(r.lookup(T1, 3)?.submittedAtMs).toBe(1);               // mốc nộp đầu không bị ghi đè
    expect(r.lookup(T1, 3)?.submittedResult).toEqual({ lockReleasedFor: "pk" });

    const c = new IssuedTxRegistry(TTL);
    c.record(T2, 0, { route: "consume", lockKeys: [OWNER] });
    c.record(T1, 1, { route: "consume", lockKeys: [OWNER] });
    expect(c.markSubmitted(T1, 3)).toBe(1);
    expect(c.lookup(T2, 3)?.supersededBy).toBe(T1);
  });
  it("gửi CHƯA XÁC NHẬN tính là lượt gửi đầu: thay tx dựng TRƯỚC, nộp lại thành công không thay tx dựng SAU; CẶP: không có lượt chưa-xác-nhận ⟹ lượt nhận đầu thay cả hai", () => {
    const r = new IssuedTxRegistry(TTL);
    r.record(T2, 0, { route: "consume", lockKeys: [OWNER] });   // dựng TRƯỚC T1
    r.record(T1, 1, { route: "consume", lockKeys: [OWNER] });
    expect(r.markSubmitted(T1, 2, "unconfirmed")).toBe(1);       // mất kết nối khi nộp
    expect(r.lookup(T2, 2)?.supersededBy).toBe(T1);
    expect(submissionStateOf(r.lookup(T1, 2)!)).toBe("unconfirmed");
    r.record(T3, 3, { route: "consume", lockKeys: [OWNER] });   // dựng SAU lượt gửi đầu
    expect(r.markSubmitted(T1, 4, "accepted")).toBe(0);          // nộp lại, nút nhận
    expect(r.lookup(T3, 4)?.supersededBy).toBeUndefined();
    expect(submissionStateOf(r.lookup(T1, 4)!)).toBe("accepted");
    expect(r.markSubmitted(T1, 5, "unconfirmed")).toBe(0);       // không hạ cấp
    expect(submissionStateOf(r.lookup(T1, 5)!)).toBe("accepted");

    const c = new IssuedTxRegistry(TTL);
    c.record(T2, 0, { route: "consume", lockKeys: [OWNER] });
    c.record(T1, 1, { route: "consume", lockKeys: [OWNER] });
    c.record(T3, 3, { route: "consume", lockKeys: [OWNER] });
    expect(c.markSubmitted(T1, 4, "accepted")).toBe(2);
    expect(c.lookup(T3, 4)?.supersededBy).toBe(T1);
  });
  it("submissionStateOf: tx chỉ DỰNG ⟹ none", () => {
    const r = new IssuedTxRegistry(TTL);
    r.record(T1, 0, { route: "consume", lockKeys: [OWNER] });
    expect(submissionStateOf(r.lookup(T1, 0)!)).toBe("none");
  });
});

describe("PendingSpends", () => {
  it("giữ input tới hết TTL rồi thôi", () => {
    const p = new PendingSpends(TTL);
    p.note([`${"ab".repeat(32)}#0`], 1_000);
    expect(p.has(`${"ab".repeat(32)}#0`, 1_000 + TTL - 1)).toBe(true);
    expect(p.has(`${"ab".repeat(32)}#1`, 1_000)).toBe(false);
    expect(p.has(`${"ab".repeat(32)}#0`, 1_000 + TTL)).toBe(false);
  });
});
