// MagicSDK/tests/lampPolicy.test.ts — cổng `lampPolicyId` ở mặt tiền công khai.
//
// Ca quan trọng nhất của tệp này KHÔNG phải "hàm có ném không" — mà là "cổng có đứng
// ở CHOKEPOINT không". Hai thứ đó phân biệt được bằng đột biến: dời cổng về riêng
// `createVault` thì khối "cổng đứng ở buildParamsList" đỏ, trong khi mọi ca gọi thẳng
// `assertLampPolicyId` vẫn xanh. Không có khối đó thì bộ kiểm này không ghim được
// điều nó nói là nó ghim.

import { describe, it, expect } from "vitest";

import { assertLampPolicyId, NON_LAMP_LOOKALIKE_POLICIES } from "../src/lampPolicy.js";
import { buildParamsList } from "../src/validatorScripts.js";
import type { ProtocolParams } from "../src/types.js";

/** Policy nhái đã đi vào cấu hình thật của kho — xem `lampPolicy.ts`. */
const LOOKALIKE = "28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4";
/** 56 hex hợp lệ về hình dạng, không nằm trong danh sách từ chối. */
const SHAPE_OK  = "a".repeat(56);

const MS_PER = 86_400_000n;

const proto = (lampPolicyId: string): ProtocolParams => ({
  network: "Preview",
  lampPolicyId,
  shardPolicyId: "b".repeat(56),
});

describe("assertLampPolicyId — danh sách từ chối", () => {
  it("ném cho policy nhái đã biết, và câu lỗi nói VÌ SAO", () => {
    expect(() => assertLampPolicyId(LOOKALIKE, "t")).toThrow(/KHÔNG PHẢI LAMP/);
    // Lý do phải đi kèm: một câu "giá trị không hợp lệ" trơ khiến người vận hành
    // đi sửa hình dạng thay vì đi lấy policy canonical.
    expect(() => assertLampPolicyId(LOOKALIKE, "t")).toThrow(/không trần phát hành/);
  });

  it("chặn policy nhái DÙ nó đúng 56 hex — đây là điểm cổng hình dạng bỏ lọt", () => {
    // Ca này là lý do danh sách từ chối tồn tại. `28e916b0…` qua được mọi phép kiểm
    // hình dạng vì nó LÀ một policy id thật; cái sai của nó không nằm ở hình dạng.
    expect(LOOKALIKE).toMatch(/^[0-9a-f]{56}$/);
    expect(() => assertLampPolicyId(LOOKALIKE, "t")).toThrow();
  });

  it("mọi mục trong danh sách đều bị chặn, không chỉ mục đầu", () => {
    for (const p of Object.keys(NON_LAMP_LOOKALIKE_POLICIES)) {
      expect(() => assertLampPolicyId(p, "t")).toThrow(/KHÔNG PHẢI LAMP/);
    }
  });
});

describe("assertLampPolicyId — cổng hình dạng", () => {
  it.each([
    ["rỗng", ""],
    ["undefined", undefined],
    ["ngắn", "abc"],
    ["hex hoa", "A".repeat(56)],
    ["57 ký tự", "a".repeat(57)],
    ["giữ chỗ", "FILL_AFTER_DEPLOY"],
  ])("ném cho %s", (_label, v) => {
    expect(() => assertLampPolicyId(v as string | undefined, "t")).toThrow(/sai hình dạng/);
  });

  it("trả lại nguyên giá trị khi hợp lệ — fail-closed, không đệm", () => {
    expect(assertLampPolicyId(SHAPE_OK, "t")).toBe(SHAPE_OK);
  });

  it("câu lỗi KHÔNG hứa rằng qua cổng là đúng policy", () => {
    // Một cổng hình dạng tự xưng là cổng chính danh sẽ dạy người đọc tin nhầm.
    expect(() => assertLampPolicyId("abc", "t")).toThrow(/chỉ là cổng HÌNH DẠNG/);
  });

  it("tên chỗ gọi đi vào câu lỗi, để lần lỗi ra đúng đường", () => {
    expect(() => assertLampPolicyId("abc", "withdrawLamp")).toThrow(/\[withdrawLamp\]/);
  });
});

describe("cổng đứng ở buildParamsList — chỗ policy id nướng vào script hash", () => {
  // Đây là khối phân biệt được hai bên đột biến. Nếu cổng bị dời ra khỏi
  // `buildParamsList` về riêng chỗ gọi, khối này đỏ còn phần trên vẫn xanh.
  it("Schedule: apply-param từ chối policy nhái", () => {
    expect(() => buildParamsList("Schedule", proto(LOOKALIKE), MS_PER))
      .toThrow(/KHÔNG PHẢI LAMP/);
  });

  it("Schedule: apply-param từ chối chuỗi sai hình dạng", () => {
    expect(() => buildParamsList("Schedule", proto(""), MS_PER))
      .toThrow(/sai hình dạng/);
  });

  it("Schedule: policy hợp lệ đi qua, và nằm ở SLOT 0 của apply-param", () => {
    // Thứ tự apply-param là hợp đồng nhị phân: đổi chỗ là đổi script hash, đổi địa
    // chỉ vault. Ca này ghim slot 0 chứ không chỉ ghim "không ném".
    const params = buildParamsList("Schedule", proto(SHAPE_OK), MS_PER);
    expect(params[0]).toBe(SHAPE_OK);
  });

  it("Instant: cổng chạy TRƯỚC các trường riêng của Instant", () => {
    // Nếu cổng đứng sau `requireField`, người đưa policy nhái sẽ nhận câu lỗi về
    // `umNftPolicyId` và đi sửa nhầm thứ.
    expect(() => buildParamsList("Instant", proto(LOOKALIKE), MS_PER))
      .toThrow(/KHÔNG PHẢI LAMP/);
  });
});
