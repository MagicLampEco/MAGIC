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
import { parseBasePath } from "./basePath.js";

/**
 * Tập ĐÓNG các loại vault dịch vụ này đọc được. Đây là một **hợp đồng với bên gọi**, không
 * phải một nhãn tự do của người vận hành: nó đi ra ngoài dưới trường `vault_kind`, và bên
 * tiêu thụ dựng cổng fail-closed trên nó (*"giá trị lạ ⟹ không vẽ con số"*).
 *
 * Vì sao là tập ĐÓNG chứ không phải chuỗi tự do — hai lý do độc lập:
 *
 *  1. **Cùng một trường datum mang hai NGHĨA tuỳ loại vault.** `consumed_credit` là số dư
 *     tiêu được ở vault Instant và là bộ đếm luỹ kế ở vault Schedule (xem docblock ở
 *     `vaultView.ts`). Bên gọi không suy ra được nghĩa nếu không biết loại, và họ không có
 *     đường nào khác để biết.
 *  2. **Thêm loại thứ ba mà bên gọi đang đọc một tập cũ** thì họ xếp nó vào một nhóm sẵn có
 *     và không gì báo. Tập đóng biến ca đó thành một lỗi khởi động ồn ào ở ĐÂY, nơi người
 *     vận hành đang đứng, thay vì một con số sai ở màn hình người dùng.
 *
 * Mỗi phần tử phải có một đường giải mã THẬT phía sau: `Instant`/`Schedule` qua
 * `vaultView.ts` ▸ `readVaultsFromUtxos` (hai hình dạng Gen v2.0, phân theo số trường);
 * `Prepaid` qua `prepaidView.ts` ▸ `readPrepaidVaultsFromUtxos` (lược đồ KHÁC hẳn — mang
 * `did_commit` và dòng hạn mức — giải bằng `decodeVaultDatum` của `@magiclamp/prepaidgen-sdk`).
 * Kê một tên mà chưa có đường giải mã là đặt tên cho một artifact chưa tồn tại.
 *
 * Thứ tự là một phần của hợp đồng: CHỈ THÊM Ở CUỐI. `Prepaid` thêm 2026-10-03 — giá trị
 * cũ giữ nguyên nghĩa; bên tiêu thụ đang dựng cổng fail-closed trên tập cũ sẽ gặp
 * `vault_kind: "Prepaid"` như một giá trị lạ và không vẽ con số, đúng chiều hỏng an toàn.
 */
export const VAULT_KINDS = ["Instant", "Schedule", "Prepaid"] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

export function isVaultKind(s: string): s is VaultKind {
  return (VAULT_KINDS as readonly string[]).includes(s);
}

export interface VaultScope {
  /** Loại vault — tập ĐÓNG `VAULT_KINDS`. Hai giá trị đầu khớp `VaultType` của MagicSDK;
   *  `Prepaid` không có trong `VaultType` (SDK dựng két Prepaid qua `sponsorJourney.ts`). */
  vaultType: VaultKind;
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
  /** Tiền tố đường khi đứng sau proxy định tuyến theo đường (`basePath.ts`). `""` ⟹ không có. */
  basePath: string;
  /** Thẻ bài chia sẻ. Rỗng CHỈ được phép khi `host` là loopback. */
  token: string;
  requestTimeoutMs: number;
  /** Địa chỉ script `consume` cần theo dõi cho chỉ mục DID ⟹ thread. Rỗng ⟹ chỉ mục TẮT
   *  (đường `/threads/*` trả 503 `THREAD_INDEX_DISABLED`, không trả rỗng). */
  consumeScopes: ConsumeScope[];
  threadIndex: ThreadIndexConfig;
}

/**
 * Một địa chỉ `consume` (ConsumeMAGIC) mà chỉ mục thread theo dõi.
 *
 * Cùng khuôn với `VaultScope`: script hash SUY từ địa chỉ và cũng là policy id của NFT thread
 * (`ConsumeMAGIC/onchain/validators/consume.ak` ▸ `validate_mint_engage_id` — handler `mint`
 * chạy dưới chính script hash đó). Mỗi loại vault có một bản `consume` riêng (apply-param
 * `vault_script_hash`), nên một mạng có thể có NHIỀU mục ở đây.
 */
export interface ConsumeScope {
  address: string;
  /** = policy id của NFT thread. */
  scriptHash: string;
  /** Bản chép phải mang nhãn: chép từ đâu, ngày nào. */
  source: string;
}

export interface ThreadIndexConfig {
  /** Chỉ mục trễ HƠN số khối này ⟹ 503 `INDEX_STALE`. */
  staleBlocks: number;
  /** Nhịp vòng đồng bộ nền. */
  syncIntervalMs: number;
  /** Thời gian khối trung bình — để ngoại suy độ trễ khi vòng đồng bộ không chạy được. */
  blockTimeMs: number;
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

  const basePath = parseBasePath(env.VAULT_READ_API_BASE_PATH, "VAULT_READ_API_BASE_PATH");
  if (token === "" && basePath !== "") {
    // FAIL-CLOSED. Tiền tố đường chỉ có nghĩa khi đứng sau một proxy định tuyến theo đường, và
    // proxy biến loopback thành cổng mở ra ngoài: nhánh loopback ngay trên không bắt được ca đó.
    // Cùng lỗ đã đo trên VaultTxAPI ngày 2026-10-07 (bind 127.0.0.1 sau đường hầm, có tiền tố,
    // không thẻ ⟹ trả 200 cho yêu cầu từ internet không kèm `Authorization`).
    throw new Error(
      `[config] VAULT_READ_API_BASE_PATH="${basePath}" (dịch vụ đứng sau proxy) mà VAULT_READ_API_TOKEN rỗng. ` +
      `Từ chối khởi động: proxy mở cổng loopback ra ngoài, nên phải đặt thẻ bài.`,
    );
  }

  const requestTimeoutMs = Number(env.VAULT_READ_API_TIMEOUT_MS || "15000");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100) {
    throw new Error(`[config] VAULT_READ_API_TIMEOUT_MS="${env.VAULT_READ_API_TIMEOUT_MS}" không hợp lệ.`);
  }

  const consumeScopes = env.VAULT_READ_API_CONSUME_SCOPES
    ? parseConsumeScopes(env.VAULT_READ_API_CONSUME_SCOPES, network)
    : [];

  const threadIndex: ThreadIndexConfig = {
    staleBlocks: intEnv(env, "VAULT_READ_API_THREAD_STALE_BLOCKS", 3, 0),
    syncIntervalMs: intEnv(env, "VAULT_READ_API_THREAD_SYNC_INTERVAL_MS", 20_000, 1_000),
    blockTimeMs: intEnv(env, "VAULT_READ_API_BLOCK_TIME_MS", 20_000, 1_000),
  };

  return {
    network, blockfrostUrl, blockfrostProjectId, scopes, host, port, basePath, token, requestTimeoutMs,
    consumeScopes, threadIndex,
  };
}

function intEnv(env: NodeJS.ProcessEnv, name: string, dflt: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min) {
    throw new Error(`[config] ${name}="${raw}" không hợp lệ (số nguyên ≥ ${min}).`);
  }
  return v;
}

/**
 * `VAULT_READ_API_CONSUME_SCOPES` = JSON `[{ "address": "addr…", "source": "…" }]`.
 * Cùng các cổng fail-closed như `parseScopes`: đúng tiền tố mạng, là địa chỉ script, có nhãn
 * nguồn, không trùng.
 */
export function parseConsumeScopes(raw: string, network: Network): ConsumeScope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[config] VAULT_READ_API_CONSUME_SCOPES không phải JSON hợp lệ: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "[config] VAULT_READ_API_CONSUME_SCOPES phải là một MẢNG không rỗng (bỏ hẳn biến nếu muốn tắt chỉ mục).",
    );
  }
  const prefix = expectedAddressPrefix(network);
  const seen = new Set<string>();
  return parsed.map((item, i) => {
    const o = item as { address?: unknown; source?: unknown };
    const where = `VAULT_READ_API_CONSUME_SCOPES[${i}]`;
    if (typeof o.address !== "string" || o.address === "") {
      throw new Error(`[config] ${where}.address thiếu.`);
    }
    if (typeof o.source !== "string" || o.source.trim() === "") {
      throw new Error(
        `[config] ${where}.source thiếu. Địa chỉ consume là BẢN CHÉP của một lần deploy; ` +
        `bản chép không mang nhãn thì không ai biết lúc nào nó hết đúng.`,
      );
    }
    if (!o.address.startsWith(prefix)) {
      throw new Error(
        `[config] ${where}.address bắt đầu bằng "${o.address.slice(0, 10)}…" nhưng mạng là ` +
        `${network} (chờ tiền tố "${prefix}").`,
      );
    }
    const cred = credentialOfOrThrow(o.address, where);
    if (cred.type !== "Script") {
      throw new Error(`[config] ${where}.address không phải địa chỉ script — thread luôn ở địa chỉ consume.`);
    }
    if (seen.has(cred.hash)) {
      throw new Error(`[config] ${where} trùng script hash với một mục trước — bỏ bớt.`);
    }
    seen.add(cred.hash);
    return { address: o.address, scriptHash: cred.hash, source: o.source };
  });
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
    if (!isVaultKind(o.vault_type)) {
      // Fail-closed ở ĐÂY, lúc khởi động, chứ không để một chuỗi lạ đi ra dưới `vault_kind`.
      // Bên gọi không có cách nào đoán nghĩa của một loại họ chưa biết, và đoán sai ở đó
      // thì con số sai xuất hiện trên màn hình người dùng — xa chỗ gây ra nó nhất.
      throw new Error(
        `[config] ${where}.vault_type = "${o.vault_type}" không thuộc tập đóng ` +
        `[${VAULT_KINDS.join(", ")}]. Thêm một loại vault là đổi một hợp đồng với bên gọi: ` +
        `mở rộng ${"`VAULT_KINDS`"} và báo các nhà đang đọc ${"`vault_kind`"} trước, ` +
        `đừng đổi riêng cấu hình.`,
      );
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

/**
 * Môi trường cho tiến trình con (`buildInfo` gọi `git`). Bản đối ứng của `VaultTxAPI/src/config.ts` ▸
 * `childProcessEnv`, để `buildInfo.ts` của hai gói giữ thân giống hệt nhau. Gói này không đọc khoá
 * platform; dòng xoá chỉ giữ cho hai bản cùng một hành vi.
 */
export function childProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.VAULT_TX_API_PLATFORM_KEY;
  return out;
}
