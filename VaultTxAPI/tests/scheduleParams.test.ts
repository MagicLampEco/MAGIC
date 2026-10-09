// VaultTxAPI/tests/scheduleParams.test.ts — `/health ▸ vault_scopes[].schedule_params` và `details.rule`.
//
// 1. `schedule_params` SINH từ hằng của ScheduleGen, không gõ tay. Bài so lời đáp THẬT của router với hai nguồn
//    đọc độc lập: (a) văn bản `ScheduleGen/onchain/lib/magiclamp/protocol/constants.ak` (hằng mà validator dùng),
//    (b) hằng off-chain `ScheduleGen/offchain/src/constants.ts`. Sửa một hằng ở bất kỳ bên nào mà không sửa bên kia
//    ⟹ đỏ. KHÔNG bài nào ở đây chứa số 10 / 200 / 2 / 1000000 làm giá trị kỳ vọng.
// 2. `details.rule`: lỗi có mã luật ở tiền tố `message` mang đúng mã đó ở `details.rule`, một chỗ chung (`errors.ts`).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_LAMP_PER_FIRE, SCHEDULE_DELAY, SCHEDULE_MAX_LENGTH, SCHEDULE_MIN_LENGTH,
} from "@magiclamp/schedulegen-sdk";
import { describe, expect, it } from "vitest";

import { BadRequestError, CodedApiError, TxBuildRejectedError, ruleOfMessage } from "../src/errors.js";
import { handle } from "../src/http.js";
import { scheduleParamsView } from "../src/scheduleParams.js";
import { consumeHarness } from "./support/contractHarness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSTANTS_AK = readFileSync(
  join(HERE, "../../ScheduleGen/onchain/lib/magiclamp/protocol/constants.ak"), "utf8");

/** `pub const <name> : Int = <số>` trong `constants.ak` — phép đọc độc lập với `constants.ts`. */
function akInt(name: string): bigint {
  const m = new RegExp(`^pub const ${name}\\s*:\\s*Int\\s*=\\s*([0-9_]+)`, "m").exec(CONSTANTS_AK);
  if (m === null) throw new Error(`constants.ak không có hằng Int \`${name}\``);
  return BigInt(m[1]!.replace(/_/g, ""));
}

describe("schedule_params — sinh từ hằng ScheduleGen", () => {
  it("hằng off-chain (constants.ts) trùng hằng validator (constants.ak), từng cặp", () => {
    expect(SCHEDULE_MIN_LENGTH).toBe(akInt("schedule_min_length"));
    expect(SCHEDULE_MAX_LENGTH).toBe(akInt("schedule_max_length"));
    expect(SCHEDULE_DELAY).toBe(akInt("schedule_delay"));
    expect(MIN_LAMP_PER_FIRE).toBe(akInt("min_lamp_per_fire"));
  });

  it("scheduleParamsView() = hằng nguồn; min_lamp_per_fire là CHUỖI chữ số (oildrop)", () => {
    const v = scheduleParamsView();
    expect(v).toEqual({
      min_length: Number(akInt("schedule_min_length")),
      max_length: Number(akInt("schedule_max_length")),
      delay_epochs: Number(akInt("schedule_delay")),
      min_lamp_per_fire: akInt("min_lamp_per_fire").toString(),
    });
    expect(typeof v.min_lamp_per_fire).toBe("string");
  });

  it("/health: mục Schedule mang schedule_params đúng hằng nguồn", async () => {
    const h = consumeHarness();
    const r = await handle({ method: "GET", url: "/health", headers: {}, body: undefined }, h.router);
    expect(r.status).toBe(200);
    const scopes = (r.body as { vault_scopes: Array<Record<string, unknown>> }).vault_scopes;
    const schedule = scopes.filter(s => s.vault_type === "Schedule");
    expect(schedule.length).toBeGreaterThan(0);
    for (const s of schedule) {
      expect(s.schedule_params).toEqual({
        min_length: Number(akInt("schedule_min_length")),
        max_length: Number(akInt("schedule_max_length")),
        delay_epochs: Number(akInt("schedule_delay")),
        min_lamp_per_fire: akInt("min_lamp_per_fire").toString(),
      });
    }
  });

  it("CẶP: mục không phải Schedule KHÔNG mang schedule_params", async () => {
    const h = consumeHarness();
    const router = { ...h.router, vaultScopes: [{ ...h.router.vaultScopes[0]!, vaultType: "Instant" as const }] };
    const r = await handle({ method: "GET", url: "/health", headers: {}, body: undefined }, router);
    const scopes = (r.body as { vault_scopes: Array<Record<string, unknown>> }).vault_scopes;
    expect(scopes.map(s => s.vault_type)).toEqual(["Instant"]);
    expect(scopes[0]).not.toHaveProperty("schedule_params");
  });
});

describe("details.rule — mã luật ở tiền tố message", () => {
  it("ruleOfMessage: nhận GEN-INST-001 / GEN-SCH-GB; bác thông điệp không có tiền tố luật", () => {
    expect(ruleOfMessage("GEN-INST-001: m vượt trần")).toBe("GEN-INST-001");
    expect(ruleOfMessage("GEN-SCH-GB: cần đúng 1 shard GB")).toBe("GEN-SCH-GB");
    expect(ruleOfMessage("Chủ không có vault")).toBeUndefined();
    expect(ruleOfMessage("GEN-INST-001 thiếu dấu hai chấm")).toBeUndefined();
    expect(ruleOfMessage("giữa câu GEN-INST-001: không phải tiền tố")).toBeUndefined();
    expect(ruleOfMessage("TX_BUILD: một từ đơn")).toBeUndefined();
  });

  it("MỌI lớp lỗi của dịch vụ: message giữ NGUYÊN, details.rule = mã, details cũ còn đó", () => {
    const e = new TxBuildRejectedError("GEN-INST-001: m = 5 vượt trần 3", { thrown_by: "Error" });
    expect(e.message).toBe("GEN-INST-001: m = 5 vượt trần 3");
    expect(e.details).toEqual({ thrown_by: "Error", rule: "GEN-INST-001" });
    expect(e.toBody().error.details.rule).toBe("GEN-INST-001");
    expect(new BadRequestError("GEN-SCH-000: không có lovelace").details).toEqual({ rule: "GEN-SCH-000" });
    expect(new CodedApiError(422, "X_CODE", "C-VAC-12: không huỷ giữa chừng").details.rule).toBe("C-VAC-12");
  });

  it("CẶP: không có tiền tố ⟹ details không có khoá rule; đã có details.rule (Feecover) ⟹ giữ cái có sẵn", () => {
    expect(new TxBuildRejectedError("Giao thức từ chối.").details).toEqual({});
    expect(new TxBuildRejectedError("Giao thức từ chối.").details).not.toHaveProperty("rule");
    const own = new CodedApiError(422, "FEE_PROXY_REJECTED", "GEN-INST-001: x", { rule: "FEECOVER-7" });
    expect(own.details.rule).toBe("FEECOVER-7");
  });
});
