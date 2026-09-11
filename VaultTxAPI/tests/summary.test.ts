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

function ctx(inputVaultDatumHex: string): SummaryContext {
  return {
    vaultAddress: VAULT_ADDRESS,
    inputVaultDatumHex,
    lampUnit: LAMP_UNIT,
    network: "Preview",
    requestedIntent: "schedule_commit",
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

describe("txBodyHash", () => {
  it("là hash 64 hex của THÂN giao dịch, và đổi khi thân đổi", () => {
    const h3 = txBodyHash(commitTx(3n));
    const h17 = txBodyHash(commitTx(17n));
    expect(h3).toMatch(/^[0-9a-f]{64}$/);
    expect(h3).not.toBe(h17);
    expect(txBodyHash(commitTx(3n))).toBe(h3);
  });
});
