// MagicSDK/tests/vaultDatumShape.test.ts — hai hình dạng datum két, đo trên LƯỢC ĐỒ THẬT.
//
// ══ VÌ SAO TỆP NÀY TỒN TẠI ════════════════════════════════════════════════════
// Gen v2.0: két InstantGen mang 20 trường, két ScheduleGen mang 19 (`schemas.ts`).
// Két đời trước (InstantGen 18, ScheduleGen 17) là hash cũ, KHÔNG di trú — SDK phải
// NÉM có tên, không đọc chúng như két v2.0.
// Cả thiết kế đứng trên MỘT tính chất của Lucid: giải mã một datum bằng lược đồ
// lệch số trường thì NÉM, ở CẢ HAI CHIỀU. Nếu nó không ném — nếu nó cắt bớt hoặc
// đệm thêm trường — thì `decodeVaultDatumEitherShape` trả về sai loại trong im
// lặng, và mọi thứ dựng trên nó là một cái vỏ im lặng.
//
// Tính chất đó đã được đo một lần trên `Data.Object` 3/4 trường đồ chơi. Phạm vi
// đó KHÔNG đủ để phát biểu về `VaultDatumSchema` thật: lược đồ thật có trường lồng
// (`activity_state`, `attribution`, `usage_window`), mảng, và `Data.Nullable` —
// một cơ chế kiểm arity có thể hành xử khác khi trường cuối là một cấu trúc chứ
// không phải một số. Tệp này đo lại trên chính hai lược đồ mà mã sản xuất dùng.
//
// Mọi khẳng định ở đây neo vào một lượt mã hoá/giải mã THẬT, không vào một con số
// đếm trường được gõ tay: đếm tay thì đúng lúc viết và im lặng sai về sau.
// ══════════════════════════════════════════════════════════════════════════════

import { Constr, Data } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import {
  InstantVaultDatumSchema,
  VaultDatumSchema,
  decodeVaultDatumEitherShape,
  decodeVaultDatumOfKind,
} from "../src/schemas.js";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";

const base = {
  ownerPkh:           "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21",
  lampBalanceOildrop: 1_000_000_000n,
  profile:            "Flame",
  currentEpoch:       40n,
} as const;

/** 19 trường ScheduleGen v2.0, dựng từ chính hàm mã sản xuất dùng — không gõ tay. */
const schedule = () => buildInitialVaultDatum({ ...base, vaultType: "Schedule" });

/** 20 trường InstantGen v2.0, cùng hàm; chỉ đổi mốc khoá để có giá trị khác 0 mà đo. */
const instant = (unlockMs = 0n) => ({
  ...buildInitialVaultDatum({ ...base, vaultType: "Instant" }),
  instant_unlock_ms: unlockMs,
});

/** Datum ĐỜI TRƯỚC Gen v2.0, dựng từ trường THÔ của két Schedule v2.0 (không gõ tay):
 *  ScheduleGen v1 = 17 trường đầu; InstantGen v1 = 17 trường đó + `instant_unlock_ms`. */
const v1Cbor = (kind: "Instant" | "Schedule") => {
  const raw = Data.from(Data.to(schedule() as never, VaultDatumSchema)) as Constr<Data>;
  const head17 = raw.fields.slice(0, 17);
  return Data.to(new Constr(0, kind === "Instant" ? [...head17, 5n] : head17));
};

describe("hai hình dạng VaultDatum — round-trip khép kín", () => {
  it("InstantVaultDatumSchema: mã hoá rồi giải mã lại ra đúng datum vào", () => {
    const d = instant(1_700_000_000_000n);
    const back = Data.from(Data.to(d as never, InstantVaultDatumSchema), InstantVaultDatumSchema);
    expect(back).toEqual(d);
  });

  it("VaultDatumSchema: mã hoá rồi giải mã lại ra đúng datum vào", () => {
    const d = schedule();
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

  it("hai hình dạng cho hai chuỗi CBOR KHÁC nhau, và số trường thô đúng 20 / 19", () => {
    const ci = Data.to(instant() as never, InstantVaultDatumSchema);
    const cs = Data.to(schedule() as never, VaultDatumSchema);
    expect(ci).not.toBe(cs);
    // Đếm trên Constr THÔ, không qua lược đồ — lược đồ tự-nhất-quán không đếm hộ được.
    expect((Data.from(ci) as Constr<Data>).fields.length).toBe(20);
    expect((Data.from(cs) as Constr<Data>).fields.length).toBe(19);
  });
});

describe("🔴 đọc chéo hình dạng phải NÉM — tính chất cả thiết kế đứng trên", () => {
  const cbor20 = () => Data.to(instant(123n) as never, InstantVaultDatumSchema);
  const cbor19 = () => Data.to(schedule() as never, VaultDatumSchema);

  it("datum 20 trường đọc bằng lược đồ 19 ⟹ NÉM", () => {
    expect(() => Data.from(cbor20(), VaultDatumSchema)).toThrow();
  });

  it("datum 19 trường đọc bằng lược đồ 20 ⟹ NÉM", () => {
    expect(() => Data.from(cbor19(), InstantVaultDatumSchema)).toThrow();
  });

  // Hai ca trên là phép đo NGƯỢC DẤU của nhau và cần cả hai: một cơ chế chỉ kiểm
  // "dữ liệu không được THIẾU trường" sẽ qua ca thứ hai và trượt ca thứ nhất, và
  // ở chiều trượt đó datum Instant bị đọc thành Schedule — mất đúng trường khoá.
});

describe("decodeVaultDatumEitherShape — nhận đúng loại, và không nuốt lỗi", () => {
  it("datum 20 trường ⟹ kind Instant, và trả đúng `instantUnlockMs`", () => {
    const out = decodeVaultDatumEitherShape(Data.to(instant(999n) as never, InstantVaultDatumSchema));
    expect(out.kind).toBe("Instant");
    expect(out.instantUnlockMs).toBe(999n);
  });

  it("datum 19 trường ⟹ kind Schedule, và `instantUnlockMs` là null chứ không phải 0n", () => {
    const out = decodeVaultDatumEitherShape(Data.to(schedule() as never, VaultDatumSchema));
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
    // Một Constr 2 trường: không phải 20/19 (v2.0), không phải 18/17 (v1).
    const la = Data.to(
      { a: "aabb", b: 1n } as never,
      Data.Object({ a: Data.Bytes(), b: Data.Integer() }) as never,
    );
    let caught: Error | null = null;
    try { decodeVaultDatumEitherShape(la); } catch (e) { caught = e as Error; }

    // Ghim rằng nó NÉM, chứ không trả `null`/`{}` — đó là chỗ một cái vỏ im lặng
    // sẽ sinh ra: một két không đọc được và một két rỗng ra cùng một màn hình.
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/^VAULT_DATUM_SHAPE/);
    expect(caught!.message).toContain("InstantGen 20");
    expect(caught!.message).toContain("ScheduleGen 19");
  });
});

// ══ Két ĐỜI TRƯỚC Gen v2.0 ══════════════════════════════════════════════════════
// v2.0 là hash két mới, KHÔNG di trú UTxO v1. Số trường 18/17 là đúng hai giá trị mà
// một bộ rẽ nhánh lỏng tay dễ "đọc thử" bằng lược đồ gần nhất — ca này ghim rằng nó
// NÉM có tên `VAULT_DATUM_V1` và nói đúng module, không rơi xuống lỗi hình dạng chung.
describe("🔴 datum đời v1 (18/17 trường) ⟹ NÉM `VAULT_DATUM_V1`", () => {
  it("fixture v1 đúng số trường thô — không thì các ca dưới đo nhầm nhánh", () => {
    expect((Data.from(v1Cbor("Instant")) as Constr<Data>).fields.length).toBe(18);
    expect((Data.from(v1Cbor("Schedule")) as Constr<Data>).fields.length).toBe(17);
  });

  it("18 trường ⟹ VAULT_DATUM_V1, nêu InstantGen v1", () => {
    expect(() => decodeVaultDatumEitherShape(v1Cbor("Instant"))).toThrow(/^VAULT_DATUM_V1:.*InstantGen v1/);
  });

  it("17 trường ⟹ VAULT_DATUM_V1, nêu ScheduleGen v1", () => {
    expect(() => decodeVaultDatumEitherShape(v1Cbor("Schedule"))).toThrow(/^VAULT_DATUM_V1:.*ScheduleGen v1/);
  });

  it("đường ĐÃ BIẾT loại (`decodeVaultDatumOfKind`) cũng NÉM với datum v1 đúng loại", () => {
    // Mã lỗi là của gói nền (`InstantGen` / `ScheduleGen` offchain ▸ `decodeVaultDatum`).
    expect(() => decodeVaultDatumOfKind("Instant", v1Cbor("Instant"))).toThrow(/^VAULT_DATUM_V1:/);
    expect(() => decodeVaultDatumOfKind("Schedule", v1Cbor("Schedule"))).toThrow(/GEN-SCH-V1-DATUM/);
  });
});
