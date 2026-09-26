// VaultReadAPI/tests/vaultView.test.ts — lõi thuần: dữ liệu vào, con số ra.

import { describe, expect, it } from "vitest";

import { readVaultsFromUtxos } from "../src/vaultView.js";
import { VaultDatumUndecodableError, VaultIdentityDuplicateError } from "../src/errors.js";
import {
  BATCH_EPOCH, EXPECTED_NANOGIC, PREVIEW_OWNER_PKH, PREVIEW_VAULT_ADDRESS,
  PREVIEW_VAULT_ID_UNIT, PREVIEW_VAULT_SCRIPT_HASH, PREVIEW_VAULT_UTXO,
  TIP_EPOCH_AT_RECORD, PREVIEW_VAULT_DATUM_HEX_RECORDED,
} from "./fixtures/preview-e5fd34b1.js";
import {
  PIN_ACCRUED, PIN_AVAILABLE, PIN_BATCHES, PIN_EPOCH, PIN_EXPIRED,
  SYNTH_ADDRESS, SYNTH_OTHER_OWNER, SYNTH_OWNER, SYNTH_SCRIPT_HASH,
  synthDatumHex, synthUtxo,
} from "./fixtures/synthetic.js";

const readPreview = (atEpoch: bigint) => readVaultsFromUtxos(
  [PREVIEW_VAULT_UTXO], PREVIEW_VAULT_SCRIPT_HASH, PREVIEW_VAULT_ADDRESS,
  PREVIEW_OWNER_PKH, atEpoch, "Schedule",
);

describe("`vaultKind` — BẮT BUỘC có mặt, và đi theo SCOPE chứ không theo datum", () => {
  it("mọi vault trả về đều mang `vaultKind` đúng bằng loại của scope", () => {
    const { vaults } = readPreview(BATCH_EPOCH);
    expect(vaults).toHaveLength(1);
    expect(vaults[0]!.vaultKind).toBe("Schedule");
  });

  it("CÙNG một UTxO đọc dưới scope Instant ⇒ `vaultKind` = Instant", () => {
    // Đây là bài phân biệt được HAI CỰC, và nó là lý do trường này tồn tại: datum của
    // Instant và của Schedule giải mã GIỐNG HỆT nhau, nên không phép đọc datum nào suy
    // ra được loại. Nếu ai đó sau này "cải tiến" bằng cách đoán loại từ datum, bài này
    // đỏ — vì cùng một byte datum phải cho hai kết quả khác nhau ở hai scope.
    const r = readVaultsFromUtxos(
      [PREVIEW_VAULT_UTXO], PREVIEW_VAULT_SCRIPT_HASH, PREVIEW_VAULT_ADDRESS,
      PREVIEW_OWNER_PKH, BATCH_EPOCH, "Instant",
    );
    expect(r.vaults[0]!.vaultKind).toBe("Instant");
  });

  it("không vault nào thiếu trường — vắng LỖ CHỖ là ca bên gọi không xử được", () => {
    // Vắng ở MỌI vault thì bên gọi biết là máy chủ bản cũ. Vắng ở MỘT SỐ vault thì họ
    // không phân biệt được "loại lạ" với "bản cũ" — hai thứ cần hai cách xử.
    const v1 = synthUtxo({
      txHash: "3a".repeat(32),
      datumHex: synthDatumHex(SYNTH_OWNER, [{ id: "e0".repeat(16), createdEpoch: PIN_EPOCH, amountNanogic: 5n }]),
      vaultIdAssetNameSeed: "31",
    });
    const v2 = synthUtxo({
      txHash: "3b".repeat(32),
      datumHex: synthDatumHex(SYNTH_OWNER, [{ id: "e1".repeat(16), createdEpoch: PIN_EPOCH, amountNanogic: 9n }]),
      vaultIdAssetNameSeed: "32",
    });
    const r = readVaultsFromUtxos(
      [v1, v2], SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, SYNTH_OWNER, PIN_EPOCH, "Instant",
    );
    expect(r.vaults).toHaveLength(2);
    for (const v of r.vaults) expect(v.vaultKind).toBe("Instant");
  });
});

describe("vault Preview thật — tx e5fd34b1…, 8 lần fire ScheduleGen", () => {
  it("ở epoch 20700 (epoch sinh ra 8 batch): tiêu được ĐÚNG 64 000 000 nanogic", () => {
    const { vaults } = readPreview(BATCH_EPOCH);
    expect(vaults).toHaveLength(1);
    const v = vaults[0]!;
    expect(v.availableNanogic).toBe(64_000_000n);
    expect(v.availableNanogic).toBe(EXPECTED_NANOGIC);
    expect(v.accruedNanogic).toBe(64_000_000n);
    expect(v.expiredNanogic).toBe(0n);
  });

  it("8 batch, mỗi batch ĐÚNG 8 000 000 nanogic — không phải một con số gần đúng", () => {
    const { vaults } = readPreview(BATCH_EPOCH);
    const b = vaults[0]!.batches;
    expect(b).toHaveLength(8);
    for (const x of b) {
      expect(x.currentAmountNanogic).toBe(8_000_000n);
      expect(x.initialAmountNanogic).toBe(8_000_000n);
      expect(x.createdEpoch).toBe(20_700n);
      expect(x.decayWindow).toBe(1n);
      expect(x.expiresAtEpoch).toBe(20_701n);
      expect(x.source).toBe("Schedule");
      expect(x.live).toBe(true);
    }
  });

  it("ở epoch 20707 (đỉnh chuỗi lúc ghi): available = 0 nhưng accrued VẪN = 64 000 000", () => {
    // §4.2 dùng-hết-hoặc-mất. `decay_window = 1` ⇒ 8 batch chỉ sống ở epoch 20700.
    // Trả MỘT con số ở đây là buộc bên gọi đoán; hai con số thì không ai phải đoán.
    const { vaults } = readPreview(TIP_EPOCH_AT_RECORD);
    const v = vaults[0]!;
    expect(v.availableNanogic).toBe(0n);
    expect(v.accruedNanogic).toBe(64_000_000n);
    expect(v.expiredNanogic).toBe(64_000_000n);
    expect(v.batches.every(b => !b.live)).toBe(true);
  });

  it("đọc đúng danh tính + lịch: NFT one-shot, rate_locked_q, fired_count", () => {
    const v = readPreview(BATCH_EPOCH).vaults[0]!;
    expect(v.ownerPkh).toBe(PREVIEW_OWNER_PKH);
    expect(v.vaultIdUnit).toBe(PREVIEW_VAULT_ID_UNIT);
    expect(v.vaultIdUnit.slice(0, 56)).toBe(PREVIEW_VAULT_SCRIPT_HASH);
    expect(v.utxoRef).toBe(
      "e5fd34b1b58e291437d419b8a7dbd8f0d508a911e722d91dae76a38cf22ebd76#0",
    );
    expect(v.genSchedules).toHaveLength(1);
    expect(v.genSchedules[0]!.rateLockedQ).toBe(8_000_000_000n);
    expect(v.genSchedules[0]!.firedCount).toBe(8n);
    expect(v.rateLockedQ).toBe(8_000_000_000n);
    expect(v.lampBalanceOildrop).toBe(1_001_000_000n);
    expect(v.lampLockedOildrop).toBe(2_000_000n);
    expect(v.consumedCreditNanogic).toBe(0n);
    expect(v.profile).toBe("Flame");
    expect(v.lastUpdatedEpoch).toBe(20_700n);
  });

  it("8 × 8 000 000 = 64 000 000 — tổng bằng phép nhân, không bằng niềm tin", () => {
    const b = readPreview(BATCH_EPOCH).vaults[0]!.batches;
    const sum = b.reduce((t, x) => t + x.currentAmountNanogic, 0n);
    expect(BigInt(b.length) * 8_000_000n).toBe(64_000_000n);
    expect(sum).toBe(64_000_000n);
  });

  it("hỏi bằng PKH của người KHÁC: 0 vault, và UTxO bị khai là OWNER_MISMATCH", () => {
    const r = readVaultsFromUtxos(
      [PREVIEW_VAULT_UTXO], PREVIEW_VAULT_SCRIPT_HASH, PREVIEW_VAULT_ADDRESS,
      SYNTH_OTHER_OWNER, BATCH_EPOCH, "Schedule",
    );
    expect(r.vaults).toHaveLength(0);
    expect(r.ignored).toEqual([
      { utxoRef: "e5fd34b1b58e291437d419b8a7dbd8f0d508a911e722d91dae76a38cf22ebd76#0",
        reason: "OWNER_MISMATCH" },
    ]);
  });
});

describe("GHIM phép cộng `available` — đột biến nào cũng phải làm bài này ĐỎ", () => {
  const utxo = synthUtxo({ txHash: "aa".repeat(32), datumHex: synthDatumHex(SYNTH_OWNER, PIN_BATCHES) });
  const read = () => readVaultsFromUtxos(
    [utxo], SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, SYNTH_OWNER, PIN_EPOCH, "Schedule",
  ).vaults[0]!;

  it("available = Σ batch CÒN SỐNG = 975", () => {
    expect(read().availableNanogic).toBe(PIN_AVAILABLE);
    expect(read().availableNanogic).toBe(975n);
  });

  it("available KHÁC mọi giá trị mà một đột biến hợp lý sinh ra", () => {
    const v = read();
    const live = v.batches.filter(b => b.live);
    // Bài này không kiểm hành vi — nó kiểm rằng MẪU ĐỦ PHÂN BIỆT. Không có nó thì
    // bài trên xanh ở cả hai bên đột biến mà không ai biết.
    const impostors = new Set<bigint>([
      v.accruedNanogic,                                       // quên lọc `live`
      v.expiredNanogic,                                       // lọc ngược dấu
      BigInt(live.length),                                    // đếm thay vì cộng
      live[0]!.currentAmountNanogic,                          // lấy batch đầu
      live.reduce((m, b) => b.currentAmountNanogic > m ? b.currentAmountNanogic : m, 0n), // lấy max
      0n,                                                     // bỏ hẳn phép cộng
    ]);
    expect(impostors.has(PIN_AVAILABLE)).toBe(false);
    expect(impostors.size).toBe(6);
  });

  it("accrued = Σ MỌI batch = 2 986 · expired = 2 011 · available + expired = accrued", () => {
    const v = read();
    expect(v.accruedNanogic).toBe(PIN_ACCRUED);
    expect(v.expiredNanogic).toBe(PIN_EXPIRED);
    expect(v.availableNanogic + v.expiredNanogic).toBe(v.accruedNanogic);
  });
});

describe("UTxO ở địa chỉ vault mà KHÔNG phải vault", () => {
  it("datum giả mạo không kèm NFT danh-tính ⇒ KHÔNG tính, và được ĐẾM", () => {
    // Địa chỉ script là công cộng. Không có cổng NFT thì bất kỳ ai cũng đặt được một
    // UTxO ở đó khai `owner` là PKH người khác và khai bao nhiêu MAGIC tuỳ thích —
    // mặt tiền sẽ báo một số dư mà không giao dịch nào chi ra được.
    // On-chain từ chối đúng ca này: `ScheduleGen/onchain/validators/vault.ak:266`.
    const forged = synthUtxo({
      txHash: "ff".repeat(32),
      datumHex: synthDatumHex(SYNTH_OWNER, [
        { id: "ee".repeat(16), createdEpoch: PIN_EPOCH, amountNanogic: 999_999_999n },
      ]),
      vaultIdAssetNameSeed: null,          // KHÔNG có NFT danh-tính
    });
    const r = readVaultsFromUtxos([forged], SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, SYNTH_OWNER, PIN_EPOCH, "Schedule");
    expect(r.vaults).toHaveLength(0);
    expect(r.ignored).toEqual([{ utxoRef: `${"ff".repeat(32)}#0`, reason: "NO_VAULT_ID_NFT" }]);
  });

  it("UTxO không datum, không NFT ⇒ NO_VAULT_ID_NFT (không ném)", () => {
    const junk = synthUtxo({ txHash: "0a".repeat(32), datumHex: null, vaultIdAssetNameSeed: null });
    const r = readVaultsFromUtxos([junk], SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, SYNTH_OWNER, PIN_EPOCH, "Schedule");
    expect(r.vaults).toHaveLength(0);
    expect(r.ignored[0]!.reason).toBe("NO_VAULT_ID_NFT");
  });
});

describe("hai ca phải KÊU TO, không được nuốt", () => {
  it("MANG NFT danh-tính mà datum không giải mã được ⇒ NÉM (lược đồ đã trôi)", () => {
    const drifted = synthUtxo({ txHash: "0b".repeat(32), datumHex: "d87980" });  // constr0 rỗng
    expect(() => readVaultsFromUtxos(
      [drifted], SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, SYNTH_OWNER, PIN_EPOCH, "Schedule",
    )).toThrow(VaultDatumUndecodableError);
  });

  it("hai UTxO cùng một NFT danh-tính ⇒ NÉM, KHÔNG cộng dồn", () => {
    // Bất khả trên sổ cái đã lắng (`vault.ak:867-869`: mỗi lần spend giữ đúng 1 NFT).
    // Thấy hai cái là dữ liệu không nhất quán; cộng cả hai là đếm hai lần một vault.
    const before = synthUtxo({
      txHash: "1a".repeat(32),
      datumHex: synthDatumHex(SYNTH_OWNER, [{ id: "c0".repeat(16), createdEpoch: PIN_EPOCH, amountNanogic: 64_000_000n }]),
      vaultIdAssetNameSeed: "7f",
    });
    const after = synthUtxo({
      txHash: "1b".repeat(32),
      datumHex: synthDatumHex(SYNTH_OWNER, [{ id: "c1".repeat(16), createdEpoch: PIN_EPOCH, amountNanogic: 40_000_000n }]),
      vaultIdAssetNameSeed: "7f",          // CÙNG NFT ⇒ cùng một vault
    });
    expect(() => readVaultsFromUtxos(
      [before, after], SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, SYNTH_OWNER, PIN_EPOCH, "Schedule",
    )).toThrow(VaultIdentityDuplicateError);
  });

  it("hai vault KHÁC NHAU của cùng một chủ thì VẪN cộng dồn — không nhầm với ca trên", () => {
    const v1 = synthUtxo({
      txHash: "2a".repeat(32),
      datumHex: synthDatumHex(SYNTH_OWNER, [{ id: "d0".repeat(16), createdEpoch: PIN_EPOCH, amountNanogic: 3n }]),
      vaultIdAssetNameSeed: "11",
    });
    const v2 = synthUtxo({
      txHash: "2b".repeat(32),
      datumHex: synthDatumHex(SYNTH_OWNER, [{ id: "d1".repeat(16), createdEpoch: PIN_EPOCH, amountNanogic: 7n }]),
      vaultIdAssetNameSeed: "22",          // NFT KHÁC ⇒ vault khác
    });
    const r = readVaultsFromUtxos([v1, v2], SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, SYNTH_OWNER, PIN_EPOCH, "Schedule");
    expect(r.vaults).toHaveLength(2);
    expect(r.vaults.reduce((t, v) => t + v.availableNanogic, 0n)).toBe(10n);
  });
});

describe("owner là Credential — datum lược đồ cũ không được đọc như két lành", () => {
  it("ÂM — datum ghi nguyên văn (owner = pkh trần) ⟹ VaultDatumUndecodableError, không lọc im", () => {
    const legacy = { ...PREVIEW_VAULT_UTXO, inlineDatumHex: PREVIEW_VAULT_DATUM_HEX_RECORDED };
    expect(() => readVaultsFromUtxos(
      [legacy], PREVIEW_VAULT_SCRIPT_HASH, PREVIEW_VAULT_ADDRESS,
      PREVIEW_OWNER_PKH, BATCH_EPOCH, "Schedule",
    )).toThrow(VaultDatumUndecodableError);
  });

  it("CỰC ĐỐI — cùng 28 byte nhưng chủ là Script(h) ⟹ OWNER_MISMATCH, không trả về", () => {
    const asScript = {
      ...PREVIEW_VAULT_UTXO,
      inlineDatumHex: PREVIEW_VAULT_UTXO.inlineDatumHex!.replace(/^d8799fd8799f581c/, "d8799fd87a9f581c"),
    };
    const { vaults, ignored } = readVaultsFromUtxos(
      [asScript], PREVIEW_VAULT_SCRIPT_HASH, PREVIEW_VAULT_ADDRESS,
      PREVIEW_OWNER_PKH, BATCH_EPOCH, "Schedule",
    ) as { vaults: unknown[]; ignored: { reason: string }[] };
    expect(vaults).toHaveLength(0);
    expect(ignored.map((i) => i.reason)).toEqual(["OWNER_MISMATCH"]);
  });
});
