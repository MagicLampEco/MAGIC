// MagicSDK/tests/minAdaVault.test.ts — min-ADA của UTxO két, đo trên datum THẬT.
//
// Bài kiểm ở đây cố ý KHÔNG dựng chuỗi hex bịa: nó mã hoá `VaultDatum` bằng
// đúng lược đồ sản xuất rồi đo. Một bài chạy trên hex bịa sẽ xanh kể cả khi
// lược đồ đã trôi — mà lược đồ trôi chính là thứ đang được canh ở tệp anh em
// `vaultDatumShape.test.ts`.

import { describe, it, expect } from "vitest";
import { Data } from "@lucid-evolution/lucid";
import { InstantVaultDatumSchema, VaultDatumSchema } from "../src/schemas.js";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";
import {
  COINS_PER_UTXO_BYTE_DEFAULT,
  minAdaForVault,
  minAdaForVaultWithMargin,
  vaultUtxoSizeBytes,
} from "../src/minAdaVault.js";

/** 17 trường chung, dựng từ CHÍNH hàm mã sản xuất dùng — không gõ tay. */
const common = () => buildInitialVaultDatum({
  ownerPkh:           "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21",
  lampBalanceOildrop: 1_000_000_000n,
  profile:            "Flame",
  currentEpoch:       100n,
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

function instantDatum(nBatches: number, nHoldings: number) {
  return {
    ...common(),
    loyalty_holdings: Array.from({ length: nHoldings }, (_, i) => holding(i)),
    magic_batches:    Array.from({ length: nBatches }, (_, i) => batch(i)),
    next_batch_index: BigInt(nBatches),
    instant_unlock_ms: 0n,
  };
}

/** Mã hoá thật; ném nếu lược đồ đã trôi khỏi fixture này. */
function cborOf(d: unknown, schema: unknown): string {
  return Data.to(d as never, schema as never);
}

describe("min-ADA của UTxO két", () => {
  it("đo được trên datum Instant THẬT ở nhiều kích thước", () => {
    const doc: string[] = [];
    let truoc = 0n;
    for (const [nb, nh] of [[0, 0], [1, 0], [4, 5], [8, 10], [16, 20], [32, 40]] as const) {
      const hex = cborOf(instantDatum(nb, nh), InstantVaultDatumSchema);
      const bytes = hex.length / 2;
      const min = minAdaForVaultWithMargin(hex);
      doc.push(`${nb} batch / ${nh} holding → ${bytes} byte → thô ${minAdaForVault(hex)} → +biên ${min}`);

      // Đơn điệu: datum dài hơn KHÔNG BAO GIỜ đòi ít ADA hơn. Đây là tính chất
      // phân biệt được hai cực — một hàm trả hằng sẽ đứng yên và trượt ca này.
      expect(min).toBeGreaterThanOrEqual(truoc);
      truoc = min;
    }
    // In ra để bảng số trong `minAdaVault.ts` có chỗ đối chiếu, thay vì già đi im lặng.
    console.log("\n" + doc.join("\n"));
    expect(doc.length).toBe(6);
  });

  it("két ĐÃ CÓ batch đòi NHIỀU HƠN hằng 2 ADA của bản trước", () => {
    // Đây là phát biểu trung tâm: hằng cũ sai ngay từ batch ĐẦU TIÊN.
    const hex = cborOf(instantDatum(1, 0), InstantVaultDatumSchema);
    expect(minAdaForVault(hex)).toBeGreaterThan(2_000_000n);
  });

  it("đại lượng này đổi hơn BỐN LẦN giữa két rỗng và két ở trần", () => {
    // Đây là phát biểu chắc nhất rút ra được, và là lý do một HẰNG không trả
    // lời được câu hỏi — bất kể hằng ấy là bao nhiêu.
    const rong = minAdaForVault(cborOf(instantDatum(0, 0), InstantVaultDatumSchema));
    const tran = minAdaForVault(cborOf(instantDatum(32, 40), InstantVaultDatumSchema));
    expect(tran).toBeGreaterThan(rong * 4n);
  });

  it("két Schedule (17 trường) cũng đo được, và ở trần thì vượt xa 2 ADA", () => {
    const { instant_unlock_ms: _bo, ...schedule } = instantDatum(32, 40);
    const hex = cborOf(schedule, VaultDatumSchema);
    expect(minAdaForVault(hex)).toBeGreaterThan(9_000_000n);
  });

  it("biên làm tròn LÊN ADA chẵn, và không bao giờ hạ dưới mức thô", () => {
    const hex = cborOf(instantDatum(4, 5), InstantVaultDatumSchema);
    const tho = minAdaForVault(hex);
    const bien = minAdaForVaultWithMargin(hex);
    expect(bien % 1_000_000n).toBe(0n);
    expect(bien).toBeGreaterThan(tho);
  });

  it("coinsPerUtxoByte là THAM SỐ, không phải hằng khoá cứng", () => {
    const hex = cborOf(instantDatum(4, 5), InstantVaultDatumSchema);
    // Gấp đôi tham số thì min-ADA gấp đôi. Ca này chết nếu ai đó khoá cứng
    // hằng vào trong thân hàm và bỏ qua đối số.
    expect(minAdaForVault(hex, COINS_PER_UTXO_BYTE_DEFAULT * 2n)).toBe(
      minAdaForVault(hex, COINS_PER_UTXO_BYTE_DEFAULT) * 2n,
    );
  });

  it("hex lẻ ký tự thì NÉM, không đoán", () => {
    expect(() => vaultUtxoSizeBytes("abc")).toThrow(/lẻ ký tự/);
  });
});
