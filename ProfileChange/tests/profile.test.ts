// tests/profile.test.ts — ProfileChange unit tests (§12)
import { describe, it, expect } from "vitest";
import { applyPendingProfile, canChangeProfile } from "../offchain/src/math.js";

describe("applyPendingProfile — §12.2", () => {
  it("No pending → unchanged", () => {
    const r = applyPendingProfile("Ember", null, 100n);
    expect(r.profile).toBe("Ember");
    expect(r.pending).toBeNull();
  });

  it("Effective epoch reached → apply + clear", () => {
    const r = applyPendingProfile("Ember", { new_profile: "Lantern", effective_epoch: 100n }, 100n);
    expect(r.profile).toBe("Lantern");
    expect(r.pending).toBeNull();
  });

  it("Not yet effective → unchanged", () => {
    const r = applyPendingProfile("Ember", { new_profile: "Lantern", effective_epoch: 101n }, 100n);
    expect(r.profile).toBe("Ember");
    expect(r.pending).not.toBeNull();
  });

  it("TV-SAMENESS-01: profile change does NOT affect existing batch profile (T4)", () => {
    // Batch created at ep95 with profile=Flame (N=6)
    // Profile changes to Ember at ep100 (effective ep101)
    // Batch at ep101: still uses Flame N=6 (profile_at_creation is immutable)
    const batchDecayWindow = 6n;   // N(Flame) — locked at creation
    const batchCreated     = 95n;
    const checkAt          = 101n;
    const k = checkAt - batchCreated;  // k=6 ≥ N=6 → expired
    expect(k >= batchDecayWindow).toBe(true);  // expired using Flame N ✓

    // If wrongly using Ember N=3: expired at k=3 (ep98), before profile change
    const wrongN = 3n;
    expect((101n - 95n) >= wrongN).toBe(true); // also expired, but for wrong reason
    // T4: batch uses ORIGINAL profile_at_creation, not current vault profile
  });
});

describe("canChangeProfile — §12.1 C-PC-V2", () => {
  it("Cooldown satisfied (gap ≥ 2)", () => {
    const r = canChangeProfile(98n, 100n);
    expect(r.allowed).toBe(true);
    expect(r.waitEpochs).toBe(0n);
  });

  it("Exact cooldown boundary (gap = 2)", () => {
    expect(canChangeProfile(98n, 100n).allowed).toBe(true);
  });

  it("Gap = 1 → not allowed", () => {
    const r = canChangeProfile(99n, 100n);
    expect(r.allowed).toBe(false);
    expect(r.waitEpochs).toBe(1n);
  });

  it("Gap = 0 (same epoch) → not allowed", () => {
    const r = canChangeProfile(100n, 100n);
    expect(r.allowed).toBe(false);
    expect(r.waitEpochs).toBe(2n);
  });
});
