// tests/instantGates.test.ts — cổng của lượt sinh InstantGen Gen v2.0, trên HÀM THUẦN.
//
// Gương: `onchain/validators/vault.ak ▸ validate_instant_gen` (IG-1..IG-14) và
// `onchain/lib/magiclamp/protocol/checkpoint.ak` (luật 1–4), `greenback.ak ▸ shard_draw`.
// Mỗi cổng có CẶP ca đứng ở biên: ca qua và ca chỉ khác đúng một ô (thường +1 nanogic)
// bị từ chối. Bối cảnh mặc định: `instantFixtures.ts` (bốn trần khác nhau, két đã làm
// mới checkpoint trong epoch E).

import { describe, it, expect } from "vitest";
import {
  instantGenLimits, computeInstantGenOutputs, computeRefreshCheckpointOutput, computeBatchId,
  type InstantGenContext,
} from "../offchain/src/instant.js";
import { amountByLamp } from "../offchain/src/genFormula.js";
import { computeCapPp, computeCapLent } from "../offchain/src/math.js";
import { INSTANT_SCALE_HORIZON, RHO_MAX_Q, MAX_BATCHES_PER_VAULT } from "../offchain/src/constants.js";
import {
  E, P, CAP_NANOGIC, GB_SEQ, SHARD_ID, WAKEME_COMMIT, LAMP_BALANCE,
  makeCtx, makeVault, makeRate, instantBatch, zeroWindow,
} from "./instantFixtures.js";

const U = E * P + 1_000n;   // cận trên validity mà script thấy

function gen(ctx: InstantGenContext, m: bigint, upper = U) {
  return computeInstantGenOutputs({ ...ctx, m, validityUpperMs: upper, msPerEpoch: P });
}

/** Cặp biên chung: `m` qua, `m + 1` NÉM đúng mẫu. */
function edge(ctx: InstantGenContext, m: bigint, reject: RegExp) {
  expect(() => gen(ctx, m)).not.toThrow();
  expect(() => gen(ctx, m + 1n)).toThrow(reject);
}

describe("IG-4 — m > 0", () => {
  it("m = 1 qua", () => {
    expect(gen(makeCtx(), 1n).m).toBe(1n);
  });
  it("CỰC ĐỐI: m = 0 ⟹ GEN-INST-004 (không có giao dịch cấp 0)", () => {
    expect(() => gen(makeCtx(), 0n)).toThrow(/GEN-INST-004/);
  });
  it("CỰC ĐỐI: m = −1 ⟹ GEN-INST-004", () => {
    expect(() => gen(makeCtx(), -1n)).toThrow(/GEN-INST-004/);
  });
});

describe("IG-3 — thời gian không lùi", () => {
  it("last_updated_epoch == e qua; == e+1 ⟹ GEN-INST-002", () => {
    expect(() => gen(makeCtx({ datum: { last_updated_epoch: E } }), 1n)).not.toThrow();
    expect(() => gen(makeCtx({ datum: { last_updated_epoch: E + 1n } }), 1n)).toThrow(/GEN-INST-002/);
  });
});

describe("IG-6 — G2 tính cả L_lent", () => {
  const thieu = { lamp_balance: 9_999_999n, loyalty_holdings: [] };
  it("CỰC ĐỐI: lamp_balance = min − 1, không két Wakeme ⟹ GEN-INST-001", () => {
    expect(() => gen(makeCtx({ datum: thieu }), 1n)).toThrow(/GEN-INST-001/);
  });
  it("cùng két, két Wakeme đã ghim góp L_lent = 1 ⟹ qua", () => {
    const ctx = makeCtx({ datum: { ...thieu, wakeme_link: WAKEME_COMMIT }, wakeme: { ownerCommit: WAKEME_COMMIT, lent: 1n } });
    expect(gen(ctx, 1n).lent).toBe(1n);
  });
});

describe("IG-7 — còn chỗ cho một batch", () => {
  const batches = (n: number) => Array.from({ length: n }, (_, i) => instantBatch(1n, E, 1n, (i + 16).toString(16).padStart(2, "0")));
  it(`${MAX_BATCHES_PER_VAULT - 1} batch sống ⟹ qua; ${MAX_BATCHES_PER_VAULT} ⟹ GEN-VAULT-001`, () => {
    expect(() => gen(makeCtx({ datum: { magic_batches: batches(MAX_BATCHES_PER_VAULT - 1) } }), 1n)).not.toThrow();
    expect(() => gen(makeCtx({ datum: { magic_batches: batches(MAX_BATCHES_PER_VAULT) } }), 1n)).toThrow(/GEN-VAULT-001/);
  });
  it("batch CHẾT (epoch trước, decay 1) không chiếm chỗ và bị dọn khỏi datum ra", () => {
    const dead = batches(MAX_BATCHES_PER_VAULT).map(b => ({ ...b, created_epoch: E - 1n }));
    const o = gen(makeCtx({ datum: { magic_batches: dead } }), 1n);
    expect(o.prunedCount).toBe(MAX_BATCHES_PER_VAULT);
    expect(o.outputDatum.magic_batches).toHaveLength(1);
  });
});

describe("IG-8 — cộng dồn trong epoch ≤ cap_nanogic", () => {
  // cap 3e8, đã sinh 1e8 trong E ⟹ còn đúng 2e8. Trần LAMP 4e11 không ràng buộc.
  const ctx = makeCtx({ datum: { cap_nanogic: 300_000_000n, magic_batches: [instantBatch(100_000_000n)], next_batch_index: 1n } });
  it("m = cap − đã sinh qua; +1 ⟹ GEN-INST-008 nêu cap_nanogic", () => {
    edge(ctx, 200_000_000n, /GEN-INST-008.*cap_nanogic/);
  });
  it("đếm initial_amount, không current_amount: lô đã tiêu sạch vẫn là ĐÃ SINH", () => {
    const spent = { ...instantBatch(100_000_000n), current_amount: 0n };
    const c = makeCtx({ datum: { cap_nanogic: 300_000_000n, magic_batches: [spent], next_batch_index: 1n } });
    edge(c, 200_000_000n, /GEN-INST-008.*cap_nanogic/);
  });
  it("lô epoch TRƯỚC còn sống KHÔNG tính vào epoch này (cùng lượng, khác created_epoch)", () => {
    const c = makeCtx({ datum: { cap_nanogic: 300_000_000n, magic_batches: [instantBatch(100_000_000n, E - 1n, 5n)], next_batch_index: 1n } });
    edge(c, 300_000_000n, /GEN-INST-008.*cap_nanogic/);
  });
});

describe("IG-9 — cộng dồn ≤ cap_pp(L_avail) + cap_lent(L_lent)", () => {
  // L = 1e8 oildrop ⟹ cap_pp = 4e8; cap_nanogic 1e12 không ràng buộc; đã sinh 1e8.
  const base = { lamp_balance: 100_000_000n, loyalty_holdings: [], magic_batches: [instantBatch(100_000_000n)], next_batch_index: 1n };
  it("không L_lent: m = 4e8 − 1e8 qua; +1 ⟹ GEN-INST-008 nêu trần LAMP", () => {
    const ctx = makeCtx({ datum: base });
    expect(instantGenLimits(ctx).capLamp).toBe(computeCapPp(100_000_000n));
    edge(ctx, 300_000_000n, /GEN-INST-008.*trần LAMP/);
  });
  it("L_lent = 1e9 ⟹ cap_lent chạm LENT_PP_CAP (1e9): biên dời đúng 1e9", () => {
    const ctx = makeCtx({ datum: { ...base, wakeme_link: WAKEME_COMMIT }, wakeme: { ownerCommit: WAKEME_COMMIT, lent: 1_000_000_000n } });
    expect(computeCapLent(1_000_000_000n)).toBe(1_000_000_000n);
    edge(ctx, 1_300_000_000n, /GEN-INST-008.*trần LAMP/);
  });
  it("L_lent = 1e8 ⟹ cap_lent = cap_pp(1e8) = 4e8 (dưới trần LENT_PP_CAP)", () => {
    const ctx = makeCtx({ datum: { ...base, wakeme_link: WAKEME_COMMIT }, wakeme: { ownerCommit: WAKEME_COMMIT, lent: 100_000_000n } });
    edge(ctx, 700_000_000n, /GEN-INST-008.*trần LAMP/);
  });
  it("trần đọc L_avail HIỆN TẠI (lamp_balance − lamp_locked), không lamp_balance", () => {
    const ctx = makeCtx({ datum: { ...base, lamp_balance: 150_000_000n, lamp_locked: 50_000_000n } });
    edge(ctx, 300_000_000n, /GEN-INST-008.*trần LAMP/);
  });
});

describe("IG-10 — beacon GreenBack mở", () => {
  it("depeg = false qua; depeg = true ⟹ GEN-INST-012", () => {
    expect(() => gen(makeCtx({ greenback: { depeg: false } }), 1n)).not.toThrow();
    expect(() => gen(makeCtx({ greenback: { depeg: true } }), 1n)).toThrow(/GEN-INST-012.*depeg/);
  });
  it("tuổi 1 epoch qua; tuổi 2 ⟹ GEN-INST-012 (cũ)", () => {
    expect(() => gen(makeCtx({ greenback: { epoch: E - 1n } }), 1n)).not.toThrow();
    expect(() => gen(makeCtx({ greenback: { epoch: E - 2n } }), 1n)).toThrow(/GEN-INST-012.*cũ/);
  });
  it("beacon mang epoch tương lai ⟹ GEN-INST-012", () => {
    expect(() => gen(makeCtx({ greenback: { epoch: E + 1n } }), 1n)).toThrow(/GEN-INST-012/);
  });
});

describe("IG-11 — shard GB của két: rút đúng m, còn lại ≥ 0", () => {
  it("shard còn 7e7: m = 7e7 qua, shard ra còn 0; +1 ⟹ GEN-INST-013", () => {
    const ctx = makeCtx({ shardIn: { remaining: 70_000_000n } });
    edge(ctx, 70_000_000n, /GEN-INST-013.*chỉ còn/);
    const o = gen(ctx, 70_000_000n);
    expect(o.shardOut).toEqual({ shard_id: SHARD_ID, seq: GB_SEQ, reset_amount: 10_000_000_000_000n, remaining: 0n });
  });
  it("shard ra = remaining − m, giữ seq và reset_amount khi seq bằng beacon", () => {
    const o = gen(makeCtx({ shardIn: { remaining: 70_000_000n } }), 1_234n);
    expect(o.shardOut.remaining).toBe(70_000_000n - 1_234n);
    expect(o.shardOut.seq).toBe(GB_SEQ);
  });
  it("seq beacon tăng ⟹ đặt lại lười về min(gb/16, cap), rồi mới rút", () => {
    // shard cũ đã cạn; beacon seq+1, gb/16 = 9e8, cap shard 6e8 ⟹ reset 6e8.
    const ctx = makeCtx({
      shardIn: { seq: GB_SEQ - 1n, remaining: 0n },
      greenback: { gb_nanogic: 900_000_000n * 16n },
      gbShardCapNanogic: 600_000_000n,
    });
    // phần GB mỗi két = 6e8·5% = 3e7 là trần đang ràng buộc — dùng m nhỏ để soi shard ra.
    const o = gen(ctx, 1_000n);
    expect(o.shardOut).toEqual({ shard_id: SHARD_ID, seq: GB_SEQ, reset_amount: 600_000_000n, remaining: 600_000_000n - 1_000n });
    // cực đối: KHÔNG tăng seq thì shard cạn ⟹ từ chối
    expect(() => gen(makeCtx({ shardIn: { remaining: 0n } }), 1n)).toThrow(/GEN-INST-013/);
  });
  it("shard mang seq > beacon ⟹ GEN-INST-013 (trạng thái không tới được)", () => {
    expect(() => gen(makeCtx({ shardIn: { seq: GB_SEQ + 1n } }), 1n)).toThrow(/GEN-INST-013.*không tới được/);
  });
  it("shard của két khác ⟹ GEN-INST-013", () => {
    expect(() => gen(makeCtx({ shardIn: { shard_id: (SHARD_ID + 1n) % 16n } }), 1n)).toThrow(/GEN-INST-013.*két thuộc shard/);
  });
});

describe("IG-12 — open.generated + m ≤ gb_vault_share(reset_amount)", () => {
  // reset 2e10 ⟹ phần mỗi két 1e9; ô 0 đã sinh 4e8 ⟹ còn 6e8.
  const win = () => { const w = zeroWindow(); w[0] = { generated: 400_000_000n, consumed: 0n }; return w; };
  const ctx = makeCtx({ datum: { usage_window: win() }, shardIn: { reset_amount: 20_000_000_000n, remaining: 20_000_000_000n } });
  it("m = 6e8 qua; +1 ⟹ GEN-INST-014", () => {
    expect(instantGenLimits(ctx).vaultShare).toBe(1_000_000_000n);
    edge(ctx, 600_000_000n, /GEN-INST-014/);
  });
  it("phần mỗi két tính từ reset_amount SAU đặt lại lười, không từ shard vào", () => {
    // shard vào reset 2e10 nhưng seq cũ; beacon cho reset mới 4e10 ⟹ phần 2e9 ⟹ còn 1.6e9.
    const c = makeCtx({
      datum: { usage_window: win() },
      shardIn: { seq: GB_SEQ - 1n, reset_amount: 20_000_000_000n, remaining: 0n },
      greenback: { gb_nanogic: 40_000_000_000n * 16n },
    });
    edge(c, 1_600_000_000n, /GEN-INST-014/);
  });
});

describe("maxM — đúng m lớn nhất qua được IG-8, IG-9, IG-11, IG-12 cùng lúc", () => {
  const scenarios: Array<[string, InstantGenContext]> = [
    ["IG-8 ràng buộc", makeCtx({ datum: { cap_nanogic: 123_456n } })],
    ["IG-9 ràng buộc", makeCtx()],
    ["IG-11 ràng buộc", makeCtx({ shardIn: { remaining: 98_765n } })],
    ["IG-12 ràng buộc", makeCtx({ shardIn: { reset_amount: 2_000_000_000n, remaining: 2_000_000_000n } })],
  ];
  for (const [name, ctx] of scenarios) {
    it(`${name}: maxM qua, maxM + 1 bị từ chối`, () => {
      const { maxM } = instantGenLimits(ctx);
      expect(maxM).toBeGreaterThan(0n);
      expect(() => gen(ctx, maxM)).not.toThrow();
      expect(() => gen(ctx, maxM + 1n)).toThrow();
    });
  }
  it("mặc định trần LAMP ràng buộc: maxM = 4·L_avail", () => {
    expect(instantGenLimits(makeCtx()).maxM).toBe(computeCapPp(LAMP_BALANCE));
  });
});

describe("IG-5 — checkpoint làm mới khi cap_epoch < e", () => {
  const cu = () => {
    const w = zeroWindow(); w[0] = { generated: 5n, consumed: 3n }; w[6] = { generated: 9n, consumed: 9n };
    return { cap_epoch: E - 1n, usage_window_epoch: E - 1n, usage_window: w, cap_nanogic: 1n };
  };
  it("CỰC ĐỐI: làm mới mà thiếu ρ ⟹ GEN-INST-011", () => {
    expect(() => instantGenLimits(makeCtx({ datum: cu() }))).toThrow(/GEN-INST-011.*beacon ρ/);
  });
  it("cùng epoch (không làm mới) thì không cần ρ", () => {
    const l = instantGenLimits(makeCtx());
    expect(l.refreshed).toBe(false);
    expect(l.capNanogic).toBe(CAP_NANOGIC);
  });
  it("có ρ ⟹ cap_epoch := e, cửa sổ dịch một ô, cap = amount_by_lamp(ρ(e))", () => {
    const rate = makeRate({ rho_q: 1_000_000_000n, effective_epoch: E });
    const l = instantGenLimits(makeCtx({ datum: cu(), rate }));
    expect(l.refreshed).toBe(true);
    expect(l.checkpoint.cap_epoch).toBe(E);
    expect(l.checkpoint.usage_window_epoch).toBe(E);
    expect(l.checkpoint.usage_window[0]).toEqual({ generated: 0n, consumed: 0n });
    expect(l.checkpoint.usage_window[1]).toEqual({ generated: 5n, consumed: 3n });
    expect(l.checkpoint.usage_window).toHaveLength(7);   // ô 6 cũ rơi ra
    expect(l.checkpoint.cap_nanogic).toBe(amountByLamp(LAMP_BALANCE, 0n, l.checkpoint.usage_window, 1_000_000_000n, INSTANT_SCALE_HORIZON));
    expect(l.checkpoint.cap_nanogic).not.toBe(1n);
  });
  it("e < effective_epoch ⟹ dùng prev_rho_q (cặp: hai ρ cho hai cap khác nhau)", () => {
    const now = instantGenLimits(makeCtx({ datum: cu(), rate: makeRate({ effective_epoch: E }) })).capNanogic;
    const prev = instantGenLimits(makeCtx({ datum: cu(), rate: makeRate({ effective_epoch: E + 1n }) }));
    expect(prev.capNanogic).not.toBe(now);
    expect(prev.capNanogic).toBe(amountByLamp(LAMP_BALANCE, 0n, prev.checkpoint.usage_window, 500_000_000n, INSTANT_SCALE_HORIZON));
  });
  it("ρ = RHO_MAX_Q qua; RHO_MAX_Q + 1 ⟹ GEN-INST-011", () => {
    expect(() => instantGenLimits(makeCtx({ datum: cu(), rate: makeRate({ rho_q: RHO_MAX_Q }) }))).not.toThrow();
    expect(() => instantGenLimits(makeCtx({ datum: cu(), rate: makeRate({ rho_q: RHO_MAX_Q + 1n }) }))).toThrow(/GEN-INST-011/);
  });
  it("datum ra mang checkpoint mới và m cộng vào ô 0 của cửa sổ ĐÃ DỊCH", () => {
    const ctx = makeCtx({ datum: cu(), rate: makeRate() });
    const o = gen(ctx, 1_000n);
    expect(o.outputDatum.cap_epoch).toBe(E);
    expect(o.outputDatum.cap_nanogic).toBe(o.checkpoint.cap_nanogic);
    expect(o.outputDatum.usage_window_epoch).toBe(E);
    expect(o.outputDatum.usage_window[0]).toEqual({ generated: 1_000n, consumed: 0n });
    expect(o.outputDatum.usage_window[1]).toEqual({ generated: 5n, consumed: 3n });
  });
});

describe("luật link két Wakeme (checkpoint.ak luật 1–2)", () => {
  const refresh = { cap_epoch: E - 1n, usage_window_epoch: E - 1n };
  const rate = makeRate();
  const w = (commit = WAKEME_COMMIT, lent = 500_000_000n) => ({ ownerCommit: commit, lent });

  it("làm mới + có két Wakeme ⟹ link := owner_commit, L_lent vào trần", () => {
    const o = gen(makeCtx({ datum: refresh, rate, wakeme: w() }), 1n);
    expect(o.outputDatum.wakeme_link).toBe(WAKEME_COMMIT);
    expect(o.lent).toBe(500_000_000n);
    expect(o.capLamp).toBe(computeCapPp(LAMP_BALANCE) + computeCapLent(500_000_000n));
  });
  it("làm mới theo FollowVault được ĐỔI sang két Wakeme khác", () => {
    const other = "d4".repeat(32);
    const o = gen(makeCtx({ datum: { ...refresh, wakeme_link: WAKEME_COMMIT }, rate, wakeme: w(other) }), 1n);
    expect(o.outputDatum.wakeme_link).toBe(other);
  });
  it("CỰC ĐỐI: link đã ghim, làm mới mà vắng két ⟹ GEN-INST-011 (luật 2)", () => {
    expect(() => gen(makeCtx({ datum: { ...refresh, wakeme_link: WAKEME_COMMIT }, rate }), 1n)).toThrow(/GEN-INST-011.*BẮT BUỘC/);
  });
  it("cùng két, KHÔNG làm mới (cap_epoch == e) mà vắng két ⟹ qua, link giữ, L_lent = 0", () => {
    const o = gen(makeCtx({ datum: { wakeme_link: WAKEME_COMMIT } }), 1n);
    expect(o.outputDatum.wakeme_link).toBe(WAKEME_COMMIT);
    expect(o.lent).toBe(0n);
  });
  it("CỰC ĐỐI: giữa epoch, két Wakeme KHÁC két đã ghim ⟹ GEN-INST-011", () => {
    expect(() => gen(makeCtx({ datum: { wakeme_link: WAKEME_COMMIT }, wakeme: w("d4".repeat(32)) }), 1n)).toThrow(/GEN-INST-011.*giữa epoch/);
  });
  it("chưa ghim, làm mới, vắng két ⟹ link rỗng, qua", () => {
    const o = gen(makeCtx({ datum: refresh, rate }), 1n);
    expect(o.outputDatum.wakeme_link).toBe("");
  });
});

describe("IG-13 — instant_unlock_ms = max(mốc cũ, cận trên + ms_per_epoch)", () => {
  const moc = (old: bigint) => gen(makeCtx({ datum: { instant_unlock_ms: old } }), 1n).outputDatum.instant_unlock_ms;
  it("mốc cũ 0 ⟹ cận trên + P", () => expect(moc(0n)).toBe(U + P));
  it("mốc cũ = U + P − 1 ⟹ U + P (mốc MỚI thắng)", () => expect(moc(U + P - 1n)).toBe(U + P));
  it("mốc cũ = U + P ⟹ U + P", () => expect(moc(U + P)).toBe(U + P));
  it("mốc cũ = U + P + 1 ⟹ giữ mốc cũ (không rút ngắn khoá)", () => expect(moc(U + P + 1n)).toBe(U + P + 1n));
  it("cận trên khác ⟹ mốc dời theo đúng cận trên", () => {
    expect(gen(makeCtx(), 1n, U + 7_000n).outputDatum.instant_unlock_ms).toBe(U + 7_000n + P);
  });
});

describe("IG-13 — datum ra so NGUYÊN bản ghi", () => {
  it("usage_window[0].generated cộng đúng m; consumed và ô 1..6 đứng yên", () => {
    const w = zeroWindow();
    w[0] = { generated: 10n, consumed: 7n };
    w[3] = { generated: 1n, consumed: 2n };
    const o = gen(makeCtx({ datum: { usage_window: w } }), 12_345n);
    expect(o.outputDatum.usage_window[0]).toEqual({ generated: 10n + 12_345n, consumed: 7n });
    expect(o.outputDatum.usage_window.slice(1)).toEqual(w.slice(1));
  });
  it("batch mới, chỉ số, epoch, attribution; LAMP + checkpoint + các ô khác đứng yên", () => {
    const d = makeVault({ next_batch_index: 4n, attribution: { attribution_root: "11".repeat(32), last_event_epoch: 3n, total_events: 8n } });
    const ctx = makeCtx({ datum: d });
    const o = gen(ctx, 777n);
    expect(o.newBatch).toEqual({
      batch_id: computeBatchId(ctx.vaultOutRef, 4n), source: "Instant", created_epoch: E,
      initial_amount: 777n, current_amount: 777n, decay_window: 1n,
      profile_at_creation: null, contract_id: null, halved: false,
    });
    const { magic_batches, next_batch_index, last_updated_epoch, attribution, instant_unlock_ms, usage_window, ...rest } = o.outputDatum;
    const { magic_batches: _a, next_batch_index: _b, last_updated_epoch: _c, attribution: _d, instant_unlock_ms: _e, usage_window: _f, ...restIn } = d;
    expect(rest).toEqual(restIn);
    expect(magic_batches).toEqual([o.newBatch]);
    expect(next_batch_index).toBe(5n);
    expect(last_updated_epoch).toBe(E);
    expect(attribution.last_event_epoch).toBe(E);
    expect(attribution.total_events).toBe(9n);
    void instant_unlock_ms; void usage_window;
  });
  it("hồ sơ chờ tới hạn được ÁP vào datum ra; chưa tới hạn thì giữ nguyên", () => {
    const due = gen(makeCtx({ datum: { pending_profile: { new_profile: "Ember", effective_epoch: E } } }), 1n).outputDatum;
    expect(due.profile).toBe("Ember");
    expect(due.pending_profile).toBeNull();
    const notDue = gen(makeCtx({ datum: { pending_profile: { new_profile: "Ember", effective_epoch: E + 1n } } }), 1n).outputDatum;
    expect(notDue.profile).toBe("Flame");
    expect(notDue.pending_profile).toEqual({ new_profile: "Ember", effective_epoch: E + 1n });
  });
});

describe("RefreshCheckpoint — FollowVaultOrUnlink, luôn làm mới", () => {
  const rate = makeRate();
  it("CỰC ĐỐI: thiếu ρ ⟹ GEN-INST-011, kể cả khi cap_epoch == e", () => {
    expect(() => computeRefreshCheckpointOutput(makeVault(), E, null, null)).toThrow(/GEN-INST-011/);
  });
  it("cap_epoch == e vẫn tính lại cap (force)", () => {
    const { outputDatum } = computeRefreshCheckpointOutput(makeVault(), E, null, rate);
    expect(outputDatum.cap_nanogic).toBe(amountByLamp(LAMP_BALANCE, 0n, zeroWindow(), rate.rho_q, INSTANT_SCALE_HORIZON));
    expect(outputDatum.cap_nanogic).not.toBe(CAP_NANOGIC);
  });
  it("link đã ghim mà vắng két ⟹ GỠ ghim (link rỗng), không ném", () => {
    const { outputDatum } = computeRefreshCheckpointOutput(makeVault({ wakeme_link: WAKEME_COMMIT }), E, null, rate);
    expect(outputDatum.wakeme_link).toBe("");
  });
  it("có két ⟹ link := owner_commit và cap tính với L_lent", () => {
    const { outputDatum, checkpoint } = computeRefreshCheckpointOutput(makeVault(), E, { ownerCommit: WAKEME_COMMIT, lent: 2_000_000_000n }, rate);
    expect(outputDatum.wakeme_link).toBe(WAKEME_COMMIT);
    expect(checkpoint.cap_nanogic).toBe(amountByLamp(LAMP_BALANCE, 2_000_000_000n, zeroWindow(), rate.rho_q, INSTANT_SCALE_HORIZON));
  });
  it("chỉ năm ô checkpoint đổi; hồ sơ chờ KHÔNG được áp (..input_datum thô)", () => {
    const d = makeVault({ cap_epoch: E - 1n, usage_window_epoch: E - 1n, pending_profile: { new_profile: "Ember", effective_epoch: E } });
    const { outputDatum } = computeRefreshCheckpointOutput(d, E, null, rate);
    const pick = ({ wakeme_link, cap_epoch, cap_nanogic, usage_window, usage_window_epoch, ...r }: typeof d) => {
      void wakeme_link; void cap_epoch; void cap_nanogic; void usage_window; void usage_window_epoch; return r;
    };
    expect(pick(outputDatum)).toEqual(pick(d));
    expect(outputDatum.profile).toBe("Flame");
    expect(outputDatum.cap_epoch).toBe(E);
  });
  it("CỰC ĐỐI: epoch lùi so với cap_epoch ⟹ GEN-INST-011", () => {
    expect(() => computeRefreshCheckpointOutput(makeVault({ cap_epoch: E + 1n }), E, null, rate)).toThrow(/GEN-INST-011/);
  });
});
