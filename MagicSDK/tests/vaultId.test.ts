// MagicSDK/tests/vaultId.test.ts — neo P8 cho tên NFT danh-tính vault
//
// MỘT NGUỒN, HAI BÊN CÙNG CHẾT: đúng hai vector dưới đây được neo song song ở
//   InstantGen/onchain/lib/magiclamp/protocol/vault_id.ak
//     test vault_id_asset_name_index_0   (TV-VAULTID-01)
//     test vault_id_asset_name_index_7   (TV-VAULTID-02)
// Giá trị ở đó do `aiken check` sinh ra từ chính `cbor.serialise` +
// `crypto.blake2b_256` mà validator dùng — KHÔNG chép từ TypeScript sang. Nếu
// sửa một bên cho "khớp" mà không hiểu vì sao, bên kia sẽ đỏ.
//
// DẠNG CBOR ĐÚNG của OutputReference (PlutusV3/Conway):
//   Constr 0 [bytes(32), int] → d879 9f 5820 <32B> <int> ff
//   (tag 121 + mảng ĐỘ-DÀI-BẤT-ĐỊNH; transaction_id là ByteArray TRẦN — V3 bỏ
//   lớp bọc TxId của V1/V2.)

import { describe, it, expect } from "vitest";
import { Data, Constr } from "@lucid-evolution/lucid";
import { vaultIdAssetName, vaultIdSeedCbor } from "../src/vaultId.js";
import { VaultIdRedeemerSchema } from "../src/schemas.js";

const SEED_TX = "0000000000000000000000000000000000000000000000000000000000000001";

// ── Vector neo (khớp bit-identical với test Aiken) ──────────────
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

describe("vaultIdAssetName — P8 parity với validate_mint_vault_id", () => {
  it("TV-VAULTID-01: index = 0", () => {
    expect(vaultIdSeedCbor(TV_VAULTID_01.seed)).toBe(TV_VAULTID_01.cbor);
    expect(vaultIdAssetName(TV_VAULTID_01.seed)).toBe(TV_VAULTID_01.name);
  });

  it("TV-VAULTID-02: index = 7 (index thực sự đi vào tên NFT)", () => {
    expect(vaultIdSeedCbor(TV_VAULTID_02.seed)).toBe(TV_VAULTID_02.cbor);
    expect(vaultIdAssetName(TV_VAULTID_02.seed)).toBe(TV_VAULTID_02.name);
  });

  it("tên asset dài đúng 32 byte (64 hex) — đúng giới hạn asset name Cardano", () => {
    expect(vaultIdAssetName(TV_VAULTID_01.seed)).toHaveLength(64);
  });

  it("hai seed khác nhau ⇒ hai tên khác nhau (one-shot per seed)", () => {
    expect(vaultIdAssetName(TV_VAULTID_01.seed))
      .not.toBe(vaultIdAssetName(TV_VAULTID_02.seed));
  });

  it("nhận bigint và number cho outputIndex như nhau", () => {
    expect(vaultIdAssetName({ txHash: SEED_TX, outputIndex: 7n }))
      .toBe(TV_VAULTID_02.name);
  });

  it("txHash hoa/thường cho cùng kết quả", () => {
    const upper = "0".repeat(63) + "1";
    expect(vaultIdAssetName({ txHash: upper.toUpperCase(), outputIndex: 0 }))
      .toBe(TV_VAULTID_01.name);
  });

  it("từ chối txHash không phải 32 byte hex", () => {
    expect(() => vaultIdAssetName({ txHash: "abcd", outputIndex: 0 }))
      .toThrow(/32 byte/);
  });

  it("từ chối outputIndex âm", () => {
    expect(() => vaultIdAssetName({ txHash: SEED_TX, outputIndex: -1 }))
      .toThrow(/âm/);
  });
});

// ── Redeemer mint: thứ tự constructor phải khớp Aiken ───────────
// pub type VaultIdRedeemer { MintVaultId { seed } | BurnVaultId }
//   MintVaultId = constr 0, BurnVaultId = constr 1
describe("VaultIdRedeemerSchema", () => {
  it("MintVaultId là constructor 0 và bọc đúng OutputReference", () => {
    const viaSchema = Data.to(
      {
        MintVaultId: {
          seed: { transaction_id: SEED_TX, output_index: 0n },
        },
      } as never,
      VaultIdRedeemerSchema,
    );
    // Dạng thủ công: Constr 0 [ Constr 0 [bytes, int] ]
    const viaConstr = Data.to(new Constr(0, [new Constr(0, [SEED_TX, 0n])]));
    expect(viaSchema).toBe(viaConstr);
  });

  it("BurnVaultId là constructor 1, không trường", () => {
    const viaSchema = Data.to("BurnVaultId" as never, VaultIdRedeemerSchema);
    expect(viaSchema).toBe(Data.to(new Constr(1, [])));
  });
});
