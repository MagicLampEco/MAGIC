// VaultReadAPI/tests/config.test.ts — các cổng FAIL-CLOSED lúc khởi động.
//
// Mỗi bài ở đây tương ứng một cách cấu hình sai mà hậu quả là một CÂU TRẢ LỜI SAI TRÔNG
// NHƯ ĐÚNG: địa chỉ testnet phục vụ dưới nhãn mainnet, địa chỉ không phải script (nên
// mãi mãi rỗng), bản chép không nhãn (nên không ai biết lúc nào nó hết đúng). Không ca
// nào trong số đó tự kêu lúc chạy — nên chúng phải bị chặn lúc khởi động.

import { describe, expect, it } from "vitest";

import { isLoopback, loadConfig, parseScopes } from "../src/config.js";
import { PREVIEW_VAULT_ADDRESS, PREVIEW_VAULT_SCRIPT_HASH } from "./fixtures/preview-e5fd34b1.js";

const GOOD_VAULTS = JSON.stringify([{
  vault_type: "Schedule",
  address: PREVIEW_VAULT_ADDRESS,
  source: "Preview 2026-09-11, tx e5fd34b1…",
}]);

const baseEnv = (): NodeJS.ProcessEnv => ({
  VAULT_READ_API_NETWORK: "Preview",
  BLOCKFROST_PROJECT_ID: "gia-tri-khoa-gia-cho-bai-kiem",
  VAULT_READ_API_VAULTS: GOOD_VAULTS,
});

describe("suy script hash TỪ địa chỉ — một sự thật, một nơi giữ", () => {
  it("script hash không cấu hình riêng mà suy ra từ bech32", () => {
    const [scope] = parseScopes(GOOD_VAULTS, "Preview");
    expect(scope!.scriptHash).toBe(PREVIEW_VAULT_SCRIPT_HASH);
    expect(scope!.vaultType).toBe("Schedule");
  });
});

describe("cấu hình sai phải CHẶN lúc khởi động, không âm thầm trả rỗng", () => {
  it("địa chỉ testnet dưới nhãn Mainnet ⇒ ném", () => {
    expect(() => parseScopes(GOOD_VAULTS, "Mainnet")).toThrow(/Mainnet/);
  });

  it("địa chỉ không phải script ⇒ ném (vault luôn ở địa chỉ script)", () => {
    // Ví deploy trong `scripts/DEPLOYED.md` §Preview — địa chỉ khoá, không phải script.
    const walletAddr =
      "addr_test1qqh9u9qc4l2q9eyzx2c58pmpqn9vvxy2gjux0lah2wp33axx7cqq55f75fypagzqnelz3uzwxf764qzjx8kvaaw3q3yq8fyl7p";
    const raw = JSON.stringify([{ vault_type: "Schedule", address: walletAddr, source: "x" }]);
    expect(() => parseScopes(raw, "Preview")).toThrow(/không phải địa chỉ script/);
  });

  it("thiếu `source` ⇒ ném — bản chép KHÔNG MANG NHÃN là bản chép sẽ chết im lặng", () => {
    const raw = JSON.stringify([{ vault_type: "Schedule", address: PREVIEW_VAULT_ADDRESS }]);
    expect(() => parseScopes(raw, "Preview")).toThrow(/source/);
  });

  it("hai mục trùng địa chỉ ⇒ ném (cộng dồn hai lần cùng một vault)", () => {
    const raw = JSON.stringify([
      { vault_type: "Schedule", address: PREVIEW_VAULT_ADDRESS, source: "a" },
      { vault_type: "Instant", address: PREVIEW_VAULT_ADDRESS, source: "b" },
    ]);
    expect(() => parseScopes(raw, "Preview")).toThrow(/trùng/);
  });

  it("danh sách rỗng ⇒ ném", () => {
    expect(() => loadConfig({ ...baseEnv(), VAULT_READ_API_VAULTS: "[]" })).toThrow(/rỗng/);
  });

  it("thiếu khoá nút chuỗi ⇒ ném, và câu lỗi chỉ nêu TÊN BIẾN, không nêu đường dẫn nào", () => {
    // Câu lỗi được phép nói "thiếu biến X". Nó KHÔNG được phép chỉ đường tới nơi cất X —
    // sơ đồ nơi cất là thứ cần TRƯỚC một giá trị, nên nó rò nhiều hơn chính giá trị.
    const env = baseEnv();
    delete env.BLOCKFROST_PROJECT_ID;
    let msg = "";
    try { loadConfig(env); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/BLOCKFROST_PROJECT_ID/);
    expect(msg).not.toMatch(/\//);          // không đường dẫn
    expect(msg).not.toMatch(/\.env/);       // không tên tệp cấu hình
  });
});

describe("ra ngoài loopback thì BẮT BUỘC có thẻ bài", () => {
  it("host 0.0.0.0 mà không thẻ bài ⇒ TỪ CHỐI khởi động", () => {
    expect(() => loadConfig({ ...baseEnv(), VAULT_READ_API_HOST: "0.0.0.0" }))
      .toThrow(/loopback/);
  });

  it("host 0.0.0.0 CÓ thẻ bài ⇒ chạy được", () => {
    const cfg = loadConfig({
      ...baseEnv(), VAULT_READ_API_HOST: "0.0.0.0", VAULT_READ_API_TOKEN: "abc",
    });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.token).toBe("abc");
  });

  it("mặc định là 127.0.0.1, và đó là loopback", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.host).toBe("127.0.0.1");
    expect(isLoopback(cfg.host)).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("10.0.0.4")).toBe(false);
  });

  it("URL Blockfrost dẫn theo MẠNG, không gõ tay", () => {
    expect(loadConfig(baseEnv()).blockfrostUrl).toBe("https://cardano-preview.blockfrost.io/api/v0");
    const mainnetEnv = {
      ...baseEnv(),
      VAULT_READ_API_NETWORK: "Mainnet",
      VAULT_READ_API_VAULTS: JSON.stringify([{
        vault_type: "Schedule",
        address: "addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx",
        source: "mẫu",
      }]),
    };
    expect(loadConfig(mainnetEnv).blockfrostUrl).toBe("https://cardano-mainnet.blockfrost.io/api/v0");
  });
});
