// tests/bind_did.test.ts — cổng VÀO của `buildBindDidTx` (offchain/src/consume.ts).
//
// Mọi ca ở đây ném TRƯỚC khi builder chạm tới Lucid, nên không cần network: đó chính
// là điều đang được kiểm. Cổng off-chain tồn tại để lỗi hiện kèm LÝ DO ở máy người
// dùng, thay vì tx nộp lên rồi chết phase-2 sau khi collateral đã mất — lúc đó thông
// điệp ledger không nhắc gì tới did_commit.
//
// Gương on-chain (ConsumeMAGIC/onchain/validators/consume.ak):
//   validate_bind_did — `in_datum.did_commit == #""` · chữ ký owner · #in==#out==1 ·
//   value bảo toàn · mọi trường khác bảo toàn · did mới khác rỗng và đúng 32 byte.

import { describe, it, expect } from "vitest";
import type { UTxO, LucidEvolution, Validator } from "@lucid-evolution/lucid";
import { buildBindDidTx, DID_COMMIT_BYTES } from "../offchain/src/consume.js";
import { encodeEngageDatum, type EngageDatumT } from "../offchain/src/types.js";

/** did_commit đúng khuôn 32 byte. */
const DID_32 = "d1".repeat(32);
const DID_32_B = "c2".repeat(32);

/** Script giả — chỉ cần đúng hình dạng Validator để `validatorToScriptHash` chạy. */
const SCRIPT: Validator = {
  type: "PlutusV3",
  script:
    "5901a4010000323232323232323222232325333008323232533300b002100114a06644646600200200644a66602200229404c8c94ccc040cdc78010028a5113330050050010033016003375c60280046eb0c038c03cc03cc03cc03cc03cc03cc03cc03cc020c8c94ccc02ccdc3a400000226464a66602060260042930b1bae301100130090021533300b3370e900100089919299980818098010a4c2c6eb8c044004c024008c024004dd5000ab9a5573aaae7955cfaba15745",
};

/** Engage UTxO: assets do người gọi khai (để bẻ ca thread NFT). */
function engageUtxo(
  datum: EngageDatumT | undefined,
  assets: Record<string, bigint>,
): UTxO {
  return {
    txHash: "00".repeat(32),
    outputIndex: 0,
    address: "addr_test1wq0000000000000000000000000000000000000000000000000000",
    assets: { lovelace: 2_000_000n, ...assets },
    datum: datum === undefined ? undefined : encodeEngageDatum(datum),
  } as UTxO;
}

const OWNER = "0b".repeat(28);

const cleanDatum: EngageDatumT = {
  owner: OWNER,
  consumed_count: 7n,
  last_epoch: 3n,
  did_commit: "",
  consumed_nanogic: 70_000_000n,
};

/** Lucid KHÔNG được chạm tới trong mọi ca dưới đây — dùng `undefined` cố ý. */
const NO_LUCID = undefined as unknown as LucidEvolution;

describe("buildBindDidTx — khuôn did_commit", () => {
  it("từ chối did rỗng (BIND-DID-001) — 'gắn' bằng chuỗi rỗng là no-op", async () => {
    await expect(
      buildBindDidTx({
        lucid: NO_LUCID,
        engageUtxo: engageUtxo(cleanDatum, {}),
        consumeScript: SCRIPT,
        didCommit: "",
      }),
    ).rejects.toThrow(/BIND-DID-001/);
  });

  it("từ chối 31 byte (biên dưới)", async () => {
    await expect(
      buildBindDidTx({
        lucid: NO_LUCID,
        engageUtxo: engageUtxo(cleanDatum, {}),
        consumeScript: SCRIPT,
        didCommit: "d1".repeat(31),
      }),
    ).rejects.toThrow(/BIND-DID-001/);
  });

  it("từ chối 33 byte (biên trên)", async () => {
    await expect(
      buildBindDidTx({
        lucid: NO_LUCID,
        engageUtxo: engageUtxo(cleanDatum, {}),
        consumeScript: SCRIPT,
        didCommit: "d1".repeat(33),
      }),
    ).rejects.toThrow(/BIND-DID-001/);
  });

  it("từ chối chuỗi không phải hex", async () => {
    await expect(
      buildBindDidTx({
        lucid: NO_LUCID,
        engageUtxo: engageUtxo(cleanDatum, {}),
        consumeScript: SCRIPT,
        didCommit: "z".repeat(64),
      }),
    ).rejects.toThrow(/BIND-DID-001/);
  });

  it("hằng DID_COMMIT_BYTES khớp khuôn on-chain (32)", () => {
    expect(DID_COMMIT_BYTES).toBe(32);
    expect(DID_32.length).toBe(DID_COMMIT_BYTES * 2);
  });
});

describe("buildBindDidTx — MỘT CHIỀU, ĐÚNG MỘT LẦN", () => {
  it("từ chối thread ĐÃ gắn DID (BIND-DID-003)", async () => {
    await expect(
      buildBindDidTx({
        lucid: NO_LUCID,
        engageUtxo: engageUtxo({ ...cleanDatum, did_commit: DID_32 }, {}),
        consumeScript: SCRIPT,
        didCommit: DID_32_B,
      }),
    ).rejects.toThrow(/BIND-DID-003/);
  });

  it("từ chối ghi lại CHÍNH giá trị cũ — không nới cổng cho ca no-op", async () => {
    await expect(
      buildBindDidTx({
        lucid: NO_LUCID,
        engageUtxo: engageUtxo({ ...cleanDatum, did_commit: DID_32 }, {}),
        consumeScript: SCRIPT,
        didCommit: DID_32,
      }),
    ).rejects.toThrow(/BIND-DID-003/);
  });
});

describe("buildBindDidTx — điều kiện UTxO", () => {
  it("từ chối engage UTxO thiếu inline datum (BIND-DID-002)", async () => {
    await expect(
      buildBindDidTx({
        lucid: NO_LUCID,
        engageUtxo: engageUtxo(undefined, {}),
        consumeScript: SCRIPT,
        didCommit: DID_32,
      }),
    ).rejects.toThrow(/BIND-DID-002/);
  });

  it("từ chối UTxO không mang thread NFT dưới policy == hash(consume) (CONSUME-006)", async () => {
    // Ai cũng gửi được UTxO tới địa chỉ script; thứ phân biệt thread THẬT với UTxO
    // giả là thread NFT, y như cổng định danh của nhánh consume.
    await expect(
      buildBindDidTx({
        lucid: NO_LUCID,
        engageUtxo: engageUtxo(cleanDatum, {}),
        consumeScript: SCRIPT,
        didCommit: DID_32,
      }),
    ).rejects.toThrow(/CONSUME-006/);
  });
});
