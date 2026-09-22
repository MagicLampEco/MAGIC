// VaultTxAPI/tests/summary.test.ts — ghim "summary SUY TỪ CBOR", không phải tiếng vọng.
//
// ── PHÉP ĐO CẮN ĐƯỢC ───────────────────────────────────────────────────────────
// Bài `ĐỘT BIẾN` dưới đây dựng HAI giao dịch khác nhau ĐÚNG MỘT trường trong datum
// output (`lamp_locked`), rồi đòi hai bản tóm tắt khác nhau ở đúng chỗ đó. Một hiện thực
// chép `summary` từ tham số yêu cầu sẽ cho HAI bản tóm tắt GIỐNG NHAU ở đây — vì
// `summarizeTx` không nhận tham số yêu cầu nào để mà chép. Đó là điều kiện cắn.
//
// Số chọn sao cho các đại lượng dễ lẫn ĐÔI MỘT KHÁC NHAU. Không có tính chất đó thì một
// bài "xanh" chẳng chứng minh gì: nó xanh ở cả hai bên đột biến.
//
//   khoá THÊM ở bản A      =  21 000 000 oildrop
//   khoá THÊM ở bản B      = 119 000 000 oildrop
//   λ mỗi epoch            =   7 000 000 oildrop
//   lamp_locked trước      =   2 000 000 oildrop
//   lamp_balance           = 1 001 000 000 oildrop
//   phí                    =     178 000 lovelace

import { describe, expect, it } from "vitest";

import { TxSummaryUndecodableError } from "../src/errors.js";
import { summarizeTx, txBodyHash, type SummaryContext } from "../src/summary.js";
import { enterpriseAddressOf } from "../src/txBuilder.js";
import {
  INPUT_TX_HASH, LAMP_UNIT, OWNER_PKH, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor } from "./fixtures/tx.js";

const LAMBDA = 7_000_000n;
const FEE = 178_000n;
const CHANGE_ADDRESS = enterpriseAddressOf("Preview", OWNER_PKH);

const BATCH_LIVE = { id: "b0".repeat(16), createdEpoch: 20_700n, amountNanogic: 5_000_000n };
const BATCH_SECOND = { id: "b1".repeat(16), createdEpoch: 20_700n, amountNanogic: 4_000_000n };
const BATCH_NEW = { id: "b9".repeat(16), createdEpoch: 20_701n, amountNanogic: 8_000_000n };

const BEFORE_COMMIT = datumHex({
  lampLockedOildrop: 2_000_000n,
  batches: [BATCH_LIVE],
});

/** `intent` là tham số chứ không phải hằng gõ cứng: `summarizeTx` nay ĐỌC nó (cổng
 *  ý-định-khớp-hình-dạng datum), nên một mẫu dán nhãn sai sẽ kiểm nhầm nhánh. Bản
 *  trước gõ cứng `"schedule_commit"` cho mọi ca, kể cả các ca InstantGen — lúc ấy vô
 *  hại vì nhãn không đi vào phép tính nào, nhưng nó là cái bẫy cho đúng lượt này. */
function ctx(
  inputVaultDatumHex: string,
  intent: SummaryContext["requestedIntent"] = "schedule_commit",
): SummaryContext {
  return {
    vaultAddress: VAULT_ADDRESS,
    inputVaultDatumHex,
    lampUnit: LAMP_UNIT,
    network: "Preview",
    requestedIntent: intent,
  };
}

/** Giao dịch ScheduleCommit khoá `L × λ` — output vault + một output tiền thừa. */
function commitTx(scheduleLength: bigint): string {
  return buildTxCbor({
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    feeLovelace: FEE,
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({
          lampLockedOildrop: 2_000_000n + scheduleLength * LAMBDA,
          batches: [BATCH_LIVE],
          genScheduleCount: 1,
        }),
      },
      { address: CHANGE_ADDRESS, assets: { lovelace: 9_400_000n } },
    ],
  });
}

describe("summarizeTx — mọi con số suy từ CBOR", () => {
  it("đọc phí, địa chỉ output và số LAMP khoá THÊM từ chính giao dịch", () => {
    const s = summarizeTx(commitTx(3n), ctx(BEFORE_COMMIT));

    expect(s.fee_lovelace).toBe("178000");
    expect(s.fee_ada).toBe("0.178000");

    expect(s.lamp.locked_delta_oildrop).toBe("21000000");
    expect(s.lamp.locked_delta_lamp).toBe("21.000000");
    expect(s.lamp.balance_delta_oildrop).toBe("0");
    expect(s.lamp.in_vault_output_oildrop).toBe("1001000000");
    expect(s.lamp.in_vault_output_lamp).toBe("1001.000000");

    expect(s.vault.address).toBe(VAULT_ADDRESS);
    expect(s.vault.output_index).toBe(0);
    expect(s.vault.owner_pkh).toBe(OWNER_PKH);
    expect(s.vault.gen_schedule_count_before).toBe(0);
    expect(s.vault.gen_schedule_count_after).toBe(1);

    expect(s.outputs).toHaveLength(2);
    expect(s.outputs[1]!.address).toBe(CHANGE_ADDRESS);
    expect(s.outputs[1]!.lovelace).toBe("9400000");
    expect(s.outputs[1]!.has_inline_datum).toBe(false);
    // NFT danh-tính phải hiện ở output vault — không có nó thì vault chết, và người dùng
    // là người duy nhất có thể nhìn thấy điều đó trước khi ký.
    expect(s.outputs[0]!.assets.map(a => a.unit)).toContain(VAULT_ID_UNIT);
  });

  it("ĐỘT BIẾN: đổi datum trong CBOR ⟹ summary đổi theo, ở đúng trường đó", () => {
    const a = summarizeTx(commitTx(3n), ctx(BEFORE_COMMIT));
    const b = summarizeTx(commitTx(17n), ctx(BEFORE_COMMIT));

    expect(a.lamp.locked_delta_oildrop).toBe("21000000");
    expect(b.lamp.locked_delta_oildrop).toBe("119000000");
    expect(a.lamp.locked_delta_oildrop).not.toBe(b.lamp.locked_delta_oildrop);

    // Mọi thứ KHÔNG đổi trong CBOR thì cũng không được đổi trong bản tóm tắt.
    expect(a.fee_lovelace).toBe(b.fee_lovelace);
    expect(a.vault.owner_pkh).toBe(b.vault.owner_pkh);
  });

  it("ĐỘT BIẾN: `balance_delta` cũng ĐỌC datum — số 0 ở ca commit là sự thật, không phải hằng", () => {
    // Ở ca ScheduleCommit, `balance_delta` bằng 0 là ĐÚNG GIAO THỨC, không phải một
    // fixture làm cho xong: `ScheduleGen/onchain/validators/vault.ak` ▸ `validate_commit`
    // ép `output.lamp_balance == datum.lamp_balance` ("commit moves no LAMP").
    //
    // Nhưng một số 0 đúng vẫn không ghim được gì: một hiện thực trả thẳng hằng `"0"` cho
    // `balance_delta` đi qua mọi bài ở trên mà không bài nào đỏ. Điều kiện cắn phải là
    // một giao dịch có `lamp_balance` KHÁC ở hai đầu — ca đó có thật ở nhánh rút
    // (`vault.ak` ▸ `new_lamp_balance = input_datum.lamp_balance - amount`).
    const before = datumHex({ lampBalanceOildrop: 1_001_000_000n, lampLockedOildrop: 2_000_000n });
    const tx = buildTxCbor({
      inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
      feeLovelace: FEE,
      outputs: [{
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 641_000_000n, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({ lampBalanceOildrop: 641_000_000n, lampLockedOildrop: 2_000_000n }),
      }],
    });
    const s = summarizeTx(tx, ctx(before));

    expect(s.lamp.balance_delta_oildrop).toBe("-360000000");
    expect(s.lamp.balance_delta_lamp).toBe("-360.000000");
    // Và trường hàng xóm KHÔNG được trôi theo — hai trường này đọc hai chỗ khác nhau.
    expect(s.lamp.locked_delta_oildrop).toBe("0");
  });

  it("HAI output cùng ở địa chỉ vault ⟹ ném, không lặng lẽ tóm tắt cái đầu tiên", () => {
    // Một giao dịch có hai output ở địa chỉ vault là thứ người dùng KHÔNG đọc ra được từ
    // một bản tóm tắt nói về "output vault". Chọn bừa cái đầu là dựng một cái vỏ im
    // lặng: bản tóm tắt vẫn đủ trường, vẫn hợp lệ, và nói về một nửa giao dịch.
    const tx = buildTxCbor({
      inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
      feeLovelace: FEE,
      outputs: [
        {
          address: VAULT_ADDRESS,
          assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
          inlineDatumHex: datumHex({ lampLockedOildrop: 23_000_000n, batches: [BATCH_LIVE] }),
        },
        {
          address: VAULT_ADDRESS,
          assets: { lovelace: 2_000_000n },
          inlineDatumHex: datumHex({ lampLockedOildrop: 2_000_000n, batches: [BATCH_LIVE] }),
        },
      ],
    });
    expect(() => summarizeTx(tx, ctx(BEFORE_COMMIT))).toThrow(TxSummaryUndecodableError);
  });

  it("MAGIC sinh ra đọc từ batch MỚI trong datum output", () => {
    const tx = buildTxCbor({
      feeLovelace: FEE,
      outputs: [{
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_659_030n, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({
          lampLockedOildrop: 14_000_000n,
          batches: [BATCH_LIVE, BATCH_NEW],
        }),
      }],
    });
    const s = summarizeTx(tx, ctx(datumHex({ lampLockedOildrop: 21_000_000n, batches: [BATCH_LIVE] })));

    expect(s.magic.minted_nanogic).toBe("8000000");
    expect(s.magic.minted_magic).toBe("0.008000000");
    expect(s.magic.burned_nanogic).toBe("0");
    expect(s.magic.expired_dropped_nanogic).toBe("0");
    expect(s.magic.total_after_nanogic).toBe("13000000");
    // LAMP được MỞ khoá thì delta âm — và nó phải hiện ra là âm, không phải bằng 0.
    expect(s.lamp.locked_delta_oildrop).toBe("-7000000");
    expect(s.lamp.locked_delta_lamp).toBe("-7.000000");
  });

  it("MAGIC đốt đọc từ consumed_credit, TÁCH khỏi phần mất hạn", () => {
    const tx = buildTxCbor({
      feeLovelace: FEE,
      outputs: [{
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_659_030n, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({
          batches: [{ ...BATCH_LIVE, amountNanogic: 2_000_000n }],
          consumedCreditNanogic: 3_000_000n,
        }),
      }],
    });
    // Trước: hai batch (5 000 000 + 4 000 000). Sau: một batch 2 000 000, đã tiêu 3 000 000.
    // ⟹ đốt 3 000 000, mất hạn 4 000 000. Gộp hai vế lại sẽ ra 7 000 000 — một con số
    // trông hợp lý và sai, đúng kiểu sai không kêu.
    const s = summarizeTx(tx, ctx(datumHex({ batches: [BATCH_LIVE, BATCH_SECOND] })));

    expect(s.magic.burned_nanogic).toBe("3000000");
    expect(s.magic.expired_dropped_nanogic).toBe("4000000");
    expect(s.magic.minted_nanogic).toBe("0");
    expect(s.magic.total_after_nanogic).toBe("2000000");
  });
});

describe("summarizeTx — hình dạng lạ thì NÉM, không đệm", () => {
  it("không có output nào ở địa chỉ vault ⟹ ném", () => {
    const tx = buildTxCbor({
      feeLovelace: FEE,
      outputs: [{ address: CHANGE_ADDRESS, assets: { lovelace: 9_400_000n } }],
    });
    expect(() => summarizeTx(tx, ctx(BEFORE_COMMIT))).toThrow(TxSummaryUndecodableError);
  });

  it("output ở địa chỉ vault mang datum KHÔNG khớp lược đồ ⟹ ném", () => {
    const tx = buildTxCbor({
      feeLovelace: FEE,
      outputs: [{
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_659_030n },
        inlineDatumHex: "d87980",   // Constr 0 rỗng — hợp lệ với CBOR, sai với VaultDatum
      }],
    });
    expect(() => summarizeTx(tx, ctx(BEFORE_COMMIT))).toThrow(TxSummaryUndecodableError);
  });

  it("tx_cbor không phải hex / không phải giao dịch ⟹ ném", () => {
    expect(() => summarizeTx("không-phải-hex", ctx(BEFORE_COMMIT))).toThrow(TxSummaryUndecodableError);
    expect(() => summarizeTx("deadbeef", ctx(BEFORE_COMMIT))).toThrow(TxSummaryUndecodableError);
  });

  it("datum của UTxO ĐANG BỊ TIÊU không khớp lược đồ ⟹ ném", () => {
    expect(() => summarizeTx(commitTx(3n), ctx("d87980"))).toThrow(TxSummaryUndecodableError);
  });
});

// ── `instant_unlock_ms` — CẶP ca kiểm, không phải một ca dương ────────────────────
//
// Ca dương một mình ở đây xanh được vì một lý do RỖNG: một hiện thực trả thẳng chuỗi
// chữ số của bất kỳ đâu cũng qua nó. Cực đối là ca Schedule — nơi trường KHÔNG TỒN TẠI
// và câu trả lời đúng là `null`, KHÔNG phải `"0"`. Hai cực đó phân biệt được ba hiện
// thực sai mà một ca dương không phân biệt nổi:
//
//   (a) đệm `"0"` khi không có trường   → ca Schedule đỏ
//   (b) trả hằng, không đọc datum       → ca ĐỘT BIẾN đỏ (hai mốc khác nhau)
//   (c) đọc từ tham số yêu cầu          → không có tham số nào để đọc; ca ĐỘT BIẾN đỏ
//
// Mốc chọn là hai số ĐÔI MỘT KHÁC NHAU và khác mọi số khác trong tệp này, để một bản
// tóm tắt lấy nhầm trường không thể tình cờ đúng.
const UNLOCK_A = 1_763_000_000_000n;   // ~2025-11-13
const UNLOCK_B = 1_763_432_000_000n;   // ~2025-11-18, cách A đúng 5 ngày

/** Giao dịch InstantGen: datum đầu ra hình dạng Instant (18 trường), mang mốc khoá. */
function instantGenTx(unlockMs: bigint): string {
  return buildTxCbor({
    inputs: [{ txHash: INPUT_TX_HASH, outputIndex: 0 }],
    feeLovelace: FEE,
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({
          batches: [BATCH_LIVE, BATCH_NEW],
          instantUnlockMs: unlockMs,
        }),
      },
      { address: CHANGE_ADDRESS, assets: { lovelace: 9_400_000n } },
    ],
  });
}

/** Datum ĐẦU VÀO hình dạng Instant, chưa từng sinh ⟹ mốc khoá bằng 0. */
const BEFORE_INSTANT = datumHex({ batches: [BATCH_LIVE], instantUnlockMs: 0n });

describe("summary ▸ instant_unlock_ms — mốc POSIX ms, đọc từ datum ĐẦU RA", () => {
  it("két Instant ⟹ mốc ra dưới dạng CHUỖI chữ số, đúng giá trị trong CBOR", () => {
    const s = summarizeTx(instantGenTx(UNLOCK_A), ctx(BEFORE_INSTANT, "instant_gen"));
    expect(s.vault.instant_unlock_ms).toBe("1763000000000");
  });

  it("CỰC ĐỐI — két Schedule KHÔNG có trường này ⟹ `null`, KHÔNG phải \"0\"", () => {
    // Đây là ca ghim được thứ ca trên không ghim: phân biệt *vắng mặt* với *bằng 0*.
    // Một két Instant chưa từng sinh CÓ trường và nó bằng 0 — nếu ở đây trả `"0"` thì
    // hai trạng thái khác hẳn nhau đọc ra giống hệt nhau, và màn hình sẽ in "hết khoá
    // lúc 1970" cho một két không hề có cơ chế khoá.
    const s = summarizeTx(commitTx(3n), ctx(BEFORE_COMMIT));
    expect(s.vault.instant_unlock_ms).toBeNull();
    expect(s.vault.instant_unlock_ms).not.toBe("0");
  });

  it("két Instant CHƯA TỪNG SINH ⟹ \"0\", và \"0\" ≠ null", () => {
    // Vế thứ ba của cặp: chứng minh `"0"` là một giá trị ĐẠT TỚI ĐƯỢC ở nhánh Instant.
    // Không có ca này thì ca Schedule ở trên còn xanh được nhờ một hiện thực trả `null`
    // cho MỌI thứ — nó sẽ không phân biệt hai cực, chỉ trông như đang phân biệt.
    const s = summarizeTx(instantGenTx(0n), ctx(BEFORE_INSTANT, "instant_gen"));
    expect(s.vault.instant_unlock_ms).toBe("0");
  });

  it("ĐỘT BIẾN: đổi MỐC trong CBOR ⟹ summary đổi theo, và chỉ ở trường đó", () => {
    const a = summarizeTx(instantGenTx(UNLOCK_A), ctx(BEFORE_INSTANT, "instant_gen"));
    const b = summarizeTx(instantGenTx(UNLOCK_B), ctx(BEFORE_INSTANT, "instant_gen"));

    expect(a.vault.instant_unlock_ms).toBe("1763000000000");
    expect(b.vault.instant_unlock_ms).toBe("1763432000000");
    expect(a.vault.instant_unlock_ms).not.toBe(b.vault.instant_unlock_ms);

    // Không đổi trong CBOR thì không được đổi trong bản tóm tắt.
    expect(a.fee_lovelace).toBe(b.fee_lovelace);
    expect(a.vault.owner_pkh).toBe(b.vault.owner_pkh);
    expect(a.magic.total_after_nanogic).toBe(b.magic.total_after_nanogic);
  });
});

// ── Ý ĐỊNH phải khớp HÌNH DẠNG datum — CẶP ca kiểm ───────────────────────────────
//
// Cực này quan trọng hơn nó trông: trước khi có cổng, một lượt `instant_gen` dựng
// nhầm datum 17 trường đi TRỌN đường và trả `200` kèm `instant_unlock_ms: null`. Mà
// `null` được tài liệu khai nghĩa là "két Schedule — trường không tồn tại", nên bên
// hiển thị đọc đúng tài liệu rồi kết luận ngược.
//
// Hai cực phải đứng cạnh nhau, vì một mình ca ném thì xanh được bằng một hiện thực
// ném cho MỌI datum Schedule — và như thế thì mọi lượt `schedule_commit` hỏng theo.
describe("summary ▸ ý định khớp hình dạng datum", () => {
  it("`instant_gen` + datum đầu ra hình dạng Schedule ⟹ NÉM, không trả bản tóm tắt", () => {
    expect(() => summarizeTx(commitTx(3n), ctx(BEFORE_COMMIT, "instant_gen")))
      .toThrow(/instant_gen.*Schedule|Schedule.*instant_gen/s);
  });

  it("CỰC ĐỐI — `schedule_commit` + đúng datum Schedule ⟹ KHÔNG ném", () => {
    // Không có ca này thì ca trên xanh nhờ một hiện thực ném cho mọi datum 17 trường.
    const s = summarizeTx(commitTx(3n), ctx(BEFORE_COMMIT, "schedule_commit"));
    expect(s.vault.instant_unlock_ms).toBeNull();
  });

  it("CỰC ĐỐI — `instant_gen` + đúng datum Instant ⟹ KHÔNG ném", () => {
    // Và không có ca này thì ca đầu xanh nhờ một hiện thực ném cho MỌI `instant_gen`.
    const s = summarizeTx(instantGenTx(UNLOCK_A), ctx(BEFORE_INSTANT, "instant_gen"));
    expect(s.vault.instant_unlock_ms).toBe("1763000000000");
  });
});

// ── `instant_unlock_ms_before` — ba câu, không phải một con số trơ ────────────────
//
// Trường `after` một mình không phân biệt được "lượt này ĐẶT khoá" với "lượt này KÉO
// DÀI khoá" với "lượt này KHÔNG ĐỤNG mốc" — cả ba hiện ra cùng một mốc tương lai. Ba
// ca dưới đây là ba cực đó; bỏ bất kỳ ca nào thì hai cực còn lại lẫn vào nhau.
describe("summary ▸ instant_unlock_ms_before", () => {
  /** Datum đầu vào Instant ĐÃ có khoá, để dựng ca "kéo dài". */
  const BEFORE_LOCKED = datumHex({ batches: [BATCH_LIVE], instantUnlockMs: UNLOCK_A });

  it("ĐẶT lần đầu: before \"0\" → after mốc thật", () => {
    const s = summarizeTx(instantGenTx(UNLOCK_A), ctx(BEFORE_INSTANT, "instant_gen"));
    expect(s.vault.instant_unlock_ms_before).toBe("0");
    expect(s.vault.instant_unlock_ms).toBe("1763000000000");
  });

  it("KÉO DÀI: before và after đều là mốc thật, và after xa hơn", () => {
    const s = summarizeTx(instantGenTx(UNLOCK_B), ctx(BEFORE_LOCKED, "instant_gen"));
    expect(s.vault.instant_unlock_ms_before).toBe("1763000000000");
    expect(s.vault.instant_unlock_ms).toBe("1763432000000");
    expect(BigInt(s.vault.instant_unlock_ms!)).toBeGreaterThan(
      BigInt(s.vault.instant_unlock_ms_before!),
    );
  });

  it("KHÔNG DỜI: before == after ⟹ bên hiển thị nói được là lượt này không khoá thêm", () => {
    // Bốn nhánh spend ghim trường đứng yên. Không có vế `_before` thì một lượt như
    // thế vẫn hiện một mốc tương lai, và nó đọc thành "giao dịch này khoá tôi".
    const s = summarizeTx(instantGenTx(UNLOCK_A), ctx(BEFORE_LOCKED, "instant_gen"));
    expect(s.vault.instant_unlock_ms_before).toBe(s.vault.instant_unlock_ms);
  });

  it("CỰC ĐỐI — két Schedule ⟹ cả hai vế đều `null`, không vế nào đệm \"0\"", () => {
    const s = summarizeTx(commitTx(3n), ctx(BEFORE_COMMIT, "schedule_commit"));
    expect(s.vault.instant_unlock_ms_before).toBeNull();
    expect(s.vault.instant_unlock_ms).toBeNull();
  });
});

describe("txBodyHash", () => {
  it("là hash 64 hex của THÂN giao dịch, và đổi khi thân đổi", () => {
    const h3 = txBodyHash(commitTx(3n));
    const h17 = txBodyHash(commitTx(17n));
    expect(h3).toMatch(/^[0-9a-f]{64}$/);
    expect(h3).not.toBe(h17);
    expect(txBodyHash(commitTx(3n))).toBe(h3);
  });
});
