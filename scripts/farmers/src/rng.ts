// scripts/farmers/src/rng.ts — bộ sinh số giả ngẫu nhiên TẤT ĐỊNH cho sổ KẾ HOẠCH.
//
// Vì sao tự viết mà không dùng Math.random: sổ KẾ HOẠCH phải dựng lại được từ một
// seed công bố. Cùng seed ⟹ cùng kế hoạch, byte-cho-byte. Math.random không nhận seed.
//
// Thuật toán: sfc32 (Chris Doty-Humphrey), trạng thái 128 bit khởi từ sha256(seed).
// Không phải RNG mật mã, và không cần là: nó chỉ chọn kịch bản, không sinh khoá.
// Riêng `rand_256` của DID (đi vào preimage pop_bind) cũng lấy từ đây — chấp nhận được
// vì đây là DID MÔ PHỎNG, và chính việc dựng lại được là điều mong muốn.

import { createHash } from "node:crypto";

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string) {
    const h = createHash("sha256").update(`farmer-sim:${seed}`).digest();
    this.a = h.readUInt32BE(0);
    this.b = h.readUInt32BE(4);
    this.c = h.readUInt32BE(8);
    this.d = h.readUInt32BE(12);
    // Xả 16 lượt đầu để trạng thái khuếch tán, theo khuyến nghị của tác giả sfc32.
    for (let i = 0; i < 16; i++) this.nextU32();
  }

  /** Một RNG con, độc lập, suy từ nhãn. Dùng để trục này không làm lệch trục kia. */
  static derive(seed: string, label: string): Rng {
    return new Rng(`${seed}/${label}`);
  }

  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Số nguyên đều trong [lo, hi] (hai đầu tính). */
  int(lo: number, hi: number): number {
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) {
      throw new Error(`Rng.int: khoảng không hợp lệ [${lo}, ${hi}]`);
    }
    const span = hi - lo + 1;
    // Loại bỏ độ lệch modulo bằng lấy mẫu từ chối.
    const limit = Math.floor(0x1_0000_0000 / span) * span;
    let x = this.nextU32();
    while (x >= limit) x = this.nextU32();
    return lo + (x % span);
  }

  /** true với xác suất `perMille`/1000. Dùng phần nghìn nguyên để JSON không mang số thực. */
  chance(perMille: number): boolean {
    return this.int(0, 999) < perMille;
  }

  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error("Rng.pick: danh sách rỗng");
    return xs[this.int(0, xs.length - 1)]!;
  }

  weighted<T>(items: readonly { value: T; weight: number }[]): T {
    const total = items.reduce((s, it) => s + it.weight, 0);
    if (total <= 0) throw new Error("Rng.weighted: tổng trọng số phải > 0");
    let r = this.int(0, total - 1);
    for (const it of items) {
      if (r < it.weight) return it.value;
      r -= it.weight;
    }
    throw new Error("Rng.weighted: không tới được");
  }

  /** Chọn k phần tử phân biệt, giữ thứ tự xuất hiện trong kết quả xáo. */
  sample<T>(xs: readonly T[], k: number): T[] {
    if (k > xs.length) throw new Error(`Rng.sample: k=${k} > ${xs.length}`);
    const arr = xs.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr.slice(0, k);
  }

  /** n byte, dạng hex chữ thường. */
  hex(nBytes: number): string {
    let s = "";
    for (let i = 0; i < nBytes; i++) s += this.int(0, 255).toString(16).padStart(2, "0");
    return s;
  }
}
