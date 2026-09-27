// VaultTxAPI/tests/config.test.ts — các cổng FAIL-CLOSED lúc khởi động.
//
// Mỗi bài ở đây tương ứng một ca mà "cảnh báo rồi chạy tiếp" sẽ ra một dịch vụ khởi động
// XANH rồi dựng giao dịch SAI. Cổng phải chặn ở lúc khởi động, nơi người bị chặn là người
// vận hành — không phải ở lúc có yêu cầu, nơi người bị chặn là người dùng.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { createVault } from "@magiclamp/sdk";

import { loadConfig, parseDeployment } from "../src/config.js";
import { createVaultProtocol, enterpriseAddressOf } from "../src/txBuilder.js";
import {
  LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, OWNER_PKH, SHARD_ADDRESS, VAULT_ADDRESS,
} from "./fixtures/preview.js";

let blueprintPath = "";
let emptyBlueprintPath = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "vault-tx-api-"));
  blueprintPath = join(dir, "plutus.json");
  writeFileSync(blueprintPath, JSON.stringify({
    preamble: { compiler: { name: "Aiken", version: "v1.1.21" } },
    validators: [{ title: "vault.vault.spend", compiledCode: "59", hash: "aa".repeat(28) }],
  }));
  emptyBlueprintPath = join(dir, "empty.json");
  writeFileSync(emptyBlueprintPath, JSON.stringify({ preamble: {} }));
});

function deploymentJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    vaults: [{ vault_type: "Schedule", address: VAULT_ADDRESS }],
    shard_address: SHARD_ADDRESS,
    ref_script_utxos: {
      vault: `${"11".repeat(32)}#0`,
      shard: `${"22".repeat(32)}#1`,
      consume: `${"33".repeat(32)}#2`,
    },
    consume: {
      engage_address: VAULT_ADDRESS,
      price_beacon_address: VAULT_ADDRESS,
      price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
    },
    ...over,
  });
}

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    VAULT_TX_API_NETWORK: "Preview",
    BLOCKFROST_PROJECT_ID: "giá-trị-khoá-không-phải-đường-dẫn",
    VAULT_TX_API_DEPLOYMENT: deploymentJson(),
    VAULT_TX_API_CHANGE_ADDRESS_STRATEGY: "enterprise_from_owner_pkh",
    VAULT_TX_API_VAULT_PLUTUS_JSON: blueprintPath,
    ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v === undefined) delete base[k];
  return base as NodeJS.ProcessEnv;
}

describe("loadConfig — đường xanh", () => {
  it("nạp đủ và điền mặc định", () => {
    const c = loadConfig(env());
    expect(c.network).toBe("Preview");
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8788);
    expect(c.token).toBe("");
    expect(c.lockTtlMs).toBe(180_000);
    expect(c.deployment.vaults).toHaveLength(1);
    // script hash SUY TỪ địa chỉ, không cấu hình riêng — hai trường cho một sự thật là
    // hai trường sẽ lệch nhau.
    expect(c.deployment.vaults[0]!.scriptHash).toHaveLength(56);
  });
});

describe("loadConfig — cổng fail-closed", () => {
  it("thiếu biến bắt buộc ⟹ từ chối khởi động", () => {
    for (const name of [
      "VAULT_TX_API_NETWORK", "BLOCKFROST_PROJECT_ID", "VAULT_TX_API_DEPLOYMENT",
      "VAULT_TX_API_CHANGE_ADDRESS_STRATEGY", "VAULT_TX_API_VAULT_PLUTUS_JSON",
    ]) {
      expect(() => loadConfig(env({ [name]: undefined }))).toThrow(new RegExp(name));
    }
  });

  it("bind ra ngoài loopback mà thẻ bài rỗng ⟹ từ chối khởi động", () => {
    expect(() => loadConfig(env({ VAULT_TX_API_HOST: "0.0.0.0" }))).toThrow(/loopback/);
    expect(() => loadConfig(env({ VAULT_TX_API_HOST: "0.0.0.0", VAULT_TX_API_TOKEN: "x".repeat(32) })))
      .not.toThrow();
  });

  it("chiến lược địa chỉ tiền thừa KHÔNG có mặc định, và chỉ nhận tên đã biết", () => {
    expect(() => loadConfig(env({ VAULT_TX_API_CHANGE_ADDRESS_STRATEGY: "tuỳ_tiện" })))
      .toThrow(/CHANGE_ADDRESS_STRATEGY/);
  });

  it("blueprint không đọc được / không phải blueprint ⟹ từ chối khởi động", () => {
    expect(() => loadConfig(env({ VAULT_TX_API_VAULT_PLUTUS_JSON: "/không/có/thật.json" })))
      .toThrow(/không đọc được/);
    expect(() => loadConfig(env({ VAULT_TX_API_VAULT_PLUTUS_JSON: emptyBlueprintPath })))
      .toThrow(/validators/);
  });

  it("cổng số: PORT và TTL ngoài khoảng ⟹ ném", () => {
    expect(() => loadConfig(env({ VAULT_TX_API_PORT: "0" }))).toThrow(/PORT/);
    expect(() => loadConfig(env({ VAULT_TX_API_LOCK_TTL_MS: "10" }))).toThrow(/LOCK_TTL_MS/);
  });
});

describe("parseDeployment — bản chép phải mang nhãn và phải khớp MẠNG", () => {
  it("thiếu `source` ⟹ ném", () => {
    expect(() => parseDeployment(deploymentJson({ source: "   " }), "Preview")).toThrow(/source/);
  });

  it("CẶP: cấu hình cũ còn `consume.engage_nft_unit` ⟹ ném (không khởi động); bỏ khoá đó ⟹ nạp được", () => {
    const consume = {
      engage_address: VAULT_ADDRESS,
      price_beacon_address: VAULT_ADDRESS,
      price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
    };
    expect(() => parseDeployment(deploymentJson({
      consume: { ...consume, engage_nft_unit: `${"44".repeat(28)}deadbeef` },
    }), "Preview")).toThrow(/engage_nft_unit/);
    const d = parseDeployment(deploymentJson({ consume }), "Preview");
    // policy thread = script hash consume, SUY từ engage_address.
    expect(d.consume.engageScriptHash).toMatch(/^[0-9a-f]{56}$/);
    expect(d.feePayerCollateralLovelace).toBe(3_000_000n);
  });

  it("`consume.max_price_stale`: vắng ⟹ undefined; số / chuỗi thập phân ⟹ bigint; âm / chuỗi lạ ⟹ ném", () => {
    const consume = JSON.parse(deploymentJson()).consume;
    expect(parseDeployment(deploymentJson(), "Preview").consume.maxPriceStale).toBeUndefined();
    expect(parseDeployment(deploymentJson({ consume: { ...consume, max_price_stale: 2 } }), "Preview").consume.maxPriceStale).toBe(2n);
    expect(parseDeployment(deploymentJson({ consume: { ...consume, max_price_stale: "3" } }), "Preview").consume.maxPriceStale).toBe(3n);
    for (const bad of [-1, 1.5, "2 epoch", "", null]) {
      expect(() => parseDeployment(deploymentJson({ consume: { ...consume, max_price_stale: bad } }), "Preview"))
        .toThrow(/max_price_stale/);
    }
  });

  it("`fee_payer_collateral_lovelace`: chuỗi chữ số thì nhận; số JSON / chuỗi lạ ⟹ ném", () => {
    expect(parseDeployment(deploymentJson({ fee_payer_collateral_lovelace: "2500000" }), "Preview")
      .feePayerCollateralLovelace).toBe(2_500_000n);
    expect(() => parseDeployment(deploymentJson({ fee_payer_collateral_lovelace: 2500000 }), "Preview"))
      .toThrow(/fee_payer_collateral_lovelace/);
    expect(() => parseDeployment(deploymentJson({ fee_payer_collateral_lovelace: "3e6" }), "Preview"))
      .toThrow(/fee_payer_collateral_lovelace/);
  });

  it("tên tài sản LAMP phải khớp mạng (tLAMP testnet / LAMP mainnet)", () => {
    // `tLAMP` dưới nhãn Mainnet: apply-param #2 sai ⟹ vault mainnet không nhìn thấy LAMP
    // của chính nó. Cổng bắt trước cả cổng tiền tố địa chỉ.
    expect(() => parseDeployment(deploymentJson(), "Mainnet")).toThrow(/asset_name_hex/);
  });

  it("địa chỉ testnet dưới nhãn Mainnet ⟹ ném", () => {
    const mainnetLamp = deploymentJson({
      lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: "4c414d50" },
    });
    expect(() => parseDeployment(mainnetLamp, "Mainnet")).toThrow(/tiền tố/);
  });

  it("địa chỉ không phải địa chỉ script ⟹ ném", () => {
    // Địa chỉ enterprise của một khoá — bech32 THẬT, sinh bằng chính hàm dịch vụ dùng.
    // Một chuỗi bech32 bịa sẽ chết ở bước giải mã và bài kiểm sẽ xanh vì LÝ DO KHÁC.
    const keyAddress = enterpriseAddressOf("Preview", OWNER_PKH);
    expect(() => parseDeployment(
      deploymentJson({ vaults: [{ vault_type: "Schedule", address: keyAddress }] }), "Preview",
    )).toThrow(/địa chỉ script/);
  });

  it("hai mục vault trùng địa chỉ ⟹ ném", () => {
    expect(() => parseDeployment(deploymentJson({
      vaults: [
        { vault_type: "Schedule", address: VAULT_ADDRESS },
        { vault_type: "Instant", address: VAULT_ADDRESS },
      ],
    }), "Preview")).toThrow(/trùng/);
  });

  it("tham chiếu UTxO script sai khuôn ⟹ ném", () => {
    expect(() => parseDeployment(deploymentJson({
      ref_script_utxos: { vault: "không-phải-outref", shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2` },
    }), "Preview")).toThrow(/ref_script_utxos\.vault/);
  });

  it("JSON hỏng / không phải đối tượng ⟹ ném", () => {
    expect(() => parseDeployment("{", "Preview")).toThrow(/JSON hợp lệ/);
    expect(() => parseDeployment("[]", "Preview")).toThrow(/ĐỐI TƯỢNG/);
  });
});

// ── `lamp.policy_id` đi qua cổng policy của SDK lúc khởi động, kèm lối mở tập dượt ──
//
// Mỗi ca dương có một ca âm chỉ khác ĐÚNG MỘT biến (ack · policy · mạng).

describe("parseDeployment — cổng policy LAMP (assertLampPolicyId) và lối mở tập dượt", () => {
  /** Đời tập dượt — nằm trong CẢ bảng đã-bị-thay lẫn bảng tập dượt của SDK. */
  const REHEARSAL = "8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd";
  /** Đã bị thay, NGOÀI bảng tập dượt. */
  const SUPERSEDED_ONLY = "d9c09230079b810ab5ed92e8db4c190d42efc42db6aac028656f7e07";
  /** Đời ACTIVE Preprod — `scripts/config.ts` (thư `lam0926mg-lp`, 2026-09-26). */
  const ACTIVE = "53bc12ade5ee24d43750b9560f152a54b48b804fab34dab810fb8743";
  const LOOKALIKE = "28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4";

  const dep = (policy: string, ack?: string) => deploymentJson({
    lamp: {
      policy_id: policy, asset_name_hex: LAMP_ASSET_NAME_HEX,
      ...(ack === undefined ? {} : { rehearsal_ack: ack }),
    },
  });

  it("policy tổng hợp của fixture vẫn qua cổng — không có ack", () => {
    const d = parseDeployment(deploymentJson(), "Preview");
    expect(d.lampPolicyId).toBe(LAMP_POLICY_ID);
    expect(d.lampRehearsalAck).toBeUndefined();
  });

  it("policy nhái 28e916b0 ⟹ từ chối khởi động (chỗ README từng khai là chưa đi qua)", () => {
    expect(() => parseDeployment(dep(LOOKALIKE), "Preprod")).toThrow(/KHÔNG PHẢI LAMP/);
  });

  it("8169b76c không ack ⟹ từ chối", () => {
    expect(() => parseDeployment(dep(REHEARSAL), "Preprod")).toThrow(/\[parseDeployment\].*ĐÃ BỊ THAY/);
  });

  it("8169b76c ack = chính nó, Preprod ⟹ qua, ack được giữ trong Deployment", () => {
    const d = parseDeployment(dep(REHEARSAL, REHEARSAL), "Preprod");
    expect(d.lampPolicyId).toBe(REHEARSAL);
    expect(d.lampRehearsalAck).toBe(REHEARSAL);
  });

  it("8169b76c ack = chính nó, Mainnet ⟹ từ chối ở cổng policy", () => {
    expect(() => parseDeployment(dep(REHEARSAL, REHEARSAL), "Mainnet")).toThrow(/ĐÃ BỊ THAY/);
  });

  it("d9c09230 (ngoài bảng tập dượt) ack = chính nó ⟹ vẫn từ chối", () => {
    expect(() => parseDeployment(dep(SUPERSEDED_ONLY, SUPERSEDED_ONLY), "Preprod")).toThrow(/ĐÃ BỊ THAY/);
  });

  it("ack = 8169b76c nhưng policy = d9c09230 ⟹ từ chối", () => {
    expect(() => parseDeployment(dep(SUPERSEDED_ONLY, REHEARSAL), "Preprod")).toThrow(/ĐÃ BỊ THAY/);
  });

  it("ACTIVE 53bc12ad không ack ⟹ qua", () => {
    expect(parseDeployment(dep(ACTIVE), "Preprod").lampPolicyId).toBe(ACTIVE);
  });

  it("rehearsal_ack không phải chuỗi ⟹ từ chối, không lặng lẽ bỏ qua", () => {
    expect(() => parseDeployment(dep(REHEARSAL, 1 as never), "Preprod")).toThrow(/lamp\.rehearsal_ack/);
  });
});

describe("createVaultProtocol — ack đi từ tệp deploy tới createVault của SDK", () => {
  const REHEARSAL = "8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd";
  const OWNER = { type: "key" as const, hash: OWNER_PKH };

  // `createVault` của SDK gọi cổng policy TRƯỚC phép kiểm `lampDeposit`. Ca dương đưa
  // `lampDeposit = 0` nên vấp ở câu về `lampDeposit` — tức cổng policy đã cho qua.
  const run = (protocol: ReturnType<typeof createVaultProtocol>) => createVault({
    lucid: {} as never,
    vaultType: "Schedule",
    protocol,
    vault: { owner: OWNER, lampDeposit: 0n },
  } as never);

  it("deploy có rehearsal_ack ⟹ SDK cho qua cổng policy", async () => {
    const d = parseDeployment(deploymentJson({
      lamp: { policy_id: REHEARSAL, asset_name_hex: LAMP_ASSET_NAME_HEX, rehearsal_ack: REHEARSAL },
    }), "Preprod");
    const p = createVaultProtocol(d, "Preprod");
    expect(p.lampRehearsalAck).toBe(REHEARSAL);
    await expect(run(p)).rejects.toThrow(/lampDeposit must be > 0/);
  });

  it("cùng deploy đó mà rơi ack ⟹ SDK chặn ở cổng policy (ca đối xứng)", async () => {
    const d = parseDeployment(deploymentJson({
      lamp: { policy_id: REHEARSAL, asset_name_hex: LAMP_ASSET_NAME_HEX, rehearsal_ack: REHEARSAL },
    }), "Preprod");
    const { lampRehearsalAck: _bo, ...khongAck } = createVaultProtocol(d, "Preprod");
    await expect(run(khongAck)).rejects.toThrow(/\[createVault\].*ĐÃ BỊ THAY/);
  });
});
