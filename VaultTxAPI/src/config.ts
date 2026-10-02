// VaultTxAPI/src/config.ts — cấu hình, và các cổng FAIL-CLOSED lúc khởi động.
//
// ══ BẤT BIẾN SỐ MỘT CỦA GÓI NÀY ═══════════════════════════════════════════════
// Dịch vụ KHÔNG BAO GIỜ giữ, đọc, nhận hay chạm vào vật liệu ký: khoá bí mật, hạt
// giống ví, hay cụm từ khôi phục.
// Nó dựng giao dịch CHƯA KÝ và trả CBOR về; app ký trong Secure Enclave của máy.
//
// Cụ thể ở tệp này: bí mật dịch vụ cần là `BLOCKFROST_PROJECT_ID` và (khi bật proxy phí)
// token ứng dụng Feecover `FEECOVER_APP_TOKEN`. Cả hai là TOKEN API, không phải khoá ký, và
// vào qua biến môi trường dưới dạng GIÁ TRỊ. Tệp này không nhận đường dẫn tới kho
// khoá, không mở tệp nào để tìm khoá, không nêu tên biến trỏ tới kho khoá, và không
// in giá trị khoá ở bất cứ nhánh lỗi nào. `tests/noSigningMaterial.test.ts` quét
// nguyên mã nguồn để giữ câu này đúng theo thời gian, chứ không để nó là một lời hứa.
// ══════════════════════════════════════════════════════════════════════════════
//
// ── ĐỊA CHỈ VÀ UTXO TRONG CẤU HÌNH LÀ BẢN CHÉP — NÊN CHÚNG PHẢI MANG NHÃN ─────
// Nguồn thật của mọi địa chỉ ở đây là một lần deploy (`aiken build` + apply-param),
// không phải tệp cấu hình. Nên khối cấu hình BẮT BUỘC khai `source`, và `/health`
// in lại nguyên văn. Không có nhãn thì vài tháng nữa không ai trả lời được câu
// "địa chỉ này còn đúng không" — và một địa chỉ hết đúng thì dịch vụ báo
// `VAULT_NOT_FOUND` mãi mãi, im lặng, giống hệt "chủ này chưa có vault".

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { getAddressDetails } from "@lucid-evolution/lucid";
import { FEE_PAYER_DEFAULT_COLLATERAL_LOVELACE, type Network } from "@magiclamp/protocol-utils";
import { assertLampPolicyId, SUPERSEDED_LAMP_POLICIES } from "@magiclamp/sdk";

import { ISSUED_ROUTES, type IssuedRoute } from "./locks.js";
import { parseBasePath } from "./basePath.js";

export interface VaultScope {
  /** "Instant" | "Schedule" — khớp `VaultType` của MagicSDK — hoặc `PREPAID_VAULT_TYPE`
   *  (két PrepaidGen, KHÔNG có trong `VaultType` của SDK; xem `PrepaidDeployment`). */
  vaultType: string;
  address: string;
  /** Script hash suy TỪ địa chỉ, cũng là policy id của NFT danh-tính. Không cấu hình
   *  riêng: hai trường cho một sự thật là hai trường sẽ lệch nhau. */
  scriptHash: string;
}

export interface OutRefConfig {
  txHash: string;
  outputIndex: number;
}

export interface ConsumeDeployment {
  /** Địa chỉ chứa thread Engage (state per-app) = địa chỉ script `consume`. */
  engageAddress: string;
  /**
   * Script hash của `consume`, SUY từ `engageAddress` — cũng là policy id của MỌI NFT thread
   * (`ConsumeMAGIC/offchain/src/engageId.ts` ▸ `engageNftUnit`). Không cấu hình riêng: hai
   * trường cho một sự thật là hai trường sẽ lệch nhau.
   *
   * 🪦 Trường cũ `engage_nft_unit` (một NFT thread CỐ ĐỊNH) đã bị gỡ: nó ghim dịch vụ vào
   * ĐÚNG MỘT thread, trong khi `consume.ak` ép chủ thread == chủ vault ⟹ mọi người dùng khác
   * không tiêu được MAGIC. Thread nay chọn theo TỪNG chủ lúc chạy (`engage.ts`).
   */
  engageScriptHash: string;
  /** Địa chỉ chứa beacon PriceParam. */
  priceBeaconAddress: string;
  /** NFT của beacon giá. */
  priceBeaconNftUnit: string;
  /**
   * Apply-param #5 của `consume` — số epoch tối đa beacon giá được trễ so với epoch hiện tại.
   * CÓ ⟹ bộ dựng từ chối trước (`CONSUME-011`, 422 đọc được). VẮNG ⟹ không kiểm ở dịch vụ,
   * validator vẫn ép, và lượt trễ chết ở pha script với câu không trỏ về beacon.
   * Phải BẰNG đúng giá trị đã apply vào script `consume` đang chạy — lấy từ cùng sổ trạng thái.
   */
  maxPriceStale?: bigint;
}

/**
 * Beacon + shard Gen v2.0 mà đường sinh (InstantGen, ScheduleGen commit), đường làm mới
 * checkpoint và đường tiêu (két Instant sang epoch mới) ĐỌC lúc chạy. Dữ kiện của lần deploy
 * `GenBeacons`, không suy được từ yêu cầu — nên cấu hình phải KHAI.
 *
 * Tên NFT KHÔNG khai ở đây: "RHO" / "GBB" / "VRG" / "GBS"‖id là hằng của giao thức
 * (`@magiclamp/instantgen-sdk` ▸ `RATE_NFT_NAME` …). Hash script của sổ két và của shard GB
 * cũng là policy của NFT tương ứng (mint gộp trong validator) ⟹ suy từ địa chỉ, không khai
 * hai trường cho một sự thật.
 *
 * 🔴 Không có mặc định nào ở đây. Một beacon thiếu thì validator fail-closed; một mặc định
 * cho ra dịch vụ luôn dựng tx và tx nào cũng chết trên chuỗi, với câu không trỏ về cấu hình.
 *
 * 🪦 Mục `instant` cũ (datum UM + beacon backing) đã bỏ cùng Gen v2.0 — UM không còn trong
 * công thức sinh, beacon backing thay bằng beacon GreenBack + shard. Khoá `instant` còn nằm
 * trong tệp deploy ⟹ `parseDeployment` từ chối khởi động (xem đó).
 */
export interface GenV2Deployment {
  /** Địa chỉ beacon ρ = `Script(rate_script_hash)`. */
  rateBeaconAddress: string;
  /** Apply-param #6 két Instant — suy từ `rateBeaconAddress`. */
  rateScriptHash: string;
  /** Apply-param #5 két Instant — policy NFT "RHO". */
  rateNftPolicy: string;
  /** Địa chỉ beacon GreenBack = `Script(gb_beacon_script_hash)`. */
  gbBeaconAddress: string;
  /** Apply-param #3 — suy từ `gbBeaconAddress`. */
  gbBeaconScriptHash: string;
  /** Apply-param #2 — policy NFT "GBB". */
  gbBeaconNftPolicy: string;
  /** Địa chỉ 16 shard GB = `Script(gb_shard_policy_id)`. */
  gbShardAddress: string;
  /** Apply-param #4 — hash script `gb_shard` = policy NFT "GBS"‖id, suy từ `gbShardAddress`. */
  gbShardPolicyId: string;
  /** Apply-param `gb_shard_cap_nanogic` của shard đã deploy. Lệch ⟹ shard bác tx. */
  gbShardCapNanogic: bigint;
  /** Địa chỉ sổ két (`vault_registry`, NFT "VRG"). */
  vaultRegistryAddress: string;
  /** Hash script sổ = policy NFT "VRG" — suy từ `vaultRegistryAddress`. */
  vaultRegistryPolicy: string;
}

/**
 * Chữ `vault_type` của két PrepaidGen (đường tài trợ). Két này KHÁC hai loại kia ở ba chỗ mà
 * khuôn cấu hình phải biết:
 *   · KHÔNG có shard — `shard_address` / `ref_script_utxos.shard` không có nghĩa với nó, nên
 *     khối Prepaid KHÔNG được mang hai khoá đó (mang ⟹ ném: đó là dấu một khối chép nhầm từ
 *     khối Instant/Schedule).
 *   · `PrepaidLock` / `FundLock` co-spend QUỸ `paid_fund` ⟹ khối phải khai địa chỉ quỹ
 *     (`paid_fund.address`) và ref-script quỹ (`ref_script_utxos.paid_fund`).
 *   · Một khối một loại két: `ref_script_utxos.vault` chỉ có một ô và bản `consume` được
 *     apply-param bằng hash của ĐÚNG loại két nó phục vụ (BOUNDARIES §2) ⟹ Prepaid không
 *     đứng chung khối với Instant/Schedule.
 * Két Prepaid chỉ đi qua các route tài trợ `/tx/sponsor/*` (`sponsor.ts`). Mọi route KHÁC đụng tới
 * scope Prepaid trả 501 `VAULT_KIND_UNSUPPORTED` (`service.ts` ▸ `assertScopesSupported`).
 */
export const PREPAID_VAULT_TYPE = "Prepaid";

/** Khối `paid_fund` của két Prepaid — chỉ có mặt khi `vaults` là đúng một loại `Prepaid`. */
export interface PrepaidDeployment {
  /** Địa chỉ quỹ = `Script(paid_fund_hash)` (bước 10 của chuỗi deploy). */
  fundAddress: string;
  /** Hash script `paid_fund`, SUY từ `fundAddress` — cũng là policy NFT quỹ. */
  fundScriptHash: string;
  /**
   * `policy ‖ tên` của CARP (khoá `paid_fund.carp_unit`) — apply-param #1, #2 của cả `paid_fund` lẫn
   * `prepaid_vault`. TUỲ CHỌN để khối cũ vẫn nạp được; vắng ⟹ mọi route `/tx/sponsor/t*` trả 501
   * `CONFIG_MISSING`. Không tin lời khai: `sponsor.ts` apply nó vào blueprint rồi đòi hai script hash
   * trùng hai địa chỉ đã cấu hình, lệch ⟹ 501 `SPONSOR_PREPAID_SCRIPTS_MISMATCH`.
   */
  carpUnit?: string;
}

export interface Deployment {
  /** Bản chép chép từ đâu, ngày nào. BẮT BUỘC. */
  source: string;
  /** Đã qua `@magiclamp/sdk` ▸ `assertLampPolicyId` lúc khởi động (`parseDeployment`). */
  lampPolicyId: string;
  /** Xác nhận lối mở TẬP DƯỢT (`lamp.rehearsal_ack` của tệp deploy) — bằng ĐÚNG
   *  `lampPolicyId`. Vắng ⟹ mọi đời LAMP đã bị thay bị chặn lúc khởi động. Có mặt thì nó
   *  đi tiếp tới `createVault` của SDK, nơi cổng chạy lại lần nữa. */
  lampRehearsalAck?: string;
  /** Tên tài sản LAMP dạng hex. THEO MẠNG: `tLAMP` testnet, `LAMP` mainnet. Đây là
   *  apply-param #2 của mọi vault — hardcode giá trị testnet vào mã là dựng ra một vault
   *  mainnet không bao giờ nhìn thấy LAMP của chính nó (BOUNDARIES §2). */
  lampAssetNameHex: string;
  vaults: VaultScope[];
  /** BẮT BUỘC khi `vaults` có két Instant/Schedule (mọi loại khác Prepaid); VẮNG với khối
   *  Prepaid. Nơi đọc phải qua `requireShard` (`txBuilder.ts`), không đọc thẳng. */
  shardAddress?: string;
  /** UTxO mang script tham chiếu CIP-33. KHÔNG phải tối ưu: đính kèm cả hai validator
   *  vào một tx cho 17 303 byte trên Preview, vượt trần 16 384 — không có chúng thì
   *  ScheduleCommit và Consume KHÔNG dựng nổi tx nào. */
  refScriptUtxos: {
    vault: OutRefConfig; consume: OutRefConfig;
    /** Cùng luật với `shardAddress`: bắt buộc với Instant/Schedule, vắng với Prepaid. */
    shard?: OutRefConfig;
    /** Chỉ két Prepaid, và BẮT BUỘC với nó: ref-script `paid_fund` (khoá `ref_script_utxos.paid_fund`). */
    paidFund?: OutRefConfig;
    /** ScheduleGen Gen v2.0: validator withdraw-zero `commit` (khoá `ref_script_utxos.commit`).
     *  Vắng ⟹ `/tx/schedule-commit` trả 501 `CONFIG_MISSING`. */
    commit?: OutRefConfig;
    /** Validator `gb_shard` (khoá `ref_script_utxos.gb_shard`) — nhánh sinh tiêu shard GB.
     *  Vắng ⟹ `/tx/instant-gen` và `/tx/schedule-commit` trả 501 `CONFIG_MISSING`. */
    gbShard?: OutRefConfig;
  };
  consume: ConsumeDeployment;
  /** Tuỳ chọn: thiếu mục này thì các đường cần beacon Gen v2.0 (`/tx/instant-gen`,
   *  `/tx/refresh-checkpoint`, `/tx/schedule-commit`, và `/tx/consume` trên két Instant sang
   *  epoch mới) trả 501 `CONFIG_MISSING`; các đường khác chạy bình thường. Đóng một cửa vì
   *  thiếu dữ kiện thì tốt hơn mở nó ra để mọi tx chết trên chuỗi. */
  genV2?: GenV2Deployment;
  /** Có mặt ⟺ `vaults` là két Prepaid (`PREPAID_VAULT_TYPE`). */
  prepaid?: PrepaidDeployment;
  /** Tuỳ chọn: tham số theo mạng cho nhân chứng chủ `Script(h)` = `did_stake` (PhoenixKey).
   *  Vắng ⟹ mọi yêu cầu có chủ script trả 501 `OWNER_SCRIPT_WITNESS_UNAVAILABLE`; chủ khoá
   *  không bị ảnh hưởng. */
  didStake?: { anchorNftPolicy: string };
  /**
   * Lượng thế chấp (lovelace) đặt TƯỜNG MINH khi giao dịch có ví trả phí bên thứ ba
   * (`fee_payer` / `funding.fee_payer`, mô hình Feecover). Khoá JSON
   * `fee_payer_collateral_lovelace`, chuỗi chữ số; vắng ⟹
   * `@magiclamp/protocol-utils` ▸ `FEE_PAYER_DEFAULT_COLLATERAL_LOVELACE`.
   *
   * Nó vừa là giá trị đưa vào `setCollateral`, vừa là TRẦN mà phép đọc lại CBOR ép lên
   * `Σ collateral_inputs − collateral_return`. Bên trả phí chỉ chịu mất thế chấp tới trần
   * của họ — đặt số này lớn hơn trần đó là dựng giao dịch họ từ chối ký.
   */
  feePayerCollateralLovelace: bigint;
  /** Tuỳ chọn: proxy tới dịch vụ ký trả phí Feecover (`feeProxy.ts`). Vắng ⟹ `/fee/utxo` và
   *  `/fee/sign` trả 501 `FEE_PROXY_UNAVAILABLE`. Không mang token — token vào qua biến môi trường. */
  feecover?: FeecoverSettings;
}

/**
 * Một ứng dụng được phép đi qua proxy phí.
 *
 * App `magic` là ứng dụng MẶC ĐỊNH: người gọi không gửi token Feecover thì đi dưới tên nó, và
 * token của nó nằm ở biến môi trường của dịch vụ, không ở app di động (token trong app di động
 * là token công khai). Ứng dụng khác gửi token của CHÍNH họ; dịch vụ chỉ giữ SHA-256 của token
 * đó để nhận ra họ, không giữ token.
 */
export interface FeecoverAppSettings {
  /** SHA-256 (64 hex thường) của token ứng dụng. App `magic` KHÔNG có trường này. */
  tokenSha256?: string;
  /** Route dựng tx → mục đích Feecover. Route vắng ⟹ proxy từ chối tx của route đó. */
  purposes: Map<IssuedRoute, string>;
}

export interface FeecoverSettings {
  /** Gốc dịch vụ Feecover, không có `/` cuối. Chỉ `https://`, hoặc `http://` tới loopback. */
  url: string;
  /** Hạn chót mỗi lượt gọi Feecover. */
  timeoutMs: number;
  apps: Map<string, FeecoverAppSettings>;
}

/** Tên ứng dụng mặc định — đi bằng token ở biến môi trường của dịch vụ. */
export const FEECOVER_DEFAULT_APP = "magic";

/**
 * Cách suy địa chỉ nhận tiền thừa (change) của người dùng từ `owner_pkh`.
 *
 * 🔴 ĐÂY LÀ MỘT DỮ KIỆN DỊCH VỤ KHÔNG CÓ, và cấu hình phải KHAI nó ra chứ không để
 * mã tự đoán. Yêu cầu HTTP chỉ mang `owner_pkh` — một khoá băm thanh toán. Từ đó suy
 * ra địa chỉ ví của người dùng chỉ đúng khi ví đó là địa chỉ ENTERPRISE của đúng khoá
 * ấy. Ví dùng địa chỉ BASE (có phần stake) thì địa chỉ suy ra là một địa chỉ KHÁC:
 * tiền thừa của giao dịch sẽ rơi vào một chỗ người dùng không kiểm soát bằng ví đang
 * dùng, và không có gì kêu lên cho tới khi họ đi tìm số dư.
 *
 * Nên biến này KHÔNG có mặc định. Người vận hành phải viết ra chiến lược, tức là phải
 * biết mình đang khẳng định điều gì về ví của app.
 */
export type ChangeAddressStrategy = "enterprise_from_owner_pkh";

const CHANGE_ADDRESS_STRATEGIES: ChangeAddressStrategy[] = ["enterprise_from_owner_pkh"];

export interface AppConfig {
  network: Network;
  blockfrostUrl: string;
  blockfrostProjectId: string;
  deployment: Deployment;
  changeAddressStrategy: ChangeAddressStrategy;
  /** Đường dẫn tới `plutus.json` của module vault — hiện vật `aiken build`, đã gitignore.
   *  Cần để suy CHỈ SỐ CONSTRUCTOR của redeemer `BurnBatch` lúc chạy, thay vì chép một
   *  con số phải khớp thứ tự enum on-chain. Đây là tệp BLUEPRINT công khai, không phải
   *  kho khoá. */
  vaultPlutusJsonPath: string;
  host: string;
  port: number;
  /** Tiền tố đường khi đứng sau proxy định tuyến theo đường (`basePath.ts`). `""` ⟹ không có. */
  basePath: string;
  /** Thẻ bài chia sẻ. Rỗng CHỈ được phép khi `host` là loopback. */
  token: string;
  requestTimeoutMs: number;
  /** Khoá mềm theo `owner_pkh` sống bao lâu, cũng là `expires_at` của tx trả về. */
  lockTtlMs: number;
  /** Token ứng dụng `magic` ở Feecover. Chỉ có khi bản deploy khai `feecover.apps.magic`. */
  feecoverAppToken?: string;
}

const BLOCKFROST_URL_BY_NETWORK: Record<Network, string> = {
  Preview: "https://cardano-preview.blockfrost.io/api/v0",
  Preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  Mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Tên tài sản LAMP mà mỗi mạng BẮT BUỘC dùng (BOUNDARIES §2 — apply-param #2). */
const LAMP_ASSET_NAME_BY_NETWORK: Record<Network, string> = {
  Preview: "tLAMP",
  Preprod: "tLAMP",
  Mainnet: "LAMP",
};

function expectedAddressPrefix(network: Network): string {
  return network === "Mainnet" ? "addr1" : "addr_test1";
}

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const network = req(env, "VAULT_TX_API_NETWORK") as Network;
  // `Object.hasOwn`, KHÔNG `in`: `in` đi theo chuỗi nguyên mẫu, nên
  // `VAULT_TX_API_NETWORK=valueOf` (hay `toString`, `constructor`…) đi qua được cổng
  // này. Nó vẫn fail-closed ở cổng asset name phía dưới, nhưng câu lỗi người vận hành
  // nhận được lúc đó nói về `asset_name_hex` và trỏ họ đi sai chỗ.
  if (!Object.hasOwn(BLOCKFROST_URL_BY_NETWORK, network)) {
    throw new Error(
      `[config] VAULT_TX_API_NETWORK="${network}" không hợp lệ. ` +
      `Nhận: ${Object.keys(BLOCKFROST_URL_BY_NETWORK).join(" | ")}.`,
    );
  }

  const blockfrostProjectId = req(env, "BLOCKFROST_PROJECT_ID");
  const blockfrostUrl = env.VAULT_TX_API_BLOCKFROST_URL || BLOCKFROST_URL_BY_NETWORK[network];

  const deployment = parseDeployment(req(env, "VAULT_TX_API_DEPLOYMENT"), network);

  const strategyRaw = req(env, "VAULT_TX_API_CHANGE_ADDRESS_STRATEGY");
  if (!CHANGE_ADDRESS_STRATEGIES.includes(strategyRaw as ChangeAddressStrategy)) {
    throw new Error(
      `[config] VAULT_TX_API_CHANGE_ADDRESS_STRATEGY="${strategyRaw}" không nhận. ` +
      `Hiện chỉ có: ${CHANGE_ADDRESS_STRATEGIES.join(" | ")}. Biến này KHÔNG có mặc định — ` +
      `đặt nó là khẳng định rằng ví của app là địa chỉ enterprise của chính owner_pkh. ` +
      `Sai khẳng định đó thì tiền thừa rơi vào một địa chỉ khác, im lặng.`,
    );
  }

  const vaultPlutusJsonPath = req(env, "VAULT_TX_API_VAULT_PLUTUS_JSON");
  assertReadableBlueprint(vaultPlutusJsonPath);

  const host = env.VAULT_TX_API_HOST || "127.0.0.1";
  const port = intOrThrow(env.VAULT_TX_API_PORT, "VAULT_TX_API_PORT", 8788, 1, 65535);
  const basePath = parseBasePath(env.VAULT_TX_API_BASE_PATH, "VAULT_TX_API_BASE_PATH");

  const token = env.VAULT_TX_API_TOKEN || "";
  if (token === "" && !LOOPBACK_HOSTS.has(host)) {
    // FAIL-CLOSED. Dịch vụ này dựng giao dịch cho bất kỳ `owner_pkh` nào được hỏi và
    // chạy bằng hạn mức Blockfrost của người vận hành. Mở ra ngoài loopback mà không
    // thẻ bài là biếu cả hai thứ.
    throw new Error(
      `[config] VAULT_TX_API_HOST="${host}" không phải loopback mà VAULT_TX_API_TOKEN rỗng. ` +
      `Từ chối khởi động: đặt thẻ bài, hoặc bind về 127.0.0.1.`,
    );
  }

  const requestTimeoutMs = intOrThrow(env.VAULT_TX_API_TIMEOUT_MS, "VAULT_TX_API_TIMEOUT_MS", 20_000, 100, 600_000);
  const lockTtlMs = intOrThrow(env.VAULT_TX_API_LOCK_TTL_MS, "VAULT_TX_API_LOCK_TTL_MS", 180_000, 1_000, 3_600_000);

  const feecoverAppToken = resolveFeecoverAppToken(deployment.feecover, env);

  return {
    network, blockfrostUrl, blockfrostProjectId, deployment,
    changeAddressStrategy: strategyRaw as ChangeAddressStrategy,
    vaultPlutusJsonPath, host, port, basePath, token, requestTimeoutMs, lockTtlMs,
    ...(feecoverAppToken === undefined ? {} : { feecoverAppToken }),
  };
}

/**
 * Token ứng dụng `magic` ở Feecover — GIÁ TRỊ từ biến môi trường, không bao giờ in ra.
 *
 * FAIL-CLOSED: khai `feecover.apps.magic` mà thiếu token là dựng một proxy khởi động xanh rồi
 * trả 401 ở mọi lượt xin phí — người bị chặn là người dùng, không phải người vận hành. Token
 * trùng băm với một ứng dụng khác thì một token nhận ra được hai ứng dụng: từ chối luôn.
 */
export function resolveFeecoverAppToken(
  feecover: FeecoverSettings | undefined, env: NodeJS.ProcessEnv,
): string | undefined {
  if (feecover === undefined || !feecover.apps.has(FEECOVER_DEFAULT_APP)) return undefined;
  const t = env.FEECOVER_APP_TOKEN;
  if (t === undefined || t === "") {
    throw new Error(
      `[config] bản deploy khai feecover.apps.${FEECOVER_DEFAULT_APP} nhưng FEECOVER_APP_TOKEN rỗng. ` +
      `Từ chối khởi động: đặt token ứng dụng, hoặc bỏ ứng dụng ${FEECOVER_DEFAULT_APP} khỏi khối feecover.`,
    );
  }
  const h = createHash("sha256").update(t, "utf8").digest("hex");
  for (const [name, app] of feecover.apps) {
    if (app.tokenSha256 === h) {
      throw new Error(
        `[config] FEECOVER_APP_TOKEN trùng băm với token_sha256 của ứng dụng "${name}" — ` +
        `mỗi ứng dụng một token riêng.`,
      );
    }
  }
  return t;
}

export function parseDeployment(rawJson: string, network: Network): Deployment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`[config] VAULT_TX_API_DEPLOYMENT không phải JSON hợp lệ: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[config] VAULT_TX_API_DEPLOYMENT phải là một ĐỐI TƯỢNG JSON.");
  }
  const o = parsed as Record<string, unknown>;

  const source = str(o.source, "source");
  if (source.trim() === "") {
    throw new Error(
      "[config] VAULT_TX_API_DEPLOYMENT.source rỗng. Mọi địa chỉ và UTxO ở đây là BẢN CHÉP " +
      "của một lần deploy; bản chép không mang nhãn thì không ai biết lúc nào nó hết đúng.",
    );
  }

  const lamp = obj(o.lamp, "lamp");
  const lampPolicyId = hex(str(lamp.policy_id, "lamp.policy_id"), 56, "lamp.policy_id");
  // Hình dạng thôi chưa đủ: policy nhái mang chữ "tLAMP" và LAMP THẬT của một đời đã bị
  // thay đều là 56 hex hợp lệ. Cổng của SDK chặn hai lớp đó — chạy nó ở ĐÂY để lỗi lộ ra
  // lúc khởi động (người bị chặn là người vận hành), không phải lúc dựng giao dịch.
  const lampRehearsalAck = lamp.rehearsal_ack === undefined
    ? undefined
    : str(lamp.rehearsal_ack, "lamp.rehearsal_ack");
  assertLampPolicyId(lampPolicyId, "parseDeployment", lampRehearsalAck, network);
  if (lampRehearsalAck !== undefined && Object.hasOwn(SUPERSEDED_LAMP_POLICIES, lampPolicyId)) {
    console.warn(
      `⚠ [config] TẬP DƯỢT: lamp.policy_id=${lampPolicyId} là một đời LAMP ĐÃ BỊ THAY, cho qua ` +
      `vì lamp.rehearsal_ack xác nhận đúng giá trị này trên ${network} — dịch vụ đang phục vụ ` +
      `một cụm tập dượt dùng một lần, KHÔNG phục vụ người dùng.`,
    );
  }
  const lampAssetNameHex = hexEven(str(lamp.asset_name_hex, "lamp.asset_name_hex"), "lamp.asset_name_hex");
  const lampAssetName = Buffer.from(lampAssetNameHex, "hex").toString("utf8");
  if (lampAssetName !== LAMP_ASSET_NAME_BY_NETWORK[network]) {
    throw new Error(
      `[config] lamp.asset_name_hex giải ra "${lampAssetName}" nhưng mạng là ${network} ` +
      `(chờ "${LAMP_ASSET_NAME_BY_NETWORK[network]}"). \`lamp_asset_name\` là apply-param #2 ` +
      `của mọi vault — sai nó là dựng giao dịch cho một vault không nhìn thấy LAMP của chính nó.`,
    );
  }

  const prefix = expectedAddressPrefix(network);
  const vaultsRaw = o.vaults;
  if (!Array.isArray(vaultsRaw) || vaultsRaw.length === 0) {
    throw new Error("[config] VAULT_TX_API_DEPLOYMENT.vaults phải là một MẢNG khác rỗng.");
  }
  const seen = new Set<string>();
  const vaults: VaultScope[] = vaultsRaw.map((item, i) => {
    const v = obj(item, `vaults[${i}]`);
    const vaultType = str(v.vault_type, `vaults[${i}].vault_type`);
    const address = scriptAddress(str(v.address, `vaults[${i}].address`), prefix, network, `vaults[${i}].address`);
    if (seen.has(address.address)) {
      throw new Error(`[config] vaults[${i}].address trùng với một mục trước — bỏ bớt.`);
    }
    seen.add(address.address);
    return { vaultType, address: address.address, scriptHash: address.scriptHash };
  });

  // ── Két Prepaid: khuôn RIÊNG, quyết theo `vault_type`, không theo khoá nào có mặt ─────
  // Quyết theo khoá có mặt (vd "vắng shard ⟹ coi là Prepaid") là nới shard cho Instant/Schedule:
  // một khối Instant quên `shard_address` sẽ nạp được rồi chết ở route đầu tiên. Nên luật là:
  // MỌI loại khác Prepaid vẫn đòi shard đúng như trước, kể cả loại lạ.
  const prepaidCount = vaults.filter(v => v.vaultType === PREPAID_VAULT_TYPE).length;
  const isPrepaid = prepaidCount > 0;
  if (isPrepaid && prepaidCount !== vaults.length) {
    throw new Error(
      `[config] VAULT_TX_API_DEPLOYMENT.vaults trộn két "${PREPAID_VAULT_TYPE}" với loại khác ` +
      `(${vaults.map(v => v.vaultType).join(", ")}). Một khối một loại két: ref_script_utxos.vault ` +
      `chỉ có một ô và bản consume được apply-param bằng hash của đúng loại két nó phục vụ. ` +
      `Tách thành hai khối deploy, mỗi khối một dịch vụ.`,
    );
  }
  const refs = obj(o.ref_script_utxos, "ref_script_utxos");

  let shardAddress: string | undefined;
  let shardRef: OutRefConfig | undefined;
  let paidFundRef: OutRefConfig | undefined;
  let prepaid: PrepaidDeployment | undefined;
  if (isPrepaid) {
    for (const [present, key] of [
      [o.shard_address !== undefined, "shard_address"],
      [refs.shard !== undefined, "ref_script_utxos.shard"],
    ] as const) {
      if (present) {
        throw new Error(
          `[config] VAULT_TX_API_DEPLOYMENT.${key} có mặt trong khối két Prepaid — két Prepaid ` +
          `KHÔNG có shard. Khoá này thường là dấu khối bị chép từ khối Instant/Schedule; bỏ nó đi.`,
        );
      }
    }
    const pf = obj(o.paid_fund, "paid_fund");
    const fund = scriptAddress(str(pf.address, "paid_fund.address"), prefix, network, "paid_fund.address");
    if (vaults.some(v => v.scriptHash === fund.scriptHash)) {
      throw new Error(
        "[config] VAULT_TX_API_DEPLOYMENT.paid_fund.address trùng script với địa chỉ két Prepaid — " +
        "quỹ và két là hai validator khác nhau (`paid_fund` ≠ `prepaid_vault`).",
      );
    }
    prepaid = {
      fundAddress: fund.address, fundScriptHash: fund.scriptHash,
      ...(pf.carp_unit === undefined
        ? {}
        : { carpUnit: unit(str(pf.carp_unit, "paid_fund.carp_unit"), "paid_fund.carp_unit") }),
    };
    paidFundRef = outRef(str(refs.paid_fund, "ref_script_utxos.paid_fund"), "ref_script_utxos.paid_fund");
  } else {
    // Không phải Prepaid ⟹ khoá Prepaid có mặt là cấu hình lạc chỗ: người vận hành tin dịch vụ
    // đang phục vụ quỹ đó. Lặng lẽ bỏ qua thì niềm tin ấy sai mà không gì báo.
    for (const [present, key] of [
      [o.paid_fund !== undefined, "paid_fund"],
      [refs.paid_fund !== undefined, "ref_script_utxos.paid_fund"],
    ] as const) {
      if (present) {
        throw new Error(
          `[config] VAULT_TX_API_DEPLOYMENT.${key} chỉ dùng cho két "${PREPAID_VAULT_TYPE}", mà khối này ` +
          `khai ${vaults.map(v => v.vaultType).join(", ")}. Bỏ khoá đó, hoặc sửa vaults[].vault_type.`,
        );
      }
    }
    shardAddress = scriptAddress(str(o.shard_address, "shard_address"), prefix, network, "shard_address").address;
    shardRef = outRef(str(refs.shard, "ref_script_utxos.shard"), "ref_script_utxos.shard");
  }

  const refScriptUtxos = {
    vault: outRef(str(refs.vault, "ref_script_utxos.vault"), "ref_script_utxos.vault"),
    ...(shardRef === undefined ? {} : { shard: shardRef }),
    ...(paidFundRef === undefined ? {} : { paidFund: paidFundRef }),
    consume: outRef(str(refs.consume, "ref_script_utxos.consume"), "ref_script_utxos.consume"),
    ...(refs.commit === undefined ? {} : { commit: outRef(str(refs.commit, "ref_script_utxos.commit"), "ref_script_utxos.commit") }),
    ...(refs.gb_shard === undefined ? {} : { gbShard: outRef(str(refs.gb_shard, "ref_script_utxos.gb_shard"), "ref_script_utxos.gb_shard") }),
  };

  const c = obj(o.consume, "consume");
  // FAIL-CLOSED với cấu hình cũ: khoá `engage_nft_unit` còn nằm đó là người vận hành đang tin
  // rằng dịch vụ phục vụ ĐÚNG thread đó. Lặng lẽ bỏ qua nó thì niềm tin ấy sai mà không gì
  // báo; từ chối khởi động thì họ đọc được câu dưới đây đúng lúc sửa cấu hình.
  if (c.engage_nft_unit !== undefined) {
    throw new Error(
      "[config] VAULT_TX_API_DEPLOYMENT.consume.engage_nft_unit đã bị gỡ. Dịch vụ nay chọn " +
      "thread Engage theo TỪNG chủ (policy = script hash của consume, suy từ engage_address); " +
      "một NFT thread cố định chỉ phục vụ được đúng một người. Bỏ khoá này khỏi cấu hình.",
    );
  }
  const engage = scriptAddress(str(c.engage_address, "consume.engage_address"), prefix, network, "consume.engage_address");
  const consume: ConsumeDeployment = {
    engageAddress: engage.address,
    engageScriptHash: engage.scriptHash,
    priceBeaconAddress: scriptAddress(str(c.price_beacon_address, "consume.price_beacon_address"), prefix, network, "consume.price_beacon_address").address,
    priceBeaconNftUnit: unit(str(c.price_beacon_nft_unit, "consume.price_beacon_nft_unit"), "consume.price_beacon_nft_unit"),
    ...(c.max_price_stale === undefined
      ? {}
      : { maxPriceStale: nonNegativeInt(c.max_price_stale, "consume.max_price_stale") }),
  };

  // 🪦 Mục `instant` (UM + beacon backing) đã chết cùng Gen v2.0. Còn nằm đó ⟹ người vận hành
  // tin rằng đường sinh đọc hai địa chỉ đó; lặng lẽ bỏ qua thì niềm tin ấy sai mà không gì báo.
  if (o.instant !== undefined) {
    throw new Error(
      "[config] VAULT_TX_API_DEPLOYMENT.instant (um_datum_address · um_nft_unit · backing_beacon_*) " +
      "đã bỏ ở Gen v2.0: UM không còn trong công thức sinh, beacon backing thay bằng beacon " +
      "GreenBack + shard GB. Khai khối `gen_v2` (rate_beacon_address · rate_nft_policy · " +
      "greenback_beacon_address · greenback_beacon_nft_policy · gb_shard_address · " +
      "gb_shard_cap_nanogic · vault_registry_address) và bỏ khoá `instant`.",
    );
  }

  // Mục `gen_v2` TUỲ CHỌN. Vắng ⟹ các đường cần beacon trả 501; CÓ ⟹ mọi trường bắt buộc,
  // phân tích bằng đúng bộ hàm NÉM như `consume`. Không nửa vời.
  let genV2: GenV2Deployment | undefined;
  if (o.gen_v2 !== undefined) {
    const g = obj(o.gen_v2, "gen_v2");
    const rate = scriptAddress(str(g.rate_beacon_address, "gen_v2.rate_beacon_address"), prefix, network, "gen_v2.rate_beacon_address");
    const gbb = scriptAddress(str(g.greenback_beacon_address, "gen_v2.greenback_beacon_address"), prefix, network, "gen_v2.greenback_beacon_address");
    const shard = scriptAddress(str(g.gb_shard_address, "gen_v2.gb_shard_address"), prefix, network, "gen_v2.gb_shard_address");
    const reg = scriptAddress(str(g.vault_registry_address, "gen_v2.vault_registry_address"), prefix, network, "gen_v2.vault_registry_address");
    const cap = g.gb_shard_cap_nanogic;
    if (typeof cap !== "string" || !/^[1-9][0-9]*$/.test(cap)) {
      throw new Error(
        "[config] VAULT_TX_API_DEPLOYMENT.gen_v2.gb_shard_cap_nanogic phải là CHUỖI chữ số > 0 — " +
        "đúng giá trị đã apply vào validator gb_shard; lệch là shard bác mọi lượt rút.",
      );
    }
    genV2 = {
      rateBeaconAddress: rate.address, rateScriptHash: rate.scriptHash,
      rateNftPolicy: hex(str(g.rate_nft_policy, "gen_v2.rate_nft_policy"), 56, "gen_v2.rate_nft_policy"),
      gbBeaconAddress: gbb.address, gbBeaconScriptHash: gbb.scriptHash,
      gbBeaconNftPolicy: hex(str(g.greenback_beacon_nft_policy, "gen_v2.greenback_beacon_nft_policy"), 56, "gen_v2.greenback_beacon_nft_policy"),
      gbShardAddress: shard.address, gbShardPolicyId: shard.scriptHash,
      gbShardCapNanogic: BigInt(cap),
      vaultRegistryAddress: reg.address, vaultRegistryPolicy: reg.scriptHash,
    };
  }

  // Mục `did_stake` TUỲ CHỌN, cùng luật với `gen_v2`: có thì đủ trường và đúng hình dạng.
  let didStake: { anchorNftPolicy: string } | undefined;
  if (o.did_stake !== undefined) {
    const d = obj(o.did_stake, "did_stake");
    const p = str(d.anchor_nft_policy, "did_stake.anchor_nft_policy");
    if (!/^[0-9a-f]{56}$/.test(p)) {
      throw new Error("[config] VAULT_TX_API_DEPLOYMENT.did_stake.anchor_nft_policy phải là 56 hex thường.");
    }
    didStake = { anchorNftPolicy: p };
  }

  // Chuỗi chữ số, không nhận số JSON — cùng luật với mọi số tiền ở `http.ts`.
  let feePayerCollateralLovelace = FEE_PAYER_DEFAULT_COLLATERAL_LOVELACE;
  if (o.fee_payer_collateral_lovelace !== undefined) {
    const v = o.fee_payer_collateral_lovelace;
    if (typeof v !== "string" || !/^[1-9][0-9]*$/.test(v)) {
      throw new Error(
        "[config] VAULT_TX_API_DEPLOYMENT.fee_payer_collateral_lovelace phải là CHUỖI chữ số " +
        "lovelace > 0 (ví dụ \"3000000\"), không phải số JSON.",
      );
    }
    feePayerCollateralLovelace = BigInt(v);
  }

  const feecover = o.feecover === undefined ? undefined : parseFeecover(o.feecover);

  return {
    source, lampPolicyId, ...(lampRehearsalAck === undefined ? {} : { lampRehearsalAck }),
    lampAssetNameHex, vaults, ...(shardAddress === undefined ? {} : { shardAddress }), refScriptUtxos, consume,
    ...(genV2 === undefined ? {} : { genV2 }), ...(prepaid === undefined ? {} : { prepaid }), didStake,
    feePayerCollateralLovelace, ...(feecover === undefined ? {} : { feecover }),
  };
}

/**
 * Khối `feecover`: `{ url, [timeout_ms], apps: { <app>: { [token_sha256], purposes: { <route>: <mục đích> } } } }`.
 * Mọi chỗ lạ đều NÉM — một bảng mục đích gõ sai route là một route lặng lẽ không xin được phí.
 */
function parseFeecover(raw: unknown): FeecoverSettings {
  const f = obj(raw, "feecover");
  const urlRaw = str(f.url, "feecover.url");
  let u: URL;
  try {
    u = new URL(urlRaw);
  } catch {
    throw new Error("[config] VAULT_TX_API_DEPLOYMENT.feecover.url không phải URL hợp lệ.");
  }
  if (u.username !== "" || u.password !== "") {
    // Chứng danh trong URL là token nằm trong tệp cấu hình — đúng thứ không được có.
    throw new Error("[config] VAULT_TX_API_DEPLOYMENT.feecover.url không được mang chứng danh (user:pass@).");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!(u.protocol === "https:" || (u.protocol === "http:" && isLoopback(host)))) {
    throw new Error(
      "[config] VAULT_TX_API_DEPLOYMENT.feecover.url phải là https://, hoặc http:// tới loopback — " +
      "token ứng dụng đi trong tiêu đề của mỗi lượt gọi.",
    );
  }
  let timeoutMs = 15_000;
  if (f.timeout_ms !== undefined) {
    const t = f.timeout_ms;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 100 || t > 120_000) {
      throw new Error("[config] VAULT_TX_API_DEPLOYMENT.feecover.timeout_ms phải là số nguyên trong [100, 120000].");
    }
    timeoutMs = t;
  }
  const appsRaw = obj(f.apps, "feecover.apps");
  const apps = new Map<string, FeecoverAppSettings>();
  const hashes = new Set<string>();
  for (const [name, v] of Object.entries(appsRaw)) {
    // Không gạch dưới trong tên ứng dụng: luật "mục đích `<app>_…` chỉ đi với đúng app đó"
    // (`feeProxy.ts`) cần tiền tố tách được một nghĩa.
    if (!/^[a-z][a-z0-9]{0,31}$/.test(name)) {
      throw new Error(`[config] feecover.apps: tên ứng dụng "${name}" phải là chữ thường/số, không gạch dưới.`);
    }
    const a = obj(v, `feecover.apps.${name}`);
    let tokenSha256: string | undefined;
    if (name === FEECOVER_DEFAULT_APP) {
      if (a.token_sha256 !== undefined) {
        throw new Error(
          `[config] feecover.apps.${name}.token_sha256 không dùng: token của ứng dụng mặc định vào qua ` +
          `biến môi trường FEECOVER_APP_TOKEN.`,
        );
      }
    } else {
      tokenSha256 = hex(str(a.token_sha256, `feecover.apps.${name}.token_sha256`), 64, `feecover.apps.${name}.token_sha256`);
      if (hashes.has(tokenSha256)) {
        throw new Error(`[config] feecover.apps.${name}.token_sha256 trùng với một ứng dụng khác.`);
      }
      hashes.add(tokenSha256);
    }
    const pRaw = obj(a.purposes, `feecover.apps.${name}.purposes`);
    const purposes = new Map<IssuedRoute, string>();
    for (const [route, purpose] of Object.entries(pRaw)) {
      if (!(ISSUED_ROUTES as readonly string[]).includes(route)) {
        throw new Error(
          `[config] feecover.apps.${name}.purposes: route "${route}" không có. Nhận: ${ISSUED_ROUTES.join(" | ")}.`,
        );
      }
      if (typeof purpose !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(purpose)) {
        throw new Error(`[config] feecover.apps.${name}.purposes.${route} phải là tên mục đích chữ thường.`);
      }
      purposes.set(route as IssuedRoute, purpose);
    }
    apps.set(name, tokenSha256 === undefined ? { purposes } : { tokenSha256, purposes });
  }
  if (apps.size === 0) throw new Error("[config] VAULT_TX_API_DEPLOYMENT.feecover.apps rỗng.");
  return { url: urlRaw.replace(/\/+$/, ""), timeoutMs, apps };
}

// ── phụ trợ phân tích, mỗi cái NÉM chứ không đệm ──────────────────────────────

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`[config] thiếu biến môi trường ${name}.`);
  return v;
}

function intOrThrow(raw: string | undefined, name: string, dflt: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`[config] ${name}="${raw}" không hợp lệ (số nguyên trong [${min}, ${max}]).`);
  }
  return n;
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`[config] VAULT_TX_API_DEPLOYMENT.${where} phải là một đối tượng JSON.`);
  }
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v === "") {
    throw new Error(`[config] VAULT_TX_API_DEPLOYMENT.${where} thiếu hoặc không phải chuỗi.`);
  }
  return v;
}

/** Số nguyên ≥ 0, nhận số JSON an toàn hoặc chuỗi thập phân. Mọi hình dạng khác ⟹ NÉM. */
function nonNegativeInt(v: unknown, where: string): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
  throw new Error(`[config] VAULT_TX_API_DEPLOYMENT.${where} phải là số nguyên ≥ 0 (số hoặc chuỗi thập phân).`);
}

function hex(v: string, len: number, where: string): string {
  if (!new RegExp(`^[0-9a-f]{${len}}$`).test(v)) {
    throw new Error(`[config] ${where} phải là ${len} ký tự hex thường (nhận ${v.length} ký tự).`);
  }
  return v;
}

function hexEven(v: string, where: string): string {
  if (!/^[0-9a-f]*$/.test(v) || v.length === 0 || v.length % 2 !== 0) {
    throw new Error(`[config] ${where} phải là hex thường, số ký tự CHẴN (nhận "${v}").`);
  }
  return v;
}

/** `policyId(56) + assetNameHex(chẵn, có thể rỗng)`. */
function unit(v: string, where: string): string {
  if (!/^[0-9a-f]+$/.test(v) || v.length < 56 || v.length % 2 !== 0) {
    throw new Error(`[config] ${where} phải là unit hex (policy 56 ký tự + tên tài sản, tổng số ký tự chẵn).`);
  }
  return v;
}

function outRef(v: string, where: string): OutRefConfig {
  const m = /^([0-9a-f]{64})#(\d+)$/.exec(v);
  if (m === null) {
    throw new Error(`[config] ${where}="${v}" phải có dạng "<tx hash 64 hex>#<chỉ số output>".`);
  }
  return { txHash: m[1]!, outputIndex: Number(m[2]!) };
}

function scriptAddress(address: string, prefix: string, network: Network, where: string): { address: string; scriptHash: string } {
  if (!address.startsWith(prefix)) {
    throw new Error(
      `[config] ${where} bắt đầu bằng "${address.slice(0, 10)}…" nhưng mạng là ${network} ` +
      `(chờ tiền tố "${prefix}"). Một địa chỉ testnet phục vụ dưới nhãn mainnet là câu trả lời ` +
      `SAI mà không gì kêu lên.`,
    );
  }
  let details;
  try {
    details = getAddressDetails(address);
  } catch (e) {
    throw new Error(`[config] ${where} không giải mã được: ${(e as Error).message}`);
  }
  const cred = details.paymentCredential;
  if (!cred) throw new Error(`[config] ${where} không có payment credential.`);
  if (cred.type !== "Script") {
    throw new Error(
      `[config] ${where} không phải địa chỉ script (payment credential là "${cred.type}"). ` +
      `Vault, shard, engage và beacon đều sống ở địa chỉ script.`,
    );
  }
  return { address, scriptHash: cred.hash };
}

/**
 * Blueprint phải ĐỌC ĐƯỢC lúc khởi động, không phải lúc có yêu cầu đầu tiên.
 *
 * Hoãn tới lúc chạy là dựng ra một dịch vụ khởi động xanh rồi hỏng ở đúng đường tiêu
 * MAGIC — và hỏng ở đó thì người đang bị chặn là người dùng, không phải người vận hành.
 */
function assertReadableBlueprint(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `[config] VAULT_TX_API_VAULT_PLUTUS_JSON không đọc được: ${(e as Error).message}. ` +
      `Đây là hiện vật \`aiken build\` (đã gitignore) — dựng lại module vault rồi trỏ vào nó.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`[config] VAULT_TX_API_VAULT_PLUTUS_JSON không phải JSON hợp lệ: ${(e as Error).message}`);
  }
  const validators = (parsed as { validators?: unknown }).validators;
  if (!Array.isArray(validators) || validators.length === 0) {
    throw new Error("[config] VAULT_TX_API_VAULT_PLUTUS_JSON thiếu mảng `validators` — không phải blueprint Aiken.");
  }
}
