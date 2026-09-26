// scripts/farmers/src/owner.ts — ADAPTER DUY NHẤT cho trường `owner` của VaultDatum.
//
// Hiện `owner` là `ByteArray` (payment key hash, 28 byte). Một nhánh song song đang đổi nó
// sang `Credential` (`VerificationKey(pkh)` | `Script(h)`). Khi nhánh đó vào main, CHỈ tệp
// này phải sửa trong `scripts/farmers/`: `ownerOf` trả hình dạng mới (nông dân dùng
// `VerificationKey(pkh)`), `sameOwner` giữ nguyên vì nó so theo cấu trúc chứ không theo kiểu.
//
// Phép kiểm canh chỗ này: `grep -rn "\.owner\b\|owner:" scripts/farmers/src` chỉ được trả
// dòng trong tệp này và trong bộ dựng datum genesis (nơi GỌI `ownerOf`).

export interface OwnerSource {
  paymentKeyHash: string;
}

/** Giá trị đặt vào `VaultDatum.owner` — đúng hình dạng lược đồ datum ĐANG chạy. */
export type VaultOwner = string;

export function ownerOf(w: OwnerSource): VaultOwner {
  if (!/^[0-9a-f]{56}$/.test(w.paymentKeyHash)) {
    throw new Error(`ownerOf: payment key hash phải là 28 byte hex (nhận độ dài ${w.paymentKeyHash.length})`);
  }
  return w.paymentKeyHash;
}

/** So hai giá trị `owner` theo cấu trúc — sống qua lần đổi ByteArray → Credential. */
export function sameOwner(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
