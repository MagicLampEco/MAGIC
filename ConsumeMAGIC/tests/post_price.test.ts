// tests/post_price.test.ts — Nợ #7: cổng của buildPostPriceTx.
//
// Không dựng tx thật (cần Lucid + provider). Kiểm ĐÚNG hai thứ kiểm được thuần tuý:
//   1. bytes redeemer PostPrice — hợp đồng nhị phân, sai là mọi tx bị từ chối;
//   2. mỗi cổng fail-closed có nổ đúng chỗ, vì cổng không nổ = lỗi lộ ra ở ledger
//      dưới dạng thông báo không đọc được, SAU KHI đã tốn phí.

import { describe, it, expect } from "vitest";
import { Data } from "@lucid-evolution/lucid";
import { buildPostPriceTx, postPriceRedeemerCbor } from "../offchain/src/postPrice.js";
import { PriceParamRedeemerSchema, encodePriceParam } from "../offchain/src/types.js";
import type { PriceParamT } from "../offchain/src/types.js";
import { M_MIN_Q, M_MAX_Q, Q } from "@magiclamp/consumemagic-pricing";

// ── 1. Hợp đồng nhị phân của redeemer ────────────────────────────────────────

describe("PostPrice redeemer", () => {
  it("là Constr(0,[]) = d87980", () => {
    expect(postPriceRedeemerCbor()).toBe("d87980");
  });

  it("🔴 schema literal-enum KHÔNG dùng để mã hoá được — Data.void() mới là đường thật", () => {
    // Đo trên @lucid-evolution/lucid 0.4.30: `Data.to("PostPrice", PriceParamRedeemerSchema)`
    // NÉM "Could not type cast to void". Data.Enum một variant không field bị lucid quy về
    // dạng void và đường cast vỡ. Nên `PriceParamRedeemerSchema` (và `NftRedeemerSchema`
    // cùng hình dạng) chỉ là bản KHAI BÁO cho người đọc, không phải bộ mã hoá dùng được.
    // Ghim lại để ai thấy schema mà tưởng nó dùng được thì đỏ ở đây, chứ không đỏ ở ledger.
    expect(() =>
      Data.to("PostPrice", PriceParamRedeemerSchema as unknown as "PostPrice"),
    ).toThrow(/Could not type cast/);
  });
});

// ── 2. Cổng fail-closed ──────────────────────────────────────────────────────

const NFT = "aa".repeat(28) + "5052494345"; // policy(28B) + "PRICE"
const MSPE_PREPROD = 86_400_000n;

const oldDatum: PriceParamT = {
  op_prices: [
    { op_type: 1n, base_price: 10_000_000n },
    { op_type: 2n, base_price: 1_000_000n },
  ],
  demand_mult: Q,
  m_min: M_MIN_Q,
  m_max: M_MAX_Q,
  epoch: 100n,
};

function beacon(over: Record<string, unknown> = {}) {
  return {
    txHash: "bb".repeat(32),
    outputIndex: 0,
    address: "addr_test1wq" + "q".repeat(50),
    assets: { lovelace: 5_000_000n, [NFT]: 1n },
    datum: encodePriceParam(oldDatum),
    ...over,
  };
}

function params(over: Record<string, unknown> = {}) {
  return {
    lucid: {},
    priceBeaconUtxo: beacon(),
    priceParamScript: { type: "PlutusV3", script: "aabb" },
    priceNftUnit: NFT,
    newOpPrices: oldDatum.op_prices,
    newDemandMult: Q,
    committeeSignerKeyHashes: ["c1".repeat(14), "c2".repeat(14)],
    threshold: 2,
    network: "Preprod",
    tipPosixMs: 101n * MSPE_PREPROD + 1_000n, // epoch hiện tại 101 > epoch cũ 100
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("cổng buildPostPriceTx", () => {
  it("POSTPRICE-001 threshold ≤ 0", async () => {
    await expect(buildPostPriceTx(params({ threshold: 0 }))).rejects.toThrow(/POSTPRICE-001/);
  });

  it("POSTPRICE-002 khoá ký trùng — một người đếm thành hai", async () => {
    const k = "c1".repeat(14);
    await expect(
      buildPostPriceTx(params({ committeeSignerKeyHashes: [k, k] })),
    ).rejects.toThrow(/POSTPRICE-002/);
  });

  it("POSTPRICE-003 thiếu ngưỡng chữ ký", async () => {
    await expect(
      buildPostPriceTx(params({ committeeSignerKeyHashes: ["c1".repeat(14)] })),
    ).rejects.toThrow(/POSTPRICE-003/);
  });

  it("POSTPRICE-004 UTxO không mang price NFT", async () => {
    await expect(
      buildPostPriceTx(params({ priceBeaconUtxo: beacon({ assets: { lovelace: 5_000_000n } }) })),
    ).rejects.toThrow(/POSTPRICE-004/);
  });

  it("POSTPRICE-005 epoch không tăng (post lại trong cùng epoch)", async () => {
    await expect(
      buildPostPriceTx(params({ tipPosixMs: 100n * MSPE_PREPROD + 1_000n })),
    ).rejects.toThrow(/POSTPRICE-005/);
  });

  it("POSTPRICE-006 epoch tương lai = khoá beacon vĩnh viễn", async () => {
    await expect(buildPostPriceTx(params({ overrideEpoch: 999_999n }))).rejects.toThrow(
      /POSTPRICE-006/,
    );
  });

  it("POSTPRICE-007 op_type không tăng ngặt", async () => {
    await expect(
      buildPostPriceTx(
        params({
          newOpPrices: [
            { op_type: 2n, base_price: 1_000_000n },
            { op_type: 1n, base_price: 10_000_000n },
          ],
        }),
      ),
    ).rejects.toThrow(/POSTPRICE-007/);
  });

  it("POSTPRICE-007 chặn base_price làm giá sập về 0", async () => {
    // base × m_min < Q ⇒ giá một đơn vị làm tròn về 0 ⇒ rút dịch vụ miễn phí.
    await expect(
      buildPostPriceTx(params({ newOpPrices: [{ op_type: 1n, base_price: 1n }] })),
    ).rejects.toThrow(/POSTPRICE-007/);
  });

  it("POSTPRICE-009 top-up âm = bào mòn ADA của beacon", async () => {
    await expect(buildPostPriceTx(params({ topUpLovelace: -1n }))).rejects.toThrow(
      /POSTPRICE-009/,
    );
  });

  it("POSTPRICE-010 beacon không có inline datum", async () => {
    await expect(
      buildPostPriceTx(params({ priceBeaconUtxo: beacon({ datum: null }) })),
    ).rejects.toThrow(/POSTPRICE-010/);
  });
});
