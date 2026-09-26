// scripts/farmers/src/smt.ts — bằng chứng chèn NÉN (bitmap) cho cây Merkle thưa độ sâu 256
// của shard-thread PhoenixKey.
//
// Gương của `PhoenixKey-Validator/lib/phoenixkey/pa2_smt.ak` ▸ `register_transition_ok` +
// `climb_compact` (chỉ ĐỌC kho đó, không sửa). Không có bản TypeScript nào khác trong hệ;
// bản Rust `pa2_thread.rs` mã hoá hình dạng DÀY cũ (không có `bitmap`) và KHÔNG khớp
// validator hiện hành — đừng chép từ đó.
//
// Hợp đồng (trích theo tên từ pa2_smt.ak):
//   H_leaf(d)   = blake2b_256(0x00 ‖ d)          ▸ h_leaf
//   H_node(l,r) = blake2b_256(0x01 ‖ l ‖ r)      ▸ h_node
//   leaf(Absent) = 32 byte 0 ; leaf(Live) = H_leaf(key ‖ 0x01)   ▸ leaf_hash
//   D_0 = 32 byte 0 ; D_{h+1} = H_node(D_h, D_h)                   ▸ empty_root
//   tầng i đánh từ ĐÁY; hướng ở tầng i = bit i của key đọc như số nguyên big-endian
//   256 bit (bit 0 = bit thấp nhất của byte CUỐI) — quy ước builtin `read_bit`.
//   bit 1 ⇒ nút đang leo là con PHẢI: parent = H_node(sibling, node).
//   bitmap bit i = 1 ⇔ anh em ở tầng i ≠ D_i ; `siblings` = chỉ các anh em bit 1, từ đáy lên.
//
// Phép kiểm neo: D_256 phải bằng hằng `empty_root_depth_256` của validator (test/smt.test.ts).

import { blake2b } from "@noble/hashes/blake2b";

export const DEPTH = 256;
export const EMPTY_ROOT_DEPTH_256 = "933f40aae7a4ce7f2705c889bd9417d6360695ec0852fb3e1326b1c03dc6da13";

export function hexToBytes(h: string): Uint8Array {
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h)) throw new Error(`hex không hợp lệ (độ dài ${h.length})`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const ZERO32 = new Uint8Array(32);

export function hNode(l: Uint8Array, r: Uint8Array): Uint8Array {
  return blake2b256(concat(Uint8Array.of(1), l, r));
}

export function leafLive(key: Uint8Array): Uint8Array {
  return blake2b256(concat(Uint8Array.of(0), key, Uint8Array.of(1)));
}

/** D_0 … D_256. */
export const DEFAULTS: Uint8Array[] = (() => {
  const d: Uint8Array[] = [ZERO32];
  for (let h = 1; h <= DEPTH; h++) d.push(hNode(d[h - 1]!, d[h - 1]!));
  return d;
})();

/** Bit i của key theo quy ước `read_bit`: byte (31 − ⌊i/8⌋), bit (i mod 8). */
export function readBit(key: Uint8Array, i: number): number {
  return (key[31 - Math.floor(i / 8)]! >> (i % 8)) & 1;
}

function setBit(buf: Uint8Array, i: number): void {
  buf[31 - Math.floor(i / 8)]! |= 1 << (i % 8);
}

/** Tầng cao nhất mà hai khoá khác nhau (tầng đánh từ đáy). −1 khi trùng. */
function topDiffBit(a: Uint8Array, b: Uint8Array): number {
  for (let i = DEPTH - 1; i >= 0; i--) if (readBit(a, i) !== readBit(b, i)) return i;
  return -1;
}

/** Hash của cây con cao `h` chứa đúng các lá Live `keys` (mọi khoá chung bit ≥ h). */
function subtreeHash(h: number, keys: Uint8Array[]): Uint8Array {
  if (keys.length === 0) return DEFAULTS[h]!;
  if (h === 0) {
    if (keys.length !== 1) throw new Error("hai khoá trùng nhau trong cây");
    return leafLive(keys[0]!);
  }
  const left = keys.filter((k) => readBit(k, h - 1) === 0);
  const right = keys.filter((k) => readBit(k, h - 1) === 1);
  return hNode(subtreeHash(h - 1, left), subtreeHash(h - 1, right));
}

export function rootOf(keysHex: string[]): string {
  return bytesToHex(subtreeHash(DEPTH, keysHex.map(hexToBytes)));
}

export interface RegisterProof {
  key: string;
  bitmap: string;
  siblings: string[];
  oldRoot: string;
  newRoot: string;
}

/**
 * Bằng chứng chèn `newKeyHex` (đang Absent) vào cây đang chứa `existingKeysHex` (Live).
 * Tự kiểm lại bằng cách leo đúng thuật toán của validator và NÉM khi không khớp.
 */
export function registerProof(existingKeysHex: string[], newKeyHex: string): RegisterProof {
  const key = hexToBytes(newKeyHex);
  if (key.length !== 32) throw new Error("khoá phải dài 32 byte");
  const existing = existingKeysHex.map(hexToBytes);
  if (existingKeysHex.includes(newKeyHex)) throw new Error("khoá đã Live trong shard — tên DID trùng");

  const byTier = new Map<number, Uint8Array[]>();
  for (const k of existing) {
    const t = topDiffBit(key, k);
    if (t < 0) throw new Error("khoá trùng");
    byTier.set(t, [...(byTier.get(t) ?? []), k]);
  }
  const bitmap = new Uint8Array(32);
  const siblings: string[] = [];
  let oldNode: Uint8Array = ZERO32;
  let newNode: Uint8Array = leafLive(key);
  for (let i = 0; i < DEPTH; i++) {
    const group = byTier.get(i) ?? [];
    const sib = subtreeHash(i, group);
    const isDefault = group.length === 0;
    if (!isDefault) {
      setBit(bitmap, i);
      siblings.push(bytesToHex(sib));
    }
    const right = readBit(key, i) === 1;
    oldNode = right ? hNode(sib, oldNode) : hNode(oldNode, sib);
    newNode = right ? hNode(sib, newNode) : hNode(newNode, sib);
  }
  const proof: RegisterProof = {
    key: newKeyHex,
    bitmap: bytesToHex(bitmap),
    siblings,
    oldRoot: bytesToHex(oldNode),
    newRoot: bytesToHex(newNode),
  };
  const expectOld = rootOf(existingKeysHex);
  if (proof.oldRoot !== expectOld) throw new Error(`smt: old root tự tính lệch (${proof.oldRoot} ≠ ${expectOld})`);
  const expectNew = rootOf([...existingKeysHex, newKeyHex]);
  if (proof.newRoot !== expectNew) throw new Error(`smt: new root tự tính lệch`);
  const check = climbCompact(proof);
  if (!check || check.old !== proof.oldRoot || check.new !== proof.newRoot) throw new Error("smt: bằng chứng không qua chính phép leo của validator");
  return proof;
}

/** Gương 1-1 của `climb_compact` (dùng để tự kiểm bằng chứng trước khi gửi). */
export function climbCompact(p: Pick<RegisterProof, "key" | "bitmap" | "siblings">): { old: string; new: string } | null {
  const key = hexToBytes(p.key);
  const bitmap = hexToBytes(p.bitmap);
  if (key.length !== 32 || bitmap.length !== 32) return null;
  const sibs = p.siblings.map(hexToBytes);
  let old: Uint8Array = ZERO32;
  let nw: Uint8Array = leafLive(key);
  let tower: Uint8Array = ZERO32;
  let inRun = true;
  let si = 0;
  for (let level = 0; level < DEPTH; level++) {
    const goRight = readBit(key, level) === 1;
    const nextTower = hNode(tower, tower);
    const pair = (node: Uint8Array, s: Uint8Array) => (goRight ? hNode(s, node) : hNode(node, s));
    if (readBit(bitmap, level) === 1) {
      const s = sibs[si++];
      if (!s) return null;
      if (bytesToHex(s) === bytesToHex(tower)) return null; // MUT-PA2-CANONICAL
      old = pair(old, s);
      nw = pair(nw, s);
      inRun = false;
    } else {
      old = inRun ? nextTower : pair(old, tower);
      nw = pair(nw, tower);
    }
    tower = nextTower;
  }
  if (si !== sibs.length) return null;
  return { old: bytesToHex(old), new: bytesToHex(nw) };
}
