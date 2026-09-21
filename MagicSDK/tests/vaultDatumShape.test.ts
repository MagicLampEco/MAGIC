// MagicSDK/tests/vaultDatumShape.test.ts — hai hình dạng datum két, đo trên LƯỢC ĐỒ THẬT.
//
// ══ VÌ SAO TỆP NÀY TỒN TẠI ════════════════════════════════════════════════════
// Từ 2026-09-21 két InstantGen mang 18 trường, két ScheduleGen/PrepaidGen mang 17.
// Cả thiết kế đứng trên MỘT tính chất của Lucid: giải mã một datum bằng lược đồ
// lệch số trường thì NÉM, ở CẢ HAI CHIỀU. Nếu nó không ném — nếu nó cắt bớt hoặc
// đệm thêm trường — thì `decodeVaultDatumEitherShape` trả về sai loại trong im
// lặng, và mọi thứ dựng trên nó là một cái vỏ im lặng.
//
// Tính chất đó đã được đo một lần trên `Data.Object` 3/4 trường đồ chơi. Phạm vi
// đó KHÔNG đủ để phát biểu về `VaultDatumSchema` thật: lược đồ thật có trường lồng
// (`delegation_cert`, `activity_state`, `attribution`), mảng, và `Data.Nullable` —
// một cơ chế kiểm arity có thể hành xử khác khi trường cuối là một cấu trúc chứ
// không phải một số. Tệp này đo lại trên chính hai lược đồ mà mã sản xuất dùng.
//
// Mọi khẳng định ở đây neo vào một lượt mã hoá/giải mã THẬT, không vào một con số
// đếm trường được gõ tay: đếm tay thì đúng lúc viết và im lặng sai về sau.
// ══════════════════════════════════════════════════════════════════════════════

import { Data } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import {
  InstantVaultDatumSchema,
  VaultDatumSchema,
  decodeVaultDatumEitherShape,
} from "../src/schemas.js";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";

/** 17 trường chung, dựng từ chính hàm mã sản xuất dùng — không gõ tay. */
const common = () => buildInitialVaultDatum({
  ownerPkh:           "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21",
  lampBalanceOildrop: 1_000_000_000n,
  profile:            "Flame",
  currentEpoch:       40n,
});

/** 18 trường = 17 chung + `instant_unlock_ms` ở CUỐI. */
const instant = (unlockMs = 0n) => ({ ...common(), instant_unlock_ms: unlockMs });

describe("hai hình dạng VaultDatum — round-trip khép kín", () => {
  it("InstantVaultDatumSchema: mã hoá rồi giải mã lại ra đúng datum vào", () => {
    const d = instant(1_700_000_000_000n);
    const back = Data.from(Data.to(d as never, InstantVaultDatumSchema), InstantVaultDatumSchema);
    expect(back).toEqual(d);
  });

  it("VaultDatumSchema: mã hoá rồi giải mã lại ra đúng datum vào", () => {
    const d = common();
    const back = Data.from(Data.to(d as never, VaultDatumSchema), VaultDatumSchema);
    expect(back).toEqual(d);
  });

  it("`instant_unlock_ms` sống sót qua round-trip, kể cả giá trị 0", () => {
    // `0n` là giá trị HỢP LỆ (két chưa từng sinh), không phải "không có trường".
    // Ca này ghim đúng chỗ đó: một bản hiện thực coi 0 là vắng mặt sẽ đỏ ở đây.
    for (const v of [0n, 1n, 1_700_000_000_000n]) {
      const back = Data.from(
        Data.to(instant(v) as never, InstantVaultDatumSchema),
        InstantVaultDatumSchema,
      ) as never as { instant_unlock_ms: bigint };
      expect(back.instant_unlock_ms).toBe(v);
    }
  });

  it("hai hình dạng cho hai chuỗi CBOR KHÁC nhau với cùng 17 trường đầu", () => {
    expect(Data.to(instant() as never, InstantVaultDatumSchema))
      .not.toBe(Data.to(common() as never, VaultDatumSchema));
  });
});

describe("🔴 đọc chéo hình dạng phải NÉM — tính chất cả thiết kế đứng trên", () => {
  const cbor18 = () => Data.to(instant(123n) as never, InstantVaultDatumSchema);
  const cbor17 = () => Data.to(common() as never, VaultDatumSchema);

  it("datum 18 trường đọc bằng lược đồ 17 ⟹ NÉM", () => {
    expect(() => Data.from(cbor18(), VaultDatumSchema)).toThrow();
  });

  it("datum 17 trường đọc bằng lược đồ 18 ⟹ NÉM", () => {
    expect(() => Data.from(cbor17(), InstantVaultDatumSchema)).toThrow();
  });

  // Hai ca trên là phép đo NGƯỢC DẤU của nhau và cần cả hai: một cơ chế chỉ kiểm
  // "dữ liệu không được THIẾU trường" sẽ qua ca thứ hai và trượt ca thứ nhất, và
  // ở chiều trượt đó datum Instant bị đọc thành Schedule — mất đúng trường khoá.
});

describe("decodeVaultDatumEitherShape — nhận đúng loại, và không nuốt lỗi", () => {
  it("datum 18 trường ⟹ kind Instant, và trả đúng `instantUnlockMs`", () => {
    const out = decodeVaultDatumEitherShape(Data.to(instant(999n) as never, InstantVaultDatumSchema));
    expect(out.kind).toBe("Instant");
    expect(out.instantUnlockMs).toBe(999n);
  });

  it("datum 17 trường ⟹ kind Schedule, và `instantUnlockMs` là null chứ không phải 0n", () => {
    const out = decodeVaultDatumEitherShape(Data.to(common() as never, VaultDatumSchema));
    expect(out.kind).toBe("Schedule");
    // `null` = trường KHÔNG TỒN TẠI. `0n` = trường tồn tại và bằng 0. Đệm `0n` ở
    // đây là xoá chỗ phân biệt hai điều đó, rồi giá trị đệm đi tiếp vào phép so ở
    // nơi khác mà không còn tự khai được là thiếu.
    expect(out.instantUnlockMs).toBeNull();
    expect(out.instantUnlockMs).not.toBe(0n);
  });

  it("két Instant CHƯA TỪNG SINH (unlock = 0) vẫn ra kind Instant, không lẫn sang Schedule", () => {
    const out = decodeVaultDatumEitherShape(Data.to(instant(0n) as never, InstantVaultDatumSchema));
    expect(out.kind).toBe("Instant");
    expect(out.instantUnlockMs).toBe(0n);
  });

  it("🔴 không khớp hình dạng nào ⟹ NÉM, câu lỗi nêu đích danh CẢ HAI hình dạng", () => {
    // Một Constr 2 trường: không phải 17, không phải 18.
    const la = Data.to(
      { a: "aabb", b: 1n } as never,
      Data.Object({ a: Data.Bytes(), b: Data.Integer() }) as never,
    );
    let caught: Error | null = null;
    try { decodeVaultDatumEitherShape(la); } catch (e) { caught = e as Error; }

    // Ghim rằng nó NÉM, chứ không trả `null`/`{}` — đó là chỗ một cái vỏ im lặng
    // sẽ sinh ra: một két không đọc được và một két rỗng ra cùng một màn hình.
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("InstantVaultDatumSchema");
    expect(caught!.message).toContain("VaultDatumSchema");
  });
});
