// tests/consume_refscript.test.ts — cổng ref-script CIP-33 của buildConsumeTx.
//
// VÌ SAO CÓ TỆP NÀY: đính kèm cả hai validator vào tx consume cho 17.310 byte ngay ở
// vault RỖNG, vượt trần giao thức 16.384 ⟹ trên chuỗi thật KHÔNG tx consume nào dựng
// nổi bằng đường `attach` (đo của agent A3, 2026-08-17). Đường sống là `readFrom` một
// UTxO ref-script đã đỗ. Nhưng đưa NHẦM UTxO ref-script thì tx chết ở phase-1 với
// "MissingScriptWitness" — thông điệp không nói nhầm cái nào, mà lúc đó đã tốn một
// vòng dựng tx. Nên builder kiểm hash TRƯỚC, nêu đích danh.
//
// KHÔNG cần network: cả ba ca dưới đều rớt trước khi builder chạm tới Lucid.

import { describe, it, expect } from "vitest";
import { validatorToScriptHash, type UTxO, type Validator } from "@lucid-evolution/lucid";
import { buildConsumeTx, type ConsumeParams } from "../offchain/src/consume.js";

// Hai script khác nhau (CBOR hex tuỳ ý, chỉ cần hash ra hai giá trị khác nhau).
const consumeScript: Validator = { type: "PlutusV3", script: "49480100002221200101" };
const vaultScript:   Validator = { type: "PlutusV3", script: "4d4d01000033222220051200120011" };

const mkUtxo = (over: Partial<UTxO>): UTxO => ({
  txHash: "00".repeat(32),
  outputIndex: 0,
  address: "addr_test1wq0000000000000000000000000000000000000000000000000000",
  assets: { lovelace: 2_000_000n },
  ...over,
});

// Chỉ những trường builder đọc TRƯỚC cổng ref-script mới cần thật; phần còn lại là
// chỗ giữ chỗ, vì không ca nào dưới đây đi qua được cổng.
const baseParams = (over: Partial<ConsumeParams>): ConsumeParams =>
  ({
    lucid: {} as ConsumeParams["lucid"],
    engageUtxo: mkUtxo({}),
    vaultUtxo: mkUtxo({ outputIndex: 1 }),
    priceBeaconUtxo: mkUtxo({ outputIndex: 2 }),
    consumeScript,
    vaultScript,
    opType: 1,
    opCount: 1n,
    vaultBurnRedeemerCbor: "d87980",
    vaultOutDatumCbor: "d87980",
    network: "Preview",
    tipPosixMs: 1_700_000_000_000n,
    ...over,
  }) as ConsumeParams;

describe("buildConsumeTx — cổng ref-script CIP-33", () => {
  it("CONSUME-004: UTxO không mang scriptRef bị từ chối, nêu đúng txHash#index", async () => {
    await expect(
      buildConsumeTx(baseParams({ consumeRefUtxo: mkUtxo({ outputIndex: 7 }) })),
    ).rejects.toThrow(/CONSUME-004.*consumeRefUtxo.*#7/s);
  });

  it("CONSUME-005: ref-script mang script KHÁC bị từ chối, in cả hash được và hash cần", async () => {
    // Đưa vault script vào ô consume — đúng ca nhầm lẫn hay gặp nhất khi có HAI
    // UTxO ref-script đỗ cạnh nhau ở cùng một bãi.
    const wrong = mkUtxo({ outputIndex: 3, scriptRef: vaultScript });
    await expect(
      buildConsumeTx(baseParams({ consumeRefUtxo: wrong })),
    ).rejects.toThrow(
      new RegExp(
        `CONSUME-005.*${validatorToScriptHash(vaultScript)}.*${validatorToScriptHash(consumeScript)}`,
        "s",
      ),
    );
  });

  it("ref-script ĐÚNG thì qua cổng — rớt ở bước sau, không rớt ở cổng này", async () => {
    // Cả hai ô đúng script ⟹ cổng im lặng. Ca này phải rớt ở CONSUME-002 (beacon
    // thiếu inline datum), tức là đã đi QUA cổng. Nếu nó rớt bằng CONSUME-004/005
    // thì cổng đang từ chối nhầm hàng thật.
    const ok = baseParams({
      consumeRefUtxo: mkUtxo({ outputIndex: 3, scriptRef: consumeScript }),
      vaultRefUtxo:   mkUtxo({ outputIndex: 4, scriptRef: vaultScript }),
    });
    await expect(buildConsumeTx(ok)).rejects.toThrow(/CONSUME-002/);
  });

  it("bỏ trống cả hai ô (đường attach cũ) cũng qua cổng — tương thích ngược", async () => {
    await expect(buildConsumeTx(baseParams({}))).rejects.toThrow(/CONSUME-002/);
  });
});
