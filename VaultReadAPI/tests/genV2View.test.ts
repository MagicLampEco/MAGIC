// VaultReadAPI/tests/genV2View.test.ts — datum két Gen v2.0: ô mới hiện đúng, datum v1 NÉM.
//
// Mẫu lấy từ vector gốc (`tests/fixtures/genV2.ts`). Mỗi khẳng định đi thành CẶP: một ca
// đúng và một ca chỉ khác đúng một chỗ — một ca dương đứng một mình có thể xanh vì lý do rỗng.

import { describe, expect, it } from "vitest";

import { RecordedChainReader } from "../src/chain.js";
import type { VaultScope } from "../src/config.js";
import { VaultDatumUndecodableError, VaultDatumV1Error, VaultReadError } from "../src/errors.js";
import { VaultReadService, toJsonBody } from "../src/service.js";
import { readVaultsFromUtxos } from "../src/vaultView.js";
import {
  SCHEDULE_V2_EXPECT, SCHEDULE_V2_ONE_SCHEDULE_HEX, TV_DATUM_V2_FULL, TV_DATUM_V2_GENESIS,
  dropTrailingFields, epochUsage, withField,
} from "./fixtures/genV2.js";
import { PREPROD_TIP_AT_BATCH_EPOCH, PREVIEW_VAULT_DATUM_HEX_V1 } from "./fixtures/preview-e5fd34b1.js";
import { SYNTH_ADDRESS, SYNTH_OWNER, SYNTH_SCRIPT_HASH, synthUtxo } from "./fixtures/synthetic.js";

const FULL_OWNER = { type: "script" as const, hash: "22".repeat(28) };
const SCHED_OWNER = { type: "key" as const, hash: SCHEDULE_V2_EXPECT.ownerPkh };

function readOne(hex: string, owner: { type: "key" | "script"; hash: string }, kind: "Instant" | "Schedule") {
  const utxo = synthUtxo({ txHash: "5a".repeat(32), datumHex: hex });
  const r = readVaultsFromUtxos([utxo], SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, owner, 20n, kind);
  expect(r.ignored).toEqual([]);
  expect(r.vaults).toHaveLength(1);
  return r.vaults[0]!;
}

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  throw new Error("không ném");
}

describe("két Instant v2.0 (20 trường) — ô mới đọc đúng từ vector TV-DATUM-V2-FULL", () => {
  const want = TV_DATUM_V2_FULL.value;
  const v = readOne(TV_DATUM_V2_FULL.cbor, FULL_OWNER, "Instant");

  it("datumKind = Instant, và các ô chỉ-Instant mang giá trị của vector", () => {
    expect(v.datumKind).toBe("Instant");
    expect(v.wakemeLink).toBe(want.wakeme_link);
    expect(v.capEpoch).toBe(want.cap_epoch);
    expect(v.capNanogic).toBe(want.cap_nanogic);
    expect(v.instantUnlockMs).toBe(want.instant_unlock_ms);
    expect(v.usageWindowEpoch).toBe(want.usage_window_epoch);
    expect(v.usageWindow).toEqual(want.usage_window.map(w => ({
      generatedNanogic: w.generated, consumedNanogic: w.consumed,
    })));
  });

  it("ô cũ vẫn đọc theo TÊN, không lệch chỉ số dù ô 6/12/14 đã tái dụng", () => {
    expect(v.lampBalanceOildrop).toBe(want.lamp_balance);
    expect(v.lampLockedOildrop).toBe(want.lamp_locked);
    expect(v.consumedCreditNanogic).toBe(want.activity_state.consumed_credit);
    expect(v.lastUpdatedEpoch).toBe(want.last_updated_epoch);
    expect(v.profile).toBe(want.profile);
    expect(v.accruedNanogic).toBe(want.magic_batches.reduce((t, b) => t + b.current_amount, 0n));
  });

  it("lịch của két Instant KHÔNG có m_per_epoch / usage_factor_locked_q ⟹ null, không 0", () => {
    expect(v.genSchedules).toHaveLength(1);
    expect(v.genSchedules[0]!.mPerEpochNanogic).toBeNull();
    expect(v.genSchedules[0]!.usageFactorLockedQ).toBeNull();
    expect(v.genSchedules[0]!.firedCount).toBe(want.gen_schedules[0]!.fired_count);
  });

  it("CẶP — genesis: wakeme_link = \"\" và cap = 0n là GIÁ TRỊ THẬT, khác null của két Schedule", () => {
    const g = readOne(TV_DATUM_V2_GENESIS.cbor, { type: "key", hash: SYNTH_OWNER }, "Instant");
    expect(g.wakemeLink).toBe("");
    expect(g.capEpoch).toBe(0n);
    expect(g.capNanogic).toBe(0n);
    expect(g.instantUnlockMs).toBe(0n);
    expect(g.usageWindow).toHaveLength(7);
    expect(g.usageWindow.every(w => w.generatedNanogic === 0n && w.consumedNanogic === 0n)).toBe(true);
    // Cực đối với FULL: cùng lối đọc, giá trị khác ⟹ lối đọc không trả hằng.
    expect(g.capNanogic).not.toBe(v.capNanogic);
    expect(g.wakemeLink).not.toBe(v.wakemeLink);
  });
});

describe("két Schedule v2.0 (19 trường) — vector tv_cbor_vault_one_schedule_hex", () => {
  const v = readOne(SCHEDULE_V2_ONE_SCHEDULE_HEX, SCHED_OWNER, "Schedule");

  it("datumKind = Schedule; ô chỉ-Instant là null (ô KHÔNG TỒN TẠI), không đệm 0/\"\"", () => {
    expect(v.datumKind).toBe("Schedule");
    expect(v.wakemeLink).toBeNull();
    expect(v.capEpoch).toBeNull();
    expect(v.capNanogic).toBeNull();
    expect(v.instantUnlockMs).toBeNull();
  });

  it("usage_window + usage_window_epoch đọc đúng; lịch mang m_per_epoch, usage_factor_locked_q", () => {
    expect(v.usageWindowEpoch).toBe(SCHEDULE_V2_EXPECT.usageWindowEpoch);
    expect(v.usageWindow).toHaveLength(7);
    expect(v.usageWindow.every(w => w.generatedNanogic === 0n && w.consumedNanogic === 0n)).toBe(true);
    expect(v.genSchedules).toHaveLength(1);
    expect(v.genSchedules[0]!.mPerEpochNanogic).toBe(SCHEDULE_V2_EXPECT.mPerEpoch);
    expect(v.genSchedules[0]!.usageFactorLockedQ).toBe(SCHEDULE_V2_EXPECT.usageFactorLockedQ);
    expect(v.genSchedules[0]!.rateLockedQ).toBe(SCHEDULE_V2_EXPECT.rateLockedQ);
    expect(v.lampBalanceOildrop).toBe(SCHEDULE_V2_EXPECT.lampBalance);
    expect(v.lampLockedOildrop).toBe(SCHEDULE_V2_EXPECT.lampLocked);
    expect(v.lastUpdatedEpoch).toBe(SCHEDULE_V2_EXPECT.lastUpdatedEpoch);
  });
});

describe("đổi ĐÚNG MỘT ô trong datum ⟹ giá trị hiển thị đổi theo (không phải hằng)", () => {
  const base = readOne(TV_DATUM_V2_FULL.cbor, FULL_OWNER, "Instant");

  it("Instant ô 14 cap_nanogic", () => {
    const v = readOne(withField(TV_DATUM_V2_FULL.cbor, 14, 987_654_321n), FULL_OWNER, "Instant");
    expect(v.capNanogic).toBe(987_654_321n);
    expect(v.capNanogic).not.toBe(base.capNanogic);
    expect(v.capEpoch).toBe(base.capEpoch);                  // ô bên cạnh giữ nguyên
  });

  it("Instant ô 12 cap_epoch và ô 19 usage_window_epoch — hai ô, hai số khác nhau", () => {
    const v = readOne(
      withField(withField(TV_DATUM_V2_FULL.cbor, 12, 31n), 19, 32n), FULL_OWNER, "Instant",
    );
    expect(v.capEpoch).toBe(31n);
    expect(v.usageWindowEpoch).toBe(32n);
  });

  it("Instant ô 6 wakeme_link: \"\" ⟹ \"\"", () => {
    const v = readOne(withField(TV_DATUM_V2_FULL.cbor, 6, ""), FULL_OWNER, "Instant");
    expect(v.wakemeLink).toBe("");
    expect(base.wakemeLink).toBe("ef".repeat(32));
  });

  it("Instant ô 18 usage_window: đổi ô 0 ⟹ chỉ ô 0 đổi", () => {
    const win = TV_DATUM_V2_FULL.value.usage_window.map((w, i) =>
      i === 0 ? epochUsage(11n, 22n) : epochUsage(w.generated, w.consumed));
    const v = readOne(withField(TV_DATUM_V2_FULL.cbor, 18, win), FULL_OWNER, "Instant");
    expect(v.usageWindow[0]).toEqual({ generatedNanogic: 11n, consumedNanogic: 22n });
    expect(v.usageWindow.slice(1)).toEqual(base.usageWindow.slice(1));
    expect(v.usageWindow[0]).not.toEqual(base.usageWindow[0]);
  });

  it("Schedule ô 18 usage_window_epoch", () => {
    const v = readOne(withField(SCHEDULE_V2_ONE_SCHEDULE_HEX, 18, 101n), SCHED_OWNER, "Schedule");
    expect(v.usageWindowEpoch).toBe(101n);
  });
});

describe("datum ĐỜI v1 ⟹ NÉM VAULT_DATUM_V1 (mã riêng), không đệm ô thiếu", () => {
  it("Instant: vector v2 bỏ 2 ô cuối (20 → 18) ⟹ VAULT_DATUM_V1 · Instant-v1", () => {
    const hex = dropTrailingFields(TV_DATUM_V2_FULL.cbor, 2);
    const e = thrown(() => readOne(hex, FULL_OWNER, "Instant"));
    expect(e).toBeInstanceOf(VaultDatumV1Error);
    expect(e).not.toBeInstanceOf(VaultDatumUndecodableError);
    const err = e as VaultReadError;
    expect(err.code).toBe("VAULT_DATUM_V1");
    expect(err.httpStatus).toBe(502);
    expect(err.details).toMatchObject({ field_count: 18, datum_generation: "Instant-v1" });
  });

  it("Schedule: vector v2 bỏ 2 ô cuối (19 → 17) ⟹ VAULT_DATUM_V1 · Schedule-v1", () => {
    const hex = dropTrailingFields(SCHEDULE_V2_ONE_SCHEDULE_HEX, 2);
    const e = thrown(() => readOne(hex, SCHED_OWNER, "Schedule")) as VaultReadError;
    expect(e).toBeInstanceOf(VaultDatumV1Error);
    expect(e.details).toMatchObject({ field_count: 17, datum_generation: "Schedule-v1" });
  });

  it("két Preview ghi từ chuỗi (17 trường, owner đã là Credential) ⟹ VAULT_DATUM_V1", () => {
    const e = thrown(() => readOne(PREVIEW_VAULT_DATUM_HEX_V1, SCHED_OWNER, "Schedule")) as VaultReadError;
    expect(e.code).toBe("VAULT_DATUM_V1");
  });

  it("CỰC ĐỐI — số trường KHÔNG thuộc đời nào (20 → 16) ⟹ UNDECODABLE, không phải V1", () => {
    const hex = dropTrailingFields(TV_DATUM_V2_FULL.cbor, 4);
    const e = thrown(() => readOne(hex, FULL_OWNER, "Instant")) as VaultReadError;
    expect(e).toBeInstanceOf(VaultDatumUndecodableError);
    expect(e.code).toBe("VAULT_DATUM_UNDECODABLE");
  });

  it("V1 ném kể cả khi chủ KHÔNG khớp — không lọc im thành OWNER_MISMATCH", () => {
    const hex = dropTrailingFields(TV_DATUM_V2_FULL.cbor, 2);
    const e = thrown(() => readOne(hex, { type: "key", hash: "99".repeat(28) }, "Instant")) as VaultReadError;
    expect(e.code).toBe("VAULT_DATUM_V1");
  });
});

describe("thân bài JSON — ô Gen v2.0 đi ra đúng khuôn", () => {
  async function body(hex: string, owner: { type: "key" | "script"; hash: string }, kind: "Instant" | "Schedule") {
    const scopes: VaultScope[] = [{ vaultType: kind, address: SYNTH_ADDRESS, scriptHash: SYNTH_SCRIPT_HASH, source: "vector" }];
    // Preprod: Preview chưa có gốc cửa sổ (`WIN-PREVIEW`) nên dịch vụ trên Preview ném.
    const svc = new VaultReadService("Preprod", scopes, new RecordedChainReader(
      { [SYNTH_ADDRESS]: [synthUtxo({ txHash: "6b".repeat(32), datumHex: hex })] }, PREPROD_TIP_AT_BATCH_EPOCH,
    ));
    const out = await svc.read({ owner, atEpoch: 20n });
    const b = JSON.parse(JSON.stringify(toJsonBody(out))) as { vaults: Record<string, unknown>[] };
    expect(b.vaults).toHaveLength(1);
    return b.vaults[0]!;
  }

  it("két Instant: tiền là chuỗi chữ số, epoch là số, cửa sổ 7 ô chuỗi", async () => {
    const v = await body(TV_DATUM_V2_FULL.cbor, FULL_OWNER, "Instant");
    expect(v.datum_kind).toBe("Instant");
    expect(v.wakeme_link).toBe("ef".repeat(32));
    expect(v.cap_epoch).toBe(20);
    expect(v.cap_nanogic).toBe("123456789012");
    expect(v.instant_unlock_ms).toBe("1730000000000");
    expect(v.usage_window_epoch).toBe(20);
    expect(v.usage_window).toEqual(TV_DATUM_V2_FULL.value.usage_window.map(w => ({
      generated_nanogic: w.generated.toString(), consumed_nanogic: w.consumed.toString(),
    })));
    const g = (v.gen_schedules as Record<string, unknown>[])[0]!;
    expect(g.m_per_epoch_nanogic).toBeNull();
    expect(g.usage_factor_locked_q).toBeNull();
  });

  it("CẶP — két Schedule: bốn ô chỉ-Instant là null, lịch mang m_per_epoch_nanogic chuỗi", async () => {
    const v = await body(SCHEDULE_V2_ONE_SCHEDULE_HEX, SCHED_OWNER, "Schedule");
    expect(v.datum_kind).toBe("Schedule");
    expect(v.wakeme_link).toBeNull();
    expect(v.cap_epoch).toBeNull();
    expect(v.cap_nanogic).toBeNull();
    expect(v.instant_unlock_ms).toBeNull();
    expect(v.usage_window_epoch).toBe(100);
    const g = (v.gen_schedules as Record<string, unknown>[])[0]!;
    expect(g.m_per_epoch_nanogic).toBe("3000000000");
    expect(g.usage_factor_locked_q).toBe("750000000");
  });
});
