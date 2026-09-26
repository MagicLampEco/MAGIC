// VaultTxAPI/tests/config.test.ts — các cổng FAIL-CLOSED lúc khởi động.
//
// Mỗi bài ở đây tương ứng một ca mà "cảnh báo rồi chạy tiếp" sẽ ra một dịch vụ khởi động
// XANH rồi dựng giao dịch SAI. Cổng phải chặn ở lúc khởi động, nơi người bị chặn là người
// vận hành — không phải ở lúc có yêu cầu, nơi người bị chặn là người dùng.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadConfig, parseDeployment } from "../src/config.js";
import { enterpriseAddressOf } from "../src/txBuilder.js";
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
