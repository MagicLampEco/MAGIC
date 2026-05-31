// LampDistribution Merkle (SPEC §QĐ4) — PHẢI khớp byte-perfect với onchain merkle.ak.
// BLAKE2b-256, RFC 6962 domain separation, sorted-pair.

import { blake2b } from "@noble/hashes/blake2b";
import { MERKLE_LEAF_PREFIX, MERKLE_NODE_PREFIX } from "./constants.js";

// ── byte helpers (pure, no Buffer dependency for portability) ──

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`MERKLE-000: odd hex length: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`MERKLE-001: invalid hex: ${hex}`);
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/** uint64 big-endian (8 bytes) — khớp Aiken from_int_big_endian(n, 8). */
export function uint64BE(n: bigint): Uint8Array {
  if (n < 0n)            throw new Error(`MERKLE-002: negative not allowed: ${n}`);
  if (n >= 1n << 64n)    throw new Error(`MERKLE-003: exceeds 8 bytes: ${n}`);
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 7; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/** Lexicographic byte compare (khớp Aiken bytearray.compare). >0 nếu a>b. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i]!, bv = b[i]!;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return a.length - b.length;
}

// ── Merkle primitives ──

/** leaf = blake2b256( 0x00 ‖ owner ‖ won_cumulative[be8] ) */
export function leafHash(ownerHex: string, wonCumulative: bigint): Uint8Array {
  const owner = hexToBytes(ownerHex);
  const pre = concatBytes(Uint8Array.of(MERKLE_LEAF_PREFIX), owner, uint64BE(wonCumulative));
  return blake2b(pre, { dkLen: 32 });
}

/** node = blake2b256( 0x01 ‖ min(a,b) ‖ max(a,b) ) — sorted-pair */
export function hashNode(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compareBytes(a, b) > 0 ? [b, a] : [a, b];
  return blake2b(concatBytes(Uint8Array.of(MERKLE_NODE_PREFIX), lo, hi), { dkLen: 32 });
}

export interface MerkleLeafInput { owner: string; wonCumulative: bigint; }

export interface MerkleTree {
  rootHex : string;
  /** proof (hex sibling list) cho mỗi owner. */
  proofs  : Map<string, string[]>;
  leafCount: number;
}

/**
 * Build Merkle tree từ danh sách leaf (sorted-pair, level-by-level).
 * Leaf được sort theo leaf-hash để cây tất định (deterministic) bất kể thứ tự input.
 * Tầng lẻ: node cuối được "nâng" (carry-up) lên tầng trên không đổi.
 * Trả root + proof cho từng owner.
 */
export function buildMerkleTree(leaves: MerkleLeafInput[]): MerkleTree {
  if (leaves.length === 0) throw new Error("MERKLE-004: empty leaf set");

  // owner phải duy nhất
  const seen = new Set<string>();
  for (const l of leaves) {
    if (seen.has(l.owner)) throw new Error(`MERKLE-005: duplicate owner ${l.owner}`);
    seen.add(l.owner);
  }

  // hash leaf + gắn owner để truy proof
  const base = leaves.map(l => ({ owner: l.owner, hash: leafHash(l.owner, l.wonCumulative) }));
  // sort tất định theo hash
  base.sort((x, y) => compareBytes(x.hash, y.hash));

  const ownerIndex = new Map<string, number>();
  base.forEach((b, i) => ownerIndex.set(b.owner, i));

  // proof[i] = list sibling hash (hex) cho leaf i
  const proofBytes: Uint8Array[][] = base.map(() => []);

  // index gốc của mỗi node hiện tại để biết leaf nào nằm dưới
  let level: Uint8Array[] = base.map(b => b.hash);
  // groups[node] = danh sách index leaf dưới node đó
  let groups: number[][] = base.map((_, i) => [i]);

  while (level.length > 1) {
    const nextLevel: Uint8Array[] = [];
    const nextGroups: number[][] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        const left = level[i]!, right = level[i + 1]!;
        const parent = hashNode(left, right);
        // mọi leaf dưới left nhận sibling = right; dưới right nhận sibling = left
        for (const li of groups[i]!)     proofBytes[li]!.push(right);
        for (const ri of groups[i + 1]!) proofBytes[ri]!.push(left);
        nextLevel.push(parent);
        nextGroups.push([...groups[i]!, ...groups[i + 1]!]);
      } else {
        // node lẻ cuối: carry-up không đổi (không thêm sibling)
        nextLevel.push(level[i]!);
        nextGroups.push(groups[i]!);
      }
    }
    level = nextLevel;
    groups = nextGroups;
  }

  const proofs = new Map<string, string[]>();
  base.forEach((b, i) => proofs.set(b.owner, proofBytes[i]!.map(bytesToHex)));

  return { rootHex: bytesToHex(level[0]!), proofs, leafCount: base.length };
}

/** Verify (mirror onchain verify_proof). */
export function verifyProof(rootHex: string, leaf: Uint8Array, proofHex: string[]): boolean {
  let acc = leaf;
  for (const sib of proofHex) acc = hashNode(acc, hexToBytes(sib));
  return bytesToHex(acc) === (rootHex.startsWith("0x") ? rootHex.slice(2) : rootHex);
}

export function verifyClaim(
  rootHex: string, ownerHex: string, wonCumulative: bigint, proofHex: string[],
): boolean {
  return verifyProof(rootHex, leafHash(ownerHex, wonCumulative), proofHex);
}
