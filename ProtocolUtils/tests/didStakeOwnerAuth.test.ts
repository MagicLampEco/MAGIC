// tests/didStakeOwnerAuth.test.ts — nhân chứng chủ `did_stake`, cổng Cardano giả.
//
// Băm thật (blake2b_224) KHÔNG kiểm ở đây: gói này không có thư viện băm. Bài ở MagicSDK
// (`didStakeLucid.test.ts`) nối cổng thật của Lucid. Ở đây ghim: rẽ đúng nhánh, so hash
// TRƯỚC khi chạm mạng, lượng rút lấy từ cổng chứ không phải 0, và các cực đối ném đúng mã.
import { describe, it, expect } from "vitest";
import {
  didStakeOwnerAuth, applyOwnerAuth, resolveOwnerAuth, OwnerAuthError,
  DID_STAKE_AUTHORIZE_REDEEMER,
  type DidStakePorts, type DidStakeTxLike, type RewardAccountState,
} from "../src/index.js";

const SH = "5c".repeat(28);
const OTHER = "6d".repeat(28);
const CTRL = "a1".repeat(28);
const DEV = "b2".repeat(28);
const CBOR = "590abc0102";
const ANCHOR = { txHash: "ee".repeat(32), outputIndex: 0 };

class FakeTx implements DidStakeTxLike<FakeTx> {
  log: string[] = [];
  reads: unknown[][] = [];
  withdrawals: Array<[string, bigint, string | undefined]> = [];
  scripts: unknown[] = [];
  signers: string[] = [];
  readFrom(u: unknown[]) { this.log.push("readFrom"); this.reads.push(u); return this; }
  withdraw(a: string, n: bigint, r?: string) { this.log.push("withdraw"); this.withdrawals.push([a, n, r]); return this; }
  attach = { WithdrawalValidator: (s: { type: "PlutusV3"; script: string }) => { this.log.push("attach"); this.scripts.push(s); return this; } };
  addSignerKey(k: string) { this.log.push("sign"); this.signers.push(k); return this; }
}

function ports(acct: RewardAccountState | (() => RewardAccountState), hashOf = (_c: string) => SH) {
  const calls = { rewardAccount: 0 };
  const p: DidStakePorts = {
    scriptHashOf: hashOf,
    rewardAddressOf: (_n, h) => `stake_test1_${h.slice(0, 8)}`,
    rewardAccount: async () => { calls.rewardAccount++; return typeof acct === "function" ? acct() : acct; },
  };
  return { p, calls };
}

const input = (over: Record<string, unknown> = {}) => ({
  owner: { type: "script" as const, hash: SH },
  didStakeScriptCbor: CBOR,
  anchorRefUtxo: ANCHOR,
  controllerPkh: CTRL,
  deviceKeyHash: DEV,
  network: "Preprod" as const,
  ...over,
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return "KHÔNG NÉM"; } catch (e) {
    expect(e).toBeInstanceOf(OwnerAuthError);
    return (e as OwnerAuthError).code;
  }
}

describe("didStakeOwnerAuth — ca dương", () => {
  it("gắn anchor + rút 0 + redeemer Constr0[] + script inline + controller & device", async () => {
    const { p } = ports({ registered: true, withdrawableLovelace: 0n });
    const auth = await didStakeOwnerAuth<FakeTx, typeof ANCHOR>(input(), p);
    const tx = applyOwnerAuth(new FakeTx(), resolveOwnerAuth({ type: "script", hash: SH }, auth));
    expect(tx.reads).toEqual([[ANCHOR]]);
    expect(tx.withdrawals).toEqual([["stake_test1_5c5c5c5c", 0n, "d87980"]]);
    expect(DID_STAKE_AUTHORIZE_REDEEMER).toBe("d87980");
    expect(tx.scripts).toEqual([{ type: "PlutusV3", script: CBOR }]);
    expect(tx.signers).toEqual([CTRL, DEV]);
    // KHÔNG ký bằng h: một script hash không ký được.
    expect(tx.signers).not.toContain(SH);
    expect(auth.details.requiredSigners).toEqual([CTRL, DEV]);
    expect(auth.details.withdrawLovelace).toBe(0n);
  });

  it("CẶP: số dư 0 thì dựng (rút 0); số dư 1 hoặc 7 thì NÉM OWNER_STAKE_REWARDS_PENDING, không dựng", async () => {
    const auth = await didStakeOwnerAuth<FakeTx, typeof ANCHOR>(input(), ports({ registered: true, withdrawableLovelace: 0n }).p);
    expect(auth.attachWithdraw(new FakeTx()).withdrawals[0]![1]).toBe(0n);
    for (const bal of [1n, 7n]) {
      expect(await codeOf(didStakeOwnerAuth<FakeTx, typeof ANCHOR>(input(), ports({ registered: true, withdrawableLovelace: bal }).p)))
        .toBe("OWNER_STAKE_REWARDS_PENDING");
    }
  });
});

describe("didStakeOwnerAuth — cực đối", () => {
  it("script băm ra hash KHÁC chủ ⟹ OWNER_AUTH_MISMATCH, và KHÔNG tra số dư", async () => {
    const { p, calls } = ports({ registered: true, withdrawableLovelace: 0n }, () => OTHER);
    expect(await codeOf(didStakeOwnerAuth(input(), p))).toBe("OWNER_AUTH_MISMATCH");
    expect(calls.rewardAccount).toBe(0);
  });

  it("chủ là khoá ⟹ OWNER_AUTH_MISMATCH", async () => {
    const { p } = ports({ registered: true, withdrawableLovelace: 0n });
    expect(await codeOf(didStakeOwnerAuth(input({ owner: { type: "key", hash: SH } }), p))).toBe("OWNER_AUTH_MISMATCH");
  });

  it("chưa đăng ký stake ⟹ OWNER_STAKE_NOT_REGISTERED", async () => {
    const { p } = ports({ registered: false, withdrawableLovelace: 0n });
    expect(await codeOf(didStakeOwnerAuth(input(), p))).toBe("OWNER_STAKE_NOT_REGISTERED");
  });

  it("cổng trả hình dạng lạ (số dư là number, âm, thiếu registered) ⟹ NÉM, không đệm", async () => {
    for (const bad of [
      { registered: true, withdrawableLovelace: 5 },
      { registered: true, withdrawableLovelace: -1n },
      { withdrawableLovelace: 0n },
      null,
    ]) {
      const { p } = ports(() => bad as unknown as RewardAccountState);
      expect(await codeOf(didStakeOwnerAuth(input(), p))).toBe("OWNER_CREDENTIAL_SHAPE");
    }
  });

  it("controller/device sai hình dạng ⟹ OWNER_HASH_INVALID; thiếu anchor ⟹ OWNER_SCRIPT_WITNESS_UNAVAILABLE; CBOR lẻ ⟹ SHAPE", async () => {
    const { p } = ports({ registered: true, withdrawableLovelace: 0n });
    expect(await codeOf(didStakeOwnerAuth(input({ controllerPkh: "ab" }), p))).toBe("OWNER_HASH_INVALID");
    expect(await codeOf(didStakeOwnerAuth(input({ deviceKeyHash: "zz".repeat(28) }), p))).toBe("OWNER_HASH_INVALID");
    expect(await codeOf(didStakeOwnerAuth(input({ anchorRefUtxo: null }), p))).toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
    expect(await codeOf(didStakeOwnerAuth(input({ didStakeScriptCbor: "abc" }), p))).toBe("OWNER_CREDENTIAL_SHAPE");
  });

  it("resolveOwnerAuth chặn nhân chứng did_stake của chủ KHÁC", async () => {
    const auth = await didStakeOwnerAuth<FakeTx, typeof ANCHOR>(input(), ports({ registered: true, withdrawableLovelace: 0n }).p);
    expect(() => resolveOwnerAuth({ type: "script", hash: OTHER }, auth)).toThrow(/OWNER_AUTH_MISMATCH/);
  });
});
