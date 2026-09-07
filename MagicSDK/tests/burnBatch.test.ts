// MagicSDK/tests/burnBatch.test.ts — gương của `validate_burn_batch` (vault.ak:512-638).
//
// Mỗi khối test neo tới dòng Aiken nó phản chiếu. Sửa Aiken mà không đỏ ở đây nghĩa là
// gương đã lệch — P8 hỏng, và nó hỏng im lặng.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Data } from "@lucid-evolution/lucid";

import {
  planBurnBatch, buildVaultBurnBatch, applyPendingProfile, isBatchExpired,
  type MagicBatchLike,
} from "../src/burnBatch.js";
import { VaultDatumSchema } from "../src/schemas.js";
import type { PlutusJson } from "../src/redeemerIndex.js";

// Phần lớn ca dưới đây kiểm hành vi CHUNG của hai module vault, nên chạy qua bản
// ScheduleGen. Những ca RIÊNG của từng module gọi thẳng `planBurnBatch` với module
// tường minh — xem describe "hai module khác nhau ở pending_profile".
const planSG = (d: Parameters<typeof planBurnBatch>[0], r: bigint, e: bigint) =>
  planBurnBatch(d, r, e, "ScheduleGen");

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
    const p = planSG(datumWith([batch("a1", 500n, 5n)]), 200n, 5n);
    expect(p.burns).toEqual([["a1", 200n]]);
    expect(p.burns.reduce((s, [, a]) => s + a, 0n)).toBe(200n);
  });

  // Đây là ca mà bản mẫu cũ (scripts/test/consume_only.ts:309, `find(current_amount >=
  // required)`) TỪ CHỐI dù người dùng thừa MAGIC. `burns` on-chain là List nên chuỗi
  // vẫn nhận — giới hạn nằm ở off-chain, và tệp này gỡ nó.
  it("ĐA-BATCH: 3 batch nhỏ gánh chung một required lớn hơn từng cái", () => {
    const p = planSG(
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
    const p = planSG(
      datumWith([
        batch("tuoi",  500n, 5n, 5n),   // chết ở epoch 10
        batch("sapchet", 500n, 5n, 1n), // chết ở epoch 6 ⟹ phải đốt trước
      ]),
      300n, 5n,
    );
    expect(p.burns).toEqual([["sapchet", 300n]]);
  });

  it("giữ THỨ TỰ GỐC của magic_batches ở output (apply_burns giữ thứ tự)", () => {
    const p = planSG(
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
    const p = planSG(datumWith([batch("a1", 200n, 5n), batch("a2", 300n, 5n)]), 200n, 5n);
    const ids = (p.newDatum as never as { magic_batches: MagicBatchLike[] })
      .magic_batches.map(b => b.batch_id);
    expect(ids).toEqual(["a2"]);
  });

  it("batch ĐÃ CHẾT bị bỏ dù KHÔNG ai đụng tới — prune_expired chạy trên cả danh sách", () => {
    const p = planSG(
      datumWith([batch("chet", 999n, 3n, 1n), batch("song", 500n, 5n, 1n)]),
      100n, 5n,
    );
    const out = (p.newDatum as never as { magic_batches: MagicBatchLike[] }).magic_batches;
    expect(out.map(b => b.batch_id)).toEqual(["song"]);
    expect(p.expiredDropped.map(b => b.batch_id)).toEqual(["chet"]);   // app phải báo người dùng
  });

  it("MAGIC trong batch chết KHÔNG được tính vào khả năng chi", () => {
    expect(() => planSG(
      datumWith([batch("chet", 10_000n, 3n, 1n), batch("song", 50n, 5n, 1n)]),
      100n, 5n,
    )).toThrow(/còn sống 50 nanogic < required 100/);
  });
});

describe("planBurnBatch — kế toán A02 (vault.ak:556-578)", () => {
  it("consumed_credit += required, KHÔNG += số dòng burn", () => {
    const p = planSG(datumWith([batch("a1", 500n, 5n), batch("a2", 500n, 5n)]), 700n, 5n);
    const d = p.newDatum as never as { activity_state: { consumed_credit: bigint } };
    expect(d.activity_state.consumed_credit).toBe(100n + 700n);
  });

  it("attribution.total_events +1 mỗi TX — không theo op_count, không theo số batch", () => {
    const p = planSG(datumWith([batch("a1", 500n, 5n), batch("a2", 500n, 5n)]), 700n, 5n);
    const d = p.newDatum as never as { attribution: { total_events: bigint; last_event_epoch: bigint } };
    expect(d.attribution.total_events).toBe(8n);
    expect(d.attribution.last_event_epoch).toBe(5n);
  });

  it("last_updated_epoch = currentEpoch", () => {
    const p = planSG(datumWith([batch("a1", 500n, 5n)]), 100n, 5n);
    expect((p.newDatum as never as { last_updated_epoch: bigint }).last_updated_epoch).toBe(5n);
  });

  it("LAMP đứng yên — BurnBatch không đụng lamp_balance/lamp_locked (C-BURN-NO-LAMP)", () => {
    const p = planSG(datumWith([batch("a1", 500n, 5n)]), 100n, 5n);
    const d = p.newDatum as never as { lamp_balance: bigint; lamp_locked: bigint };
    expect(d.lamp_balance).toBe(1_000_000n);
    expect(d.lamp_locked).toBe(0n);
  });

  // Bản mẫu cũ (consume_only.ts:302) từ chối vault có pending_profile; ràng buộc đó là
  // của kịch bản test, không phải của chuỗi.
  it("vault có pending_profile CHƯA tới hạn: cả hai module giữ nguyên trường", () => {
    const pending = { new_profile: "Flame", effective_epoch: 9n };
    const d = datumWith([batch("a1", 500n, 5n)], { pending_profile: pending });
    for (const m of ["ScheduleGen", "InstantGen"] as const) {
      const p = planBurnBatch(d, 100n, 5n, m);   // 5n < eff 9n ⟹ on-chain cũng không apply
      expect((p.newDatum as never as { pending_profile: unknown }).pending_profile).toEqual(pending);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// HAI MODULE KHÁC NHAU Ở pending_profile — ca mà bộ test cũ không có
// ══════════════════════════════════════════════════════════════════════════════════
//
// InstantGen chạy `apply_pending_profile` TRƯỚC khi kiểm A02
// (`InstantGen/onchain/validators/vault.ak:913`, so với `applied` ở `:940-942`).
// ScheduleGen KHÔNG (`ScheduleGen/.../vault.ak:564-566` chép `input_datum` thô; cả tệp
// không có hàm đó). Bộ test cũ chỉ chạy `effective_epoch = 9n` với `currentEpoch = 5n`
// — tức nhánh mà on-chain CŨNG không apply — nên nó xanh với cả hành vi đúng lẫn sai.
describe("planBurnBatch — hai module khác nhau ở pending_profile (tới hạn)", () => {
  const pending = { new_profile: "Flame", effective_epoch: 5n };
  const datum   = () => datumWith([batch("a1", 500n, 5n)], {
    profile: "Lantern", pending_profile: pending,
  });

  it("InstantGen: eff <= current ⟹ profile đã áp, pending về null", () => {
    const p = planBurnBatch(datum(), 100n, 5n, "InstantGen");
    const d = p.newDatum as never as { profile: string; pending_profile: unknown };
    expect(d.profile).toBe("Flame");
    expect(d.pending_profile).toBeNull();
  });

  it("ScheduleGen: eff <= current ⟹ VẪN giữ nguyên, vì on-chain không apply", () => {
    const p = planBurnBatch(datum(), 100n, 5n, "ScheduleGen");
    const d = p.newDatum as never as { profile: string; pending_profile: unknown };
    expect(d.profile).toBe("Lantern");
    expect(d.pending_profile).toEqual(pending);
  });

  it("hai module cho datum KHÁC nhau ở đúng ca này — nếu bằng nhau là gương đã hỏng", () => {
    const a = planBurnBatch(datum(), 100n, 5n, "InstantGen").newDatum;
    const b = planBurnBatch(datum(), 100n, 5n, "ScheduleGen").newDatum;
    expect(a).not.toEqual(b);
  });

  it("applyPendingProfile: thuần, không đột biến datum vào", () => {
    const d = datum();
    const out = applyPendingProfile(d, 5n);
    expect((d as never as { pending_profile: unknown }).pending_profile).toEqual(pending);
    expect((out as never as { pending_profile: unknown }).pending_profile).toBeNull();
  });

  it("applyPendingProfile: pending null thì trả về chính nó", () => {
    const d = datumWith([batch("a1", 500n, 5n)], { pending_profile: null });
    expect(applyPendingProfile(d, 99n)).toBe(d);
  });
});

describe("planBurnBatch — từ chối sớm với lý do đúng", () => {
  it("required <= 0 (vault.ak:552 expect total_burned > 0)", () => {
    expect(() => planSG(datumWith([batch("a1", 500n, 5n)]), 0n, 5n)).toThrow(/phải > 0/);
    expect(() => planSG(datumWith([batch("a1", 500n, 5n)]), -1n, 5n)).toThrow(/phải > 0/);
  });

  it("không đủ MAGIC sống — nói rõ đã chết bao nhiêu batch", () => {
    expect(() => planSG(datumWith([batch("a1", 50n, 5n)]), 100n, 5n))
      .toThrow(/dùng-hết-hoặc-mất/);
  });

  // apply_burns (vault.ak:602) đòi count == 1. Trùng id ⟹ vault KHÔNG BAO GIỜ đốt được
  // nữa, kể cả burn nhắm batch khác. Bắt ở đây để lỗi trỏ đúng nguyên nhân.
  it("hai batch trùng batch_id ⟹ chặn ngay, không để chuỗi trả 'script failed'", () => {
    expect(() => planSG(
      datumWith([batch("dup", 500n, 5n), batch("dup", 500n, 5n)]), 100n, 5n,
    )).toThrow(/HAI batch cùng batch_id/);
  });

  it("vượt trần 32 batch ở output ⟹ báo trước, không để vault.ak:583 từ chối", () => {
    const many = Array.from({ length: 34 }, (_, i) => batch(`b${i}`, 100n, 5n, 9n));
    expect(() => planSG(datumWith(many), 50n, 5n)).toThrow(/> trần 32/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// buildVaultBurnBatch — CBOR THẬT, đọc plutus.json ĐÃ BUILD
// ══════════════════════════════════════════════════════════════════════════════════
//
// Trước khối này, 19 ca của tệp chỉ chạm `planBurnBatch` + `isBatchExpired`. Phần rủi
// ro nhất — `new Constr(burnIx, [...])`, chỉ số tra từ plutus.json, và
// `Data.to(newDatum, VaultDatumSchema)` — không có ca nào chốt chuỗi sinh ra. Nghĩa là
// bọc nhầm một lớp `Constr` (đúng cái bẫy mà chú thích trong `src/` cảnh báo) vẫn xanh
// hết bảng. Số đo dưới đây ghim thẳng chuỗi, không phải "hàm không ném lỗi".
describe("buildVaultBurnBatch — CBOR redeemer + datum", () => {
  const plutusPath = (m: string) =>
    fileURLToPath(new URL(`../../${m}/onchain/plutus.json`, import.meta.url));
  const loadPlutus = (m: string) =>
    JSON.parse(readFileSync(plutusPath(m), "utf8")) as PlutusJson;

  // `datumWith` ở trên là fixture cho HÀM THUẦN — `delegation_cert: {}` không thoả
  // `DelegationCertificateSchema` nên không mã hoá được. Khối này cần datum mã hoá
  // THẬT, nên khai đủ trường theo đúng schema.
  const encodable = (over: Record<string, unknown> = {}) => ({
    owner: "aa".repeat(28),
    lamp_balance: 1_000_000n, lamp_locked: 0n,
    loyalty_holdings: [], magic_batches: [batch("a1", 500n, 5n)], next_batch_index: 1n,
    vacuum_orders: [], gen_schedules: [],
    profile: "Ember", profile_changed_epoch: 0n, pending_profile: null,
    last_updated_epoch: 5n,
    delegation_cert: {
      current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n,
    },
    activity_state: { recent_burn_epochs: [], consumed_credit: 100n },
    streak_state: { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate: null,
    attribution: { attribution_root: "00".repeat(32), last_event_epoch: 4n, total_events: 7n },
    ...over,
  });

  const utxoWith = (d: unknown) => ({
    txHash: "ab".repeat(32), outputIndex: 0,
    address: "addr_test1xxx", assets: { lovelace: 2_000_000n },
    datum: Data.to(d as never, VaultDatumSchema),
  });

  it("ScheduleGen: redeemer là Constr(BurnBatch) bọc List các tuple [bid, amt]", () => {
    const pj  = loadPlutus("ScheduleGen");
    const out = buildVaultBurnBatch({
      vaultUtxo: utxoWith(encodable()) as never,
      required: 200n, currentEpoch: 5n,
      vaultModule: "ScheduleGen", vaultPlutusJson: pj,
    });
    // GHIM CHUỖI CỨNG, không phải khẳng định phủ định. Đo bằng lucid 0.4.30:
    //   đúng (tuple = list) : d87b9f 9f 9f41a118c8 ff ff ff
    //   sai  (bọc Constr)   : d87b9f 9f d8799f41a118c8ff ff ff
    // Hai chuỗi chỉ khác ở `d8799f`, nên `not.toContain(...)` là bẫy: viết nhầm chuỗi dò
    // là mutant sống sót mà bảng vẫn xanh. Ghim cả chuỗi thì không trượt được.
    expect(out.vaultBurnRedeemerCbor).toBe("d87b9f9f9f41a118c8ffffff");
    expect(out.burns).toEqual([["a1", 200n]]);
    // datum giải mã ngược phải bằng chính newDatum ⟹ round-trip khép kín.
    expect(Data.from(out.vaultOutDatumCbor, VaultDatumSchema)).toEqual(out.newDatum);
  });

  it("InstantGen: cùng chỉ số redeemer, nhưng datum ra đã áp pending_profile tới hạn", () => {
    const pj = loadPlutus("InstantGen");
    const d  = encodable({
      profile: "Lantern",
      pending_profile: { new_profile: "Flame", effective_epoch: 5n },
    });
    const out = buildVaultBurnBatch({
      vaultUtxo: utxoWith(d) as never,
      required: 200n, currentEpoch: 5n,
      vaultModule: "InstantGen", vaultPlutusJson: pj,
    });
    expect(out.vaultBurnRedeemerCbor.startsWith("d87b")).toBe(true);
    const back = Data.from(out.vaultOutDatumCbor, VaultDatumSchema) as never as {
      profile: string; pending_profile: unknown;
    };
    expect(back.profile).toBe("Flame");
    expect(back.pending_profile).toBeNull();
  });

  it("hai module cho CBOR datum KHÁC nhau ở ca pending tới hạn", () => {
    const d = () => encodable({
      profile: "Lantern",
      pending_profile: { new_profile: "Flame", effective_epoch: 5n },
    });
    const mk = (m: "InstantGen" | "ScheduleGen") => buildVaultBurnBatch({
      vaultUtxo: utxoWith(d()) as never,
      required: 200n, currentEpoch: 5n,
      vaultModule: m, vaultPlutusJson: loadPlutus(m),
    }).vaultOutDatumCbor;
    expect(mk("InstantGen")).not.toBe(mk("ScheduleGen"));
  });
});
