// scripts/config.ts — Shared testnet config
// Điền vào sau khi hoàn thành từng bước deploy
// KHÔNG commit file này nếu chứa private key thật

import "dotenv/config";
import { slotsPerEpoch, msPerEpoch, lampAssetName, type Network } from "@magiclamp/protocol-utils";
import type { LucidEvolution } from "@lucid-evolution/lucid";
// Giới hạn shard là ràng buộc cưỡng chế on-chain — giữ MỘT nguồn duy nhất.
// Khai lại ở đây từng làm hai nơi có thể trôi khỏi nhau mà không test nào đỏ.
import { SHARD_COUNT, SHARD_CAP } from "../ScheduleGen/offchain/src/constants.js";

// ── Network ───────────────────────────────────────────────────
export const NETWORK: Network = (process.env.NETWORK ?? "Preview") as Network;
export const BLOCKFROST_URL = `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0`;
export const BLOCKFROST_KEY = process.env.BLOCKFROST_KEY ?? "";
export const PRIVATE_KEY    = process.env.PRIVATE_KEY ?? "";
export const WALLET_SEED    = (process.env.WALLET_SEED ?? "").trim().replace(/\s+/g, " ");

if (!BLOCKFROST_KEY)              throw new Error("BLOCKFROST_KEY missing in .env");
if (!PRIVATE_KEY && !WALLET_SEED) throw new Error("Either PRIVATE_KEY or WALLET_SEED required in .env");

/** Select wallet from whichever credential is available. CRLF-safe for Windows. */
export function selectWallet(lucid: LucidEvolution): void {
  if (PRIVATE_KEY)      lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);
  else if (WALLET_SEED) lucid.selectWallet.fromSeed(WALLET_SEED);
}

// ── Script hashes (điền sau khi aiken build) ──────────────────
// Lấy từ: cat [Module]/onchain/plutus.json | jq '.validators[0].hash'
// SnapshotGen/VacuumGen đã dời sang Legacy/ (mô hình GenMAGIC v3.3,
// đã bỏ) — không còn hash nào cho hai module đó ở đây.
export const SCRIPT_HASHES = {
  vault_instant:   process.env.VAULT_INSTANT_HASH   ?? "FILL_AFTER_AIKEN_BUILD",
  vault_schedule:  process.env.VAULT_SCHEDULE_HASH  ?? "FILL_AFTER_AIKEN_BUILD",
  shard:           process.env.SHARD_HASH           ?? "FILL_AFTER_AIKEN_BUILD",
  um_datum:        process.env.UM_DATUM_HASH        ?? "FILL_AFTER_AIKEN_BUILD",
  // BackingBeacon script hash (§6.3)  [CẦN XÁC NHẬN — chờ CARP]
  // All-zero default = beacon not deployed ⟹ InstantGen SHUT (fail-closed).
  backing_beacon:  process.env.BACKING_SCRIPT_HASH  ?? "00".repeat(28),
};

// ── Token policy IDs (điền sau khi mint) ─────────────────────
/** Policy id LAMP đã KIỂM. Ném khi thiếu hoặc sai hình dạng.
 *
 * VÌ SAO LÀ CỔNG CHỨ KHÔNG PHẢI GIÁ TRỊ MẶC ĐỊNH. Bản cũ trả chuỗi
 * `"FILL_AFTER_MINT"`. Vài nơi gọi có kiểm chuỗi đó, nhưng
 * `deploy/03_deploy_shards.ts` và `deploy/06_publish_ref_scripts.ts` đưa thẳng nó
 * vào **apply-param** mà không kiểm gì. Apply-param là tham số lúc BIÊN DỊCH: một
 * giá trị rác ở đó vẫn cho ra bytes, vẫn cho ra script hash, vẫn deploy êm — và
 * địa chỉ thu được sai vĩnh viễn, không lệnh nào đỏ. Đó đúng là hình dạng
 * "rót đúng địa chỉ nhưng không vào sổ".
 *
 * Đặt ở `POLICY_IDS.lamp` dưới dạng getter để MỌI nơi gọi được che cùng lúc,
 * thay vì rải cổng ở từng tệp rồi sót đúng hai tệp nguy hiểm nhất.
 */
/** Policy ĐÃ BIẾT là không phải LAMP. Danh sách TỪ CHỐI, không phải danh sách cho phép.
 *
 * Hai loại giá trị này bất đối xứng, và chỗ đó quyết định cái nào được gõ cứng:
 * gõ cứng một giá trị CHO PHÉP là dựng một bản sao sẽ chết im lặng khi nguồn đổi —
 * và nguồn thật sắp đổi, kho LAMP đang đổi tên bốn nhãn NFT mà nhãn là apply-param
 * nằm TRONG policy id. Gõ cứng một giá trị TỪ CHỐI thì hỏng về phía an toàn: sai
 * lắm là chặn nhầm một thứ hợp lệ, và người bị chặn BIẾT mình bị chặn.
 *
 * Vì sao cần đến nó dù đã có cổng hình dạng ở dưới: `28e916b0…` là 56 ký tự hex
 * hợp lệ. Cổng hình dạng KHÔNG phân biệt được nó với policy thật. Và sổ trạng thái
 * `scripts/state.*.sh` bị `.gitignore` chặn, nên bản vá trong kho không với tới được
 * sổ cũ đang nằm trên đĩa của từng máy — máy nào còn sổ cũ thì vẫn nạp đúng giá trị
 * đó vào môi trường, và cổng hình dạng sẽ để nó đi qua.
 *
 * Nguồn phân loại: kho LAMP ▸ Genesis ▸ `lampPolicies` ▸ `NON_LAMP_LOOKALIKE_POLICIES`.
 * Chép có nhãn vì không có đường nhập khẩu: kho này chưa phụ thuộc gói đó.
 * Chép ngày 2026-09-14.
 */
const NON_LAMP_LOOKALIKE_POLICIES: Record<string, string> = {
  "28e916b097be13ed955330f00710bd93e2ea74bbc89aa5f5cd0f12b4":
    "chính sách chữ-ký-đơn suy từ khoá ví deploy của kho này — không trần phát hành, " +
    "không SupplyState, không cổng WHO; đã có lúc cung lên 72 tỷ, gấp đôi trần 36 tỷ. " +
    "Nó đúc được cả REG và SUPPLY nên bắt chước trọn hình dạng của lamp_mint thật.",
  "7a1a7aed5ec47acc37b6fa82695c1219bf76895b505b01161367adf9":
    "bản diễn tập đời trước, đã bị thay (SUPERSEDED).",
};

function requireLampPolicyId(): string {
  const v = process.env.LAMP_POLICY_ID ?? "";
  const why = NON_LAMP_LOOKALIKE_POLICIES[v];
  if (why) {
    throw new Error(
      `LAMP_POLICY_ID đang trỏ vào một token KHÔNG PHẢI LAMP: ${v}\n` +
      `  ${why}\n` +
      `  · Giá trị này thường tới từ một sổ trạng thái cũ (\`scripts/state.<mạng>.sh\`) —` +
      ` tệp đó nằm ngoài git nên bản vá trong kho không dọn hộ được. Dọn tay.\n` +
      `  · Nó hiển thị ra đúng chữ "tLAMP" và đúng 56 ký tự hex, nên không cổng hình dạng` +
      ` nào phân biệt được. Phải so CẢ policy id lẫn asset name hex với sổ canonical.`,
    );
  }
  if (!/^[0-9a-f]{56}$/.test(v)) {
    throw new Error(
      `LAMP_POLICY_ID thiếu hoặc sai hình dạng (nhận ${JSON.stringify(v)}). ` +
      `Phải là 56 ký tự hex thường.\n` +
      `  · ĐỪNG tự đúc LAMP để lấp chỗ này. Policy đúc bằng native "sig" suy tất định ` +
      `từ khoá ví, KHÔNG có trần phát hành, và đúc lần hai thì cộng dồn lên tài sản cũ.\n` +
      `  · Lấy giá trị canonical THEO MẠNG từ kho LAMP (Genesis ▸ lampPolicies). Token ` +
      `hiển thị ra chữ "tLAMP" chưa chắc là LAMP — phải so CẢ policy id lẫn asset name hex.`,
    );
  }
  return v;
}

export const POLICY_IDS = {
  get lamp(): string { return requireLampPolicyId(); },
  um_nft:   process.env.UM_NFT_POLICY_ID   ?? "FILL_AFTER_DEPLOY_UM",
  shard_nft:process.env.SHARD_NFT_POLICY_ID ?? "FILL_AFTER_DEPLOY_SHARDS",
  // BackingBeacon NFT (§6.3)  [CẦN XÁC NHẬN — chờ CARP]
  // Default = all-zero: no UTxO can carry a token under a zero policy, so the
  // InstantGen reference-input lookup fails and Gen stays SHUT (fail-closed).
  // Never replace this with a fabricated value to "make it run".
  backing:  process.env.BACKING_NFT_POLICY_ID ?? "00".repeat(28),
};

// ── Asset names (hex) ─────────────────────────────────────────
// LAMP asset name is applied as a validator parameter (vault takes
// lamp_asset_name) — not a hardcoded literal — so the on-chain value check
// reads whatever asset the network's LAMP is minted under.
// DERIVED FROM NETWORK (same rule as MS_PER_EPOCH below): Mainnet "LAMP",
// testnets "tLAMP". A testnet default here would silently bake a tLAMP vault
// on a mainnet deploy — the exact lock this param exists to prevent.
// LAMP_ASSET_NAME env only overrides for a non-canonical mint.
export const ASSET_NAMES = {
  lamp:      process.env.LAMP_ASSET_NAME ?? lampAssetName(NETWORK),
  um_nft:    "554d44",     // "UMD"
  shard_nft: "5348415244", // "SHARD"
  backing:   "425251",     // "BRQ" — BackingBeacon
};

// ── Addresses (điền sau khi deploy) ──────────────────────────
export const ADDRESSES = {
  treasury: process.env.TREASURY_ADDRESS ?? "FILL_AFTER_DEPLOY",
};

// ── Protocol constants ───────────────────────────────────────
//
// 🔴 HAI ĐỒNG HỒ, KHÔNG SUY RA NHAU. Đừng "sửa" cái này cho khớp cái kia.
//
//   SLOTS_PER_EPOCH — nhịp THẬT của chuỗi Cardano (Preview 86_400 / Preprod 432_000 /
//                     Mainnet 432_000). Chỉ dùng khi phải diễn giải slot thật.
//                     KHÔNG đi vào apply-param của validator nào.
//   MS_PER_EPOCH    — nhịp của GIAO THỨC, và là apply-param #4 của mọi vault validator
//                     (xem `deployParams.ts`). Preprod cố tình KHÁC nhịp mạng.
//
// Công thức `ms_per_epoch = slots_per_epoch × 1000` từng đứng ở đúng dòng này và nó
// SAI: nó đúng cho Preview và Mainnet, sai cho Preprod. Ai áp lại công thức đó rồi
// chỉnh `MS_PER_EPOCH_BY_NETWORK` cho "khớp" sẽ đổi apply-param ⟹ đổi script hash ⟹
// đổi địa chỉ vault ⟹ mọi thứ đang sống trên Preprod (`scripts/DEPLOYED.md` §Preprod:
// vault `94c0c8b2…`, UM `c81d0a41…`) thành mồ côi, không ai spend được nữa.
// Nguồn duy nhất của hai bảng: `ProtocolUtils/src/index.ts` — đọc ghi chú ở đó trước
// khi đụng bất cứ con số nào.
export const PROTOCOL = {
  SHARD_COUNT,                            // ← ScheduleGen/offchain/src/constants.ts
  SHARD_CAP,                              // ← nt. (4.5×10^14 oildrop = 450M LAMP)
  SLOTS_PER_EPOCH: slotsPerEpoch(NETWORK), // nhịp chuỗi — hiện KHÔNG call site nào
  MS_PER_EPOCH:    msPerEpoch(NETWORK),    // nhịp giao thức — apply-param, 26 call site
  Q:               1_000_000_000n,
};

// ── Helpers ───────────────────────────────────────────────────
export function toUnit(policyId: string, assetName: string): string {
  return policyId + assetName;
}

export function lampToOildrop(lamp: bigint): bigint {
  return lamp * 1_000_000n;
}
