// VaultTxAPI/tests/txBuilder.test.ts — ghim hai thứ mà bản trước KHÔNG có bài nào canh.

import { msPerEpoch, posixMsToEpoch, WindowOriginError, type Network } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { enterpriseAddressOf, protocolEpoch } from "../src/txBuilder.js";
import { OWNER_PKH } from "./fixtures/preview.js";

const T = 1_789_100_703_000n;

describe("protocolEpoch — nhịp epoch là THAM SỐ THEO MẠNG, không phải một hằng", () => {
  it("trả đúng thứ ProtocolUtils trả, trên hai mạng có gốc cửa sổ", () => {
    for (const net of ["Preprod", "Mainnet"] as Network[]) {
      expect(protocolEpoch(T, net)).toBe(posixMsToEpoch(T, net));
    }
  });

  it("Preview chưa có gốc cửa sổ ⟹ NÉM WIN-PREVIEW, không đoán một epoch", () => {
    expect(() => protocolEpoch(T, "Preview")).toThrow(WindowOriginError);
    expect(() => protocolEpoch(T, "Preview")).toThrow(/WIN-PREVIEW/);
  });

  it("vector LAMP `Specs/Window/CONTRACT.md` v1.0 — trừ gốc rồi chia sàn, cặp biên ±1 ms", () => {
    expect(protocolEpoch(1_790_459_091_000n, "Mainnet")).toBe(658n);
    expect(protocolEpoch(1_790_459_090_999n, "Mainnet")).toBe(657n);
    expect(protocolEpoch(1_790_553_600_000n, "Preprod")).toBe(316n);
    expect(protocolEpoch(1_790_553_599_999n, "Preprod")).toBe(315n);
  });

  it("CÙNG mốc thời gian mà Mainnet ra số KHÁC Preprod — cùng nhịp, KHÁC gốc; và nhịp Mainnet khác Preview", () => {
    // Từ gốc cửa sổ, Preview không còn tính được epoch (ném), nên dòng CẮN của bản trước —
    // Mainnet ≠ Preview — chuyển sang hai mạng có gốc: Preprod và Mainnet CÙNG nhịp 5 ngày
    // mà KHÁC gốc, nên cùng một mốc phải ra hai số khác nhau. Quên trừ gốc thì dòng này đỏ.
    expect(protocolEpoch(T, "Mainnet")).not.toBe(protocolEpoch(T, "Preprod"));
    // 🪦 Bản trước viết `posixMs / 86_400_000n` và bỏ hẳn tham số mạng. Nó đúng trên
    // Preview/Preprod (86 400 000 ms) và sai 5× trên Mainnet (432 000 000 ms), nên mọi
    // bài chạy trên Preview đều xanh — không có bài nào chạy trên Mainnet.
    //
    // Hai dòng dưới phân biệt được hai bên đột biến: khôi phục phép chia cứng thì dòng
    // thứ nhất đỏ. Dòng thứ hai neo nguyên nhân vào bảng nhịp, để khi ai đó đổi
    // `MS_PER_EPOCH_BY_NETWORK` thì chỗ này nói được là nó đổi, chứ không im.
    expect(msPerEpoch("Mainnet")).not.toBe(msPerEpoch("Preview"));
  });

  it("Preprod nay đi theo nhịp MAINNET, không còn theo Preview — ghim trạng thái sau lượt đổi 2026-09-20", () => {
    // Đây là bài ghim TRẠNG THÁI, không phải một bất biến giao thức. Nguồn của bộ ba số
    // là `MS_PER_EPOCH_BY_NETWORK` trong ProtocolUtils, và chú thích tại chỗ đó là nơi
    // duy nhất mô tả vì sao nhịp Preprod đang mang giá trị nó đang mang. Sửa bảng ấy thì
    // hai dòng dưới đỏ và trỏ thẳng về đây, thay vì một sai lệch epoch lộ ra ở Preprod.
    //
    // 🪦 Bản trước ghim chiều NGƯỢC LẠI (`Preprod === Preview`) và nó đúng cho tới
    // 2026-09-20. Lượt đổi nhịp chạm 13 tệp mà KHÔNG chạm dòng này, nên bài đỏ ở đây
    // chính là bài đã làm đúng việc của nó. Phạm vi của câu "duy nhất": trong 23 job
    // của lượt kiểm PR ấy, đây là job npm DUY NHẤT đỏ — 18 job npm kia và 4 job
    // `aiken check` đều xanh. Nên đổi DẤU KỲ VỌNG, đừng xoá bài: xoá là gỡ luôn cái
    // chuông cho lần đổi nhịp sau.
    //
    // Hai dòng, vì một dòng không đủ. Dòng `not.toBe` bắt việc ai đó đưa Preprod về lại
    // nhịp 1 ngày; dòng `toBe` bắt việc ai đó đẩy nó sang một giá trị thứ ba không bằng
    // mạng nào. Chỉ giữ dòng đầu thì mọi giá trị khác 86 400 000 đều đi lọt.
    //
    // Từ gốc cửa sổ (2026-10-02) bài so NHỊP trực tiếp chứ không so epoch: Preview không còn
    // epoch để so, và Preprod/Mainnet cùng nhịp nhưng khác gốc nên epoch của chúng khác nhau.
    expect(msPerEpoch("Preprod")).not.toBe(msPerEpoch("Preview"));
    expect(msPerEpoch("Preprod")).toBe(msPerEpoch("Mainnet"));
  });
});

describe("enterpriseAddressOf — địa chỉ tiền thừa suy từ owner_pkh", () => {
  it("cùng pkh mà khác mạng thì khác địa chỉ", () => {
    expect(enterpriseAddressOf("Mainnet", OWNER_PKH))
      .not.toBe(enterpriseAddressOf("Preview", OWNER_PKH));
  });

  it("Preview và Preprod dùng chung tiền tố testnet nên trùng địa chỉ", () => {
    expect(enterpriseAddressOf("Preprod", OWNER_PKH))
      .toBe(enterpriseAddressOf("Preview", OWNER_PKH));
  });
});
