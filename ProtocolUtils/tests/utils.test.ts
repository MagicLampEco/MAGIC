// tests/utils.test.ts — protocol-utils canonical tests
import { describe, it, expect } from "vitest";
import {
  slotToEpoch, lampToOildrop, nanogicToMagicStr,
  selectLampForLock, removeLockedAmount, unlockLockedAmount, sumHoldings, sumLocked,
  pruneActivityWindow, countActiveAppsInOacWindow, addBurnToActivity,
  isqrt, isqrt10th, verifyVd, vDampened, mulQ, clamp,
  cmpBigIntAsc, cmpBigIntDesc, Q,
  DRM_LOOKBACK,
  msPerEpoch, slotsPerEpoch, posixMsToEpoch,
  vaultOutValue, droppedUnits, assertVaultIdentityKept, sortAiken,
} from "../src/index.js";

const MAGIC = Q;

// ══════════════════════════════════════════════════════════════
// Epoch + conversions
// ══════════════════════════════════════════════════════════════
describe("Epoch utilities", () => {
  it("slotToEpoch Mainnet: 432_000 slots = 1 epoch", () => {
    expect(slotToEpoch(432_000n, "Mainnet")).toBe(1n);
    expect(slotToEpoch(863_999n, "Mainnet")).toBe(1n);
    expect(slotToEpoch(864_000n, "Mainnet")).toBe(2n);
  });
  it("slotToEpoch Preview: 86_400 slots = 1 epoch", () => {
    expect(slotToEpoch(86_400n, "Preview")).toBe(1n);
    expect(slotToEpoch(172_799n, "Preview")).toBe(1n);
    expect(slotToEpoch(172_800n, "Preview")).toBe(2n);
  });
  it("slotToEpoch Preprod: 432_000 slots = 1 epoch (mạng thật 5 ngày)", () => {
    // VÁ 2026-09-05: bản trước ghim 86_400 và đó là số SAI về mạng — Preprod chạy
    // 5 ngày/epoch, đo Blockfrost `/epochs/latest` (epoch 311 dài 432 000 s).
    expect(slotToEpoch(432_000n, "Preprod")).toBe(1n);
    expect(slotToEpoch(863_999n, "Preprod")).toBe(1n);
    expect(slotToEpoch(864_000n, "Preprod")).toBe(2n);
  });

  // ── Hai đồng hồ phải ở lại HAI đồng hồ ────────────────────────────────────
  // Chốt này tồn tại vì lần hỏng trước không có gì bắt được: bảng ms bị suy ra từ
  // bảng slot bằng một câu bình luận, nên một trong hai phải sai mà test vẫn xanh
  // (test dùng chính hằng sai đó làm chuẩn).
  it("Preprod: nhịp giao thức KHÁC nhịp mạng — nén 5×, chưa có quyết định ghi lại", () => {
    expect(msPerEpoch("Preprod")).toBe(86_400_000n);          // 1 ngày — nén 5× so với mạng
    expect(slotsPerEpoch("Preprod")).toBe(432_000n);          // 5 ngày, mạng thật
    expect(slotsPerEpoch("Preprod") * 1_000n).not.toBe(msPerEpoch("Preprod"));
  });
  it("Preview/Mainnet: hai nhịp trùng nhau — nên chốt trên phải chỉ đúng Preprod", () => {
    for (const n of ["Preview", "Mainnet"] as const) {
      expect(slotsPerEpoch(n) * 1_000n).toBe(msPerEpoch(n));
    }
  });
  it("epoch giao thức KHÔNG phải epoch Cardano (không trừ genesis)", () => {
    // 2026-09-04, Preprod: epoch Cardano = 311; epoch giao thức cùng lúc ≈ 20 700.
    const tipMs = 1_788_393_600_000n;                          // start epoch 311
    expect(posixMsToEpoch(tipMs, "Preprod")).toBe(20_699n);
    expect(posixMsToEpoch(tipMs, "Preprod")).not.toBe(311n);
  });
  it("lampToOildrop: 1 LAMP = 10^6 oildrop", () => {
    expect(lampToOildrop(1n)).toBe(1_000_000n);
    expect(lampToOildrop(1000n)).toBe(1_000_000_000n);
  });
});

// ══════════════════════════════════════════════════════════════
// Display
// ══════════════════════════════════════════════════════════════
describe("nanogicToMagicStr", () => {
  it("0 → 0.0000", () => expect(nanogicToMagicStr(0n)).toBe("0.0000"));
  it("1 MAGIC", () => expect(nanogicToMagicStr(Q)).toBe("1.0000"));
  it("0.5 MAGIC", () => expect(nanogicToMagicStr(500_000_000n)).toBe("0.5000"));
  it("45 MAGIC", () => expect(nanogicToMagicStr(45n * Q)).toBe("45.0000"));
  it("negative handled", () => expect(nanogicToMagicStr(-Q)).toBe("-1.0000"));
});

// ══════════════════════════════════════════════════════════════
// BigInt sort comparators — safe, no Number() cast
// ══════════════════════════════════════════════════════════════
describe("BigInt comparators", () => {
  it("cmpBigIntAsc: ascending order", () => {
    const arr = [5n, 1n, 3n, 2n, 4n];
    arr.sort(cmpBigIntAsc);
    expect(arr).toEqual([1n, 2n, 3n, 4n, 5n]);
  });
  it("cmpBigIntDesc: descending order", () => {
    const arr = [5n, 1n, 3n, 2n, 4n];
    arr.sort(cmpBigIntDesc);
    expect(arr).toEqual([5n, 4n, 3n, 2n, 1n]);
  });
});

// ══════════════════════════════════════════════════════════════
// Lock algorithm (P8 canonical — TV-LOCK-01)
// ══════════════════════════════════════════════════════════════
describe("selectLampForLock — §6.8, T5, TV-LOCK-01", () => {
  it("TV-LOCK-01: lock 2500 from 3 holdings youngest-first", () => {
    const h = [
      { amount: 1000n, acquired_epoch: 50n, is_locked: false },
      { amount: 2000n, acquired_epoch: 80n, is_locked: false },
      { amount: 1500n, acquired_epoch: 60n, is_locked: false },
    ];
    const result = selectLampForLock(h, 2500n);
    // Youngest first: ep80(2000) + ep60(500 of 1500) → remainder 1000@60 + 1000@50 free
    const locked   = result.filter(x =>  x.is_locked);
    const unlocked = result.filter(x => !x.is_locked);
    expect(locked.find(x => x.acquired_epoch === 80n)?.amount).toBe(2000n);
    expect(locked.find(x => x.acquired_epoch === 60n)?.amount).toBe(500n);
    expect(unlocked.find(x => x.acquired_epoch === 60n)?.amount).toBe(1000n);
    expect(unlocked.find(x => x.acquired_epoch === 50n)?.amount).toBe(1000n);
    // T5: free = oldest → LF maximized ✓
    expect(sumHoldings(result)).toBe(4500n);  // conservation ✓
  });

  it("Insufficient holdings → GEN-LOCK-001 error", () => {
    expect(() => selectLampForLock([{ amount: 100n, acquired_epoch: 0n, is_locked: false }], 200n))
      .toThrow("GEN-LOCK-001");
  });
});

describe("removeLockedAmount — §A.9", () => {
  it("Removes oldest-locked-first", () => {
    const h = [
      { amount: 500n, acquired_epoch: 50n, is_locked: true  },  // oldest
      { amount: 500n, acquired_epoch: 60n, is_locked: true  },
      { amount: 1000n, acquired_epoch: 70n, is_locked: false },  // unlocked
    ];
    const result = removeLockedAmount(h, 1000n);
    // Both locked removed; unlocked kept
    expect(result.filter(x => x.is_locked)).toHaveLength(0);
    expect(result.find(x => !x.is_locked)?.amount).toBe(1000n);
    expect(sumHoldings(result)).toBe(1000n);  // 500+500 removed
  });
});

// I-ACT-7: the difference that matters is Σholdings. `remove` shrinks it (and
// with it the vault's lamp_balance); `unlock` leaves it alone.
describe("unlockLockedAmount — I-ACT-7 (LAMP stays put)", () => {
  const h = () => [
    { amount: 500n,  acquired_epoch: 50n, is_locked: true  },  // oldest locked
    { amount: 500n,  acquired_epoch: 60n, is_locked: true  },
    { amount: 1000n, acquired_epoch: 70n, is_locked: false },
  ];

  it("Σholdings is invariant — unlike removeLockedAmount", () => {
    expect(sumHoldings(unlockLockedAmount(h(), 1000n))).toBe(2000n);
    expect(sumHoldings(removeLockedAmount(h(), 1000n))).toBe(1000n);
  });

  it("Frees oldest-locked-first, order = [unlocked, freed, still locked]", () => {
    expect(unlockLockedAmount(h(), 500n)).toEqual([
      { amount: 1000n, acquired_epoch: 70n, is_locked: false },  // already unlocked
      { amount: 500n,  acquired_epoch: 50n, is_locked: false },  // epoch 50 freed
      { amount: 500n,  acquired_epoch: 60n, is_locked: true  },  // still locked
    ]);
  });

  it("Partial release splits one holding, parts sum to the original", () => {
    const out = unlockLockedAmount([{ amount: 500n, acquired_epoch: 50n, is_locked: true }], 200n);
    expect(out).toEqual([
      { amount: 200n, acquired_epoch: 50n, is_locked: false },
      { amount: 300n, acquired_epoch: 50n, is_locked: true  },
    ]);
    expect(sumHoldings(out)).toBe(500n);
  });

  it("Releasing more than is locked throws, not silently clamps", () => {
    expect(() => unlockLockedAmount(h(), 1500n)).toThrow("GEN-LOCK-002");
  });

  // THE BOUND. Each partial release splits a holding and nothing is dropped, so
  // without coalescing the list grew +1 per fire — past MAX_LOYALTY_HOLDINGS=64,
  // which the vault enforces on withdrawal. That freezes the user's LAMP.
  // P8: same input as `f_unlock_repeated_does_not_grow` in lock.ak — the two
  // implementations must agree element-for-element, not just on the count.
  it("Repeated releases match the Aiken vector exactly", () => {
    let h = [{ amount: 1000n, acquired_epoch: 5n, is_locked: true }];
    for (let i = 0; i < 3; i++) h = unlockLockedAmount(h, 100n);
    expect(h).toEqual([
      { amount: 300n, acquired_epoch: 5n, is_locked: false },
      { amount: 700n, acquired_epoch: 5n, is_locked: true  },
    ]);
  });

  it("Repeated releases do not grow the list", () => {
    let h = [{ amount: 1000n, acquired_epoch: 5n, is_locked: true }];
    for (let i = 0; i < 20; i++) h = unlockLockedAmount(h, 10n);
    expect(h).toHaveLength(2);
    expect(sumHoldings(h)).toBe(1000n);
    expect(h).toEqual([
      { amount: 200n, acquired_epoch: 5n, is_locked: false },
      { amount: 800n, acquired_epoch: 5n, is_locked: true  },
    ]);
  });

  // acquired_epoch is the loyalty age — distinct epochs must never merge.
  it("Distinct epochs stay separate", () => {
    expect(unlockLockedAmount(
      [{ amount: 50n, acquired_epoch: 2n, is_locked: true },
       { amount: 50n, acquired_epoch: 7n, is_locked: true }], 100n,
    )).toEqual([
      { amount: 50n, acquired_epoch: 2n, is_locked: false },
      { amount: 50n, acquired_epoch: 7n, is_locked: false },
    ]);
  });
});

// ══════════════════════════════════════════════════════════════
// OAC — canonical window definitions (CRITICAL FIX)
// ══════════════════════════════════════════════════════════════
// ── P8: `list.sort` của Aiken KHÔNG ổn định ─────────────────────────────────────
// Mọi số kỳ vọng dưới đây là GIÁ TRỊ ĐO ĐƯỢC TỪ AIKEN, không phải giá trị suy ra:
// chạy `aiken check` trên bản sao `ScheduleGen` với chính các đầu vào này (2026-09-05).
// Đây là trọng tài P8 cho ca hoà — trước đó không vector nào trong kho có hai holding
// cùng `acquired_epoch`, nên hai bên lệch nhau suốt mà mọi bộ test đều xanh.
describe("sortAiken — P8, phần tử hoà", () => {
  const h = (amount: bigint, ep: bigint, locked: boolean) =>
    ({ amount, acquired_epoch: ep, is_locked: locked });

  it("hai phần tử hoà bị ĐẢO, khác Array.sort của JS", () => {
    const xs = [h(100n, 10n, false), h(50n, 10n, false)];
    const cmp = (a: typeof xs[0], b: typeof xs[0]) =>
      cmpBigIntDesc(a.acquired_epoch, b.acquired_epoch);
    expect(sortAiken(xs, cmp).map(x => x.amount)).toEqual([50n, 100n]);
    expect([...xs].sort(cmp).map(x => x.amount)).toEqual([100n, 50n]);   // JS ổn định
  });

  it("ba phần tử hoà — đảo TRỌN cụm, không phải hoán vị hai cái cuối", () => {
    const xs = [h(1n, 5n, false), h(2n, 5n, false), h(3n, 5n, false)];
    expect(sortAiken(xs, (a, b) => cmpBigIntAsc(a.acquired_epoch, b.acquired_epoch))
      .map(x => x.amount)).toEqual([3n, 2n, 1n]);
  });

  it("không hoà thì giống Array.sort, và không đột biến mảng vào", () => {
    const xs = [h(1n, 9n, false), h(2n, 3n, false), h(3n, 6n, false)];
    const cmp = (a: typeof xs[0], b: typeof xs[0]) =>
      cmpBigIntAsc(a.acquired_epoch, b.acquired_epoch);
    expect(sortAiken(xs, cmp).map(x => x.acquired_epoch)).toEqual([3n, 6n, 9n]);
    expect(xs.map(x => x.amount)).toEqual([1n, 2n, 3n]);                 // vào còn nguyên
  });

  it("selectLampForLock khớp giá trị ĐO TỪ AIKEN ở ca hoà", () => {
    const out = selectLampForLock([h(100n, 10n, false), h(50n, 10n, false)], 20n);
    // aiken: [(20,ep10,T), (30,ep10,F), (100,ep10,F)]
    expect(out).toEqual([h(20n, 10n, true), h(30n, 10n, false), h(100n, 10n, false)]);
    expect(sumHoldings(out)).toBe(150n);                                 // không sinh/mất
  });

  it("removeLockedAmount khớp giá trị ĐO TỪ AIKEN ở ca hoà", () => {
    const out = removeLockedAmount([h(100n, 10n, true), h(50n, 10n, true)], 30n);
    expect(sumHoldings(out)).toBe(120n);
  });
});

describe("OAC window — §6.4 (two semantics by design)", () => {

  const entries: [string, bigint][] = [
    ["aladin", 103n], ["app1", 95n], ["app2", 91n],
  ];

  it("pruneActivityWindow: keeps ep ≥ e-12 (ConsumeMAGIC STEP 0e)", () => {
    // At e=104: keeps ep ≥ 92; ep=91 pruned
    const pruned = pruneActivityWindow(entries, 104n);
    expect(pruned.some(([, ep]) => ep === 91n)).toBe(false);  // 91 < 92 → pruned
    expect(pruned).toHaveLength(2);
  });

  it("countActiveAppsInOacWindow: counts ep ∈ [e-12, e) — EXCLUSIVE upper (SnapshotGen §6.4)", () => {
    // At e=104: window [92, 104) exclusive
    // aladin@103: IN ✓  app1@95: IN ✓  app2@91: OUT (91 < 92)
    expect(countActiveAppsInOacWindow(entries, 104n)).toBe(2);

    // Burns at CURRENT epoch (104) NOT counted — apply to NEXT epoch's OAC (by design)
    const withCurrent: [string, bigint][] = [["newapp", 104n], ...entries];
    expect(countActiveAppsInOacWindow(withCurrent, 104n)).toBe(2);  // 104 excluded ✓
  });

  it("FIXED: SnapshotGen vs ConsumeMAGIC window semantics are intentionally different", () => {
    // ConsumeMAGIC prune: [e-12, ∞) — keeps future-relevant entries
    // SnapshotGen count:  [e-12, e) — counts completed-epoch burns only
    // This is CORRECT: burns at epoch e are counted starting at epoch e+1
    const burnAtCurrent: [string, bigint][] = [["newapp", 100n]];
    expect(countActiveAppsInOacWindow(burnAtCurrent, 100n)).toBe(0);  // not yet counted
    expect(countActiveAppsInOacWindow(burnAtCurrent, 101n)).toBe(1);  // counted next epoch
  });

  it("addBurnToActivity: C-ACTIVITY-DEDUP enforced", () => {
    let e: [string, bigint][] = [];
    e = addBurnToActivity(e, "app_A", 103n);
    e = addBurnToActivity(e, "app_A", 103n);  // duplicate
    e = addBurnToActivity(e, "app_A", 103n);  // duplicate
    expect(e).toHaveLength(1);  // deduplicated ✓
    e = addBurnToActivity(e, "app_B", 103n);
    expect(e).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════
// isqrt — pure BigInt Newton (Lemma 3.5)
// ══════════════════════════════════════════════════════════════
describe("isqrt — §3.3 Lemma 3.5 (pure BigInt)", () => {
  it("Basic cases", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(4n)).toBe(2n);
    expect(isqrt(9n)).toBe(3n);
    expect(isqrt(10n)).toBe(3n);  // ⌊√10⌋ = 3
  });
  it("Large value: ⌊√(Q²)⌋ = Q", () => {
    expect(isqrt(Q * Q)).toBe(Q);
  });
  it("∀ n: isqrt(n)² ≤ n < (isqrt(n)+1)²", () => {
    for (const n of [0n, 1n, 2n, 99n, 100n, 1_000_000n, Q, Q * Q]) {
      const r = isqrt(n);
      expect(r * r <= n).toBe(true);
      expect((r + 1n) * (r + 1n) > n).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// isqrt_10th — pure BigInt (AppEconomics §9.1, TV-001, TV-009)
// ══════════════════════════════════════════════════════════════
describe("isqrt10th + verifyVd — §9.1 (pure BigInt, no float)", () => {

  it("TV-009: V=1000, Vd=125", () => {
    expect(isqrt10th(1000n ** 7n)).toBe(125n);
    expect(verifyVd(1000n, 125n)).toBe(true);
  });

  it("TV-001: V=10^12, Vd=251_188_643", () => {
    const Vd = vDampened(1_000_000_000_000n);
    expect(Vd).toBe(251_188_643n);
    expect(verifyVd(1_000_000_000_000n, Vd)).toBe(true);
  });

  it("verifyVd rejects wrong claims", () => {
    expect(verifyVd(1_000_000_000_000n, 251_188_644n)).toBe(false);
    expect(verifyVd(1_000_000_000_000n, 251_188_642n)).toBe(false);
  });

  it("Sub-linearity: vDampened(2V)/vDampened(V) < 2", () => {
    const V = 1_000_000_000_000n;
    const ratio = Number(vDampened(2n * V)) / Number(vDampened(V));
    expect(ratio).toBeGreaterThan(1.6);
    expect(ratio).toBeLessThan(2.0);  // sub-linear ✓
  });

  it("Very large V (S_LAMP level): no overflow", () => {
    // V = 36×10^15 (max possible LAMP)
    const V = 36_000_000_000_000_000n;
    expect(() => vDampened(V)).not.toThrow();
    const Vd = vDampened(V);
    expect(verifyVd(V, Vd)).toBe(true);
  });
});

// ── INV-VAULT-IDENTITY ───────────────────────────────────────────────────────────
// Chốt cho lỗi đã xảy ra hai lần và im lặng cả hai lần: dựng lại value output của vault
// từ đầu làm rơi vault-id NFT ⟹ mọi nhánh spend bị từ chối. Xem chú thích ở
// `ProtocolUtils/src/index.ts` mục cùng tên.
describe("vaultOutValue — INV-VAULT-IDENTITY", () => {
  const NFT  = "beef".repeat(14) + "0011";   // policy+name, giá trị không quan trọng
  const LAMP = "cafe".repeat(14) + "744c414d50";
  const vaultIn = { lovelace: 5_000_000n, [LAMP]: 1_000_000n, [NFT]: 1n };

  it("bê NFT danh tính sang output khi chỉ đổi LAMP", () => {
    const out = vaultOutValue(vaultIn, { [LAMP]: 400_000n });
    expect(out[NFT]).toBe(1n);
    expect(out[LAMP]).toBe(400_000n);
    expect(out.lovelace).toBe(5_000_000n);
  });

  it("bê NFT sang output khi đổi CẢ lovelace lẫn LAMP", () => {
    const out = vaultOutValue(vaultIn, { lovelace: 6_000_000n, [LAMP]: 0n + 900_000n });
    expect(out[NFT]).toBe(1n);
    expect(droppedUnits(vaultIn, out)).toEqual([]);
  });

  it("droppedUnits BẮT được đúng cách viết đã gây hồi quy", () => {
    const saiCach = { lovelace: 5_000_000n, [LAMP]: 400_000n };   // dựng lại từ đầu
    expect(droppedUnits(vaultIn, saiCach)).toEqual([NFT]);
  });

  it("droppedUnits im lặng khi không rơi gì", () => {
    expect(droppedUnits(vaultIn, vaultOutValue(vaultIn, { [LAMP]: 1n }))).toEqual([]);
  });

  it("đặt một đơn vị về 0n là cố ý cho nó rời vault, không phải rơi", () => {
    const out = vaultOutValue(vaultIn, { [LAMP]: 0n });
    expect(LAMP in out).toBe(false);
    expect(out[NFT]).toBe(1n);                        // NFT vẫn ở lại
    expect(droppedUnits(vaultIn, out)).toEqual([LAMP]); // và báo đúng thứ đã rời
  });

  // Chốt lúc chạy. Nó im chừng nào builder còn dùng `vaultOutValue`; nó chỉ lên tiếng
  // đúng lúc có người thay biểu thức value bằng object dựng mới — lần viết lại đã xảy
  // ra hai lần trong kho này.
  it("assertVaultIdentityKept im khi value ra dựng đúng cách", () => {
    expect(() =>
      assertVaultIdentityKept(vaultIn, vaultOutValue(vaultIn, { [LAMP]: 400_000n })),
    ).not.toThrow();
  });

  it("assertVaultIdentityKept NÉM khi value ra dựng lại từ đầu", () => {
    const saiCach = { lovelace: 5_000_000n, [LAMP]: 400_000n };
    expect(() => assertVaultIdentityKept(vaultIn, saiCach)).toThrow(/INV-VAULT-IDENTITY/);
  });

  it("thông điệp lỗi gọi ĐÚNG TÊN đơn vị bị rơi, không nói chung chung", () => {
    const saiCach = { lovelace: 5_000_000n, [LAMP]: 400_000n };
    expect(() => assertVaultIdentityKept(vaultIn, saiCach)).toThrow(NFT);
  });
});
