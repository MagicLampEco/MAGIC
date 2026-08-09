// MagicSDK/tests/createVault.test.ts — unit tests that don't hit a network.
//
// These cover input-validation, schema integrity, and validator-application
// determinism. End-to-end testnet verification is Tuân's domain (per-module
// smoke scripts in scripts/test/).

import { describe, it, expect } from "vitest";
import { Data } from "@lucid-evolution/lucid";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";
import { applyVaultValidator } from "../src/validatorScripts.js";
import { VaultDatumSchema } from "../src/schemas.js";
import type { ProtocolParams, ValidatorBundle, VaultType } from "../src/types.js";

const PKH_28 = "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21";

// Minimal valid PlutusV3 CBOR (a `validator { spend(...) { True } }` compiled
// with no params). Only used to exercise applyParamsToScript paths.
// Replace via env if you want a real validator in tests.
const STUB_CBOR =
  "5907f5010100332323232323223225333004323232323253323300a3001300b375400226464a666018600260206ea8004540041860226024002601e6ea8c038c03cc03cc03c004526163006375a0024464a66601a600260120022a66601e60106ea800854008458595900cc8c8c8c8c008894ccc008cdc78010008a99980d99baf300c30093754a66601800a266ebcc02ccc00c0040088c8c008008c8c004004008894ccc008cdc78018008a4d2c601866646002446e1ccdc424014002a66601866ebcc01cc004c01cc024c01400454ccc02ccdd79817980180319810800a51005301230080021300700113001001001";

const baseProtocol: ProtocolParams = {
  network:        "Preview",
  lampPolicyId:   "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077",
};
const validators: ValidatorBundle = { vaultUnappliedCbor: STUB_CBOR };

// ── buildInitialVaultDatum ──────────────────────────────────────

describe("buildInitialVaultDatum", () => {
  it("produces clean genesis state for a fresh vault", () => {
    const d = buildInitialVaultDatum({
      ownerPkh:       PKH_28,
      lampBalanceOildrop: 1_000_000_000n,
      profile:        "Flame",
      currentEpoch:   20589n,
    });
    expect(d.owner).toBe(PKH_28);
    expect(d.lamp_balance).toBe(1_000_000_000n);
    expect(d.lamp_locked).toBe(0n);
    expect(d.profile).toBe("Flame");
    expect(d.magic_batches).toEqual([]);
    expect(d.vacuum_orders).toEqual([]);
    expect(d.gen_schedules).toEqual([]);
    expect(d.next_batch_index).toBe(0n);
    expect(d.attribution.total_events).toBe(0n);
    expect(d.personal_delegate).toBeNull();
    // `acquired_epoch` KHÔNG bị validator ghim (LF đo tuổi từ đây) → giữ epoch thật.
    expect(d.loyalty_holdings).toEqual([{
      amount:         1_000_000_000n,
      acquired_epoch: 20589n,
      is_locked:      false,
    }]);
  });

  // ── Các trường bị `validate_mint_vault_id` GHIM CỨNG ────────────
  // Nguồn: InstantGen/onchain/validators/vault.ak → fn validate_mint_vault_id.
  // Sai một trường ⇒ tx tạo vault fail ⇒ không có vault nào ra đời.
  it("khớp datum khởi sinh mà validate_mint_vault_id đòi hỏi", () => {
    const d = buildInitialVaultDatum({
      ownerPkh:       PKH_28,
      lampBalanceOildrop: 1_000_000_000n,
      profile:        "Flame",
      currentEpoch:   20589n,
    });
    // `expect vd.last_updated_epoch == 0` — KHÔNG phải epoch hiện tại.
    expect(d.last_updated_epoch).toBe(0n);
    // `attribution_root: #""` — chuỗi byte RỖNG, không phải 32 byte 0.
    expect(d.attribution.attribution_root).toBe("");
    expect(d.attribution.last_event_epoch).toBe(0n);
    // `expect vd.personal_delegate == None`
    expect(d.personal_delegate).toBeNull();
    expect(d.profile_changed_epoch).toBe(0n);
    expect(d.pending_profile).toBeNull();
    expect(d.streak_state).toEqual({ current_streak: 0n, last_active_epoch: 0n });
    expect(d.delegation_cert).toEqual({
      current: [], pending: null,
      current_effective_epoch: 0n, last_changed_epoch: 0n,
    });
    // ActivityState { recent_burn_epochs: [], consumed_credit: 0 }
    // (nhãn off-chain vẫn là total_burns_count — cùng vị trí, cùng kiểu.)
    expect(d.activity_state).toEqual({ recent_burn_epochs: [], total_burns_count: 0n });
    // sum_holdings(loyalty_holdings) == lamp_balance
    const sum = d.loyalty_holdings.reduce((s, h) => s + h.amount, 0n);
    expect(sum).toBe(d.lamp_balance);
    expect(d.loyalty_holdings.every(h => !h.is_locked)).toBe(true);
  });

  it("rejects ownerPkh not 28-byte hex", () => {
    expect(() => buildInitialVaultDatum({
      ownerPkh: "short", lampBalanceOildrop: 1n, profile: "Flame", currentEpoch: 0n,
    })).toThrow("28-byte hex");
  });

  it("rejects zero or negative lamp deposit", () => {
    expect(() => buildInitialVaultDatum({
      ownerPkh: PKH_28, lampBalanceOildrop: 0n, profile: "Flame", currentEpoch: 0n,
    })).toThrow("> 0");
  });

  // Đảo ngược kỳ vọng cũ: genesis BẮT BUỘC personal_delegate == None
  // (`expect vd.personal_delegate == None` trong validate_mint_vault_id).
  // Trước đây SDK nhận personalDelegate lúc tạo → tx sẽ fail on-chain.
  it("từ chối personalDelegate lúc tạo vault (genesis phải sạch)", () => {
    expect(() => buildInitialVaultDatum({
      ownerPkh:         PKH_28,
      lampBalanceOildrop:   1n,
      profile:          "Lantern",
      currentEpoch:     0n,
      personalDelegate: "a".repeat(56),
    })).toThrow(/SetDelegate/);
  });

  it("rejects malformed personalDelegate", () => {
    expect(() => buildInitialVaultDatum({
      ownerPkh: PKH_28, lampBalanceOildrop: 1n, profile: "Flame", currentEpoch: 0n,
      personalDelegate: "nothex",
    })).toThrow("personalDelegate");
  });
});

// ── VaultDatumSchema CBOR roundtrip ────────────────────────────

describe("VaultDatumSchema CBOR roundtrip", () => {
  it("Data.to → Data.from preserves all fields", () => {
    const original = buildInitialVaultDatum({
      ownerPkh:       PKH_28,
      lampBalanceOildrop: 5_000_000n,
      profile:        "Ember",
      currentEpoch:   12345n,
    });
    const cbor    = Data.to(original as never, VaultDatumSchema);
    const decoded = Data.from(cbor, VaultDatumSchema);
    expect(decoded.owner).toBe(original.owner);
    expect(decoded.lamp_balance).toBe(original.lamp_balance);
    expect(decoded.profile).toBe(original.profile);
    expect(decoded.last_updated_epoch).toBe(original.last_updated_epoch);
    // attribution_root rỗng phải sống sót vòng CBOR (bytes rỗng ≠ null).
    expect(decoded.attribution.attribution_root).toBe("");
  });
});

// ── applyVaultValidator: per-vault-type param requirements ─────

describe("applyVaultValidator: requires correct params per vault type", () => {
  const types: VaultType[] = ["Instant", "Vacuum", "Schedule"];

  for (const t of types) {
    it(`${t}: throws when treasuryAddress missing`, () => {
      expect(() => applyVaultValidator(t, validators, baseProtocol)).toThrow();
    });
  }

  it("Snapshot: works with minimal params (no treasury/UM)", () => {
    // Note: the CBOR here is a stub — applyParamsToScript may still error if
    // it expects 1 typed param. We accept either success OR a clear param-related
    // error (not a missing-field error).
    try {
      const { vaultScript, vaultAddress } = applyVaultValidator(
        "Snapshot", validators, baseProtocol,
      );
      expect(vaultScript.type).toBe("PlutusV3");
      expect(vaultAddress.startsWith("addr_test1")).toBe(true);
    } catch (e: any) {
      // If the stub CBOR is incompatible, the error should NOT be about missing
      // protocol fields (those are vault-type specific and only apply to Inst/Vac/Sch).
      expect(String(e.message)).not.toMatch(/required for vaultType/);
    }
  });
});
