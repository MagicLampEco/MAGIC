// MagicSDK/tests/burnBatch.test.ts — gương của `validate_burn_batch` (vault.ak:512-638).
//
// Mỗi khối test neo tới dòng Aiken nó phản chiếu. Sửa Aiken mà không đỏ ở đây nghĩa là
// gương đã lệch — P8 hỏng, và nó hỏng im lặng.

import { describe, it, expect } from "vitest";
import { planBurnBatch, isBatchExpired, type MagicBatchLike } from "../src/burnBatch.js";

/** Batch tối thiểu. `decay_window = 1` là giá trị thật đang chạy (§4.2 vách đứng). */
const batch = (
  id: string, amount: bigint, created: bigint, decay = 1n,
): MagicBatchLike => ({
  batch_id: id, current_amount: amount, created_epoch: created, decay_window: decay,
  source: "Schedule", initial_amount: amount, profile_at_creation: null,
  contract_id: null, halved: false,
});

const datumWith = (batches: MagicBatchLike[], over: Record<string, unknown> = {}) => ({
  owner: "aa".repeat(28),
  lamp_balance: 1_000_000n, lamp_locked: 0n,
  loyalty_holdings: [], magic_batches: batches, next_batch_index: BigInt(batches.length),
  vacuum_orders: [], gen_schedules: [],
  profile: "Ember", profile_changed_epoch: 0n, pending_profile: null,
  last_updated_epoch: 5n,
  delegation_cert: {},
  activity_state: { recent_burn_epochs: [], consumed_credit: 100n },
  streak_state: { current_streak: 0n, last_active_epoch: 0n },
  personal_delegate: null,
  attribution: { attribution_root: "00".repeat(32), last_event_epoch: 4n, total_events: 7n },
  ...over,
}) as never;

describe("isBatchExpired — §4.2 vách đứng (vault.ak:630-632)", () => {
  it("k < decay_window ⟹ còn sống", () => {
    expect(isBatchExpired(batch("a1", 10n, 5n, 1n), 5n)).toBe(false);
  });
  it("k == decay_window ⟹ CHẾT (dấu >=, không phải >)", () => {
    expect(isBatchExpired(batch("a1", 10n, 5n, 1n), 6n)).toBe(true);
  });
  it("decay_window rộng hơn thì sống lâu hơn", () => {
    expect(isBatchExpired(batch("a1", 10n, 5n, 3n), 7n)).toBe(false);
    expect(isBatchExpired(batch("a1", 10n, 5n, 3n), 8n)).toBe(true);
  });
});

describe("planBurnBatch — chọn batch", () => {
  it("một batch đủ: burns đúng một dòng, Σ == required (vault.ak:552)", () => {
    const p = planBurnBatch(datumWith([batch("a1", 500n, 5n)]), 200n, 5n);
    expect(p.burns).toEqual([["a1", 200n]]);
    expect(p.burns.reduce((s, [, a]) => s + a, 0n)).toBe(200n);
  });

  // Đây là ca mà bản mẫu cũ (scripts/test/consume_only.ts:309, `find(current_amount >=
  // required)`) TỪ CHỐI dù người dùng thừa MAGIC. `burns` on-chain là List nên chuỗi
  // vẫn nhận — giới hạn nằm ở off-chain, và tệp này gỡ nó.
  it("ĐA-BATCH: 3 batch nhỏ gánh chung một required lớn hơn từng cái", () => {
    const p = planBurnBatch(
      datumWith([batch("a1", 500n, 5n), batch("a2", 500n, 5n), batch("a3", 500n, 5n)]),
      1200n, 5n,
    );
    expect(p.burns.reduce((s, [, a]) => s + a, 0n)).toBe(1200n);
    expect(p.burns.length).toBe(3);
    // batch_id không được lặp: apply_burns (vault.ak:602) đòi count == 1 ở MỖI bước đệ quy,
    // nên dòng thứ hai trên một batch đã cháy hết sẽ thấy count == 0 và fail.
    expect(new Set(p.burns.map(b => b[0])).size).toBe(p.burns.length);
  });

  it("đốt batch SẮP CHẾT trước — không vứt phần dùng-hết-hoặc-mất", () => {
    const p = planBurnBatch(
      datumWith([
        batch("tuoi",  500n, 5n, 5n),   // chết ở epoch 10
        batch("sapchet", 500n, 5n, 1n), // chết ở epoch 6 ⟹ phải đốt trước
      ]),
      300n, 5n,
    );
    expect(p.burns).toEqual([["sapchet", 300n]]);
  });

  it("giữ THỨ TỰ GỐC của magic_batches ở output (apply_burns giữ thứ tự)", () => {
    const p = planBurnBatch(
      datumWith([
        batch("x", 100n, 5n, 9n),   // chết muộn
        batch("y", 100n, 5n, 1n),   // chết sớm ⟹ được chọn trước
        batch("z", 100n, 5n, 9n),
      ]),
      50n, 5n,
    );
    const ids = (p.newDatum as never as { magic_batches: MagicBatchLike[] })
      .magic_batches.map(b => b.batch_id);
    expect(ids).toEqual(["x", "y", "z"]);   // KHÔNG phải thứ tự đã sắp để chọn
  });
});

describe("planBurnBatch — prune (vault.ak:545-546)", () => {
  it("batch cháy về 0 bị bỏ khỏi output", () => {
    const p = planBurnBatch(datumWith([batch("a1", 200n, 5n), batch("a2", 300n, 5n)]), 200n, 5n);
    const ids = (p.newDatum as never as { magic_batches: MagicBatchLike[] })
      .magic_batches.map(b => b.batch_id);
    expect(ids).toEqual(["a2"]);
  });

  it("batch ĐÃ CHẾT bị bỏ dù KHÔNG ai đụng tới — prune_expired chạy trên cả danh sách", () => {
    const p = planBurnBatch(
      datumWith([batch("chet", 999n, 3n, 1n), batch("song", 500n, 5n, 1n)]),
      100n, 5n,
    );
    const out = (p.newDatum as never as { magic_batches: MagicBatchLike[] }).magic_batches;
    expect(out.map(b => b.batch_id)).toEqual(["song"]);
    expect(p.expiredDropped.map(b => b.batch_id)).toEqual(["chet"]);   // app phải báo người dùng
  });

  it("MAGIC trong batch chết KHÔNG được tính vào khả năng chi", () => {
    expect(() => planBurnBatch(
      datumWith([batch("chet", 10_000n, 3n, 1n), batch("song", 50n, 5n, 1n)]),
      100n, 5n,
    )).toThrow(/còn sống 50 nanogic < required 100/);
  });
});

describe("planBurnBatch — kế toán A02 (vault.ak:556-578)", () => {
  it("consumed_credit += required, KHÔNG += số dòng burn", () => {
    const p = planBurnBatch(datumWith([batch("a1", 500n, 5n), batch("a2", 500n, 5n)]), 700n, 5n);
    const d = p.newDatum as never as { activity_state: { consumed_credit: bigint } };
    expect(d.activity_state.consumed_credit).toBe(100n + 700n);
  });

  it("attribution.total_events +1 mỗi TX — không theo op_count, không theo số batch", () => {
    const p = planBurnBatch(datumWith([batch("a1", 500n, 5n), batch("a2", 500n, 5n)]), 700n, 5n);
    const d = p.newDatum as never as { attribution: { total_events: bigint; last_event_epoch: bigint } };
    expect(d.attribution.total_events).toBe(8n);
    expect(d.attribution.last_event_epoch).toBe(5n);
  });

  it("last_updated_epoch = currentEpoch", () => {
    const p = planBurnBatch(datumWith([batch("a1", 500n, 5n)]), 100n, 5n);
    expect((p.newDatum as never as { last_updated_epoch: bigint }).last_updated_epoch).toBe(5n);
  });

  it("LAMP đứng yên — BurnBatch không đụng lamp_balance/lamp_locked (C-BURN-NO-LAMP)", () => {
    const p = planBurnBatch(datumWith([batch("a1", 500n, 5n)]), 100n, 5n);
    const d = p.newDatum as never as { lamp_balance: bigint; lamp_locked: bigint };
    expect(d.lamp_balance).toBe(1_000_000n);
    expect(d.lamp_locked).toBe(0n);
  });

  // vault.ak:566 chép `pending_profile` y nguyên ⟹ BurnBatch KHÔNG lazy-apply profile.
  // Bản mẫu cũ (consume_only.ts:302) từ chối vault có pending_profile; ràng buộc đó là
  // của kịch bản test, không phải của chuỗi.
  it("vault có pending_profile vẫn tiêu được, và trường đi qua nguyên vẹn", () => {
    const pending = { new_profile: "Flame", effective_epoch: 9n };
    const p = planBurnBatch(datumWith([batch("a1", 500n, 5n)], { pending_profile: pending }), 100n, 5n);
    expect((p.newDatum as never as { pending_profile: unknown }).pending_profile).toEqual(pending);
  });
});

describe("planBurnBatch — từ chối sớm với lý do đúng", () => {
  it("required <= 0 (vault.ak:552 expect total_burned > 0)", () => {
    expect(() => planBurnBatch(datumWith([batch("a1", 500n, 5n)]), 0n, 5n)).toThrow(/phải > 0/);
    expect(() => planBurnBatch(datumWith([batch("a1", 500n, 5n)]), -1n, 5n)).toThrow(/phải > 0/);
  });

  it("không đủ MAGIC sống — nói rõ đã chết bao nhiêu batch", () => {
    expect(() => planBurnBatch(datumWith([batch("a1", 50n, 5n)]), 100n, 5n))
      .toThrow(/dùng-hết-hoặc-mất/);
  });

  // apply_burns (vault.ak:602) đòi count == 1. Trùng id ⟹ vault KHÔNG BAO GIỜ đốt được
  // nữa, kể cả burn nhắm batch khác. Bắt ở đây để lỗi trỏ đúng nguyên nhân.
  it("hai batch trùng batch_id ⟹ chặn ngay, không để chuỗi trả 'script failed'", () => {
    expect(() => planBurnBatch(
      datumWith([batch("dup", 500n, 5n), batch("dup", 500n, 5n)]), 100n, 5n,
    )).toThrow(/HAI batch cùng batch_id/);
  });

  it("vượt trần 32 batch ở output ⟹ báo trước, không để vault.ak:583 từ chối", () => {
    const many = Array.from({ length: 34 }, (_, i) => batch(`b${i}`, 100n, 5n, 9n));
    expect(() => planBurnBatch(datumWith(many), 50n, 5n)).toThrow(/> trần 32/);
  });
});
