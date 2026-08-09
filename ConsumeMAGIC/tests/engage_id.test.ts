// tests/engage_id.test.ts — P8 cho TÊN thread NFT Engage.
//
// ⚠ NEO GỐC KHÔNG NẰM Ở ĐÂY. Hai vector dưới là BẢN CHÉP CÓ NHÃN của
//   `MagicSDK/tests/vaultId.test.ts` (TV-VAULTID-01 / TV-VAULTID-02), mà chính nó
//   neo song song vào test Aiken
//   `InstantGen/onchain/lib/magiclamp/protocol/vault_id.ak`
//     test vault_id_asset_name_index_0
//     test vault_id_asset_name_index_7
//   Giá trị gốc do `aiken check` sinh ra từ chính `cbor.serialise` +
//   `crypto.blake2b_256` mà validator dùng — KHÔNG chép ngược từ TypeScript.
//
//   ⇒ SỬA MỘT SỐ Ở ĐÂY LÀ SAI. Nếu tệp này đỏ, đi đọc hai nguồn trên trước.
//
// VÌ SAO ConsumeMAGIC dùng CÙNG vector với vault: `validate_mint_engage_id`
// (ConsumeMAGIC/onchain/validators/consume.ak) là bản song sinh của
// `validate_mint_vault_id` — cùng công thức `blake2b_256(cbor.serialise(seed))` trên
// cùng kiểu `OutputReference`. Cùng input ⇒ BẮT BUỘC cùng output. Nếu bản sao
// `offchain/src/engageId.ts` trôi khỏi `MagicSDK/src/vaultId.ts`, tệp này đỏ trước
// khi ai đó kịp submit một tx mint hỏng.

import { describe, it, expect } from "vitest";
import { engageAssetName, engageSeedCbor, engageNftUnit } from "../offchain/src/engageId.js";

const SEED_TX = "0000000000000000000000000000000000000000000000000000000000000001";

// ── Vector CHÉP (nhãn + con trỏ ở đầu tệp) ─────────────────────
const TV_VAULTID_01 = {
  seed: { txHash: SEED_TX, outputIndex: 0 },
  cbor: "d8799f5820000000000000000000000000000000000000000000000000000000000000000100ff",
  name: "d7fe829bc1202d4b45654a9f8d017ed3132639e28f419564a348a8c62e627ac9",
};
const TV_VAULTID_02 = {
  seed: { txHash: SEED_TX, outputIndex: 7 },
  cbor: "d8799f5820000000000000000000000000000000000000000000000000000000000000000107ff",
  name: "2a3c0cc4d3dc51fe9c02e68a1681b80f9fb29f8f05fcc855f7a466476c361bc8",
};

describe("engageAssetName — P8 với validate_mint_engage_id", () => {
  it("TV-VAULTID-01 (chép): index = 0 — CBOR trung gian + hash", () => {
    // Kiểm CBOR RIÊNG: hash trùng mà CBOR khác là trùng-hợp che lỗi.
    expect(engageSeedCbor(TV_VAULTID_01.seed)).toBe(TV_VAULTID_01.cbor);
    expect(engageAssetName(TV_VAULTID_01.seed)).toBe(TV_VAULTID_01.name);
  });

  it("TV-VAULTID-02 (chép): index = 7 — index thực sự đi vào tên NFT", () => {
    expect(engageSeedCbor(TV_VAULTID_02.seed)).toBe(TV_VAULTID_02.cbor);
    expect(engageAssetName(TV_VAULTID_02.seed)).toBe(TV_VAULTID_02.name);
  });

  it("CBOR là Constr 0 + mảng ĐỘ-DÀI-BẤT-ĐỊNH (PlutusV3, KHÔNG bọc TxId của V1/V2)", () => {
    const cbor = engageSeedCbor(TV_VAULTID_01.seed);
    expect(cbor.startsWith("d8799f")).toBe(true); // tag 121 + 0x9f
    expect(cbor.endsWith("ff")).toBe(true); // break
    expect(cbor.slice(6, 10)).toBe("5820"); // bytes(32) TRẦN, không lồng Constr
  });

  it("tên asset dài đúng 32 byte (64 hex) — đúng giới hạn asset name Cardano", () => {
    expect(engageAssetName(TV_VAULTID_01.seed)).toHaveLength(64);
  });

  it("hai seed khác nhau ⇒ hai tên khác nhau (N thread / 1 policy, one-shot per seed)", () => {
    expect(engageAssetName(TV_VAULTID_01.seed)).not.toBe(engageAssetName(TV_VAULTID_02.seed));
  });

  it("KHÔNG còn là hằng '454e47' (ENG) của mô hình engage_nft.ak cũ", () => {
    expect(engageAssetName(TV_VAULTID_01.seed)).not.toBe("454e47");
  });

  it("nhận bigint và number cho outputIndex như nhau", () => {
    expect(engageAssetName({ txHash: SEED_TX, outputIndex: 7n })).toBe(TV_VAULTID_02.name);
  });

  it("txHash hoa/thường cho cùng kết quả", () => {
    const upper = ("0".repeat(63) + "1").toUpperCase();
    expect(engageAssetName({ txHash: upper, outputIndex: 0 })).toBe(TV_VAULTID_01.name);
  });

  it("từ chối txHash không phải 32 byte hex (ENGAGE-ID-001)", () => {
    expect(() => engageAssetName({ txHash: "abcd", outputIndex: 0 })).toThrow(/ENGAGE-ID-001/);
  });

  it("từ chối outputIndex âm (ENGAGE-ID-002)", () => {
    expect(() => engageAssetName({ txHash: SEED_TX, outputIndex: -1 })).toThrow(/ENGAGE-ID-002/);
  });
});

describe("engageNftUnit — policy PHẢI là script hash consume (tự tham chiếu)", () => {
  const consumeHash = "aa".repeat(28); // 28 byte

  it("unit = consumeScriptHash ++ blake2b_256(cbor(seed))", () => {
    expect(engageNftUnit(consumeHash, TV_VAULTID_01.seed))
      .toBe(consumeHash + TV_VAULTID_01.name);
  });

  it("từ chối hash sai độ dài (ENGAGE-ID-003) — policy khác = thread không tiêu được", () => {
    expect(() => engageNftUnit("deadbeef", TV_VAULTID_01.seed)).toThrow(/ENGAGE-ID-003/);
  });
});
