// MagicSDK/tests/lampPolicy.test.ts — cổng `lampPolicyId` ở mặt tiền công khai.
//
// Ca quan trọng nhất của tệp này KHÔNG phải "hàm có ném không" — mà là "cổng có đứng
// ở CHOKEPOINT không". Hai thứ đó phân biệt được bằng đột biến: dời cổng về riêng
// `createVault` thì khối "cổng đứng ở buildParamsList" đỏ, trong khi mọi ca gọi thẳng
// `assertLampPolicyId` vẫn xanh. Không có khối đó thì bộ kiểm này không ghim được
// điều nó nói là nó ghim.

import { describe, it, expect } from "vitest";
import { Data } from "@lucid-evolution/lucid";

import {
  assertLampPolicyId,
  NON_LAMP_LOOKALIKE_POLICIES,
  REHEARSAL_LAMP_POLICIES,
  SUPERSEDED_LAMP_POLICIES,
} from "../src/lampPolicy.js";
import { buildParamsList, buildCommitParamsList } from "../src/validatorScripts.js";
import { createVault } from "../src/createVault.js";
import { withdrawLamp } from "../src/withdrawLamp.js";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";
import { VaultDatumSchema } from "../src/schemas.js";
import { ACCEPT_INLINE_SCRIPT_CEILING } from "../src/refScript.js";
import type { ProtocolParams } from "../src/types.js";

/** Policy nhái đã đi vào cấu hình thật của kho — xem `lampPolicy.ts`. */
const LOOKALIKE = "28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4";
/** 56 hex hợp lệ về hình dạng, không nằm trong danh sách từ chối. */
const SHAPE_OK  = "a".repeat(56);

const MS_PER = 86_400_000n;

/** Năm tham số GenBeacons Gen v2.0 — cả hai loại két đều đòi (`validatorScripts.ts`). */
const V2_BEACONS = {
  gbBeaconNftPolicy:  "c".repeat(56),
  gbBeaconScriptHash: "d".repeat(56),
  gbShardPolicyId:    "e".repeat(56),
  rateNftPolicy:      "f".repeat(56),
  rateScriptHash:     "1".repeat(56),
} as const;
/** Hash `commit` giả — tham số #6 của két Schedule; bài ở đây chỉ đọc slot 0. */
const COMMIT_HASH = "2".repeat(56);

/** Đủ mọi thứ két Schedule đòi, để phép đo rơi ĐÚNG vào cổng policy chứ không vào `requireField`. */
// Preview chưa có gốc cửa sổ (`WIN-PREVIEW`) — bài chỉ đo slot 0, truyền gốc tường minh của bài.
const TEST_ORIGIN = 1_000_000_000n;
const proto = (lampPolicyId: string): ProtocolParams => ({
  network: "Preview",
  windowOriginMs: TEST_ORIGIN,
  lampPolicyId,
  shardPolicyId: "b".repeat(56),
  ...V2_BEACONS,
});

/** CHỈ trường chung, KHÔNG có trường két Instant đòi (beacon, wakeme) — dùng cho ca thứ tự cổng. */
const protoBare = (lampPolicyId: string): ProtocolParams => ({
  network: "Preview",
  windowOriginMs: TEST_ORIGIN,
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

describe("assertLampPolicyId — đời LAMP đã bị thay", () => {
  /** Đời `preprod-oneshot-12param`. Chính là thứ ví Preprod có tADA đang cầm. */
  const SUPERSEDED = "d9c09230079b810ab5ed92e8db4c190d42efc42db6aac028656f7e07";

  it("chặn đời đã bị thay — đây là đời DỄ dùng nhầm nhất, không phải khó gặp nhất", () => {
    expect(SUPERSEDED).toMatch(/^[0-9a-f]{56}$/);
    expect(() => assertLampPolicyId(SUPERSEDED, "t")).toThrow(/ĐÃ BỊ THAY/);
  });

  it("mọi mục trong danh sách đều bị chặn, không chỉ mục đầu", () => {
    for (const p of Object.keys(SUPERSEDED_LAMP_POLICIES)) {
      expect(() => assertLampPolicyId(p, "t")).toThrow(/ĐÃ BỊ THAY/);
    }
  });

  it("hai bảng nói HAI câu khác nhau — gộp là dạy người đọc làm sai một trong hai", () => {
    // Ca này là thứ phân biệt được hai bên đột biến: gộp `SUPERSEDED_LAMP_POLICIES`
    // vào bảng nhái thì nó đỏ, trong khi mọi ca "có ném không" ở trên vẫn xanh.
    expect(() => assertLampPolicyId(SUPERSEDED, "t")).toThrow(/KHÔNG phải token nhái/);
    expect(() => assertLampPolicyId(LOOKALIKE, "t")).not.toThrow(/ĐÃ BỊ THAY/);
  });

  it("hai danh sách KHÔNG giao nhau — một policy chỉ mang đúng một mức", () => {
    for (const p of Object.keys(SUPERSEDED_LAMP_POLICIES)) {
      expect(NON_LAMP_LOOKALIKE_POLICIES[p]).toBeUndefined();
    }
  });

  it("cổng đứng ở buildParamsList cũng chặn đời đã bị thay", () => {
    // Đường mà bên tích hợp thật sự đi. Cổng chỉ nằm trong `assertLampPolicyId`
    // mà không với tới đây thì apply-param vẫn nhận đời chết.
    expect(() => buildParamsList("Schedule", proto(SUPERSEDED), MS_PER, COMMIT_HASH))
      .toThrow(/ĐÃ BỊ THAY/);
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
    expect(() => buildParamsList("Schedule", proto(LOOKALIKE), MS_PER, COMMIT_HASH))
      .toThrow(/KHÔNG PHẢI LAMP/);
  });

  it("Schedule: apply-param từ chối chuỗi sai hình dạng", () => {
    expect(() => buildParamsList("Schedule", proto(""), MS_PER, COMMIT_HASH))
      .toThrow(/sai hình dạng/);
  });

  it("Schedule: policy hợp lệ đi qua, và nằm ở SLOT 0 của apply-param", () => {
    // Thứ tự apply-param là hợp đồng nhị phân: đổi chỗ là đổi script hash, đổi địa
    // chỉ vault. Ca này ghim slot 0 chứ không chỉ ghim "không ném".
    const params = buildParamsList("Schedule", proto(SHAPE_OK), MS_PER, COMMIT_HASH);
    expect(params[0]).toBe(SHAPE_OK);
  });

  it("Schedule commit: policy cũng nướng vào `commit`, cổng chặn ở đó và nằm ở SLOT 0", () => {
    // Gen v2.0: két Schedule nướng hash `commit`, nên policy nhái lọt vào `commit` là
    // lọt vào két qua đường vòng. Ghim cả hai chiều trên cùng một đường gọi.
    expect(() => buildCommitParamsList(proto(LOOKALIKE), MS_PER)).toThrow(/KHÔNG PHẢI LAMP/);
    expect(buildCommitParamsList(proto(SHAPE_OK), MS_PER)[0]).toBe(SHAPE_OK);
  });

  it("Instant: cổng chạy TRƯỚC các trường riêng của Instant", () => {
    // Nếu cổng đứng sau `requireField`, người đưa policy nhái sẽ nhận câu lỗi về
    // trường riêng của két (Gen v2.0: beacon GB/ρ, `wakemeVaultHash`) và đi sửa nhầm thứ.
    // `protoBare` cố ý THIẾU các trường đó: câu lỗi phải nói về policy trước.
    expect(() => buildParamsList("Instant", protoBare(LOOKALIKE), MS_PER))
      .toThrow(/KHÔNG PHẢI LAMP/);
  });
});

// ── Lối mở TẬP DƯỢT — xác nhận THEO GIÁ TRỊ ──────────────────────────────────
//
// Mỗi ca dương có một ca âm chỉ khác ĐÚNG MỘT biến (ack · policy · mạng). Ca dương đứng
// một mình xanh được ở cả bản đúng lẫn bản "cho qua mọi đời đã bị thay".

describe("assertLampPolicyId — lối mở tập dượt", () => {
  /** Đời tập dượt: nằm trong CẢ bảng đã-bị-thay lẫn bảng tập dượt. */
  const REHEARSAL = "8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd";
  /** Đã bị thay, NGOÀI bảng tập dượt. */
  const SUPERSEDED_ONLY = "d9c09230079b810ab5ed92e8db4c190d42efc42db6aac028656f7e07";
  /** Đời ACTIVE Preprod (thư `lam0926mg-lp`, 2026-09-26) — chép từ `scripts/config.ts`. */
  const ACTIVE = "53bc12ade5ee24d43750b9560f152a54b48b804fab34dab810fb8743";

  it("bảng tập dượt là TẬP CON của bảng đã-bị-thay — sự thật 'đã bị thay' không đổi", () => {
    const keys = Object.keys(REHEARSAL_LAMP_POLICIES);
    expect(keys).toEqual([REHEARSAL]);
    for (const p of keys) expect(SUPERSEDED_LAMP_POLICIES[p]).toBeDefined();
  });

  it("8169b76c KHÔNG ack ⟹ ném, câu lỗi cũ nguyên văn", () => {
    expect(() => assertLampPolicyId(REHEARSAL, "t", undefined, "Preprod")).toThrow(/ĐÃ BỊ THAY/);
  });

  it("8169b76c ack = chính nó, mạng Preprod ⟹ qua, trả lại nguyên giá trị", () => {
    expect(assertLampPolicyId(REHEARSAL, "t", REHEARSAL, "Preprod")).toBe(REHEARSAL);
  });

  it("8169b76c ack = chính nó nhưng mạng Mainnet ⟹ ném", () => {
    expect(() => assertLampPolicyId(REHEARSAL, "t", REHEARSAL, "Mainnet")).toThrow(/ĐÃ BỊ THAY/);
  });

  it("8169b76c ack = chính nó nhưng KHÔNG nêu mạng ⟹ ném (fail-closed)", () => {
    expect(() => assertLampPolicyId(REHEARSAL, "t", REHEARSAL)).toThrow(/ĐÃ BỊ THAY/);
  });

  it("8169b76c ack = chính nó nhưng mạng lạ ⟹ ném", () => {
    expect(() => assertLampPolicyId(REHEARSAL, "t", REHEARSAL, "preprod")).toThrow(/ĐÃ BỊ THAY/);
  });

  it("d9c09230 (ngoài bảng tập dượt) ack = chính nó ⟹ VẪN ném", () => {
    expect(() => assertLampPolicyId(SUPERSEDED_ONLY, "t", SUPERSEDED_ONLY, "Preprod"))
      .toThrow(/ĐÃ BỊ THAY/);
  });

  it("ack = 8169b76c nhưng policy = d9c09230 ⟹ ném", () => {
    expect(() => assertLampPolicyId(SUPERSEDED_ONLY, "t", REHEARSAL, "Preprod"))
      .toThrow(/ĐÃ BỊ THAY/);
  });

  it("ack = '1' (kiểu cờ bật/tắt) cho 8169b76c ⟹ ném — xác nhận là GIÁ TRỊ, không phải cờ", () => {
    expect(() => assertLampPolicyId(REHEARSAL, "t", "1", "Preprod")).toThrow(/ĐÃ BỊ THAY/);
  });

  it("policy ACTIVE 53bc12ad không ack ⟹ qua", () => {
    expect(assertLampPolicyId(ACTIVE, "t", undefined, "Preprod")).toBe(ACTIVE);
    expect(assertLampPolicyId(ACTIVE, "t")).toBe(ACTIVE);
  });

  it("ack KHÔNG mở được cửa cho policy nhái", () => {
    expect(() => assertLampPolicyId(LOOKALIKE, "t", LOOKALIKE, "Preprod")).toThrow(/KHÔNG PHẢI LAMP/);
  });
});

describe("lối mở tập dượt đi tới ĐỦ ba chỗ gọi của SDK", () => {
  const REHEARSAL = "8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd";
  const protoPreprod = (ack?: string): ProtocolParams => ({
    network: "Preprod",
    lampPolicyId: REHEARSAL,
    shardPolicyId: "b".repeat(56),
    ...V2_BEACONS,
    ...(ack === undefined ? {} : { lampRehearsalAck: ack }),
  });

  it("buildParamsList: có ack ⟹ qua, policy nằm ở slot 0", () => {
    expect(buildParamsList("Schedule", protoPreprod(REHEARSAL), MS_PER, COMMIT_HASH)[0]).toBe(REHEARSAL);
  });

  it("buildParamsList: không ack ⟹ ném", () => {
    expect(() => buildParamsList("Schedule", protoPreprod(), MS_PER, COMMIT_HASH)).toThrow(/ĐÃ BỊ THAY/);
  });

  // `createVault` gọi cổng TRƯỚC phép kiểm `lampDeposit`. Ca dương đưa `lampDeposit = 0`
  // nên nó ném câu về `lampDeposit` — nghĩa là cổng policy đã cho qua; ca âm ném ở cổng.
  const cv = (ack?: string) => createVault({
    lucid: {} as never,
    vaultType: "Schedule",
    protocol: protoPreprod(ack),
    vault: { ownerPkh: "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21", lampDeposit: 0n },
  } as never);

  it("createVault: có ack ⟹ đi QUA cổng policy (vấp ở lampDeposit phía sau)", async () => {
    await expect(cv(REHEARSAL)).rejects.toThrow(/lampDeposit must be > 0/);
  });

  it("createVault: không ack ⟹ ném ở cổng policy", async () => {
    await expect(cv()).rejects.toThrow(/\[createVault\].*ĐÃ BỊ THAY/);
  });

  // `withdrawLamp` gọi cổng SAU khi giải datum; sau cổng là bước tra redeemer trong
  // `vaultPlutusJson`. Đưa `{}` ⟹ ca dương vấp ở bước đó, ca âm vấp ở cổng.
  const STUB_CBOR =
    "5907f5010100332323232323223225333004323232323253323300a3001300b375400226464a666018600260206ea8004540041860226024002601e6ea8c038c03cc03cc03c004526163006375a0024464a66601a600260120022a66601e60106ea800854008458595900cc8c8c8c8c008894ccc008cdc78010008a99980d99baf300c30093754a66601800a266ebcc02ccc00c0040088c8c008008c8c004004008894ccc008cdc78018008a4d2c601866646002446e1ccdc424014002a66601866ebcc01cc004c01cc024c01400454ccc02ccdd79817980180319810800a51005301230080021300700113001001001";
  const wd = (ack?: string) => {
    const datum = buildInitialVaultDatum({
      ownerPkh: "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21",
      lampBalanceOildrop: 1_000_000n, profile: "Flame", currentEpoch: 1n,
    });
    return withdrawLamp({
      lucid: {} as never,
      vaultUtxo: {
        txHash: "11".repeat(32), outputIndex: 0, address: "addr_test1", assets: { lovelace: 2_000_000n },
        datum: Data.to(datum as never, VaultDatumSchema),
      },
      amountOildrop: 1n,
      vaultScript: { type: "PlutusV3", script: STUB_CBOR },
      vaultRefScriptUtxo: ACCEPT_INLINE_SCRIPT_CEILING,
      vaultType: "Schedule",
      vaultPlutusJson: {} as never,
      network: "Preprod",
      lampPolicyId: REHEARSAL,
      destinationAddress: "addr_test1vpd9crk9ckgj8vrwxs2azwk3fvxz3gd0x3qfryq6tnmz3wgxxhgsf",
      tipPosixMs: 1_654_041_600_000n + 1_000n,   // gốc cửa sổ Preprod + 1 s — epoch 0, như bản trước tính từ 0
      ...(ack === undefined ? {} : { lampRehearsalAck: ack }),
    });
  };

  it("withdrawLamp: có ack ⟹ đi QUA cổng policy (vấp ở bước tra redeemer phía sau)", async () => {
    const err = await wd(REHEARSAL).then(() => null, (e: Error) => e);
    expect(err).not.toBeNull();
    expect(err!.message).not.toMatch(/ĐÃ BỊ THAY/);
  });

  it("withdrawLamp: không ack ⟹ ném ở cổng policy", async () => {
    await expect(wd()).rejects.toThrow(/\[withdrawLamp\].*ĐÃ BỊ THAY/);
  });
});
