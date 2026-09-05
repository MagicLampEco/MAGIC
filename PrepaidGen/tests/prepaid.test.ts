// tests/prepaid.test.ts — PrepaidGen: math + máy trạng thái + nhánh tấn công
// Chạy: cd offchain && npx vitest run ../tests/prepaid.test.ts

import { describe, expect, it } from "vitest";
import {
  BATCH_SOURCE_PREPAID,
  BURN_BATCH_CONSTR,
  CARP_ASSET_NAME,
  CARP_POLICY_ID,
  MAX_BATCHES_PER_VAULT,
  MAX_PREPAID_CREDITS,
  MIN_BUFFER_BPS,
  MIN_DRAW_CARPDROP,
  MIN_LOCK_CARPDROP,
  NANOGIC_PER_MAGIC,
  CARPDROP_PER_CARP,
  PAR_SCALE,
  PREPAID_DECAY_WINDOW,
} from "../offchain/src/constants.js";
import {
  bufferFloor,
  claimCeiling,
  computeBatchId,
  computeFundId,
  outstandingOf,
  parCarpFromMagic,
  parMagicFromCarp,
} from "../offchain/src/math.js";
import {
  PrepaidRuleError,
  assertFundInvariant,
  burnBatches,
  creditsAfterLock,
  drawMagic,
  fundAfterClaim,
  fundAfterLock,
  fundAfterSettle,
  liveMagic,
  maxClaimable,
  pruneExpired,
  settleDelta,
} from "../offchain/src/prepaid.js";
import type {
  MagicBatch,
  PaidFundDatum,
  PrepaidVaultDatum,
} from "../offchain/src/types.js";
import {
  TV_PP_01,
  TV_PP_02,
  TV_PP_BUFFER,
  TV_PP_EXPIRE,
  TV_PP_OVERFLOW,
} from "./vectors.js";

// ══════════════════════════════════════════════════════════════
// Fixtures
// ══════════════════════════════════════════════════════════════

const FUND_ID = "aa".repeat(32);
const OTHER_FUND = "bb".repeat(32);
const OWNER = "00".repeat(28);
const PLATFORM = "77".repeat(28);
const VAULT_HASH = "11".repeat(28);
const OWN_REF = { txHash: "33".repeat(32), outputIndex: 0n };
const EPOCH = 100n;

function vault(
  credits: { fund_id: string; remaining: bigint }[] = [],
  batches: MagicBatch[] = [],
): PrepaidVaultDatum {
  return {
    owner: OWNER,
    did_commit: "deadbeef",
    prepaid_credits: credits.map((c) => ({
      fund_id: c.fund_id,
      remaining: c.remaining,
      issued_epoch: 99n,
      last_draw_epoch: 99n,
    })),
    magic_batches: batches,
    next_batch_index: 0n,
    personal_delegate: null,
    last_updated_epoch: 99n,
    attribution: { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
  };
}

function batch(
  id: string,
  amount: bigint,
  epoch: bigint = EPOCH,
  fundId: string = FUND_ID,
): MagicBatch {
  return {
    batch_id: id,
    source: BATCH_SOURCE_PREPAID,
    created_epoch: epoch,
    current_amount: amount,
    decay_window: PREPAID_DECAY_WINDOW,
    profile_at_creation: 0n,
    contract_id: fundId,
  };
}

function fund(
  carpLocked: bigint,
  creditIssued: bigint,
  magicSettled = 0n,
  providerClaimed = 0n,
  bufferBps = MIN_BUFFER_BPS,
): PaidFundDatum {
  return {
    fund_id: FUND_ID,
    platform: PLATFORM,
    vault_hash: VAULT_HASH,
    carp_locked: carpLocked,
    credit_issued: creditIssued,
    magic_settled: magicSettled,
    provider_claimed: providerClaimed,
    buffer_bps: bufferBps,
    last_updated_epoch: EPOCH,
  };
}

// ══════════════════════════════════════════════════════════════
// Math
// ══════════════════════════════════════════════════════════════

describe("par 1:1 (C-PP-1)", () => {
  it.each(TV_PP_01.cases)(
    "$carp CARP ↔ $magic MAGIC",
    ({ carpdrop, nanogic }) => {
      expect(parMagicFromCarp(carpdrop)).toBe(nanogic);
      expect(parCarpFromMagic(nanogic)).toBe(carpdrop);
    },
  );

  it("PAR_SCALE dẫn xuất từ hai thang decimals, không phải số ma thuật", () => {
    // Ghim theo HẰNG, không theo literal: bản trước viết `/ 1_000_000n` nên khi
    // CARP đổi sang 9 chữ số thì chốt này vẫn xanh trong lúc nó đã sai.
    expect(NANOGIC_PER_MAGIC / CARPDROP_PER_CARP).toBe(PAR_SCALE);
    expect(PAR_SCALE).toBe(1n);   // CARP và MAGIC cùng 9 chữ số ⇒ par đồng nhất
  });

  it("chiều CARP→MAGIC không mất số dư với mọi giá trị thử", () => {
    for (const c of [0n, 1n, 7n, 999n, 1_000n, 123_456_789n, 10n ** 18n]) {
      expect(parCarpFromMagic(parMagicFromCarp(c))).toBe(c);
    }
  });

  it("chiều MAGIC→CARP KHÔNG còn cắt phần dư — par_scale = 1", () => {
    // Bản trước ghim `999n → 0n` và `1_999n → 1n`: đó là hành vi của par_scale
    // = 1_000. Với CARP 9 chữ số thì hai thang bằng nhau, phép chia sàn không
    // cắt gì, nên lập luận "sàn lệch về phía an toàn cho quỹ" hết chỗ dựa —
    // quỹ khớp đúng bằng số. Ghim đúng hành vi hiện tại, không giữ một chốt
    // mô tả cơ chế đã biến mất.
    expect(parCarpFromMagic(999n)).toBe(999n);
    expect(parCarpFromMagic(1_999n)).toBe(1_999n);
    expect(parCarpFromMagic(parMagicFromCarp(7n))).toBe(7n);
  });

  it("từ chối số âm thay vì để BigInt cắt-về-0 lệch với ⌊⌋ của Aiken", () => {
    expect(() => parCarpFromMagic(-1_500n)).toThrow(RangeError);
    expect(() => parMagicFromCarp(-1n)).toThrow(RangeError);
  });
});

describe("C-OVERFLOW — BigInt tuyệt đối", () => {
  it("thang par toàn cung vượt 2^53 vẫn chính xác", () => {
    expect(parMagicFromCarp(TV_PP_OVERFLOW.carpdrop)).toBe(TV_PP_OVERFLOW.nanogic);
    expect(TV_PP_OVERFLOW.nanogic > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("cùng phép tính bằng Number thì SAI — chứng minh vector này có răng", () => {
    // Thang nanogic vượt khỏi vùng số nguyên an toàn của double.
    expect(Number.isSafeInteger(Number(TV_PP_OVERFLOW.nanogic))).toBe(false);

    // par_scale = 1 nên phép quy đổi là ĐỒNG NHẤT — không còn phép nhân thang
    // nào để làm mất số lẻ. Cái vẫn mất được là bước đi VÒNG qua `Number`, và
    // đó đúng là thứ vector này canh: giá trị dưới đây không biểu diễn được
    // chính xác bằng double, nên chuyển sang Number rồi quay lại là đã sai.
    const lossy = 36_000_000_000_000_000_001n;
    expect(parMagicFromCarp(lossy)).toBe(lossy);
    const viaNumber = BigInt(Number(lossy) * Number(PAR_SCALE));
    expect(viaNumber).not.toBe(lossy);
  });
});

describe("sàn đệm buffer-Paid (C-PP-6 / F2)", () => {
  it.each(TV_PP_BUFFER.cases)("$note", (c) => {
    const outstanding = outstandingOf(TV_PP_BUFFER.credit_issued, c.magic_settled);
    expect(bufferFloor(outstanding, TV_PP_BUFFER.buffer_bps)).toBe(c.buffer_floor);
    const f = fund(
      TV_PP_BUFFER.credit_issued,
      TV_PP_BUFFER.credit_issued,
      c.magic_settled,
      0n,
      TV_PP_BUFFER.buffer_bps,
    );
    expect(maxClaimable(f)).toBe(c.max_claimable);
  });

  it("quỹ chưa tiêu gì thì provider không rút được đồng nào", () => {
    expect(maxClaimable(fund(1_000_000_000n, 1_000_000_000n))).toBe(0n);
  });

  it("trần F2 thô: claim ≤ ⌊magic_settled / par_scale⌋ − đã rút", () => {
    expect(claimCeiling(6_000_000_000n, 1_000_000_000n)).toBe(5_000_000_000n);
  });
});

// ══════════════════════════════════════════════════════════════
// Vòng đời (TV-PP-02)
// ══════════════════════════════════════════════════════════════

describe("TV-PP-02 — vòng đời lock → draw → burn → settle → claim", () => {
  it("chạy hết vòng và khớp mọi con số của vector", () => {
    // 1. Platform khoá 1000 CARP
    const f0 = fund(0n, 0n);
    const f1 = fundAfterLock(f0, TV_PP_02.lock_carpdrop, EPOCH);
    expect(f1.carp_locked).toBe(TV_PP_02.fund_after_lock.carp_locked);
    expect(f1.credit_issued).toBe(TV_PP_02.fund_after_lock.credit_issued);
    assertFundInvariant(f1);

    const v0: PrepaidVaultDatum = {
      ...vault(),
      prepaid_credits: creditsAfterLock([], FUND_ID, TV_PP_02.lock_carpdrop, EPOCH),
    };
    expect(v0.prepaid_credits[0]!.remaining).toBe(TV_PP_02.lock_carpdrop);

    // 2. User rút 10 CARP thành 10 MAGIC
    const v1 = drawMagic(v0, FUND_ID, TV_PP_02.draw_carpdrop, EPOCH, OWN_REF);
    expect(v1.magic_batches).toHaveLength(1);
    expect(v1.magic_batches[0]!.current_amount).toBe(TV_PP_02.drawn_nanogic);
    expect(v1.magic_batches[0]!.created_epoch).toBe(EPOCH);
    expect(v1.magic_batches[0]!.decay_window).toBe(1n);
    expect(v1.prepaid_credits[0]!.remaining).toBe(
      TV_PP_02.lock_carpdrop - TV_PP_02.draw_carpdrop,
    );

    // 3. Tiêu 6 MAGIC
    const bid = v1.magic_batches[0]!.batch_id;
    const v2 = burnBatches(v1, [[bid, TV_PP_02.burn_nanogic]], EPOCH);
    expect(v2.magic_batches[0]!.current_amount).toBe(TV_PP_02.batch_left_nanogic);
    expect(v2.attribution.total_events).toBe(1n);

    // 4. Quỹ quyết toán đúng phần đã tiêu thật
    const delta = settleDelta(v1, v2, FUND_ID, EPOCH);
    expect(delta).toBe(TV_PP_02.settle_delta_nanogic);
    const f2 = fundAfterSettle(f1, delta, EPOCH);
    expect(parCarpFromMagic(f2.magic_settled)).toBe(TV_PP_02.settled_par_carpdrop);

    // 5. Provider chưa rút được gì (đệm buffer-Paid còn chặn)
    expect(maxClaimable(f2)).toBe(TV_PP_02.max_claimable_after);
    expect(() => fundAfterClaim(f2, 1n, EPOCH)).toThrow(PrepaidRuleError);
  });
});

describe("TV-PP-EXPIRE — hết hạn trả lại hạn-mức, không trả lại CARP", () => {
  it("phần MAGIC không tiêu hết chuyển ngược thành hạn-mức ở epoch sau", () => {
    const v0: PrepaidVaultDatum = {
      ...vault(),
      prepaid_credits: creditsAfterLock([], FUND_ID, 1_000_000_000_000n, EPOCH), // 1000 CARP
    };
    const v1 = drawMagic(v0, FUND_ID, TV_PP_EXPIRE.draw_carpdrop, EPOCH, OWN_REF);
    const bid = v1.magic_batches[0]!.batch_id;
    const v2 = burnBatches(v1, [[bid, TV_PP_EXPIRE.burned_nanogic]], EPOCH);
    expect(v2.magic_batches[0]!.current_amount).toBe(TV_PP_EXPIRE.expired_nanogic);

    const before = v2.prepaid_credits[0]!.remaining;
    const v3 = pruneExpired(v2, EPOCH + 1n);
    expect(v3.magic_batches).toHaveLength(0);
    expect(v3.prepaid_credits[0]!.remaining - before).toBe(
      TV_PP_EXPIRE.credit_restored_carpdrop,
    );
  });

  it("MAGIC hết hạn KHÔNG bao giờ được tính là đã tiêu (INV-MAGIC-CITIZEN)", () => {
    const v1 = vault([{ fund_id: FUND_ID, remaining: 0n }], [
      batch("b1", 4_000_000_000n, EPOCH - 1n),
    ]);
    const v2 = pruneExpired(v1, EPOCH);
    expect(settleDelta(v1, v2, FUND_ID, EPOCH)).toBe(0n);
    expect(() => fundAfterSettle(fund(1_000_000n, 1_000_000n), 0n, EPOCH)).toThrow(
      /C-PP-7/,
    );
  });
});

// ══════════════════════════════════════════════════════════════
// Nhánh tấn công
// ══════════════════════════════════════════════════════════════

describe("TẤN CÔNG — sinh MAGIC mà không khoá CARP (C-PP-2)", () => {
  it("rút từ quỹ chưa từng khoá → từ chối", () => {
    const v = vault([{ fund_id: OTHER_FUND, remaining: 10n ** 9n }]);
    expect(() => drawMagic(v, FUND_ID, 1_000_000n, EPOCH, OWN_REF)).toThrow(/C-PP-2/);
  });

  it("rút quá hạn-mức còn lại → từ chối", () => {
    const v = vault([{ fund_id: FUND_ID, remaining: 500_000n }]);
    expect(() => drawMagic(v, FUND_ID, 1_000_000n, EPOCH, OWN_REF)).toThrow(/C-PP-2/);
  });

  it("rút dưới sàn tối thiểu → từ chối", () => {
    const v = vault([{ fund_id: FUND_ID, remaining: 10n ** 9n }]);
    expect(() =>
      drawMagic(v, FUND_ID, MIN_DRAW_CARPDROP - 1n, EPOCH, OWN_REF),
    ).toThrow(/C-PP-12/);
  });

  it("khoá dưới sàn tối thiểu → từ chối", () => {
    expect(() =>
      creditsAfterLock([], FUND_ID, MIN_LOCK_CARPDROP - 1n, EPOCH),
    ).toThrow(/C-PP-12/);
  });

  it("vượt trần số quỹ trên một vault → từ chối", () => {
    let credits = creditsAfterLock([], "00".repeat(32), MIN_LOCK_CARPDROP, EPOCH);
    for (let i = 1; i < MAX_PREPAID_CREDITS; i++) {
      const id = i.toString(16).padStart(2, "0").repeat(32);
      credits = creditsAfterLock(credits, id, MIN_LOCK_CARPDROP, EPOCH);
    }
    expect(credits).toHaveLength(MAX_PREPAID_CREDITS);
    expect(() =>
      creditsAfterLock(credits, "ff".repeat(32), MIN_LOCK_CARPDROP, EPOCH),
    ).toThrow(/C-PP-12/);
  });

  it("vượt trần batch trên một vault → từ chối", () => {
    let v: PrepaidVaultDatum = {
      ...vault(),
      prepaid_credits: creditsAfterLock([], FUND_ID, 10n ** 12n, EPOCH),
    };
    for (let i = 0; i < MAX_BATCHES_PER_VAULT; i++) {
      v = drawMagic(v, FUND_ID, MIN_DRAW_CARPDROP, EPOCH, OWN_REF);
    }
    expect(v.magic_batches).toHaveLength(MAX_BATCHES_PER_VAULT);
    expect(() => drawMagic(v, FUND_ID, MIN_DRAW_CARPDROP, EPOCH, OWN_REF)).toThrow(
      /C-PP-12/,
    );
  });
});

describe("TẤN CÔNG — tiêu batch của epoch đã chết (C-PP-5)", () => {
  it("batch epoch trước không tiêu được", () => {
    const v = vault([], [batch("b1", 10n ** 9n, EPOCH - 1n)]);
    expect(() => burnBatches(v, [["b1", 1n]], EPOCH)).toThrow(/C-PP-5/);
  });

  it("batch epoch hiện tại thì tiêu được", () => {
    const v = vault([], [batch("b1", 10n ** 9n, EPOCH)]);
    expect(burnBatches(v, [["b1", 1n]], EPOCH).magic_batches[0]!.current_amount).toBe(
      10n ** 9n - 1n,
    );
  });

  it("tiêu quá số dư batch → từ chối", () => {
    const v = vault([], [batch("b1", 10n, EPOCH)]);
    expect(() => burnBatches(v, [["b1", 11n]], EPOCH)).toThrow(/C-PP-9/);
  });

  it("lượng tiêu 0 hoặc danh sách rỗng → từ chối", () => {
    const v = vault([], [batch("b1", 10n, EPOCH)]);
    expect(() => burnBatches(v, [["b1", 0n]], EPOCH)).toThrow(/C-PP-9/);
    expect(() => burnBatches(v, [], EPOCH)).toThrow(/C-PP-9/);
  });

  it("MAGIC còn sống chỉ đếm batch của epoch hiện tại", () => {
    const v = vault(
      [],
      [batch("b1", 10n ** 9n, EPOCH), batch("b2", 5n * 10n ** 9n, EPOCH - 1n)],
    );
    expect(liveMagic(v, EPOCH)).toBe(10n ** 9n);
  });
});

describe("TẤN CÔNG — rút CARP ra khỏi quỹ (C-PP-3, C-PP-6)", () => {
  it("rút quá phần MAGIC đã tiêu thật → từ chối (F2)", () => {
    const f = fund(1_000_000_000n, 1_000_000_000n, 500_000_000n, 0n, 0n);
    expect(() => fundAfterClaim(f, 600_000_000n, EPOCH)).toThrow(/C-PP-6/);
  });

  it("rút thêm 1 đơn vị quá sàn đệm → từ chối", () => {
    const f = fund(1_000_000_000n, 1_000_000_000n, 500_000_000n);
    expect(maxClaimable(f)).toBe(425_000_000n);
    expect(fundAfterClaim(f, 425_000_000n, EPOCH).carp_locked).toBe(575_000_000n);
    expect(() => fundAfterClaim(f, 425_000_001n, EPOCH)).toThrow(/C-PP-6/);
  });

  it("quỹ tiêu hết thì rút được toàn bộ, và sổ vẫn cân", () => {
    const f = fund(1_000_000_000n, 1_000_000_000n, 1_000_000_000n);
    const after = fundAfterClaim(f, 1_000_000_000n, EPOCH);
    expect(after.carp_locked).toBe(0n);
    expect(after.provider_claimed).toBe(1_000_000_000n);
    assertFundInvariant(after);
  });

  it("sổ quỹ lệch value → bắt được bằng C-PP-3", () => {
    expect(() => assertFundInvariant(fund(900_000n, 1_000_000n, 0n, 0n))).toThrow(
      /C-PP-3/,
    );
  });

  it("rút 0 hoặc âm → từ chối", () => {
    const f = fund(1_000_000n, 1_000_000n, 1_000_000_000n);
    expect(() => fundAfterClaim(f, 0n, EPOCH)).toThrow(/C-PP-6/);
    expect(() => fundAfterClaim(f, -5n, EPOCH)).toThrow(/C-PP-6/);
  });
});

describe("TẤN CÔNG — quyết toán sai (C-PP-7)", () => {
  it("chỉ tính batch của ĐÚNG quỹ này", () => {
    const vin = vault([], [batch("b1", 10n ** 9n, EPOCH, OTHER_FUND)]);
    const vout = vault([], [batch("b1", 0n, EPOCH, OTHER_FUND)]);
    expect(settleDelta(vin, vout, FUND_ID, EPOCH)).toBe(0n);
  });

  it("không tính batch đã chết dù nó biến mất khỏi output", () => {
    const vin = vault([], [batch("b1", 10n ** 9n, EPOCH - 1n)]);
    const vout = vault([], []);
    expect(settleDelta(vin, vout, FUND_ID, EPOCH)).toBe(0n);
  });

  it("batch tăng số dư khi 'tiêu' → từ chối", () => {
    const vin = vault([], [batch("b1", 10n, EPOCH)]);
    const vout = vault([], [batch("b1", 20n, EPOCH)]);
    expect(() => settleDelta(vin, vout, FUND_ID, EPOCH)).toThrow(/C-PP-7/);
  });

  it("quyết toán vượt tổng hạn-mức đã cấp → từ chối", () => {
    const f = fund(1_000_000n, 1_000_000n);
    expect(() => fundAfterSettle(f, 2_000_000_000n, EPOCH)).toThrow(/C-PP-7/);
  });
});

describe("TẤN CÔNG — dọn rác sai (PrunePrepaid)", () => {
  it("dọn khi không có gì chết → từ chối (reject-noop)", () => {
    const v = vault([{ fund_id: FUND_ID, remaining: 0n }], [batch("b1", 10n, EPOCH)]);
    expect(() => pruneExpired(v, EPOCH)).toThrow(/C-PP-9/);
  });

  it("batch chết mà không còn dòng hạn-mức tương ứng → từ chối", () => {
    const v = vault([], [batch("b1", 10n ** 9n, EPOCH - 1n)]);
    expect(() => pruneExpired(v, EPOCH)).toThrow(/C-PP-2/);
  });

  it("chỉ dọn batch chết, batch sống giữ nguyên", () => {
    const v = vault(
      [{ fund_id: FUND_ID, remaining: 0n }],
      [batch("b1", 10n ** 9n, EPOCH - 1n), batch("b2", 2n * 10n ** 9n, EPOCH)],
    );
    const after = pruneExpired(v, EPOCH);
    expect(after.magic_batches.map((b) => b.batch_id)).toEqual(["b2"]);
    expect(after.prepaid_credits[0]!.remaining).toBe(1_000_000_000n);
  });
});

// ══════════════════════════════════════════════════════════════
// Định danh + cấu hình
// ══════════════════════════════════════════════════════════════

describe("định danh dẫn xuất", () => {
  it("batch_id đổi theo chỉ số batch (không trùng trong cùng giao dịch)", () => {
    const a = computeBatchId(OWN_REF.txHash, 0n, 0n);
    const b = computeBatchId(OWN_REF.txHash, 0n, 1n);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64);
  });

  it("fund_id đổi theo output_index của input seed", () => {
    expect(computeFundId(OWN_REF.txHash, 0n)).not.toBe(
      computeFundId(OWN_REF.txHash, 1n),
    );
  });

  it("dẫn xuất là tất định (gọi lại cho cùng kết quả)", () => {
    expect(computeBatchId(OWN_REF.txHash, 0n, 7n)).toBe(
      computeBatchId(OWN_REF.txHash, 0n, 7n),
    );
  });
});

describe("cấu hình mạng đã verify", () => {
  it("giữ đúng policy tCARP đã đúc thật trên hai testnet", () => {
    expect(CARP_POLICY_ID.Preview).toBe(
      "074cf29c52db3700910d249e0da5b761b7588f8d5bcea595a335bcf7",
    );
    expect(CARP_POLICY_ID.Preprod).toBe(
      "47144f2e675f5fd2b909fc295ba2a975291c4cbb576a15e7298cdb0b",
    );
    expect(CARP_ASSET_NAME).toBe("43415250");
    expect(Buffer.from(CARP_ASSET_NAME, "hex").toString()).toBe("CARP");
  });

  it("burn_batch_constr = 2, đồng nhất với InstantGen/ScheduleGen (§11)", () => {
    expect(BURN_BATCH_CONSTR).toBe(2);
  });
});
