// scripts/farmers/src/farmers.ts — danh sách nông dân = mọi biến môi trường FARMER_SEED_<số>.
//
// Chủ dự án chốt 2026-09-20: "có bao nhiêu dùng bấy nhiêu". Nên tệp này LIỆT KÊ rồi ĐẾM,
// không nhận một con số làm tham số, và không có hằng số nông dân nào trong thư mục này.
//
// Tệp này chỉ đọc TÊN biến và việc biến đó CÓ giá trị hay không. Giá trị (hạt giống) không
// đi vào kế hoạch, không đi vào sổ nào, không được in.

export interface FarmerRef {
  /** Định danh ổn định trong sổ: "farmer-01", "farmer-17", … */
  id: string;
  /** Tên biến môi trường giữ hạt giống — chỉ TÊN, không bao giờ là giá trị. */
  seedVar: string;
  /** Số thứ tự đọc từ tên biến. */
  index: number;
}

const SEED_VAR = /^FARMER_SEED_([0-9]+)$/;

/**
 * Liệt kê nông dân từ môi trường. Biến khớp tên mà RỖNG thì NÉM — một ví khai có mà
 * không có hạt giống là sổ khoá hỏng, không phải "bớt một nông dân".
 */
export function enumerateFarmers(env: Record<string, string | undefined>): FarmerRef[] {
  const out: FarmerRef[] = [];
  const empty: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    const m = SEED_VAR.exec(name);
    if (!m) continue;
    if (!value || value.trim().length === 0) {
      empty.push(name);
      continue;
    }
    const index = Number.parseInt(m[1]!, 10);
    out.push({ id: `farmer-${m[1]!.padStart(2, "0")}`, seedVar: name, index });
  }
  if (empty.length > 0) {
    throw new Error(`Biến hạt giống nông dân có tên mà không có giá trị: ${empty.sort().join(", ")}`);
  }
  out.sort((a, b) => a.index - b.index);
  const ids = new Set<string>();
  for (const f of out) {
    if (ids.has(f.id)) throw new Error(`Hai biến cùng quy về một nông dân ${f.id} (vd FARMER_SEED_1 và FARMER_SEED_01)`);
    ids.add(f.id);
  }
  return out;
}
