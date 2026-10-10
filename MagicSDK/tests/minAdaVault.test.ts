// MagicSDK/tests/minAdaVault.test.ts — min-ADA CHÍNH XÁC của output két, đo trên datum THẬT.
//
// Bài kiểm ở đây cố ý KHÔNG dựng chuỗi hex bịa: nó mã hoá `VaultDatum` bằng đúng lược đồ sản xuất
// rồi đo. Một bài chạy trên hex bịa sẽ xanh kể cả khi lược đồ đã trôi — mà lược đồ trôi chính là
// thứ đang được canh ở tệp anh em `vaultDatumShape.test.ts`.
//
// Trọng tài là CÔNG THỨC sổ cái, không phải chính hàm CML mà mã dùng: dựng output với đúng lovelace
// trả về (`with_value`), đếm byte CBOR, so `coinsPerUtxoByte × (160 + byte)`. Cặp ca: lovelace trả
// về THOẢ công thức, lovelace trừ 1 thì KHÔNG — tức nó là giá trị NHỎ NHẤT, không chỉ là một giá trị
// đủ (một hàm cộng biên xanh vế đầu và đỏ vế sau).
//
// 2026-10-10: bỏ năm bài ghim hành vi CŨ (`minAdaForVault` / `minAdaForVaultWithMargin` /
// `vaultUtxoSizeBytes` — ước chặn trên, biên 20%, làm tròn LÊN ADA chẵn) vì cả ba hàm đã gỡ khỏi
// `minAdaVault.ts`. Ba tính chất còn đúng được viết lại trên hàm chính xác: đơn điệu theo số
// batch, "hằng 2 ADA thiếu từ batch đầu", và `coinsPerUtxoByte` là tham số. Bài "biên làm tròn LÊN
// ADA chẵn" bỏ hẳn — đó chính là hành vi đã bị bác (trượt luật L28 của hàng rào phí). Bài "hex lẻ
// ký tự thì NÉM" giữ, chuyển sang hàm mới.

import { describe, it, expect } from "vitest";
import {
  CML, Data, assetsToValue, credentialToAddress, scriptHashToCredential, type Assets,
} from "@lucid-evolution/lucid";
import { InstantVaultDatumSchema, VaultDatumSchema } from "../src/schemas.js";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";
import {
  COINS_PER_UTXO_BYTE_DEFAULT, coinsPerUtxoByteOf, exactMinAdaForVaultOutput,
} from "../src/minAdaVault.js";

const VAULT_HASH = "1bc65c005cde71bee2ea21d5b3391954de610470e843c36bda851ddb";
const ADDR_ENTERPRISE = credentialToAddress("Preprod", scriptHashToCredential(VAULT_HASH));
const ADDR_BASE = credentialToAddress("Preprod", scriptHashToCredential(VAULT_HASH), { type: "Key", hash: "5e".repeat(28) });
const LAMP_UNIT = "493002cc03004e3e14fd607cfba59312bd946e478e69d6ab431ccfac744c414d50";
const NFT = VAULT_HASH + "ab".repeat(32);

/** Datum genesis Gen v2.0 (Instant 20 trường / Schedule 19), dựng từ CHÍNH hàm mã sản xuất dùng. */
const genesis = (vaultType: "Instant" | "Schedule") => buildInitialVaultDatum({
  ownerPkh:           "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21",
  lampBalanceOildrop: 1_000_000_000n,
  profile:            "Flame",
  currentEpoch:       100n,
  vaultType,
});

function batch(i: number) {
  return {
    batch_id:            i.toString(16).padStart(6, "0"),
    source:              "Instant",
    created_epoch:       100n,
    initial_amount:      3_900_000_000n,
    current_amount:      3_900_000_000n,
    decay_window:        1n,
    profile_at_creation: null,
    contract_id:         null,
    halved:              false,
  };
}

const holding = (i: number) =>
  ({ amount: 1_000_000n * BigInt(i + 1), acquired_epoch: 90n + BigInt(i), is_locked: false });

function sized(vaultType: "Instant" | "Schedule", nBatches: number, nHoldings: number) {
  return {
    ...genesis(vaultType),
    loyalty_holdings: Array.from({ length: nHoldings }, (_, i) => holding(i)),
    magic_batches:    Array.from({ length: nBatches }, (_, i) => batch(i)),
    next_batch_index: BigInt(nBatches),
  };
}

const cborOf = (d: unknown, schema: unknown): string => Data.to(d as never, schema as never);

/** Công thức sổ cái trên output dựng với ĐÚNG `lovelace`: coinsPerUtxoByte × (160 + byte CBOR). */
function ledgerMin(address: string, tokens: Assets, datumHex: string, lovelace: bigint, cpub: bigint): bigint {
  const out = CML.TransactionOutputBuilder.new()
    .with_address(CML.Address.from_bech32(address))
    .with_data(CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(datumHex)))
    .next()
    .with_value(assetsToValue({ ...tokens, lovelace }))
    .build().output();
  return cpub * (160n + BigInt(out.to_cbor_bytes().length));
}

const tokens = { [LAMP_UNIT]: 1_000_000_000n, [NFT]: 1n };

describe("exactMinAdaForVaultOutput — min-ADA chính xác của output két", () => {
  it.each([["enterprise", ADDR_ENTERPRISE], ["base", ADDR_BASE]])(
    "địa chỉ %s: là giá trị NHỎ NHẤT thoả công thức sổ cái (đủ ở m, thiếu ở m − 1), đơn điệu theo số batch",
    (_shape, addr) => {
      const doc: string[] = [];
      let prev = 0n;
      for (const [nb, nh] of [[0, 0], [1, 0], [4, 5], [8, 10], [16, 20], [32, 40]] as const) {
        const hex = cborOf(sized("Instant", nb, nh), InstantVaultDatumSchema);
        const m = exactMinAdaForVaultOutput({ address: addr, datumCborHex: hex, tokens, coinsPerUtxoByte: 4310n });
        expect(ledgerMin(addr, tokens, hex, m, 4310n)).toBeLessThanOrEqual(m);
        expect(ledgerMin(addr, tokens, hex, m - 1n, 4310n)).toBeGreaterThan(m - 1n);
        // Đơn điệu: một hàm trả hằng đứng yên và trượt ca này.
        expect(m).toBeGreaterThan(prev);
        prev = m;
        doc.push(`${nb} batch / ${nh} holding → datum ${hex.length / 2} B → min ${m}`);
      }
      console.log("\n" + doc.join("\n"));
    });

  it("két ĐÃ CÓ batch đòi NHIỀU HƠN hằng 2 ADA của bản đầu", () => {
    const hex = cborOf(sized("Instant", 1, 0), InstantVaultDatumSchema);
    expect(exactMinAdaForVaultOutput({ address: ADDR_ENTERPRISE, datumCborHex: hex, tokens, coinsPerUtxoByte: 4310n }))
      .toBeGreaterThan(2_000_000n);
  });

  it("két Schedule (19 trường) ở trần đòi hơn BỐN LẦN két Schedule rỗng — một HẰNG không trả lời được câu hỏi này", () => {
    // Ngưỡng cũ "> 9 ADA" đo trên ước chặn trên đã gỡ; min chính xác ở trần là ~8,9 ADA. Tính chất
    // giữ lại là TỶ LỆ, không phải một con số: nó không già đi theo phép đếm byte.
    const at = (nb: number, nh: number) => exactMinAdaForVaultOutput({
      address: ADDR_ENTERPRISE, datumCborHex: cborOf(sized("Schedule", nb, nh), VaultDatumSchema), tokens, coinsPerUtxoByte: 4310n,
    });
    expect(at(32, 40)).toBeGreaterThan(at(0, 0) * 4n);
  });

  it("coinsPerUtxoByte là THAM SỐ: đổi nó thì kết quả đổi, và vẫn là min chính xác ở tham số mới", () => {
    const hex = cborOf(sized("Instant", 4, 5), InstantVaultDatumSchema);
    const a = exactMinAdaForVaultOutput({ address: ADDR_ENTERPRISE, datumCborHex: hex, tokens, coinsPerUtxoByte: 4310n });
    const b = exactMinAdaForVaultOutput({ address: ADDR_ENTERPRISE, datumCborHex: hex, tokens, coinsPerUtxoByte: 8620n });
    expect(b).not.toBe(a);
    expect(ledgerMin(ADDR_ENTERPRISE, tokens, hex, b, 8620n)).toBeLessThanOrEqual(b);
    expect(ledgerMin(ADDR_ENTERPRISE, tokens, hex, b - 1n, 8620n)).toBeGreaterThan(b - 1n);
  });

  it("hex rỗng / lẻ ký tự ⟹ NÉM; `tokens` mang lovelace ⟹ NÉM", () => {
    const base = { address: ADDR_ENTERPRISE, tokens, coinsPerUtxoByte: 4310n };
    expect(() => exactMinAdaForVaultOutput({ ...base, datumCborHex: "abc" })).toThrow(/lẻ ký tự/);
    expect(() => exactMinAdaForVaultOutput({ ...base, datumCborHex: "" })).toThrow(/rỗng/);
    const hex = cborOf(genesis("Instant"), InstantVaultDatumSchema);
    expect(() => exactMinAdaForVaultOutput({ ...base, datumCborHex: hex, tokens: { ...tokens, lovelace: 1n } }))
      .toThrow(/lovelace/);
  });
});

describe("coinsPerUtxoByteOf — nguồn tham số giao thức", () => {
  it("Lucid mang tham số ⟹ dùng nó (bigint hoặc số nguyên an toàn)", () => {
    expect(coinsPerUtxoByteOf({ config: () => ({ protocolParameters: { coinsPerUtxoByte: 4311n } }) }))
      .toEqual({ coinsPerUtxoByte: 4311n, source: "lucid" });
    expect(coinsPerUtxoByteOf({ config: () => ({ protocolParameters: { coinsPerUtxoByte: 4312 } }) }))
      .toEqual({ coinsPerUtxoByte: 4312n, source: "lucid" });
  });

  it("Lucid KHÔNG mang tham số (không `config`, hoặc `protocolParameters` vắng) ⟹ hằng bản sao, nói rõ nguồn", () => {
    expect(coinsPerUtxoByteOf({})).toEqual({ coinsPerUtxoByte: COINS_PER_UTXO_BYTE_DEFAULT, source: "default" });
    expect(coinsPerUtxoByteOf({ config: () => ({}) })).toEqual({ coinsPerUtxoByte: COINS_PER_UTXO_BYTE_DEFAULT, source: "default" });
  });

  it.each([["0", 0n], ["âm", -1n], ["chuỗi", "4310"], ["số lẻ", 4310.5], ["vắng trường", undefined]])(
    "tham số CÓ mà hình dạng lạ (%s) ⟹ NÉM, không đệm bằng hằng", (_n, v) => {
      expect(() => coinsPerUtxoByteOf({ config: () => ({ protocolParameters: { coinsPerUtxoByte: v } }) }))
        .toThrow(/hình dạng lạ/);
    });
});
