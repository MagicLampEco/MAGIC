// VaultReadAPI/src/config.ts — cấu hình, và các cổng FAIL-CLOSED lúc khởi động.
//
// ── BÍ MẬT ────────────────────────────────────────────────────────────────────
// Tệp này nhận GIÁ TRỊ khoá qua biến môi trường. Nó KHÔNG nhận đường dẫn tới kho
// khoá, KHÔNG mở tệp nào để tìm khoá, KHÔNG nêu tên biến trỏ tới kho, và KHÔNG in
// khoá ở bất cứ nhánh lỗi nào. Muốn chạy tay thì đặt biến ngay trước lệnh, để bí
// mật sống trong đúng một tiến trình.
//
// ── MỘT TIẾN TRÌNH = MỘT MẠNG ─────────────────────────────────────────────────
// Cố ý. Trộn hai mạng trong một tiến trình là mở đúng cái cửa mà `lamp_asset_name`
// sinh ra để đóng: một câu trả lời testnet đi ra dưới nhãn mainnet, không gì kêu.
//
// ── ĐỊA CHỈ VAULT LÀ MỘT BẢN CHÉP — NÊN NÓ PHẢI MANG NHÃN ─────────────────────
// Nguồn của địa chỉ vault là lần deploy (`aiken build` + apply-param), không phải
// tệp này. Nên mỗi mục BẮT BUỘC khai `source`: chép từ đâu, ngày nào. `/health` in
// lại nguyên văn. Không có nhãn thì vài tháng nữa không ai trả lời được câu "địa
// chỉ này còn đúng không", và một địa chỉ hết đúng thì mặt tiền trả `{vaults: []}`
// mãi mãi — im lặng, và giống hệt "chủ này chưa có vault".

import { getAddressDetails } from "@lucid-evolution/lucid";
import type { Network } from "@magiclamp/protocol-utils";

export interface VaultScope {
  /** "Instant" | "Schedule" — khớp `VaultType` của MagicSDK. */
  vaultType: string;
  address: string;
  /** Script hash suy TỪ địa chỉ, cũng là policy id của NFT danh-tính. Không cấu hình
   *  riêng: hai trường cho một sự thật là hai trường sẽ lệch nhau. */
  scriptHash: string;
  /** Bản chép phải mang nhãn: chép từ đâu, ngày nào. */
  source: string;
}

export interface AppConfig {
  network: Network;
  blockfrostUrl: string;
  blockfrostProjectId: string;
  scopes: VaultScope[];
  host: string;
  port: number;
  /** Thẻ bài chia sẻ. Rỗng CHỈ được phép khi `host` là loopback. */
  token: string;
  requestTimeoutMs: number;
}

const BLOCKFROST_URL_BY_NETWORK: Record<Network, string> = {
  Preview: "https://cardano-preview.blockfrost.io/api/v0",
  Preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  Mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Địa chỉ mạng nào ⇒ tiền tố bech32 nào. Preview và Preprod dùng chung `addr_test`. */
function expectedAddressPrefix(network: Network): string {
  return network === "Mainnet" ? "addr1" : "addr_test1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const network = req(env, "VAULT_READ_API_NETWORK") as Network;
  if (!(network in BLOCKFROST_URL_BY_NETWORK)) {
    throw new Error(
      `[config] VAULT_READ_API_NETWORK="${network}" không hợp lệ. ` +
      `Nhận: ${Object.keys(BLOCKFROST_URL_BY_NETWORK).join(" | ")}.`,
    );
  }

  const blockfrostProjectId = req(env, "BLOCKFROST_PROJECT_ID");
  const blockfrostUrl = env.VAULT_READ_API_BLOCKFROST_URL || BLOCKFROST_URL_BY_NETWORK[network];

  const scopes = parseScopes(req(env, "VAULT_READ_API_VAULTS"), network);
  if (scopes.length === 0) {
    throw new Error("[config] VAULT_READ_API_VAULTS rỗng — sidecar không có gì để đọc.");
  }

  const host = env.VAULT_READ_API_HOST || "127.0.0.1";
  const port = Number(env.VAULT_READ_API_PORT || "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[config] VAULT_READ_API_PORT="${env.VAULT_READ_API_PORT}" không phải cổng hợp lệ.`);
  }

  const token = env.VAULT_READ_API_TOKEN || "";
  if (token === "" && !LOOPBACK_HOSTS.has(host)) {
    // FAIL-CLOSED. Mặt tiền này chạy bằng khoá Blockfrost của người vận hành và trả lời
    // "PKH → số dư" trong một lời gọi rẻ. Mở ra ngoài mà không có thẻ bài là vừa biếu
    // hạn mức của mình, vừa biến một phép tra cứu đắt thành một phép tra cứu hàng loạt.
    throw new Error(
      `[config] VAULT_READ_API_HOST="${host}" không phải loopback mà VAULT_READ_API_TOKEN rỗng. ` +
      `Từ chối khởi động: đặt thẻ bài, hoặc bind về 127.0.0.1.`,
    );
  }

  const requestTimeoutMs = Number(env.VAULT_READ_API_TIMEOUT_MS || "15000");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100) {
    throw new Error(`[config] VAULT_READ_API_TIMEOUT_MS="${env.VAULT_READ_API_TIMEOUT_MS}" không hợp lệ.`);
  }

  return { network, blockfrostUrl, blockfrostProjectId, scopes, host, port, token, requestTimeoutMs };
}

export function parseScopes(raw: string, network: Network): VaultScope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[config] VAULT_READ_API_VAULTS không phải JSON hợp lệ: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("[config] VAULT_READ_API_VAULTS phải là một MẢNG các mục vault.");
  }

  const prefix = expectedAddressPrefix(network);
  const seen = new Set<string>();
  return parsed.map((item, i) => {
    const o = item as { vault_type?: unknown; address?: unknown; source?: unknown };
    const where = `VAULT_READ_API_VAULTS[${i}]`;
    if (typeof o.vault_type !== "string" || o.vault_type === "") {
      throw new Error(`[config] ${where}.vault_type thiếu.`);
    }
    if (typeof o.address !== "string" || o.address === "") {
      throw new Error(`[config] ${where}.address thiếu.`);
    }
    if (typeof o.source !== "string" || o.source.trim() === "") {
      throw new Error(
        `[config] ${where}.source thiếu. Địa chỉ vault là BẢN CHÉP của một lần deploy; ` +
        `bản chép không mang nhãn thì không ai biết lúc nào nó hết đúng.`,
      );
    }
    if (!o.address.startsWith(prefix)) {
      throw new Error(
        `[config] ${where}.address bắt đầu bằng "${o.address.slice(0, 10)}…" nhưng mạng là ` +
        `${network} (chờ tiền tố "${prefix}"). Một địa chỉ testnet phục vụ dưới nhãn mainnet ` +
        `là câu trả lời SAI mà không gì kêu lên.`,
      );
    }

    const cred = credentialOfOrThrow(o.address, where);
    if (cred.type !== "Script") {
      throw new Error(
        `[config] ${where}.address không phải địa chỉ script (payment credential là ` +
        `"${cred.type}"). Vault luôn sống ở địa chỉ script.`,
      );
    }

    if (seen.has(o.address)) {
      throw new Error(`[config] ${where}.address trùng với một mục trước — bỏ bớt.`);
    }
    seen.add(o.address);

    return { vaultType: o.vault_type, address: o.address, scriptHash: cred.hash, source: o.source };
  });
}

function credentialOfOrThrow(address: string, where: string): { type: string; hash: string } {
  try {
    const d = getAddressDetails(address);
    if (!d.paymentCredential) throw new Error("không có payment credential");
    return { type: d.paymentCredential.type, hash: d.paymentCredential.hash };
  } catch (e) {
    throw new Error(`[config] ${where}.address không giải mã được: ${(e as Error).message}`);
  }
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`[config] thiếu biến môi trường ${name}.`);
  return v;
}

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}
