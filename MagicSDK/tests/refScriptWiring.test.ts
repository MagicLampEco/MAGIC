// MagicSDK/tests/refScriptWiring.test.ts — DÂY NỐI, không phải cái cổng.
//
// ══ VÌ SAO TỆP NÀY TỒN TẠI, TÁCH KHỎI `refScript.test.ts` ═════════════════════
// Hai thứ khác nhau, và bộ kiểm cũ chỉ ghim một:
//
//   `refScript.test.ts`   canh HÀM `assertRefScriptMatches` làm đúng việc của nó
//   tệp này               canh CHỖ GỌI thật sự gọi nó, và thật sự đi `readFrom`
//
// Phép đột biến đo được: gỡ TRỌN nhánh `readFrom` khỏi `withdrawLamp.ts` và
// `updateProfile.ts` — `tsc --noEmit` vẫn 0, và toàn bộ bộ kiểm vẫn XANH. Tức
// hàm canh được ghim chắc, còn dây nối thì không có gì ghim: một lần viết lại gỡ
// `.readFrom` đi sẽ không có màu đỏ nào, và lỗi chỉ lộ ra ở vault thật đã tích
// dữ liệu — tức người dùng có nhiều tài sản nhất, trên nhánh DUY NHẤT đưa LAMP
// rời vault (I-ACT-7).
//
// Cách ghim: một `lucid` giả ghi lại mọi phương thức được gọi trên trình dựng.
// Không cần Emulator, không cần mạng — thứ cần khẳng định là HÌNH DẠNG giao dịch
// mà SDK yêu cầu, không phải việc chuỗi có nhận nó không.
// ══════════════════════════════════════════════════════════════════════════════

import { Data, type LucidEvolution, type UTxO, type Validator } from "@lucid-evolution/lucid";
import { msPerEpoch, posixMsToEpoch } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { withdrawLamp } from "../src/withdrawLamp.js";
import { updateProfile } from "../src/updateProfile.js";
import { ACCEPT_INLINE_SCRIPT_CEILING } from "../src/refScript.js";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";
import { InstantVaultDatumSchema, VaultDatumSchema } from "../src/schemas.js";

const OWNER_PKH = "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21";
const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";

// Mốc thời gian ghim cứng, và epoch của vault SUY RA từ nó — đừng gõ hai con số
// rồi hy vọng chúng khớp: `posixMsToEpoch` có gốc riêng theo mạng, nên một cặp
// gõ tay sẽ lệch và bài kiểm chết ở cổng cooldown chứ không ở chỗ đang đo.
const TIP_MS = 60n * msPerEpoch("Preview");
const CUR_EPOCH = posixMsToEpoch(TIP_MS, "Preview");

const VAULT_SCRIPT: Validator = { type: "PlutusV3", script: "4746010000222220" };
const OTHER_SCRIPT: Validator = { type: "PlutusV3", script: "49480100002221200101" };

/** plutus.json tối thiểu — chỉ đủ để `resolveConstrIndex` tra ra chỉ số redeemer. */
const PLUTUS_JSON = {
  validators: [{
    title: "vault.vault.spend",
    redeemer: { schema: { $ref: "#/definitions/vault~1VaultRedeemer" } },
  }],
  definitions: {
    "vault/VaultRedeemer": {
      anyOf: [
        { title: "InstantGen",    index: 0, fields: [] },
        { title: "BurnBatch",     index: 1, fields: [] },
        { title: "WithdrawLamp",  index: 2, fields: [] },
        { title: "UpdateProfile", index: 3, fields: [] },
      ],
    },
  },
} as never;

/**
 * UTxO vault mẫu. `kind` BẮT BUỘC, không có mặc định — và đó là điểm chính.
 *
 * Hai hình dạng datum khác số trường (Instant 18 · Schedule 17), mà giải mã Plutus
 * Data nghiêm ngặt về số trường ở cả hai chiều. Một fixture đoán hộ hình dạng sẽ làm
 * bài kiểm đỏ vì FIXTURE chứ không vì mã, và người đọc bảng đỏ đi sửa nhầm chỗ. Bắt
 * khai ra thì người viết bài phải trả lời "đường này chạm loại vault nào" — câu mà
 * chính `updateProfile` (chỉ Instant) và `withdrawLamp` (cả hai) trả lời khác nhau.
 */
function vaultUtxo(kind: "Instant" | "Schedule"): UTxO {
  const common = buildInitialVaultDatum({
    ownerPkh:           OWNER_PKH,
    lampBalanceOildrop: 1_000_000_000n,
    profile:            "Flame",
    currentEpoch:       CUR_EPOCH > 10n ? CUR_EPOCH - 10n : 0n,
  });
  const datum = kind === "Instant" ? { ...common, instant_unlock_ms: 0n } : common;
  const schema = kind === "Instant" ? InstantVaultDatumSchema : VaultDatumSchema;
  return {
    txHash: "bb".repeat(32), outputIndex: 0,
    address: "addr_test1wqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahga0t3ee",
    assets: { lovelace: 20_000_000n, [`${LAMP_POLICY}744c414d50`]: 1_000_000_000n },
    datum: Data.to(datum as never, schema),
    datumHash: null, scriptRef: null,
  } as UTxO;
}

function refUtxo(carries: Validator): UTxO {
  return {
    txHash: "cc".repeat(32), outputIndex: 0,
    address: "addr_test1wqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahga0t3ee",
    assets: { lovelace: 20_000_000n },
    datum: null, datumHash: null, scriptRef: carries,
  } as UTxO;
}

/** `lucid` giả: ghi tên mọi phương thức được gọi trên trình dựng giao dịch. */
function recordingLucid() {
  const calls:     string[] = [];
  const readInputs: UTxO[]  = [];
  const builder: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(builder, {
    get(_t, prop) {
      if (prop === "attach") {
        return {
          SpendingValidator: () => { calls.push("attach.SpendingValidator"); return proxy; },
          MintingPolicy:     () => { calls.push("attach.MintingPolicy");     return proxy; },
        };
      }
      if (prop === "pay") {
        return {
          ToAddressWithData: () => { calls.push("pay.ToAddressWithData"); return proxy; },
          ToAddress:         () => { calls.push("pay.ToAddress");         return proxy; },
        };
      }
      if (prop === "readFrom") {
        return (us: UTxO[]) => { calls.push("readFrom"); readInputs.push(...us); return proxy; };
      }
      if (prop === "complete") {
        return async () => ({ __fakeTxSignBuilder: true });
      }
      if (prop === "then") return undefined;   // đừng để ai `await` nhầm trình dựng
      return () => { calls.push(String(prop)); return proxy; };
    },
  });
  const lucid = { newTx: () => proxy } as unknown as LucidEvolution;
  return { lucid, calls, readInputs };
}

const baseWithdraw = {
  amountOildrop:   1_000_000n,
  vaultScript:     VAULT_SCRIPT,
  vaultType:       "Instant" as const,
  vaultPlutusJson: PLUTUS_JSON,
  network:         "Preview" as const,
  lampPolicyId:    LAMP_POLICY,
  destinationAddress: "addr_test1vqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahgwq9x0u",
};

describe("dây nối CIP-33 — withdrawLamp", () => {
  it("🔴 có ref UTxO ⟹ ĐỌC nó (`readFrom`) và KHÔNG nhét script inline", async () => {
    const { lucid, calls, readInputs } = recordingLucid();
    const ref = refUtxo(VAULT_SCRIPT);

    await withdrawLamp({
      ...baseWithdraw, lucid, vaultUtxo: vaultUtxo("Schedule"),
      vaultRefScriptUtxo: ref, tipPosixMs: TIP_MS,
    } as never);

    // Hai vế NGƯỢC DẤU, cần cả hai: chỉ khẳng định "có readFrom" thì một đột biến
    // để lại CẢ HAI đường vẫn xanh, mà giao dịch đó vẫn chở trọn script.
    expect(calls).toContain("readFrom");
    expect(calls).not.toContain("attach.SpendingValidator");
    expect(readInputs.map((u) => `${u.txHash}#${u.outputIndex}`))
      .toEqual([`${ref.txHash}#${ref.outputIndex}`]);
  });

  it("🔴 ref UTxO mang script KHÁC ⟹ NÉM trước khi dựng, không để người dùng ký", async () => {
    const { lucid, calls } = recordingLucid();
    await expect(withdrawLamp({
      ...baseWithdraw, lucid, vaultUtxo: vaultUtxo("Schedule"),
      vaultRefScriptUtxo: refUtxo(OTHER_SCRIPT), tipPosixMs: TIP_MS,
    } as never)).rejects.toThrow(/REFSCRIPT-002/);
    // Ném TRƯỚC khi chạm trình dựng: một lỗi sau `complete()` thì người dùng đã
    // thấy một giao dịch hợp lệ về hình dạng rồi.
    expect(calls).not.toContain("readFrom");
  });

  it("chọn đường inline TƯỜNG MINH ⟹ nhét script, và KHÔNG readFrom", async () => {
    const { lucid, calls } = recordingLucid();
    await withdrawLamp({
      ...baseWithdraw, lucid, vaultUtxo: vaultUtxo("Schedule"),
      vaultRefScriptUtxo: ACCEPT_INLINE_SCRIPT_CEILING, tipPosixMs: TIP_MS,
    } as never);
    expect(calls).toContain("attach.SpendingValidator");
    expect(calls).not.toContain("readFrom");
  });
});

describe("dây nối CIP-33 — updateProfile", () => {
  const baseUpdate = {
    newProfile:      "Ember" as const,
    vaultScript:     VAULT_SCRIPT,
    vaultType:       "Instant" as const,
    vaultPlutusJson: PLUTUS_JSON,
    network:         "Preview" as const,
  };

  it("🔴 có ref UTxO ⟹ ĐỌC nó và KHÔNG nhét script inline", async () => {
    const { lucid, calls, readInputs } = recordingLucid();
    const ref = refUtxo(VAULT_SCRIPT);

    await updateProfile({
      ...baseUpdate, lucid, vaultUtxo: vaultUtxo("Instant"),
      vaultRefScriptUtxo: ref, tipPosixMs: TIP_MS,
    } as never);

    expect(calls).toContain("readFrom");
    expect(calls).not.toContain("attach.SpendingValidator");
    expect(readInputs).toHaveLength(1);
  });

  it("🔴 ref UTxO KHÔNG mang scriptRef ⟹ NÉM, nêu đúng nhánh gọi", async () => {
    const { lucid } = recordingLucid();
    const bare = { ...refUtxo(VAULT_SCRIPT), scriptRef: null } as UTxO;
    await expect(updateProfile({
      ...baseUpdate, lucid, vaultUtxo: vaultUtxo("Instant"),
      vaultRefScriptUtxo: bare, tipPosixMs: TIP_MS,
    } as never)).rejects.toThrow(/REFSCRIPT-001[\s\S]*UpdateProfile|UpdateProfile[\s\S]*REFSCRIPT-001/);
  });
});
