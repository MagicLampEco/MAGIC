// MagicSDK/tests/createVaultInstantZeroLamp.test.ts — két Instant mở với 0 LAMP + `wakeme_link`
// khai sẵn lúc genesis (2026-10-02).
//
// Đối chiếu on-chain: `InstantGen/onchain/validators/vault.ak` ▸ `validate_mint_vault_id` —
// `lamp_balance == LAMP thật trong output` (không ép > 0), `sum_holdings == lamp_balance`, và
// `wakeme_link` rỗng HOẶC đúng 32 byte. Bài Aiken cùng hình dạng: `np_mint_genesis_zero_lamp_ok`
// (`loyalty_holdings: []`), `np_journey_mint_zero_lamp_linked_ok`.
//
// Mỗi luật có CẶP ca: Instant 0 ⟹ qua; Schedule 0 ⟹ ném. Link 32 byte ⟹ vào datum; 31/33 byte ⟹
// ném. Một hiện thực "luôn cho 0" hay "luôn bỏ link" đỏ ở một vế.

import { Data, validatorToScriptHash, type LucidEvolution, type UTxO, type Validator } from "@lucid-evolution/lucid";
import { epochStartMs } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { createVault } from "../src/createVault.js";
import { ACCEPT_INLINE_SCRIPT_CEILING } from "../src/refScript.js";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";
import { InstantVaultDatumSchema } from "../src/schemas.js";

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const LAMP_UNIT = `${LAMP_POLICY}744c414d50`;
const TIP_MS = epochStartMs(60n, "Preprod");
const PKH = "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21";
const LINK = "c1".repeat(32);
const VAULT_SCRIPT: Validator = { type: "PlutusV3", script: "4746010000222220" };

/** Trình dựng ghi lại tên + tham số mọi lượt gọi (cùng khuôn `ownerScript.test.ts`). */
function recordingLucid(walletUtxos: UTxO[]) {
  const calls: Array<[string, unknown[]]> = [];
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === "attach" || prop === "pay") {
        return new Proxy({}, { get(_x, sub) { return (...a: unknown[]) => { calls.push([`${String(prop)}.${String(sub)}`, a]); return proxy; }; } });
      }
      if (prop === "complete") return async () => ({ __fake: true });
      return (...a: unknown[]) => { calls.push([String(prop), a]); return proxy; };
    },
  });
  const lucid = {
    newTx: () => proxy,
    wallet: () => ({
      address: async () => "addr_test1vqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahgwq9x0u",
      getUtxos: async () => walletUtxos,
    }),
  } as unknown as LucidEvolution;
  const argsOf = (n: string) => calls.filter(c => c[0] === n).map(c => c[1]);
  return { lucid, argsOf };
}

/** Ví KHÔNG có LAMP — đúng người mới. */
const adaOnlyWallet = {
  txHash: "dd".repeat(32), outputIndex: 0,
  address: "addr_test1vqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahgwq9x0u",
  assets: { lovelace: 50_000_000n },
  datum: null, datumHash: null, scriptRef: null,
} as UTxO;

const base = (vaultType: "Instant" | "Schedule") => ({
  vaultType,
  protocol: { network: "Preprod" as const, lampPolicyId: LAMP_POLICY },
  appliedVault: { script: VAULT_SCRIPT, expectedScriptHash: validatorToScriptHash(VAULT_SCRIPT) },
  vaultRefScriptUtxo: ACCEPT_INLINE_SCRIPT_CEILING,
  tipPosixMs: TIP_MS,
});

function vaultOutput(r: ReturnType<typeof recordingLucid>) {
  const out = r.argsOf("pay.ToAddressWithData")[0]!;
  return {
    datum: Data.from((out[1] as { value: string }).value, InstantVaultDatumSchema) as unknown as {
      lamp_balance: bigint; loyalty_holdings: unknown[]; wakeme_link: string;
    },
    assets: out[2] as Record<string, bigint>,
  };
}

describe("buildInitialVaultDatum — 0 LAMP + wakeme_link", () => {
  const common = { ownerPkh: PKH, profile: "Flame" as const, currentEpoch: 60n };

  it("Instant 0 LAMP ⟹ lamp_balance 0, KHÔNG holding nào (genesis: tổng holding == 0)", () => {
    const d = buildInitialVaultDatum({ ...common, lampBalanceOildrop: 0n, vaultType: "Instant" });
    expect(d.lamp_balance).toBe(0n);
    expect(d.loyalty_holdings).toEqual([]);
    expect(d.wakeme_link).toBe("");
  });

  it("CỰC ĐỐI: Schedule 0 LAMP ⟹ NÉM (két Schedule không nạp được LAMP sau genesis)", () => {
    expect(() => buildInitialVaultDatum({ ...common, lampBalanceOildrop: 0n, vaultType: "Schedule" }))
      .toThrow(/lampDeposit must be > 0 oildrop for Schedule/);
  });

  it("LAMP âm ⟹ NÉM ở cả hai loại két", () => {
    expect(() => buildInitialVaultDatum({ ...common, lampBalanceOildrop: -1n, vaultType: "Instant" })).toThrow(/lampDeposit/);
    expect(() => buildInitialVaultDatum({ ...common, lampBalanceOildrop: -1n, vaultType: "Schedule" })).toThrow(/lampDeposit/);
  });

  it("link 32 byte ⟹ vào đúng ô wakeme_link; chữ hoa được chuẩn hoá về thường", () => {
    const d = buildInitialVaultDatum({ ...common, lampBalanceOildrop: 0n, vaultType: "Instant", wakemeLink: LINK.toUpperCase() });
    expect(d.wakeme_link).toBe(LINK);
    // Bytes đi qua lược đồ: ô 6 (`wakeme_link`) mang đúng 32 byte.
    const cbor = Data.to(d as never, InstantVaultDatumSchema);
    expect(cbor).toContain(`5820${LINK}`);
  });

  it.each([["31 byte", "c1".repeat(31)], ["33 byte", "c1".repeat(33)], ["không phải hex", "zz".repeat(32)]])(
    "link %s ⟹ NÉM (genesis chỉ nhận rỗng hoặc đúng 32 byte)", (_n, bad) => {
      expect(() => buildInitialVaultDatum({ ...common, lampBalanceOildrop: 0n, vaultType: "Instant", wakemeLink: bad }))
        .toThrow(/wakemeLink phải rỗng hoặc đúng 32 byte/);
    });

  it("link cho két Schedule ⟹ NÉM (két Schedule không có trường này)", () => {
    expect(() => buildInitialVaultDatum({ ...common, lampBalanceOildrop: 1n, vaultType: "Schedule", wakemeLink: LINK }))
      .toThrow(/chỉ có ở két Instant/);
  });
});

describe("createVault — két Instant 0 LAMP từ ví không có LAMP", () => {
  it("dựng được: output két KHÔNG mang mục LAMP (không có mục số lượng 0), datum 0 + link", async () => {
    const r = recordingLucid([adaOnlyWallet]);
    const res = await createVault({ ...base("Instant"), lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 0n, wakemeLink: LINK } } as never);
    const o = vaultOutput(r);
    expect(o.datum.lamp_balance).toBe(0n);
    expect(o.datum.loyalty_holdings).toEqual([]);
    expect(o.datum.wakeme_link).toBe(LINK);
    expect(Object.keys(o.assets)).not.toContain(LAMP_UNIT);
    expect(o.assets[res.vaultIdUnit]).toBe(1n);
    expect(o.assets.lovelace! > 0n).toBe(true);
  });

  it("CỰC ĐỐI: Instant 1 oildrop từ cùng ví ⟹ NÉM vì ví không có LAMP (phép kiểm số dư vẫn chạy)", async () => {
    const r = recordingLucid([adaOnlyWallet]);
    await expect(createVault({ ...base("Instant"), lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 1n } } as never))
      .rejects.toThrow(/Wallet has 0 oildrop LAMP/);
  });

  it("CỰC ĐỐI: Schedule 0 LAMP ⟹ NÉM trước khi chạm ví", async () => {
    const r = recordingLucid([adaOnlyWallet]);
    await expect(createVault({ ...base("Schedule"), lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 0n } } as never))
      .rejects.toThrow(/lampDeposit must be > 0 oildrop for Schedule/);
    expect(r.argsOf("pay.ToAddressWithData")).toHaveLength(0);
  });

  it("link cho két Schedule ⟹ NÉM", async () => {
    const r = recordingLucid([adaOnlyWallet]);
    await expect(createVault({ ...base("Schedule"), lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 1n, wakemeLink: LINK } } as never))
      .rejects.toThrow(/chỉ có ở két Instant/);
  });
});
