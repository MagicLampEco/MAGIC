// MagicSDK/tests/withdrawLampLockSum.test.ts — C-SCH-LOCKSUM (#132) ở nhánh rút LAMP.
//
// `ScheduleGen/onchain/validators/vault.ak` ▸ `validate_withdraw_lamp` ép
// `sum_locked(output.loyalty_holdings) == output.lamp_locked`. `withdrawLamp` gương nó bằng
// `@magiclamp/schedulegen-sdk` ▸ `assertLockSumMatches` — CHỈ cho két Schedule (két Instant
// không có đẳng thức này).
//
// Ba ca, vì một ca đơn lẻ xanh được ở cả hai cực:
//   · Schedule, datum vào nhất quán          ⟹ qua
//   · Schedule, lệch ĐÚNG 1 oildrop          ⟹ ném GEN-LOCK-SUM (đi qua cổng L_avail)
//   · Instant, cùng độ lệch                   ⟹ KHÔNG ném GEN-LOCK-SUM (cổng chỉ của Schedule)

import { Data, type LucidEvolution, type UTxO, type Validator } from "@lucid-evolution/lucid";
import { epochStartMs } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { withdrawLamp } from "../src/withdrawLamp.js";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";
import { InstantVaultDatumSchema, VaultDatumSchema } from "../src/schemas.js";
import { ACCEPT_INLINE_SCRIPT_CEILING } from "../src/refScript.js";

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const LAMP_UNIT = `${LAMP_POLICY}744c414d50`;
const TIP_MS = epochStartMs(60n, "Preprod");
const PKH = "a1".repeat(28);
const DEST = "addr_test1vqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahgwq9x0u";
const VAULT_SCRIPT: Validator = { type: "PlutusV3", script: "4746010000222220" };
const PLUTUS_JSON = {
  validators: [{ title: "vault.vault.spend", redeemer: { schema: { $ref: "#/definitions/vault~1VaultRedeemer" } } }],
  definitions: {
    "vault/VaultRedeemer": {
      anyOf: [
        { title: "InstantGen", index: 0, fields: [] },
        { title: "BurnBatch", index: 1, fields: [] },
        { title: "WithdrawLamp", index: 2, fields: [] },
        { title: "UpdateProfile", index: 3, fields: [] },
      ],
    },
  },
} as never;

/** Trình dựng giả: mọi lượt gọi trả về chính nó, `complete` trả một đối tượng đánh dấu. */
function fakeLucid(): LucidEvolution {
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === "attach" || prop === "pay") {
        return new Proxy({}, { get() { return () => proxy; } });
      }
      if (prop === "complete") return async () => ({ __fake: true });
      return () => proxy;
    },
  });
  return {
    newTx: () => proxy,
    wallet: () => ({ address: async () => DEST, getUtxos: async () => [] }),
  } as unknown as LucidEvolution;
}

const LOCKED = 500_000_000n;
function vaultUtxo(kind: "Instant" | "Schedule", lockedSkew: bigint): UTxO {
  const d = {
    ...buildInitialVaultDatum({
      owner: { type: "key", hash: PKH }, lampBalanceOildrop: 1_000_000_000n, profile: "Flame",
      currentEpoch: 50n, vaultType: kind,
    }),
    lamp_locked: LOCKED + lockedSkew,
    loyalty_holdings: [
      { amount: LOCKED, acquired_epoch: 1n, is_locked: true },
      { amount: 1_000_000_000n - LOCKED, acquired_epoch: 2n, is_locked: false },
    ],
  };
  return {
    txHash: "bb".repeat(32), outputIndex: 0,
    address: "addr_test1wqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahga0t3ee",
    assets: { lovelace: 20_000_000n, [LAMP_UNIT]: 1_000_000_000n },
    datum: Data.to(d as never, kind === "Instant" ? InstantVaultDatumSchema : VaultDatumSchema),
    datumHash: null, scriptRef: null,
  } as UTxO;
}

const base = (kind: "Instant" | "Schedule", lockedSkew: bigint) => ({
  amountOildrop: 1_000_000n, vaultScript: VAULT_SCRIPT, vaultType: kind,
  vaultPlutusJson: PLUTUS_JSON, network: "Preprod" as const, lampPolicyId: LAMP_POLICY,
  destinationAddress: DEST, vaultRefScriptUtxo: ACCEPT_INLINE_SCRIPT_CEILING, tipPosixMs: TIP_MS,
  lucid: fakeLucid(), vaultUtxo: vaultUtxo(kind, lockedSkew),
}) as never;

async function msgOf(p: Promise<unknown>): Promise<string> {
  try { await p; return "KHÔNG NÉM"; } catch (e) { return (e as Error).message; }
}

describe("withdrawLamp — C-SCH-LOCKSUM", () => {
  it("Schedule, datum vào nhất quán ⟹ qua", async () => {
    expect(await msgOf(withdrawLamp(base("Schedule", 0n)))).toBe("KHÔNG NÉM");
  });
  it("Schedule, lamp_locked lệch ĐÚNG 1 oildrop ⟹ ném GEN-LOCK-SUM (withdrawLamp)", async () => {
    expect(await msgOf(withdrawLamp(base("Schedule", 1n)))).toMatch(/GEN-LOCK-SUM \(withdrawLamp\)/);
  });
  it("CỰC ĐỐI: Instant, cùng độ lệch ⟹ KHÔNG ném GEN-LOCK-SUM (cổng chỉ của Schedule)", async () => {
    expect(await msgOf(withdrawLamp(base("Instant", 1n)))).toBe("KHÔNG NÉM");
  });
});
