// VaultReadAPI/tests/prepaidView.test.ts — két PrepaidGen: datum thật ⟹ đúng số; datum sai
// lược đồ ⟹ 502; cấu hình `vault_type: "Prepaid"` nạp được.
//
// Datum mẫu mã hoá bằng CHÍNH codec của PrepaidGen (`encodeVaultDatum`), không gõ tay CBOR:
// lược đồ bên đó đổi thì mẫu đổi theo và bài kiểm nói ra. Mỗi khẳng định đi thành CẶP.

import { describe, expect, it } from "vitest";
import { encodeVaultDatum, type PrepaidVaultDatum } from "@magiclamp/prepaidgen-sdk";

import { RecordedChainReader } from "../src/chain.js";
import { parseScopes, type VaultScope } from "../src/config.js";
import { VaultDatumUndecodableError, VaultReadError } from "../src/errors.js";
import { readPrepaidVaultsFromUtxos } from "../src/prepaidView.js";
import { VaultReadService, toJsonBody } from "../src/service.js";
import { readVaultsFromUtxos } from "../src/vaultView.js";
import { TV_DATUM_V2_FULL } from "./fixtures/genV2.js";
import { PREPROD_TIP_AT_BATCH_EPOCH, PREVIEW_VAULT_ADDRESS } from "./fixtures/preview-e5fd34b1.js";
import {
  SYNTH_ADDRESS, SYNTH_OTHER_OWNER, SYNTH_OWNER, SYNTH_SCRIPT_HASH, synthDatumHex, synthUtxo,
} from "./fixtures/synthetic.js";

const FUND_ID = "f0".repeat(28);

// Số chọn sao cho available / accrued / expired / một batch đôi một KHÁC nhau — gỡ bộ lọc
// `live` hay gỡ phép cộng đều ra một con số khác cả ba.
const LIVE_AMT = 1_750_000_000n;   // lô epoch 20 (đang sống ở epoch 20)
const DEAD_AMT = 300_000_000n;     // lô epoch 19 (đã chết ở epoch 20)

function prepaidDatum(over: Partial<PrepaidVaultDatum> = {}): PrepaidVaultDatum {
  return {
    owner: { VerificationKey: [SYNTH_OWNER] },
    did_commit: "d1".repeat(32),
    prepaid_credits: [{
      fund_id: FUND_ID,
      remaining: 7_000_000_000n,
      issued_epoch: 18n,
      last_draw_epoch: 20n,
      consumed_unsettled: 250_000_000n,
    }],
    magic_batches: [
      { batch_id: "b0".repeat(32), source: 3n, created_epoch: 19n, current_amount: DEAD_AMT,
        decay_window: 1n, profile_at_creation: 0n, contract_id: FUND_ID },
      { batch_id: "b1".repeat(32), source: 3n, created_epoch: 20n, current_amount: LIVE_AMT,
        decay_window: 1n, profile_at_creation: 0n, contract_id: FUND_ID },
    ],
    next_batch_index: 2n,
    personal_delegate: null,
    last_updated_epoch: 20n,
    attribution: { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
    ...over,
  } as PrepaidVaultDatum;
}

const PREPAID_HEX = encodeVaultDatum(prepaidDatum());

function readOne(hex: string, atEpoch = 20n) {
  const r = readPrepaidVaultsFromUtxos(
    [synthUtxo({ txHash: "7c".repeat(32), datumHex: hex })], SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, SYNTH_OWNER, atEpoch,
  );
  expect(r.ignored).toEqual([]);
  expect(r.vaults).toHaveLength(1);
  return r.vaults[0]!;
}

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  throw new Error("không ném");
}

describe("két Prepaid — datum thật (codec PrepaidGen) ⟹ đúng số", () => {
  const v = readOne(PREPAID_HEX);

  it("available = Σ lô còn sống, accrued = Σ mọi lô, expired = hiệu", () => {
    expect(v.vaultKind).toBe("Prepaid");
    expect(v.datumKind).toBe("Prepaid");
    expect(v.availableNanogic).toBe(LIVE_AMT);
    expect(v.accruedNanogic).toBe(LIVE_AMT + DEAD_AMT);
    expect(v.expiredNanogic).toBe(DEAD_AMT);
    expect(v.batches.map(b => [b.createdEpoch, b.live])).toEqual([[19n, false], [20n, true]]);
    expect(v.batches.every(b => b.initialAmountNanogic === null && b.source === "Prepaid")).toBe(true);
    expect(v.batches[1]!.expiresAtEpoch).toBe(21n);
    expect(v.batches[1]!.contractId).toBe(FUND_ID);
  });

  it("dòng hạn mức đi ra nguyên giá trị datum", () => {
    expect(v.prepaidCredits).toEqual([{
      fundId: FUND_ID, remainingCarpdrop: 7_000_000_000n, issuedEpoch: 18n, lastDrawEpoch: 20n,
      consumedUnsettledNanogic: 250_000_000n,
    }]);
    expect(v.owner).toEqual({ type: "key", hash: SYNTH_OWNER });
    expect(v.ownerPkh).toBe(SYNTH_OWNER);
    expect(v.lastUpdatedEpoch).toBe(20n);
  });

  it("CẶP — at_epoch 19: lô epoch 19 sống, lô epoch 20 KHÔNG (luật C-PP-5, không phải isBatchExpired)", () => {
    // `isBatchExpired` của SDK cho lô epoch 20 là "sống" ở epoch 19 (19 − 20 < 1). Két Prepaid
    // chỉ cho đốt lô `created_epoch == current_epoch` ⟹ ở epoch 19 chỉ lô 19 tiêu được.
    const at19 = readOne(PREPAID_HEX, 19n);
    expect(at19.availableNanogic).toBe(DEAD_AMT);
    expect(at19.batches.map(b => b.live)).toEqual([true, false]);
    expect(at19.availableNanogic).not.toBe(v.availableNanogic);
  });

  it("CẶP — chủ khác ⟹ OWNER_MISMATCH (cổng chung), không NFT ⟹ NO_VAULT_ID_NFT", () => {
    const other = encodeVaultDatum(prepaidDatum({ owner: { VerificationKey: [SYNTH_OTHER_OWNER] } }));
    const r = readPrepaidVaultsFromUtxos([
      synthUtxo({ txHash: "01".repeat(32), datumHex: other, vaultIdAssetNameSeed: "e1" }),
      synthUtxo({ txHash: "02".repeat(32), datumHex: PREPAID_HEX, vaultIdAssetNameSeed: null }),
      synthUtxo({ txHash: "03".repeat(32), datumHex: PREPAID_HEX, vaultIdAssetNameSeed: "e3" }),
    ], SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, SYNTH_OWNER, 20n);
    expect(r.vaults.map(x => x.utxoRef)).toEqual([`${"03".repeat(32)}#0`]);
    expect(r.ignored).toEqual([
      { utxoRef: `${"01".repeat(32)}#0`, reason: "OWNER_MISMATCH" },
      { utxoRef: `${"02".repeat(32)}#0`, reason: "NO_VAULT_ID_NFT" },
    ]);
  });
});

describe("datum sai lược đồ ⟹ NÉM 502, không nuốt", () => {
  it("datum két Instant ở địa chỉ khai Prepaid ⟹ VAULT_DATUM_UNDECODABLE", () => {
    const e = thrown(() => readOne(TV_DATUM_V2_FULL.cbor));
    expect(e).toBeInstanceOf(VaultDatumUndecodableError);
    expect((e as VaultReadError).httpStatus).toBe(502);
    expect((e as VaultReadError).code).toBe("VAULT_DATUM_UNDECODABLE");
  });

  it("CẶP — cùng datum Instant ở scope Instant đọc được (ca trên đỏ vì LƯỢC ĐỒ, không vì UTxO)", () => {
    const r = readVaultsFromUtxos(
      [synthUtxo({ txHash: "7c".repeat(32), datumHex: TV_DATUM_V2_FULL.cbor })],
      SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, { type: "script", hash: "22".repeat(28) }, 20n, "Instant",
    );
    expect(r.vaults).toHaveLength(1);
  });

  it("chiều ngược: datum Prepaid ở scope Instant ⟹ cũng 502", () => {
    const e = thrown(() => readVaultsFromUtxos(
      [synthUtxo({ txHash: "7c".repeat(32), datumHex: PREPAID_HEX })],
      SYNTH_SCRIPT_HASH, SYNTH_ADDRESS, SYNTH_OWNER, 20n, "Instant",
    ));
    expect(e).toBeInstanceOf(VaultDatumUndecodableError);
  });

  it("lô mang source ≠ 3 hoặc decay_window ≠ 1 ⟹ NÉM (hằng validator ép lúc Draw)", () => {
    const base = prepaidDatum().magic_batches[1]!;
    const badSource = encodeVaultDatum(prepaidDatum({ magic_batches: [{ ...base, source: 2n }] }));
    const badDecay = encodeVaultDatum(prepaidDatum({ magic_batches: [{ ...base, decay_window: 2n }] }));
    expect(thrown(() => readOne(badSource))).toBeInstanceOf(VaultDatumUndecodableError);
    expect(thrown(() => readOne(badDecay))).toBeInstanceOf(VaultDatumUndecodableError);
    // Cực đối: chỉ khác đúng trường đó ⟹ đọc được.
    expect(readOne(encodeVaultDatum(prepaidDatum({ magic_batches: [base] }))).availableNanogic).toBe(LIVE_AMT);
  });
});

describe("cấu hình + thân bài JSON", () => {
  it("`vault_type: \"Prepaid\"` nạp được; giá trị lạ vẫn bị từ chối", () => {
    const ok = JSON.stringify([{ vault_type: "Prepaid", address: PREVIEW_VAULT_ADDRESS, source: "x" }]);
    expect(parseScopes(ok, "Preview")[0]!.vaultType).toBe("Prepaid");
    const bad = JSON.stringify([{ vault_type: "PrepaidGen", address: PREVIEW_VAULT_ADDRESS, source: "x" }]);
    expect(() => parseScopes(bad, "Preview")).toThrow(/không thuộc tập đóng/);
  });

  async function body(hex: string, kind: "Instant" | "Prepaid", owner: { type: "key" | "script"; hash: string }) {
    const scopes: VaultScope[] = [{ vaultType: kind, address: SYNTH_ADDRESS, scriptHash: SYNTH_SCRIPT_HASH, source: "vector" }];
    const svc = new VaultReadService("Preprod", scopes, new RecordedChainReader(
      { [SYNTH_ADDRESS]: [synthUtxo({ txHash: "6b".repeat(32), datumHex: hex })] }, PREPROD_TIP_AT_BATCH_EPOCH,
    ));
    const out = await svc.read({ owner, atEpoch: 20n });
    return JSON.parse(JSON.stringify(toJsonBody(out))) as {
      vaults: Record<string, unknown>[]; totals: Record<string, unknown>;
    };
  }

  it("két Prepaid: thân bài đúng từng ô (mẫu README lấy từ đây)", async () => {
    const b = await body(PREPAID_HEX, "Prepaid", { type: "key", hash: SYNTH_OWNER });
    expect(b.vaults[0]).toEqual({
      utxo_ref: `${"6b".repeat(32)}#0`,
      vault_kind: "Prepaid",
      datum_kind: "Prepaid",
      vault_address: SYNTH_ADDRESS,
      vault_id_unit: SYNTH_SCRIPT_HASH + "cd".repeat(32),
      owner: { type: "key", hash: SYNTH_OWNER },
      owner_pkh: SYNTH_OWNER,
      available_nanogic: "1750000000",
      accrued_nanogic: "2050000000",
      expired_nanogic: "300000000",
      consumed_credit_nanogic: null,
      lamp_balance_oildrop: null,
      lamp_locked_oildrop: null,
      profile: null,
      last_updated_epoch: 20,
      rate_locked_q: null,
      wakeme_link: null,
      cap_epoch: null,
      cap_nanogic: null,
      instant_unlock_ms: null,
      usage_window_epoch: null,
      usage_window: null,
      batches: [
        { batch_id: "b0".repeat(32), source: "Prepaid", created_epoch: 19, decay_window: 1, expires_at_epoch: 20,
          initial_amount_nanogic: null, current_amount_nanogic: "300000000", live: false, contract_id: FUND_ID },
        { batch_id: "b1".repeat(32), source: "Prepaid", created_epoch: 20, decay_window: 1, expires_at_epoch: 21,
          initial_amount_nanogic: null, current_amount_nanogic: "1750000000", live: true, contract_id: FUND_ID },
      ],
      gen_schedules: null,
      prepaid_credits: [{
        fund_id: FUND_ID, remaining_carpdrop: "7000000000", issued_epoch: 18, last_draw_epoch: 20,
        consumed_unsettled_nanogic: "250000000",
      }],
    });
    expect(b.totals.available_nanogic).toBe("1750000000");
  });

  it("CẶP — két Prepaid và két Instant mang CÙNG bộ khoá (vắng thì null, không vắng lỗ chỗ)", async () => {
    const p = await body(PREPAID_HEX, "Prepaid", { type: "key", hash: SYNTH_OWNER });
    const i = await body(TV_DATUM_V2_FULL.cbor, "Instant", { type: "script", hash: "22".repeat(28) });
    expect(Object.keys(p.vaults[0]!)).toEqual(Object.keys(i.vaults[0]!));
    expect(i.vaults[0]!.prepaid_credits).toBeNull();
    expect(i.vaults[0]!.consumed_credit_nanogic).not.toBeNull();
  });

  it("két Schedule cũ: thêm khoá prepaid_credits = null, mọi ô cũ giữ nguyên", async () => {
    const hex = synthDatumHex(SYNTH_OWNER, [{ id: "aa".repeat(32), createdEpoch: 20n, amountNanogic: 5n }]);
    const scopes: VaultScope[] = [{ vaultType: "Schedule", address: SYNTH_ADDRESS, scriptHash: SYNTH_SCRIPT_HASH, source: "v" }];
    const svc = new VaultReadService("Preprod", scopes, new RecordedChainReader(
      { [SYNTH_ADDRESS]: [synthUtxo({ txHash: "6c".repeat(32), datumHex: hex })] }, PREPROD_TIP_AT_BATCH_EPOCH,
    ));
    const b = toJsonBody(await svc.read({ owner: { type: "key", hash: SYNTH_OWNER }, atEpoch: 20n })) as {
      vaults: Record<string, unknown>[];
    };
    expect(b.vaults[0]!.prepaid_credits).toBeNull();
    expect(b.vaults[0]!.vault_kind).toBe("Schedule");
    expect(b.vaults[0]!.available_nanogic).toBe("5");
  });
});
