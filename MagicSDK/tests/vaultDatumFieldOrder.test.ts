import { describe, it, expect } from "vitest";
import { VaultDatumSchema, InstantVaultDatumSchema } from "../src/schemas.js";

// ── VÌ SAO TỆP NÀY TỒN TẠI ───────────────────────────────────────────────────────
//
// Một vòng soát đo được rằng **hoán vị vị trí hai trường trong lược đồ đi qua TRỌN
// bộ kiểm của kho**, xanh hoàn toàn. Lý do không phải ai lười viết ca: mẫu mã hoá và
// bản giải mã **dùng CHUNG một lược đồ** —
//
//   VaultTxAPI/tests/fixtures/preview.ts   Data.to(...,   InstantVaultDatumSchema)
//   MagicSDK/src/schemas.ts                Data.from(hex, InstantVaultDatumSchema)
//
// `Data.to`/`Data.from` khớp trường theo TÊN rồi xếp theo THỨ TỰ LƯỢC ĐỒ, nên mọi
// hoán vị đi một vòng tròn rồi về đúng chỗ cũ. Một mẫu "đi qua lược đồ thật" là mẫu
// tự-nhất-quán; nó KHÔNG chứng minh khớp chuỗi, và một chú thích trong kho từng nói
// ngược đúng chỗ này.
//
// Thứ tự ấy là **hợp đồng nhị phân**: Plutus Data mã hoá theo vị trí, nên lệch một ô
// là mọi UTxO thật bị đọc sai — `attribution` ra làm một ngày, mốc khoá ra làm một
// cấu trúc — và không phép kiểm kiểu nào đỏ. Có bên còn đọc theo VỊ TRÍ chứ không
// qua lược đồ (`Paymaster` ▸ `vault_delegate_is` lấy thẳng trường 15), nên bên đó
// lấy nhầm trường mà KHÔNG kêu.
//
// ── PHẠM VI — đọc kỹ trước khi tin màu xanh của tệp này ──────────────────────────
//
// Nó ghim danh sách dưới đây là một **phép liệt kê ĐÓNG**, nên hoán vị · thêm · bớt ·
// đổi tên đều ĐỎ. Nó **KHÔNG** chứng minh danh sách khớp `types.ak` của Aiken: nó so
// lược đồ với một hằng trong chính tệp này, và cả hai do người gõ. Sửa Aiken mà quên
// sửa cả hai chỗ ở đây thì nó vẫn xanh.
//
// Phép đo thật sự khớp Aiken phải đọc `plutus.json` — mà `plutus.json` là hiện vật
// `aiken build` sinh ra, đã gitignore và CI của kho này KHÔNG chạy `aiken check`. Một
// bài phụ thuộc nó sẽ đỏ trên máy sạch vì lý do rỗng, rồi bị tắt, rồi không ai canh
// gì nữa. Nên mức đúng của tệp này là: **biến một hoán vị im lặng thành một hoán vị
// ồn ào**, buộc người sửa phải sửa hai chỗ và nhìn thấy dòng dặn ngay đây.
//
// Nguồn chân lý của thứ tự: `InstantGen/onchain/lib/magiclamp/protocol/types.ak`
// ▸ `pub type VaultDatum` (18 trường) và `ScheduleGen/.../types.ak` ▸ `VaultDatum`
// (17 trường chung đầu). Đối chiếu bằng mắt lần cuối 2026-09-22.

/** 17 trường chung, ĐÚNG thứ tự Aiken. Chỉ số trong danh sách = chỉ số Plutus Data. */
const COMMON_FIELDS_IN_ORDER = [
  "owner",                 //  0
  "lamp_balance",          //  1
  "lamp_locked",           //  2
  "loyalty_holdings",      //  3
  "magic_batches",         //  4
  "next_batch_index",      //  5
  "vacuum_orders",         //  6  🪦 bia mộ — mô hình bỏ, trường ở lại
  "gen_schedules",         //  7
  "profile",               //  8
  "profile_changed_epoch", //  9
  "pending_profile",       // 10
  "last_updated_epoch",    // 11
  "delegation_cert",       // 12
  "activity_state",        // 13
  "streak_state",          // 14
  "personal_delegate",     // 15  🪦 quyền chết, trường ở lại (Paymaster đọc VỊ TRÍ này)
  "attribution",           // 16
] as const;

/** Thứ tự trường mà lược đồ THẬT SỰ mã hoá.
 *
 *  Đọc `anyOf[0].fields[].title` — hình dạng lược đồ đã biên dịch của
 *  `@lucid-evolution`, tức chính thứ đi vào Plutus Data. Cố ý KHÔNG đọc
 *  `Object.keys` của đối tượng TypeScript: bản trước của hàm này làm thế, và nó
 *  trả về `["anyOf"]` — một mảng dài 1, hợp lệ, không ném. Cả ba ca dưới đây khi
 *  ấy đỏ vì lý do RỖNG (so một danh sách 1 phần tử với danh sách 17), chứ không vì
 *  thứ tự sai. Một phép đo đọc nhầm chỗ thì màu của nó không mang thông tin. */
function fieldOrderOf(schema: unknown): string[] {
  const s = schema as { anyOf?: { fields?: { title?: string }[] }[] };
  const fields = s.anyOf?.[0]?.fields;
  if (!fields) {
    throw new Error(
      "không đọc được `anyOf[0].fields` của lược đồ — hình dạng nội bộ của " +
      "@lucid-evolution đã đổi. NÉM chứ không trả mảng rỗng: một mảng rỗng làm ba " +
      "ca dưới đây đỏ với thông điệp nói về thứ tự trường, tức chỉ sai chỗ.",
    );
  }
  return fields.map((f, i) => {
    if (typeof f.title !== "string") {
      throw new Error(`trường ở chỉ số ${i} không có \`title\` — không đọc được tên`);
    }
    return f.title;
  });
}

describe("VaultDatum ▸ thứ tự trường là HỢP ĐỒNG NHỊ PHÂN", () => {
  it("VaultDatumSchema: đúng 17 trường, đúng thứ tự", () => {
    expect(fieldOrderOf(VaultDatumSchema)).toEqual([...COMMON_FIELDS_IN_ORDER]);
  });

  it("InstantVaultDatumSchema: 17 trường ĐÓ, cùng thứ tự, cộng mốc khoá ở chỉ số 17", () => {
    expect(fieldOrderOf(InstantVaultDatumSchema)).toEqual([
      ...COMMON_FIELDS_IN_ORDER,
      "instant_unlock_ms",
    ]);
  });

  it("CỰC ĐỐI — hai lược đồ chỉ khác nhau ĐÚNG một trường, và nó ở CUỐI", () => {
    // Không có ca này thì hai ca trên còn xanh được khi ai đó chèn `instant_unlock_ms`
    // vào GIỮA rồi sửa cả hai danh sách cho khớp — lúc đó chỉ số 17..16 dịch hết, mọi
    // UTxO Instant đang sống đọc sai, và hai ca trên vẫn xanh vì chúng chỉ so với
    // chính bản đã sửa. Vế "ở cuối" thì không sửa được bằng cách sửa danh sách.
    const chung = fieldOrderOf(VaultDatumSchema);
    const instant = fieldOrderOf(InstantVaultDatumSchema);

    expect(instant.slice(0, chung.length)).toEqual(chung);
    expect(instant.length).toBe(chung.length + 1);
    expect(instant[instant.length - 1]).toBe("instant_unlock_ms");
  });

  it("ĐỘT BIẾN tự chạy: hoán vị hai trường ⟹ danh sách KHÁC ⟹ phép so ở trên đỏ", () => {
    // Bài này không kiểm mã sản phẩm — nó kiểm rằng PHÉP ĐO ở ba ca trên thật sự
    // phân biệt được. `toEqual` trên mảng so theo THỨ TỰ, không so theo tập hợp; nếu
    // ai đó đổi nó thành một phép so tập hợp thì ba ca trên im lặng mất răng, và ca
    // này là chỗ điều đó lộ ra.
    const goc = [...COMMON_FIELDS_IN_ORDER];
    const hoanVi = [...goc];
    [hoanVi[2], hoanVi[3]] = [hoanVi[3], hoanVi[2]];

    expect(hoanVi).not.toEqual(goc);
    expect([...hoanVi].sort()).toEqual([...goc].sort()); // cùng TẬP, khác THỨ TỰ
  });
});
