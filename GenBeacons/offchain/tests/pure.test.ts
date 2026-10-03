// Hàm thuần khớp validator — mỗi cổng một CẶP ca (qua / chỉ khác một ô bị từ chối).
// Ca đối chiếu lấy từ chính test Aiken cùng tên để hai bên đo cùng một điểm.

import { describe, expect, it } from "vitest";
import {
  appliedByName,
  assertVaultList,
  deriveGenBeaconsScripts,
  epochValidityWindow,
  outRefData,
  genesisShard,
  lazyReset,
  loadBlueprint,
  nextGreenBackBeacon,
  genesisRateParam,
  nextRateParam,
  rhoAt,
  shardAfterDraw,
  shardNftName,
  shardResetAmount,
  txEpoch,
  epochOf,
  epochStartMs,
} from "../src/index.js";

const CAP = 1_800_000_000_000_000n;

describe("shardResetAmount = min(⌊GB/16⌋, cap)", () => {
  it("dưới trần: ⌊GB/16⌋ (sàn)", () => {
    expect(shardResetAmount(1_600n, 1_000n)).toBe(100n); // shard.ak ▸ lazy_reset_newer_beacon_resets
    expect(shardResetAmount(1_615n, 1_000n)).toBe(100n);
  });
  it("trên trần: cap", () => {
    expect(shardResetAmount(1_600_000n, 1_000n)).toBe(1_000n); // lazy_reset_caps_at_cap
    expect(shardResetAmount(16n * CAP + 16n, CAP)).toBe(CAP);
  });
  it("biên: ⌊GB/16⌋ == cap", () => {
    expect(shardResetAmount(16_000n, 1_000n)).toBe(1_000n);
  });
  it("GB âm bị từ chối", () => {
    expect(() => shardResetAmount(-1n, 1_000n)).toThrow();
  });
});

describe("lazyReset ↔ shard.ak ▸ lazy_reset", () => {
  const s = { shard_id: 2n, seq: 4n, reset_amount: 50n, remaining: 1n };
  const b = (seq: bigint, gb = 1_600n) => ({ gb_nanogic: gb, seq, epoch: 9n, depeg: false });
  it("beacon mới hơn ⟹ đặt lại, KHÔNG cộng dồn", () => {
    expect(lazyReset(s, b(5n), 1_000n)).toEqual({ shard_id: 2n, seq: 5n, reset_amount: 100n, remaining: 100n });
  });
  it("cùng seq ⟹ giữ nguyên", () => {
    expect(lazyReset({ ...s, seq: 5n }, b(5n), 1_000n)).toEqual({ ...s, seq: 5n });
  });
  it("beacon cũ hơn ⟹ ném", () => {
    expect(() => lazyReset({ ...s, seq: 6n }, b(5n), 1_000n)).toThrow(/không tới được/);
  });
});

describe("shardAfterDraw", () => {
  const s = { shard_id: 3n, seq: 5n, reset_amount: 1_000n, remaining: 1_000n };
  const b = { gb_nanogic: 48_000n, seq: 5n, epoch: 7n, depeg: false };
  it("rút đúng còn lại: qua; rút hơn 1: ném", () => {
    expect(shardAfterDraw(s, b, CAP, 1_000n).remaining).toBe(0n);
    expect(() => shardAfterDraw(s, b, CAP, 1_001n)).toThrow(/còn lại/);
  });
  it("depeg ⟹ ném", () => {
    expect(() => shardAfterDraw(s, { ...b, depeg: true }, CAP, 0n)).toThrow(/depeg/);
  });
  it("amount âm ⟹ ném", () => {
    expect(() => shardAfterDraw(s, b, CAP, -1n)).toThrow();
  });
  it("beacon mới ⟹ trừ trên lượng ĐÃ đặt lại", () => {
    expect(shardAfterDraw(s, { ...b, seq: 6n }, CAP, 400n)).toEqual({
      shard_id: 3n, seq: 6n, reset_amount: 3_000n, remaining: 2_600n,
    });
  });
});

describe("genesisRateParam ↔ rate_param.ak ▸ mint", () => {
  it("ρ hiệu lực NGAY epoch genesis (effective_epoch == now), prev = 0", () => {
    // rate_param.ak ▸ rate_genesis_happy / rate_genesis_effective_next_epoch_fail
    const g = genesisRateParam(5n, 42n, 100n);
    expect(g).toEqual({ rho_q: 5n, prev_rho_q: 0n, effective_epoch: 42n });
    expect(rhoAt(g, 42n)).toBe(5n);
    expect(rhoAt(g, 41n)).toBe(0n);
  });
  it("trên trần 1: ném", () => {
    expect(() => genesisRateParam(101n, 42n, 100n)).toThrow(/rho_max_q/);
  });
});

describe("rhoAt / nextRateParam ↔ rate.ak, rate_param.ak", () => {
  const d = { rho_q: 7n, prev_rho_q: 3n, effective_epoch: 10n };
  it("trước / tại / sau mốc hiệu lực", () => {
    expect(rhoAt(d, 9n)).toBe(3n);
    expect(rhoAt(d, 10n)).toBe(7n);
    expect(rhoAt(d, 11n)).toBe(7n);
  });
  it("đăng lần hai trong CÙNG epoch: prev = ρ đang hiệu lực, không phải rho_q chưa hiệu lực", () => {
    // rate_param.ak ▸ rate_second_update_same_epoch_happy
    expect(nextRateParam(d, 8n, 9n, 100n)).toEqual({ rho_q: 8n, prev_rho_q: 3n, effective_epoch: 10n });
  });
  it("tại trần: qua; trên trần 1: ném", () => {
    expect(nextRateParam(d, 100n, 9n, 100n).rho_q).toBe(100n);
    expect(() => nextRateParam(d, 101n, 9n, 100n)).toThrow(/rho_max_q/);
  });
});

describe("nextGreenBackBeacon", () => {
  it("seq +1, epoch = epoch giao dịch", () => {
    const cur = { gb_nanogic: 1_000n, seq: 4n, epoch: 6n, depeg: false };
    expect(nextGreenBackBeacon(cur, 2_000n, 7n, false)).toEqual({ gb_nanogic: 2_000n, seq: 5n, epoch: 7n, depeg: false });
    expect(() => nextGreenBackBeacon(cur, -1n, 7n, false)).toThrow();
  });
});

describe("assertVaultList ↔ registry.ak ▸ vault_list_ok", () => {
  const h1 = "7a" + "00".repeat(26) + "01";
  const h2 = "7a" + "00".repeat(26) + "02";
  it("hai hash 28 byte khác nhau: qua", () => {
    expect(() => assertVaultList([h1, h2])).not.toThrow();
  });
  it("rỗng / trùng / 27 byte / 29 byte: ném", () => {
    expect(() => assertVaultList([])).toThrow(/rỗng/);
    expect(() => assertVaultList([h1, h1])).toThrow(/trùng/);
    expect(() => assertVaultList([h1.slice(2)])).toThrow(/28 byte/);
    expect(() => assertVaultList([h1 + "04"])).toThrow(/28 byte/);
  });
});

describe("thời gian ↔ util.ak ▸ get_epoch", () => {
  const MS = 3_600_000n;
  // Gốc cửa sổ KHÁC 0 và KHÔNG chia hết cho MS (Mainnet, CONTRACT Window v1.0 §2) — gốc 0
  // không phân biệt được bản trừ gốc với bản quên trừ gốc.
  const O = 1_506_203_091_000n;
  const at = (e: bigint) => O + e * MS;
  it("cùng epoch: qua; vắt hai epoch: ném", () => {
    expect(txEpoch(at(10n), at(11n) - 1n, MS, O)).toBe(10n);
    expect(() => txEpoch(at(10n), at(11n), MS, O)).toThrow(/hai epoch/);
  });
  it("khoảng hiệu lực nằm gọn trong epoch của now", () => {
    const w = epochValidityWindow(Number(at(10n) + 5_000n), MS, O);
    expect(w.epoch).toBe(10n);
    expect(txEpoch(BigInt(w.fromMs), BigInt(w.toMs), MS, O)).toBe(10n);
    const late = epochValidityWindow(Number(at(11n) - 10_000n), MS, O);
    expect(BigInt(late.toMs)).toBe(at(11n) - 1_000n);
  });
  it("sát ranh giới: ném", () => {
    expect(() => epochValidityWindow(Number(at(11n) - 2_500n), MS, O)).toThrow(/sát/);
  });
  it("cực đối: sát biên của LƯỚI CŨ (k·MS) nhưng giữa epoch thật ⟹ KHÔNG ném", () => {
    expect(O % MS).not.toBe(0n);
    const k = at(11n) / MS + 1n;
    expect(() => epochValidityWindow(Number(k * MS - 2_500n), MS, O)).not.toThrow();
  });
});

describe("gốc cửa sổ — vector CONTRACT Window v1.0 §3 (gương ProtocolUtils ▸ windowOf)", () => {
  const P = 432_000_000n;
  const MAINNET = 1_506_203_091_000n;
  const PREPROD = 1_654_041_600_000n;
  it("bốn vector theo cặp biên", () => {
    expect(epochOf(1_790_459_091_000n, P, MAINNET)).toBe(658n);
    expect(epochOf(1_790_459_090_999n, P, MAINNET)).toBe(657n);
    expect(epochOf(1_790_553_600_000n, P, PREPROD)).toBe(316n);
    expect(epochOf(1_790_553_599_999n, P, PREPROD)).toBe(315n);
  });
  it("quên trừ gốc cho số khác hẳn", () => {
    expect(epochOf(1_790_553_600_000n, P, 0n)).toBe(4_144n);
  });
  it("epochStartMs là biên: start(e) ⟹ e, start(e) − 1 ⟹ e − 1", () => {
    expect(epochStartMs(316n, P, PREPROD)).toBe(1_790_553_600_000n);
    expect(epochStartMs(658n, P, MAINNET)).toBe(1_790_459_091_000n);
  });
  it("t < gốc: chia SÀN về −∞ như Aiken, không cắt về 0", () => {
    expect(epochOf(PREPROD - 1n, P, PREPROD)).toBe(-1n);
    expect(epochOf(PREPROD - P - 1n, P, PREPROD)).toBe(-2n);
  });
  it("gốc âm / nhịp ≤ 0 ⟹ ném", () => {
    expect(() => epochOf(1n, P, -1n)).toThrow(/window_origin_ms/);
    expect(() => epochOf(1n, 0n, 0n)).toThrow(/ms_per_epoch/);
  });
});

describe("tên NFT + shard genesis", () => {
  it("GBS ‖ byte id", () => {
    expect(shardNftName(0n)).toBe("47425300");
    expect(shardNftName(15n)).toBe("4742530f");
    expect(() => shardNftName(16n)).toThrow();
    expect(genesisShard(7n)).toEqual({ shard_id: 7n, seq: 0n, reset_amount: 0n, remaining: 0n });
  });
});

describe("cổng apply-param theo TÊN", () => {
  const bp = loadBlueprint();
  const seed = { txHash: "ab".repeat(32), outputIndex: 0 };
  it("đủ tên đúng thứ tự: qua; đảo hai tên: ném; thiếu một tên: ném", () => {
    const ok = appliedByName(bp, "greenback_beacon", {
      greenback_beacon_writer: "e1".repeat(28),
      ms_per_epoch: 3_600_000n,
      seed: outRefData(seed),
      window_origin_ms: 1_654_041_600_000n,
    });
    expect(ok.type).toBe("PlutusV3");
    expect(() =>
      appliedByName(bp, "greenback_beacon", {
        ms_per_epoch: 3_600_000n,
        greenback_beacon_writer: "e1".repeat(28),
        seed: outRefData(seed),
        window_origin_ms: 1_654_041_600_000n,
      }),
    ).toThrow(/APPLY-PARAM LỆCH/);
    expect(() =>
      appliedByName(bp, "greenback_beacon", {
        greenback_beacon_writer: "e1".repeat(28),
        seed: outRefData(seed),
      }),
    ).toThrow(/APPLY-PARAM LỆCH/);
  });

  it("bốn seed trùng nhau ⟹ ném (hai one-shot chung seed = một cái không bao giờ đúc được)", () => {
    const base = {
      msPerEpoch: 3_600_000n,
      windowOriginMs: 1_654_041_600_000n,
      vaultRegistrySeed: { txHash: "01".repeat(32), outputIndex: 0 },
      greenbackWriter: "e1".repeat(28),
      greenbackSeed: { txHash: "01".repeat(32), outputIndex: 1 },
      gbShardCapNanogic: CAP,
      gbShardSeed: { txHash: "01".repeat(32), outputIndex: 2 },
      rateKey: "b1".repeat(28),
      rhoMaxQ: 4_000_000_000n,
      rateSeed: { txHash: "01".repeat(32), outputIndex: 3 },
    };
    const s = deriveGenBeaconsScripts(bp, "Custom", base);
    // gb_shard bake đúng hash beacon + hash sổ vừa suy ra.
    expect(s.gbShard.gbBeaconNftPolicy).toBe(s.greenback.hash);
    expect(s.gbShard.vaultRegistryPolicy).toBe(s.vaultRegistry.hash);
    expect(() =>
      deriveGenBeaconsScripts(bp, "Custom", { ...base, rateSeed: base.greenbackSeed }),
    ).toThrow(/khác nhau/);
  });
});
