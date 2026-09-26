// tests/consume_vault_owner.test.ts — cổng CHỦ VAULT == CHỦ THREAD của buildConsumeTx.
//
// VÌ SAO CÓ TỆP NÀY: bản vá 2026-09-15 hạ cổng quyền ghi của `consume.ak` xuống MỘT vế
// vô điều kiện — mọi vault bị đốt phải thuộc chủ thread (`all_vault_owners_are`). Vế
// `|| chữ ký chủ thread` không còn. Nên hình dạng "vault của khoá A, thread của khoá B"
// bị từ chối 100%, và một tx như thế nộp lên chỉ để mất collateral: nó chết ở phase-2
// với một thông điệp không nhắc gì tới chủ vault.
//
// Builder phải nói ra điều đó LÚC DỰNG, kèm chỉ dẫn hành động — đó là CONSUME-010.
//
// KHÔNG cần network: mọi ca dưới đây rớt trước khi builder chạm tới Lucid.

import { describe, it, expect } from "vitest";
import { Constr, Data, type UTxO, type Validator } from "@lucid-evolution/lucid";
import { buildConsumeTx, type ConsumeParams } from "../offchain/src/consume.js";
import { encodeEngageDatum, encodePriceParam, type EngageDatumT } from "../offchain/src/types.js";

const consumeScript: Validator = { type: "PlutusV3", script: "49480100002221200101" };
const vaultScript:   Validator = { type: "PlutusV3", script: "4d4d01000033222220051200120011" };

const OWNER_THREAD = "0b".repeat(28);
const OWNER_VAULT  = "de".repeat(28);

// Bảng giá hợp lệ tối thiểu (mirror `valid_param`): op_type tăng ngặt, m_min/m_max pin,
// base_price × m_min ≥ Q. Beacon phải qua `assertValidPriceParam` TRƯỚC cổng đang đo,
// nếu không ca sẽ chết sớm và không đo gì.
// CC-LOAD-COUNT-UNIT (2026-09-25): `demand_mult` nay là trường THỨ BA của MỖI DÒNG.
const priceDatum = encodePriceParam({
  op_prices: [{ op_type: 1n, base_price: 10_000_000n, demand_mult: 1_000_000_000n }],
  m_min: 500_000_000n,
  m_max: 2_000_000_000n,
  epoch: 0n,
});

const engageDatum = (owner: string): string =>
  encodeEngageDatum({
    owner: { VerificationKey: [owner] },
    consumed_count: 0n,
    last_epoch: 0n,
    did_commit: "",
    consumed_nanogic: 0n,
  } satisfies EngageDatumT);

/** Datum vault ở đúng hình dạng mà `all_vault_owners_are` đọc: Constr(_, [owner, ..]),
 *  `owner` là `Credential` — tag 0 khoá, tag 1 script. */
const vaultDatum = (owner: string, tag: 0 | 1 = 0): string =>
  Data.to(new Constr(0, [new Constr(tag, [owner]), 0n]));

const mkUtxo = (over: Partial<UTxO>): UTxO => ({
  txHash: "00".repeat(32),
  outputIndex: 0,
  address: "addr_test1wq0000000000000000000000000000000000000000000000000000",
  assets: { lovelace: 2_000_000n },
  ...over,
});

const baseParams = (over: Partial<ConsumeParams>): ConsumeParams =>
  ({
    lucid: {} as ConsumeParams["lucid"],
    engageUtxo: mkUtxo({ datum: engageDatum(OWNER_THREAD) }),
    vaultUtxo: mkUtxo({ outputIndex: 1, datum: vaultDatum(OWNER_VAULT) }),
    priceBeaconUtxo: mkUtxo({ outputIndex: 2, datum: priceDatum }),
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

describe("buildConsumeTx — CONSUME-010: thread và vault phải cùng một khoá", () => {
  it("chủ vault KHÁC chủ thread → chặn lúc dựng, in CẢ HAI pkh", async () => {
    await expect(buildConsumeTx(baseParams({}))).rejects.toThrow(
      new RegExp(`CONSUME-010.*${OWNER_THREAD}.*${OWNER_VAULT}`, "s"),
    );
  });

  it("thông điệp nói NGƯỜI DÙNG PHẢI LÀM GÌ, không dừng ở 'có lỗi xảy ra'", async () => {
    // Đây là phần dễ bị bào mòn nhất khi ai đó gom lỗi lại cho gọn: một mã lỗi đúng mà
    // không có câu hành động thì người đọc vẫn phải đi hỏi. Ghim cả hai mảnh.
    await expect(buildConsumeTx(baseParams({}))).rejects.toThrow(/CÙNG MỘT khoá/);
    await expect(buildConsumeTx(baseParams({}))).rejects.toThrow(/personal_delegate/);
  });

  it("chủ vault TRÙNG chủ thread → qua cổng, rớt ở CHỐT KẾ TIẾP (CONSUME-006)", async () => {
    // Đối cực XANH sát cạnh: khác ca trên ĐÚNG MỘT BIẾN — owner trong datum vault.
    //
    // Ghim mã lỗi của chốt KẾ TIẾP chứ không chỉ ghim "không phải CONSUME-010": một
    // phủ định như thế còn xanh cả khi builder ném một lỗi hoàn toàn khác ở một chốt
    // ĐỨNG TRƯỚC, và lúc đó ca này thôi không chứng minh gì về cổng nó mang tên.
    // CONSUME-006 (`resolveThreadNft`) nằm SAU CONSUME-010 trong `buildConsumeTx`, nên
    // chạm tới nó là bằng chứng đã đi qua cổng.
    const ok = baseParams({ vaultUtxo: mkUtxo({ outputIndex: 1, datum: vaultDatum(OWNER_THREAD) }) });
    await expect(buildConsumeTx(ok)).rejects.toThrow(/CONSUME-006/);
  });

  it("vault UTxO thiếu datum → CONSUME-010, không im lặng bỏ qua", async () => {
    const noDatum = baseParams({ vaultUtxo: mkUtxo({ outputIndex: 1 }) });
    await expect(buildConsumeTx(noDatum)).rejects.toThrow(/CONSUME-010.*thiếu inline datum/s);
  });

  it("datum vault KHÔNG phải Constr → CONSUME-010, nêu hình dạng cần", async () => {
    const intDatum = baseParams({ vaultUtxo: mkUtxo({ outputIndex: 1, datum: Data.to(7n) }) });
    await expect(buildConsumeTx(intDatum)).rejects.toThrow(/CONSUME-010.*Constr/s);
  });

  it("trường 0 của datum vault không phải Credential → CONSUME-010 + OWNER_CREDENTIAL_SHAPE", async () => {
    const wrongField = baseParams({
      vaultUtxo: mkUtxo({ outputIndex: 1, datum: Data.to(new Constr(0, [42n])) }),
    });
    await expect(buildConsumeTx(wrongField)).rejects.toThrow(/OWNER_CREDENTIAL_SHAPE.*CONSUME-010.*Credential/s);
  });

  it("ÂM — vault lược đồ cũ (trường 0 = pkh trần, đúng chủ) → OWNER_CREDENTIAL_SHAPE", async () => {
    // Cùng 28 byte với chủ thread: bản cũ so chuỗi thì cho qua; on-chain `expect
    // vault_owner: Credential` thì chết. Ca này ghim rằng builder đọc như on-chain.
    const legacy = baseParams({
      vaultUtxo: mkUtxo({ outputIndex: 1, datum: Data.to(new Constr(0, [OWNER_THREAD, 0n])) }),
    });
    await expect(buildConsumeTx(legacy)).rejects.toThrow(/OWNER_CREDENTIAL_SHAPE/);
  });

  it("CỰC ĐỐI — vault Script(h), thread VerificationKey(h) cùng 28 byte → CONSUME-010", async () => {
    // Khác ca "TRÙNG chủ" ở trên ĐÚNG MỘT BIẾN: tag của credential vault.
    const tagOnly = baseParams({ vaultUtxo: mkUtxo({ outputIndex: 1, datum: vaultDatum(OWNER_THREAD, 1) }) });
    await expect(buildConsumeTx(tagOnly)).rejects.toThrow(/CONSUME-010.*key:.*script:/s);
  });
});
