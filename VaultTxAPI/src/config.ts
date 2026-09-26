// VaultTxAPI/src/config.ts — cấu hình, và các cổng FAIL-CLOSED lúc khởi động.
//
// ══ BẤT BIẾN SỐ MỘT CỦA GÓI NÀY ═══════════════════════════════════════════════
// Dịch vụ KHÔNG BAO GIỜ giữ, đọc, nhận hay chạm vào vật liệu ký: khoá bí mật, hạt
// giống ví, hay cụm từ khôi phục.
// Nó dựng giao dịch CHƯA KÝ và trả CBOR về; app ký trong Secure Enclave của máy.
//
// Cụ thể ở tệp này: bí mật DUY NHẤT dịch vụ cần là `BLOCKFROST_PROJECT_ID`, và nó
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

import { readFileSync } from "node:fs";

import { getAddressDetails } from "@lucid-evolution/lucid";
import { FEE_PAYER_DEFAULT_COLLATERAL_LOVELACE, type Network } from "@magiclamp/protocol-utils";

export interface VaultScope {
  /** "Instant" | "Schedule" — khớp `VaultType` của MagicSDK. */
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
}

/**
 * Hai reference input mà `InstantGen` ĐỌC lúc chạy. Cả hai là dữ kiện của dịch vụ,
 * không suy được từ yêu cầu HTTP — nên cấu hình phải KHAI, giống `consume` ở trên.
 *
 * 🔴 Vì sao beacon backing phải là một mục cấu hình chứ không phải một mặc định:
 * `validate_instant_gen` fail-closed quanh nó — thiếu beacon, beacon quá hạn, hoặc
 * cờ `depeg` bật thì giao dịch sinh BỊ TỪ CHỐI. Một mặc định all-zero ở đây cho ra
 * một dịch vụ luôn dựng tx và tx nào cũng chết trên chuỗi, với một thông điệp không
 * trỏ về cấu hình. Không có giá trị nào thay được một địa chỉ thật.
 *
 * Người ghi beacon backing là keeper tầng GreenBack của kho này (chốt 2026-09-19) —
 * không phải engine CarpetMint. Ai đi tìm chủ của giá trị này thì tìm ở đó.
 */
export interface InstantDeployment {
  /** Địa chỉ chứa datum UM (hệ số cầu mạng, keeper cập nhật mỗi epoch). */
  umDatumAddress: string;
  /** NFT của datum UM — `policyId + assetNameHex`. */
  umNftUnit: string;
  /** Địa chỉ chứa beacon backing (`B` là một DANH MỤC token, chốt 2026-09-18). */
  backingBeaconAddress: string;
  /** NFT của beacon backing. */
  backingBeaconNftUnit: string;
}

export interface Deployment {
  /** Bản chép chép từ đâu, ngày nào. BẮT BUỘC. */
  source: string;
  lampPolicyId: string;
  /** Tên tài sản LAMP dạng hex. THEO MẠNG: `tLAMP` testnet, `LAMP` mainnet. Đây là
   *  apply-param #2 của mọi vault — hardcode giá trị testnet vào mã là dựng ra một vault
   *  mainnet không bao giờ nhìn thấy LAMP của chính nó (BOUNDARIES §2). */
  lampAssetNameHex: string;
  vaults: VaultScope[];
  shardAddress: string;
  /** UTxO mang script tham chiếu CIP-33. KHÔNG phải tối ưu: đính kèm cả hai validator
   *  vào một tx cho 17 303 byte trên Preview, vượt trần 16 384 — không có chúng thì
   *  ScheduleCommit và Consume KHÔNG dựng nổi tx nào. */
  refScriptUtxos: { vault: OutRefConfig; shard: OutRefConfig; consume: OutRefConfig };
  consume: ConsumeDeployment;
  /** Tuỳ chọn: thiếu mục này thì đường `/tx/instant-gen` ĐÓNG (404), các đường khác
   *  chạy bình thường. Đóng một cửa vì thiếu dữ kiện thì tốt hơn mở nó ra để mọi tx
   *  chết trên chuỗi. */
  instant?: InstantDeployment;
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
}

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
  /** Thẻ bài chia sẻ. Rỗng CHỈ được phép khi `host` là loopback. */
  token: string;
  requestTimeoutMs: number;
  /** Khoá mềm theo `owner_pkh` sống bao lâu, cũng là `expires_at` của tx trả về. */
  lockTtlMs: number;
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

  return {
    network, blockfrostUrl, blockfrostProjectId, deployment,
    changeAddressStrategy: strategyRaw as ChangeAddressStrategy,
    vaultPlutusJsonPath, host, port, token, requestTimeoutMs, lockTtlMs,
  };
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

  const shardAddress = scriptAddress(str(o.shard_address, "shard_address"), prefix, network, "shard_address").address;

  const refs = obj(o.ref_script_utxos, "ref_script_utxos");
  const refScriptUtxos = {
    vault: outRef(str(refs.vault, "ref_script_utxos.vault"), "ref_script_utxos.vault"),
    shard: outRef(str(refs.shard, "ref_script_utxos.shard"), "ref_script_utxos.shard"),
    consume: outRef(str(refs.consume, "ref_script_utxos.consume"), "ref_script_utxos.consume"),
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
  };

  // Mục `instant` là TUỲ CHỌN. Vắng ⟹ `/tx/instant-gen` đóng; CÓ ⟹ mọi trường bắt
  // buộc, phân tích bằng đúng bộ hàm NÉM như `consume`. Không có nửa vời: một mục
  // khai thiếu một trường là một cửa mở ra rồi chết trên chuỗi.
  let instant: InstantDeployment | undefined;
  if (o.instant !== undefined) {
    const i = obj(o.instant, "instant");
    instant = {
      umDatumAddress: scriptAddress(str(i.um_datum_address, "instant.um_datum_address"), prefix, network, "instant.um_datum_address").address,
      umNftUnit: unit(str(i.um_nft_unit, "instant.um_nft_unit"), "instant.um_nft_unit"),
      backingBeaconAddress: scriptAddress(str(i.backing_beacon_address, "instant.backing_beacon_address"), prefix, network, "instant.backing_beacon_address").address,
      backingBeaconNftUnit: unit(str(i.backing_beacon_nft_unit, "instant.backing_beacon_nft_unit"), "instant.backing_beacon_nft_unit"),
    };
  }

  // Mục `did_stake` TUỲ CHỌN, cùng luật với `instant`: có thì đủ trường và đúng hình dạng.
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

  return {
    source, lampPolicyId, lampAssetNameHex, vaults, shardAddress, refScriptUtxos, consume, instant, didStake,
    feePayerCollateralLovelace,
  };
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
