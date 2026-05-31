// Integration test — mô phỏng full flow SPEC §8 off-chain (pure logic).
// Kiểm chứng: cumulative accounting, Merkle interop, chống double-redeem, batch tự nhiên,
// bất biến redeemed ≤ won ≤ claimed. Mirror CHÍNH XÁC logic claim_account Redeem validator.

import { describe, it, expect } from "vitest";
import { buildMerkleTree, verifyClaim } from "../offchain/src/merkle.js";
import { runLottery } from "../offchain/src/lottery.js";
import { computeNextP } from "../offchain/src/pparam.js";
import { P_GENESIS, Q, lampOil } from "./helpers.js";
import type { LotteryAccount } from "../offchain/src/types.js";

// ── Mô hình ClaimAccount (mirror onchain datum) ──
interface Account { owner: string; claimedCumulative: bigint; redeemedCumulative: bigint; }

// Mirror claim_account.ak Redeem: trả released + redeemed mới (hoặc throw như validator).
function simulateRedeem(
  acc: Account, wonCumulative: bigint, proof: string[], rootHex: string,
): { released: bigint; newRedeemed: bigint } {
  // C-RDM-1
  if (!verifyClaim(rootHex, acc.owner, wonCumulative, proof)) throw new Error("C-RDM-1: bad proof");
  // C-RDM-2
  if (wonCumulative <= acc.redeemedCumulative) throw new Error("C-RDM-2: released <= 0");
  // C-RDM-5
  if (wonCumulative > acc.claimedCumulative) throw new Error("C-RDM-5: exceeds claimed");
  const released = wonCumulative - acc.redeemedCumulative;   // C-RDM-3
  return { released, newRedeemed: wonCumulative };           // C-RDM-4
}

describe("Full distribution flow (SPEC §8)", () => {
  it("claim → P announce → lottery → redeem → double-redeem reject → batch", () => {
    // 1. CLAIM: committee confirm A=250 LAMP, B=1000 LAMP
    const accounts: Account[] = [
      { owner: "a1", claimedCumulative: lampOil(250n),  redeemedCumulative: 0n },
      { owner: "b2", claimedCumulative: lampOil(1000n), redeemedCumulative: 0n },
    ];

    // 2. P ANNOUNCE: cân bằng → P giữ genesis 100 LAMP
    const pRes = computeNextP(P_GENESIS, {
      magicConsumed: 1000n, magicGenerated: 1000n, lampnetUtil: 0n, claimedUnredeemed: 0n,
    }, 0n);
    const P1 = pRes.pNext;
    expect(P1).toBe(P_GENESIS);

    // 3. LOTTERY epoch 1: p=100% (test deterministic) → mọi remaining thắng
    const lotteryAccts1: LotteryAccount[] = accounts.map(a => ({
      owner: a.owner, claimedCum: a.claimedCumulative, wonCumPrev: 0n,
    }));
    const res1 = runLottery(lotteryAccts1, { nonceHex: "ab".repeat(32), P: P1, targetRateQ: Q });

    // 4. BUILD MERKLE root_1 từ won_cumulative
    const leaves1 = res1.filter(r => r.wonCumNew > 0n).map(r => ({ owner: r.owner, wonCumulative: r.wonCumNew }));
    const tree1 = buildMerkleTree(leaves1);

    // 5. REDEEM: A redeem → nhận đúng won_A
    const wonA1 = res1.find(r => r.owner === "a1")!.wonCumNew;
    const accA = accounts.find(a => a.owner === "a1")!;
    const r1 = simulateRedeem(accA, wonA1, tree1.proofs.get("a1")!, tree1.rootHex);
    expect(r1.released).toBe(wonA1);            // p=100% → won = full 250 LAMP
    expect(r1.released).toBe(lampOil(250n));
    accA.redeemedCumulative = r1.newRedeemed;

    // 6. DOUBLE-REDEEM: dùng lại proof_1 → reject (released = 0)
    expect(() => simulateRedeem(accA, wonA1, tree1.proofs.get("a1")!, tree1.rootHex))
      .toThrow("C-RDM-2");

    // 7. BATCH: thêm claim cho A (epoch sau), lottery epoch 2, won tăng → 1 proof gộp
    accA.claimedCumulative += lampOil(150n);     // A claim thêm 150 → tổng 400
    const lotteryAccts2: LotteryAccount[] = [{
      owner: "a1", claimedCum: accA.claimedCumulative, wonCumPrev: wonA1,
    }];
    const res2 = runLottery(lotteryAccts2, { nonceHex: "cd".repeat(32), P: P1, targetRateQ: Q });
    const wonA2 = res2[0]!.wonCumNew;
    expect(wonA2).toBe(lampOil(400n));           // p=100% → toàn bộ 400 LAMP đã thắng
    const tree2 = buildMerkleTree([{ owner: "a1", wonCumulative: wonA2 }]);
    const r2 = simulateRedeem(accA, wonA2, tree2.proofs.get("a1")!, tree2.rootHex);
    expect(r2.released).toBe(lampOil(150n));      // chỉ phần mới (400 − 250)
    accA.redeemedCumulative = r2.newRedeemed;

    // 8. INVARIANTS
    for (const a of accounts) {
      expect(a.redeemedCumulative).toBeLessThanOrEqual(a.claimedCumulative); // redeemed ≤ claimed
      expect(a.redeemedCumulative).toBeGreaterThanOrEqual(0n);
    }
    expect(accA.redeemedCumulative).toBe(lampOil(400n));
  });

  it("partial lottery (p<100%) keeps won ≤ claimed across epochs", () => {
    const acc: Account = { owner: "c3", claimedCumulative: lampOil(10000n), redeemedCumulative: 0n };
    let wonPrev = 0n;
    let redeemed = 0n;
    // 5 epoch lottery với p=20%, cộng dồn
    for (let e = 0; e < 5; e++) {
      const res = runLottery(
        [{ owner: "c3", claimedCum: acc.claimedCumulative, wonCumPrev: wonPrev }],
        { nonceHex: e.toString(16).padStart(2, "0").repeat(32), P: lampOil(100n), targetRateQ: 200_000_000n },
      );
      const won = res[0]!.wonCumNew;
      expect(won).toBeGreaterThanOrEqual(wonPrev);            // đơn điệu
      expect(won).toBeLessThanOrEqual(acc.claimedCumulative); // ≤ claimed
      if (won > redeemed) {
        const tree = buildMerkleTree([{ owner: "c3", wonCumulative: won }]);
        const r = simulateRedeem(acc, won, tree.proofs.get("c3")!, tree.rootHex);
        expect(r.released).toBe(won - redeemed);
        acc.redeemedCumulative = r.newRedeemed;   // mirror validator: account datum cập nhật
        redeemed = r.newRedeemed;
      }
      wonPrev = won;
    }
    expect(redeemed).toBe(wonPrev);
    expect(redeemed).toBeLessThanOrEqual(acc.claimedCumulative);
  });

  it("redeem rejects forged won_cumulative (not in tree)", () => {
    const acc: Account = { owner: "a1", claimedCumulative: lampOil(1000n), redeemedCumulative: 0n };
    const tree = buildMerkleTree([{ owner: "a1", wonCumulative: lampOil(100n) }]);
    // kẻ gian khai won = 999 LAMP nhưng tree chỉ commit 100 → proof fail
    expect(() => simulateRedeem(acc, lampOil(999n), tree.proofs.get("a1")!, tree.rootHex))
      .toThrow("C-RDM-1");
  });
});
