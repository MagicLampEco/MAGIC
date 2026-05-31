import { describe, it, expect } from "vitest";
import {
  leafHash, hashNode, buildMerkleTree, verifyProof, verifyClaim,
  uint64BE, compareBytes, bytesToHex, hexToBytes,
} from "../offchain/src/merkle.js";

describe("byte helpers", () => {
  it("uint64BE matches Aiken from_int_big_endian(n,8)", () => {
    expect(bytesToHex(uint64BE(0n))).toBe("0000000000000000");
    expect(bytesToHex(uint64BE(1n))).toBe("0000000000000001");
    expect(bytesToHex(uint64BE(256n))).toBe("0000000000000100");
    expect(bytesToHex(uint64BE(100_000_000n))).toBe("0000000005f5e100");
  });

  it("uint64BE rejects negative + overflow", () => {
    expect(() => uint64BE(-1n)).toThrow();
    expect(() => uint64BE(1n << 64n)).toThrow();
  });

  it("compareBytes lexicographic", () => {
    expect(compareBytes(hexToBytes("00"), hexToBytes("01"))).toBeLessThan(0);
    expect(compareBytes(hexToBytes("01"), hexToBytes("00"))).toBeGreaterThan(0);
    expect(compareBytes(hexToBytes("0102"), hexToBytes("0102"))).toBe(0);
    expect(compareBytes(hexToBytes("01"), hexToBytes("0100"))).toBeLessThan(0);
  });
});

describe("merkle primitives", () => {
  it("leaf hash deterministic + domain separated from node", () => {
    const a = leafHash("aa", 100n);
    const b = leafHash("aa", 100n);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    // leaf (0x00) ≠ node (0x01) preimage → no second-preimage
    const node = hashNode(leafHash("aa", 100n), leafHash("bb", 200n));
    expect(bytesToHex(node)).not.toBe(bytesToHex(a));
  });

  it("hashNode sorted-pair commutative", () => {
    const a = leafHash("aa", 100n);
    const b = leafHash("bb", 200n);
    expect(bytesToHex(hashNode(a, b))).toBe(bytesToHex(hashNode(b, a)));
  });
});

describe("merkle tree build + verify", () => {
  it("single leaf: root == leaf, empty proof", () => {
    const t = buildMerkleTree([{ owner: "aa", wonCumulative: 100n }]);
    expect(t.leafCount).toBe(1);
    expect(verifyClaim(t.rootHex, "aa", 100n, t.proofs.get("aa")!)).toBe(true);
  });

  it("two leaves: both verify", () => {
    const t = buildMerkleTree([
      { owner: "aa", wonCumulative: 100n },
      { owner: "bb", wonCumulative: 200n },
    ]);
    expect(verifyClaim(t.rootHex, "aa", 100n, t.proofs.get("aa")!)).toBe(true);
    expect(verifyClaim(t.rootHex, "bb", 200n, t.proofs.get("bb")!)).toBe(true);
  });

  it("odd count (3 leaves) carry-up works", () => {
    const t = buildMerkleTree([
      { owner: "01", wonCumulative: 10n },
      { owner: "02", wonCumulative: 20n },
      { owner: "03", wonCumulative: 30n },
    ]);
    for (const [owner, won] of [["01", 10n], ["02", 20n], ["03", 30n]] as const) {
      expect(verifyClaim(t.rootHex, owner, won, t.proofs.get(owner)!)).toBe(true);
    }
  });

  it("many leaves (17) all verify", () => {
    const leaves = Array.from({ length: 17 }, (_, i) => ({
      owner: i.toString(16).padStart(2, "0"),
      wonCumulative: BigInt((i + 1) * 1_000_000),
    }));
    const t = buildMerkleTree(leaves);
    expect(t.leafCount).toBe(17);
    for (const l of leaves) {
      expect(verifyClaim(t.rootHex, l.owner, l.wonCumulative, t.proofs.get(l.owner)!)).toBe(true);
    }
  });

  it("rejects wrong amount / wrong owner", () => {
    const t = buildMerkleTree([
      { owner: "aa", wonCumulative: 100n },
      { owner: "bb", wonCumulative: 200n },
    ]);
    expect(verifyClaim(t.rootHex, "aa", 999n, t.proofs.get("aa")!)).toBe(false);
    expect(verifyClaim(t.rootHex, "cc", 100n, t.proofs.get("aa")!)).toBe(false);
  });

  it("deterministic regardless of input order", () => {
    const a = buildMerkleTree([
      { owner: "aa", wonCumulative: 100n },
      { owner: "bb", wonCumulative: 200n },
      { owner: "cc", wonCumulative: 300n },
    ]);
    const b = buildMerkleTree([
      { owner: "cc", wonCumulative: 300n },
      { owner: "aa", wonCumulative: 100n },
      { owner: "bb", wonCumulative: 200n },
    ]);
    expect(a.rootHex).toBe(b.rootHex);
  });

  it("rejects empty + duplicate owner", () => {
    expect(() => buildMerkleTree([])).toThrow();
    expect(() => buildMerkleTree([
      { owner: "aa", wonCumulative: 100n },
      { owner: "aa", wonCumulative: 200n },
    ])).toThrow();
  });
});

// CROSS-CHECK on-chain ↔ off-chain: leaf hash phải khớp Aiken merkle.ak.
// Giá trị pin lấy từ chính offchain rồi verify trong Aiken test (xem onchain/lib merkle.ak
// test `leaf_hash_xcheck`). Test này in ra hex để pin.
describe("cross-check vector", () => {
  it("prints reference leaf hash for Aiken pinning", () => {
    const h = bytesToHex(leafHash("aa", 100n));
    // eslint-disable-next-line no-console
    console.log("XCHECK leaf_hash(#\"aa\",100) =", h);
    expect(h.length).toBe(64);
  });
});
