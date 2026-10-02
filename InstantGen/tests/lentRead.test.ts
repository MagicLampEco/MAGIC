// tests/lentRead.test.ts — `readLentLamp` là gương của `wakeme_lent.ak ▸ lent_lamp`
// (CC-GEN-LENT-READ). Mỗi ca chỉ đổi MỘT vế so với ca dương.
import { describe, it, expect } from "vitest";
import {
  Data, Constr, credentialToAddress, scriptHashToCredential, keyHashToCredential,
  type UTxO,
} from "@lucid-evolution/lucid";
import { explainWakemeVault, floorDiv, readLentLamp, type LentReadContext } from "../offchain/src/instant.js";
import { TV_WAKEME_PIN } from "./vectors.js";

const WAKEME = "cc62732565af6be1e0874975ad3b3e2afdb0abafb3f5bc4b3008f4e1";
const OTHER  = "dd62732565af6be1e0874975ad3b3e2afdb0abafb3f5bc4b3008f4e1";
const IG     = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const IG_NAME = "b2".repeat(32);
const COMMIT  = "c3".repeat(32);
const LAMP_POLICY = "e1".repeat(28);
const LAMP_NAME   = "744c414d50";
const CONDITIONAL = 700_000_000n;
const OWNED       = 301_000_000n;
const PERIOD      = 100n;

const ctx: LentReadContext = {
  wakemeVaultHash: WAKEME, ownScriptHash: IG, ownVaultName: IG_NAME,
  currentPeriod: PERIOD, lampPolicyId: LAMP_POLICY, lampAssetName: LAMP_NAME,
  // Gốc 0: [2] mặc định 1_700_000_000_000 rơi vào kỳ 3935 ≠ mọi [12] dưới đây ⟹ vế genesis
  // sai ở các ca cũ, chúng đo đúng vế `[12] < current_period` (như `wakeme_lent.ak ▸ run`).
  msPerEpoch: 432_000_000n, windowOriginMs: 0n,
};

function pin(hash: string, name: string): Data {
  return new Constr(0, [new Constr(0, [hash, name])]);
}

function fields(o: Partial<{ commit: string; cond: bigint; owned: bigint; gen: Data; period: bigint }> = {}): Data[] {
  return [
    o.commit ?? COMMIT, "e5e5", 1_700_000_000_000n, o.cond ?? CONDITIONAL, 0n, 50n, 49n,
    o.owned ?? OWNED, 1_000_000n, 0n, "f6f6", o.gen ?? pin(IG, IG_NAME), o.period ?? PERIOD - 1n,
  ];
}

function utxo(o: Partial<{
  script: string; fs: Data[]; lamp: bigint; nftQty: bigint; datumHash: boolean; tag: number;
  /** Thay trọn phần NFT két (mặc định `{ WAKEME+COMMIT: nftQty }`). */
  nfts: Record<string, bigint>;
}> = {}): UTxO {
  const script = o.script ?? WAKEME;
  return {
    txHash: "00".repeat(32), outputIndex: 0,
    address: credentialToAddress("Preprod", scriptHashToCredential(script)),
    assets: {
      lovelace: 5_000_000n,
      ...(o.nfts ?? { [WAKEME + COMMIT]: o.nftQty ?? 1n }),
      [LAMP_POLICY + LAMP_NAME]: o.lamp ?? CONDITIONAL + OWNED,
    },
    datum: o.datumHash ? undefined : Data.to(new Constr(o.tag ?? 0, o.fs ?? fields())),
    datumHash: o.datumHash ? "ab".repeat(32) : undefined,
  } as UTxO;
}

describe("readLentLamp — gương lent_lamp", () => {
  it("két hợp lệ ⟹ conditional + owned", () => {
    expect(readLentLamp(utxo(), ctx)).toBe(CONDITIONAL + OWNED);
  });
  it("(d) ghim trong chính kỳ ⟹ 0, không ném", () => {
    expect(readLentLamp(utxo({ fs: fields({ period: PERIOD }) }), ctx)).toBe(0n);
  });
  it("(f) value thiếu 1 oildrop ⟹ 0", () => {
    expect(readLentLamp(utxo({ lamp: CONDITIONAL + OWNED - 1n }), ctx)).toBe(0n);
  });
  it("(f) value dư ⟹ đúng số datum, không phải phần dư", () => {
    expect(readLentLamp(utxo({ lamp: CONDITIONAL + OWNED + 5n }), ctx)).toBe(CONDITIONAL + OWNED);
  });
  it("(c) ghim két IG khác ⟹ 0 + owner_commit, KHÔNG ném (2026-10-02)", () => {
    const r = explainWakemeVault(utxo({ fs: fields({ gen: pin(IG, "0101") }) }), ctx);
    expect(r).toEqual({ read: { ownerCommit: COMMIT, lent: 0n }, reason: "not_pinned_to_this_vault" });
  });
  it("(c) gen_vault = None ⟹ 0 + owner_commit, KHÔNG ném", () => {
    const r = explainWakemeVault(utxo({ fs: fields({ gen: new Constr(1, []) }) }), ctx);
    expect(r).toEqual({ read: { ownerCommit: COMMIT, lent: 0n }, reason: "not_pinned_to_this_vault" });
  });
  it("(c) chưa ghim mà lượng âm ⟹ VẪN ném — nhánh 0 không che vế (e)", () => {
    expect(() => readLentLamp(utxo({ fs: fields({ gen: new Constr(1, []), cond: -1n }) }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("(c) chưa ghim mà NFT sai ⟹ VẪN ném — nhánh 0 không che vế (b)", () => {
    expect(() => readLentLamp(utxo({ fs: fields({ gen: new Constr(1, []) }), nftQty: 2n }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("(a) [2] vest_start_ms không phải số ⟹ ném (un_i_data fail)", () => {
    const fs = fields(); fs[2] = "00";
    expect(() => readLentLamp(utxo({ fs }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("(d) lý do khi ghim trong chính kỳ", () => {
    expect(explainWakemeVault(utxo({ fs: fields({ period: PERIOD }) }), ctx).reason).toBe("pinned_in_current_period");
  });
  it("(f) lý do khi value thiếu", () => {
    expect(explainWakemeVault(utxo({ lamp: CONDITIONAL + OWNED - 1n }), ctx).reason).toBe("lamp_short_of_datum");
  });
  it("(b) NFT số lượng 2 ⟹ ném", () => {
    expect(() => readLentLamp(utxo({ nftQty: 2n }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("(e) lượng âm ⟹ ném", () => {
    expect(() => readLentLamp(utxo({ fs: fields({ cond: -1n }) }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("(a) 12 trường ⟹ ném", () => {
    expect(() => readLentLamp(utxo({ fs: fields().slice(0, 12) }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("luật 1: két ở script khác ⟹ ném (bộ dựng không lọc hộ)", () => {
    expect(() => readLentLamp(utxo({ script: OTHER }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("địa chỉ khoá (không phải script) ⟹ ném", () => {
    const u = { ...utxo(), address: credentialToAddress("Preprod", keyHashToCredential(WAKEME)) } as UTxO;
    expect(() => readLentLamp(u, ctx)).toThrow(/GEN-INST-010/);
  });
});

// ── TV-WAKEME-PIN: vế (c)(d) trên gốc lưới Mainnet — P8 với `wakeme_lent.ak` ────────
describe("TV-WAKEME-PIN — gương vế (c)(d) của wakeme_read", () => {
  const V = TV_WAKEME_PIN;
  for (const c of V.cases) {
    it(c.id, () => {
      const vest = V.in_period(c.vest_period);
      const pinPeriod = c.gen_pin_period === "unix" ? vest / V.ms_per_epoch : c.gen_pin_period;
      const fs = fields({ period: pinPeriod, ...(c.pinned ? {} : { gen: new Constr(1, []) }) });
      fs[2] = vest;
      const r = explainWakemeVault(utxo({ fs }), {
        ...ctx, currentPeriod: c.current_period, msPerEpoch: V.ms_per_epoch, windowOriginMs: V.window_origin_ms,
      });
      expect(r.read).toEqual({ ownerCommit: COMMIT, lent: c.counted ? CONDITIONAL + OWNED : 0n });
      expect(r.reason).toBe("reason" in c ? c.reason : undefined);
    });
  }
  it("floorDiv làm tròn về −∞ như Aiken (số bị chia âm)", () => {
    expect(floorDiv(-1n, 432_000_000n)).toBe(-1n);
    expect(floorDiv(-432_000_000n, 432_000_000n)).toBe(-1n);
    expect(floorDiv(432_000_001n, 432_000_000n)).toBe(1n);
  });
});

// ── Đối ứng TỪNG ca của `wakeme_lent.ak` (P8) ──────────────────────────────────────
// Tên ca = tên bài Aiken. Hằng số trùng byte với bên Aiken (WAKEME = t_wakeme_hash, IG =
// t_ig_hash, IG_NAME = t_ig_name, COMMIT = t_owner_commit, OTHER = t_other_hash, 700_000_000
// / 301_000_000 / kỳ 100), nên cùng đầu vào ⟹ cùng con số. Bài Aiken `fail` ⟹ ở đây NÉM.
describe("đối ứng ca Aiken `wakeme_lent.ak` — cùng đầu vào, cùng kết quả", () => {
  const COMMIT_2 = "c4".repeat(32);
  const ok = (r: ReturnType<typeof explainWakemeVault>, lent: bigint) =>
    expect(r.read).toEqual({ ownerCommit: COMMIT, lent });

  it("t_gen_vault_other_hash_links_without_lent", () => {
    ok(explainWakemeVault(utxo({ fs: fields({ gen: pin(OTHER, IG_NAME) }) }), ctx), 0n);
  });
  it("t_gen_vault_other_name_links_without_lent", () => {
    ok(explainWakemeVault(utxo({ fs: fields({ gen: pin(IG, COMMIT_2) }) }), ctx), 0n);
  });
  it("t_gen_vault_reshaped_pin_is_zero — GenPin thêm trường ⟹ 0, không đọc lệch", () => {
    const reshaped = new Constr(0, [new Constr(0, [IG, IG_NAME, 0n])]);
    const r = explainWakemeVault(utxo({ fs: fields({ gen: reshaped }) }), ctx);
    ok(r, 0n);
    expect(r.reason).toBe("not_pinned_to_this_vault");
  });
  it("t_genesis_pin_value_short_is_zero — ngoại lệ genesis không che vế (f)", () => {
    const V = TV_WAKEME_PIN;
    const fs = fields({ period: 10n }); fs[2] = V.in_period(10n);
    const r = explainWakemeVault(utxo({ fs, lamp: CONDITIONAL + OWNED - 1n }), {
      ...ctx, currentPeriod: 10n, msPerEpoch: V.ms_per_epoch, windowOriginMs: V.window_origin_ms,
    });
    ok(r, 0n);
    expect(r.reason).toBe("lamp_short_of_datum");
  });
  it("t_pinned_this_period_and_negative_fail — (d) sai + (e) sai ⟹ NÉM, không 0", () => {
    expect(() => explainWakemeVault(utxo({ fs: fields({ period: PERIOD, owned: -1n }) }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_owned_negative_fail", () => {
    expect(() => explainWakemeVault(utxo({ fs: fields({ owned: -1n }) }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_zero_amounts_ok — 0 + 0, value đủ ⟹ 0, được tính (không lý do)", () => {
    const r = explainWakemeVault(utxo({ fs: fields({ cond: 0n, owned: 0n }) }), ctx);
    ok(r, 0n);
    expect(r.reason).toBeUndefined();
  });
  it("t_datum_constr_tag_1_fail", () => {
    expect(() => explainWakemeVault(utxo({ tag: 1 }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_datum_not_inline_fail", () => {
    expect(() => explainWakemeVault(utxo({ datumHash: true }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_datum_15_fields_ok — Wakeme nối trường cuối ⟹ vẫn đọc đúng", () => {
    ok(explainWakemeVault(utxo({ fs: [...fields(), 42n, "ab"] }), ctx), CONDITIONAL + OWNED);
  });
  it("t_nft_wrong_policy_fail", () => {
    expect(() => explainWakemeVault(utxo({ nfts: { [OTHER + COMMIT]: 1n } }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_nft_name_not_owner_commit_fail", () => {
    expect(() => explainWakemeVault(utxo({ nfts: { [WAKEME + COMMIT_2]: 1n } }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_nft_missing_fail", () => {
    expect(() => explainWakemeVault(utxo({ nfts: {} }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_nft_second_name_same_policy_fail — tên hợp lệ đứng trước vẫn phải NÉM", () => {
    expect(() => explainWakemeVault(utxo({ nfts: { [WAKEME + COMMIT]: 1n, [WAKEME + COMMIT_2]: 1n } }), ctx))
      .toThrow(/GEN-INST-010/);
  });
  it("t_owner_commit_not_32_bytes_fail — tên NFT cùng 31 byte, chỉ vế độ dài chặn", () => {
    const short = "c3".repeat(31);
    expect(() => explainWakemeVault(utxo({ fs: fields({ commit: short }), nfts: { [WAKEME + short]: 1n } }), ctx))
      .toThrow(/GEN-INST-010/);
  });
  it("t_unpinned_and_nft_wrong_fail — chưa ghim + NFT sai tên ⟹ NÉM ở (b)", () => {
    expect(() => explainWakemeVault(utxo({ fs: fields({ gen: new Constr(1, []) }), nfts: { [WAKEME + COMMIT_2]: 1n } }), ctx))
      .toThrow(/GEN-INST-010/);
  });
  // ── kiểu ô datum (W-IG2): cùng tên bài Aiken; mỗi ca âm có cực đối chỉ khác đúng ô đó ──
  const unpinned = () => fields({ gen: new Constr(1, []) });
  it("t_vest_start_not_int_unpinned_fail — chưa ghim: (c) trả 0 trước (d), [2] vẫn phải NÉM", () => {
    const fs = unpinned(); fs[2] = "00";
    expect(() => explainWakemeVault(utxo({ fs }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_gen_pin_period_not_int_fail — [12] không phải số ⟹ NÉM", () => {
    const fs = fields(); fs[12] = "63";
    expect(() => explainWakemeVault(utxo({ fs }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_gen_pin_period_not_int_unpinned_fail — chưa ghim, [12] không phải số ⟹ NÉM", () => {
    const fs = unpinned(); fs[12] = "63";
    expect(() => explainWakemeVault(utxo({ fs }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_owner_commit_not_bytes_fail — [0] là số, NFT vẫn tên COMMIT ⟹ NÉM", () => {
    const fs = fields(); fs[0] = 0n;
    expect(() => explainWakemeVault(utxo({ fs }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("t_unpinned_fields_pole_links_without_lent — cực đối dương của các ca chưa ghim", () => {
    const r = explainWakemeVault(utxo({ fs: unpinned() }), ctx);
    ok(r, 0n);
    expect(r.reason).toBe("not_pinned_to_this_vault");
    ok(explainWakemeVault(utxo({ fs: fields() }), ctx), CONDITIONAL + OWNED);
  });
});
