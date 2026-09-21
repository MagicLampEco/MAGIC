// scripts/config.ts — Shared testnet config
// Điền vào sau khi hoàn thành từng bước deploy
// KHÔNG commit file này nếu chứa private key thật

import "dotenv/config";
import { slotsPerEpoch, msPerEpoch, lampAssetName, type Network } from "@magiclamp/protocol-utils";
import type { LucidEvolution } from "@lucid-evolution/lucid";
// Giới hạn shard là ràng buộc cưỡng chế on-chain — giữ MỘT nguồn duy nhất.
// Khai lại ở đây từng làm hai nơi có thể trôi khỏi nhau mà không test nào đỏ.
import { SHARD_COUNT, SHARD_CAP } from "../ScheduleGen/offchain/src/constants.js";
// Cửa DUY NHẤT của cặp định danh CARP — xem khối chú thích ở `requireCarpIdentity`.
import { carpAssetClass, type CarpNetwork } from "../PrepaidGen/offchain/src/constants.js";

// ── Network ───────────────────────────────────────────────────
export const NETWORK: Network = (process.env.NETWORK ?? "Preview") as Network;
export const BLOCKFROST_URL = `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0`;
export const BLOCKFROST_KEY = process.env.BLOCKFROST_KEY ?? "";
export const PRIVATE_KEY    = process.env.PRIVATE_KEY ?? "";
export const WALLET_SEED    = (process.env.WALLET_SEED ?? "").trim().replace(/\s+/g, " ");

// Thông báo chỉ nêu TÊN BIẾN còn thiếu, không nêu tệp nào giữ giá trị: chỉ đường tới kho
// khoá là thứ cần TRƯỚC một giá trị, nên một câu lỗi "tìm ở tệp X" là một chỉ dẫn sai chỗ
// kể cả khi nó đúng. Bản trước viết "missing in .env" và tệp đó còn không phải nơi giá trị
// thật đang nằm, nên nó vừa lộ hướng vừa chỉ nhầm hướng.
if (!BLOCKFROST_KEY)              throw new Error("Thiếu biến môi trường BLOCKFROST_KEY.");
if (!PRIVATE_KEY && !WALLET_SEED) throw new Error("Thiếu biến môi trường: cần PRIVATE_KEY hoặc WALLET_SEED.");

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
  // BackingBeacon script hash (§6.3) — chưa deploy. Người GHI beacon là keeper
  // tầng GreenBack của MagicLamp (chốt 2026-09-19), không phải nhà CARP; xem
  // ghi chú dài ở `POLICY_IDS.backing`.
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
  "3628b069a032490ca24863f48fe36f902d6cf676e1f5b5d3e7845d44":
    "mang đúng asset 744c414d50, cung 1.000.000. NGUY hơn hàng nhái thường vì nó NẰM " +
    "SẴN trong UTxO của một ví deploy đang dùng — một vòng lặp chọn tài sản theo TÊN " +
    "nhặt phải nó mà không cần ai tấn công. Hai sổ trong hệ ghi XUẤT XỨ khác nhau cho " +
    "cùng policy này (hàng thử cũ đã bỏ / ví phí tự đúc cho chính nó), nghĩa là ít " +
    "nhất một sổ đang ghi sai nguồn. Cổng KHÔNG đọc xuất xứ — nó so policy id — nên " +
    "chênh đó không đổi hành vi chặn; ghi ra để lần truy ngược sau không ra sai chỗ. " +
    "Chép có nhãn 2026-09-16.",
};

/** Đời LAMP **THẬT** nhưng ĐÃ BỊ THAY. Khác loại với bảng trên, và chỗ khác nhau
 * đó quyết định thông điệp lỗi phải nói gì.
 *
 * BA đời, BA loại — đừng gộp hai đời sau làm một:
 *   `28e916b0…` chưa bao giờ là LAMP: chữ-ký-đơn, không trần, không `SupplyState`.
 *   `d9c09230…` CÓ one-shot proof, CÓ `SupplyState`, chỉ là đời cũ.
 *   `7a1a7aed…` thì KHÁC: nó neo native-sig ⇒ KHÔNG one-shot ⇒ không có trần
 *   cung cưỡng chế được. Người giữ khoá đúc lại SUPPLY NFT lượt hai là đúc lại
 *   trọn cap — xem đúng bảng bên dưới, `SUPERSEDED_LAMP_POLICIES["7a1a7aed…"]`.
 *
 * Gộp chung một bảng thì thông điệp lỗi khai sai bản chất của loại thứ hai, và
 * người đọc đi tìm một token nhái không tồn tại.
 *
 * > Bản trước của đoạn này xếp `7a1a7aed…` chung với `d9c09230…` là "CÓ one-shot
 * > proof, chỉ là đời cũ" — NGƯỢC với chính bảng nằm ngay dưới nó. Cổng không
 * > hỏng vì cổng đọc BẢNG, không đọc chú thích; cái hỏng là chú thích giải thích
 * > VÌ SAO bảng tồn tại, và người sửa cổng lần sau đọc nó trước. Kho LAMP soi ra
 * > và đối chiếu với sổ nguồn `Genesis/offchain/src/lampPolicies.ts:124`
 * > (`anchor: "native-sig-markers"`), thư `lamp0920mg`, 2026-09-20.
 *
 * Vì sao bảng này phải có, đo được hôm nay: ví Preprod DUY NHẤT có tADA đang cầm
 * `d9c09230…` (10⁹ đơn vị). Bảng cũ liệt `28e916b0…` và `7a1a7aed…` nhưng KHÔNG
 * có `d9c09230…` — nên một lượt E2E chạy bằng đúng ví đó sẽ đi lọt cổng này và
 * xanh trọn vẹn trên một đời đã chết. Cổng im lặng đúng ca nó sinh ra để chặn.
 *
 * Nguồn phân loại: kho LAMP ▸ `Genesis/offchain/src/lampPolicies.ts`. Chép có
 * nhãn (chưa có đường nhập khẩu), ngày 2026-09-16. Câu hỏi cũ ở đây — sổ nguồn
 * có `d9c09230…` chưa — đã có đáp: CÓ, `lampPolicies.ts:151-155`,
 * `id: "preprod-oneshot-12param"`, `status: "SUPERSEDED"` (kho LAMP xác nhận
 * 2026-09-20). Chỗ thiếu không ở nguồn.
 *
 * ✅ `8169b76c…` ở `LAMP_ACTIVE` **KHÔNG** thành SUPERSEDED — chốt 2026-09-21
 * (thư `lam921mag-a`). Bản trước của chú thích này cảnh báo ngược: *"SẮP thành
 * SUPERSEDED, đợt đổi nhãn bốn marker đi CÙNG đợt đúc cuối, mà bốn nhãn là
 * apply-param ⇒ policy id đổi"*. Chủ dự án kho LAMP chốt đúc THÊM dưới chính
 * policy đang chạy, không dựng policy mới. Sổ nguồn: `Genesis/offchain/src/
 * lampPolicies.ts` ▸ `preprod-oneshot-14param`, `status: "ACTIVE"`,
 * `supersededBy: null`, `mintParamCount: 14`.
 *
 * ⟹ `lamp_policy_id` không đổi ⟹ script hash cụm vault không đổi ⟹ **không phải
 * dựng lại vì lý do này**. (Cụm vẫn sẽ dựng lại một lượt, nhưng vì nhịp epoch +
 * hình dạng datum — lý do KHÁC, mốc KHÁC. Đừng gộp hai cái làm một.)
 *
 * Phạm vi HẸP: câu trên nói về **Preprod**. Policy mạng chính là một giá trị khác
 * và chưa tồn tại; kho LAMP không khai nó là "sẽ giống". Nghĩa vụ báo trước khi
 * giá trị đổi vẫn nguyên hiệu lực.
 */
const SUPERSEDED_LAMP_POLICIES: Record<string, string> = {
  "7a1a7aed5ec47acc37b6fa82695c1219bf76895b505b01161367adf9":
    "đời `preprod/preview-nativesig`, đã bị thay. Policy giống nhau xuyên mạng vì " +
    "cả bốn khe marker đều neo bởi native-sig ví deploy — người giữ khoá đúc lại " +
    "SUPPLY NFT lượt hai là đúc lại trọn cap.",
  "d9c09230079b810ab5ed92e8db4c190d42efc42db6aac028656f7e07":
    "đời `preprod-oneshot-12param`, đã bị thay bởi `8169b76c…` " +
    "(`preprod-oneshot-14param`, đúc 2026-09-14). Đây là thứ ví Preprod có tADA " +
    "đang cầm — nên nó là đời DỄ dùng nhầm nhất, không phải đời khó gặp nhất.",
};

function requireLampPolicyId(): string {
  const v = process.env.LAMP_POLICY_ID ?? "";
  const doi = SUPERSEDED_LAMP_POLICIES[v];
  if (doi) {
    throw new Error(
      `LAMP_POLICY_ID đang trỏ vào một đời LAMP ĐÃ BỊ THAY: ${v}\n` +
      `  ${doi}\n` +
      `  · Đây KHÔNG phải token nhái — đừng đi tìm một kẻ giả mạo. Nó là LAMP thật ` +
      `của một đời đã chết, nên mọi phép so hình dạng đều cho nó đi qua.\n` +
      `  · Hại cụ thể nếu cứ chạy: \`03_deploy_shards.ts\` và \`07_create_schedule_vault.ts\` ` +
      `đều apply-param theo policy này ⟹ 16 shard one-shot và vault sinh ra ở một ` +
      `script hash không ai dùng nữa, và mất thêm 2 epoch chờ để làm lại.\n` +
      `  · Lấy đời ACTIVE theo mạng từ kho LAMP (Genesis ▸ \`activeLampPolicyId\`).`,
    );
  }
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
  // BackingBeacon NFT (§6.3) — chưa deploy.
  // 🔴 VAI ĐÃ ĐƯỢC CHỐT LẠI 2026-09-19: beacon này do keeper tầng GreenBack của
  // MagicLamp ghi, KHÔNG phải một thứ chờ nhà CARP giao. Dòng cũ ở đây khai
  // "chờ CARP" và khai đó tự già: nó làm việc trông như đang bị chặn bởi bên
  // khác trong khi nó nằm trong tầm tay nhà này.
  // Hành vi thì GIỮ NGUYÊN — all-zero: không UTxO nào mang nổi token dưới một
  // policy toàn số 0, nên phép tra reference input hỏng và Gen ĐÓNG (fail-closed).
  // Đừng thay bằng một giá trị bịa để "cho nó chạy".
  backing:  process.env.BACKING_NFT_POLICY_ID ?? "00".repeat(28),
  get carp(): string { return requireCarpIdentity().policyId; },
};

// ── Asset names (hex) ─────────────────────────────────────────
// LAMP asset name is applied as a validator parameter (vault takes
// lamp_asset_name) — not a hardcoded literal — so the on-chain value check
// reads whatever asset the network's LAMP is minted under.
// DERIVED FROM NETWORK (same rule as MS_PER_EPOCH below): Mainnet "LAMP",
// testnets "tLAMP". A testnet default here would silently bake a tLAMP vault
// on a mainnet deploy — the exact lock this param exists to prevent.
// LAMP_ASSET_NAME env only overrides for a non-canonical mint.
//
// 🔴 VẾ ASSET NAME TỪNG KHÔNG CÓ CỔNG NÀO, trong khi câu lỗi của cổng policy ngay
// trên đã hứa hai lần là "phải so CẢ policy id lẫn asset name hex". Đo 2026-09-16,
// nạp tệp này với các bộ biến môi trường:
//
//   LAMP_ASSET_NAME=deadbeefcafe  → QUA    (hex hợp lệ, không phải LAMP)
//   LAMP_ASSET_NAME=4c414d50      → QUA    (tên MAINNET trên một mạng thử)
//   LAMP_ASSET_NAME=              → QUA    (RỖNG — `??` không bắt chuỗi rỗng)
//
// Ca rỗng là ca nặng nhất, và nó vẫn ra một script hash trông hợp lệ: vault sinh
// ra mang `lamp_asset_name` là chuỗi byte rỗng, nên `quantity_of(value, policy, "")`
// trả 0 mãi mãi — LAMP gửi vào không bao giờ được vault nhận ra. Rót đúng địa chỉ,
// nằm ngoài sổ. Và đường đi tới đó không xa: hai sổ trạng thái hiện có đều đã xoá
// `LAMP_POLICY_ID` bằng cách bỏ hẳn dòng, nên người dọn tiếp theo làm điều tự nhiên
// với asset name là để lại `LAMP_ASSET_NAME=`.
//
// Hai vế của MỘT cặp định danh nay đi qua hai cổng cùng mức nghiêm.
function requireLampAssetName(): string {
  const canonical = lampAssetName(NETWORK);
  const raw = process.env.LAMP_ASSET_NAME;
  if (raw === undefined) return canonical;

  if (!/^([0-9a-f]{2})+$/.test(raw)) {
    throw new Error(
      `LAMP_ASSET_NAME sai hình dạng (nhận ${JSON.stringify(raw)}). Phải là hex ` +
      `thường, SỐ KÝ TỰ CHẴN, và KHÔNG được rỗng.\n` +
      `  · Chuỗi rỗng đi lọt mọi phép kiểm hình dạng lỏng và vẫn ra một script hash ` +
      `hợp lệ — vault đó không bao giờ nhận ra LAMP của chính nó, và không giao dịch ` +
      `nào báo lỗi.\n` +
      `  · Bỏ hẳn biến này đi thì giá trị canonical theo mạng (${canonical}) được dùng. ` +
      `Để trống KHÔNG phải cách bỏ.`,
    );
  }

  if (raw !== canonical && process.env.LAMP_ASSET_NAME_NONCANONICAL !== "1") {
    throw new Error(
      `LAMP_ASSET_NAME=${raw} KHÁC giá trị canonical của mạng ${NETWORK} ` +
      `(${canonical}).\n` +
      `  · Đây là tham số apply-param #2 của mọi vault: sai ở đây là sai script hash, ` +
      `sai địa chỉ, và không sửa được bằng cách đổi cấu hình về sau.\n` +
      `  · Trộn hai mạng đi qua êm nếu không có cổng này — tên mainnet \`4c414d50\` ` +
      `là một chuỗi hex hoàn toàn hợp lệ trên Preprod.\n` +
      `  · Thật sự đang trỏ vào một lượt đúc KHÔNG canonical thì khai rõ ý định: ` +
      `đặt LAMP_ASSET_NAME_NONCANONICAL=1 trong cùng một lệnh.`,
    );
  }

  return raw;
}

export const ASSET_NAMES = {
  get lamp(): string { return requireLampAssetName(); },
  um_nft:    "554d44",     // "UMD"
  shard_nft: "5348415244", // "SHARD"
  backing:   "425251",     // "BRQ" — BackingBeacon
  get carp(): string { return requireCarpIdentity().assetName; },
};

// ── CARP — apply-param #1 và #2 của CẢ HAI validator PrepaidGen ──
//
// KHÔNG có giá trị mặc định, và KHÔNG có bản all-zero fail-closed như `backing`
// ở trên. Hai cách fail-closed đó KHÁC NHAU, và chỗ khác nhau là chỗ quyết định:
//
//   `backing` đi vào REFERENCE INPUT lúc chạy. All-zero ⟹ không UTxO nào mang nổi
//   token dưới policy đó ⟹ phép tra hỏng ⟹ InstantGen ĐÓNG. Sai mà an toàn.
//
//   `carp_policy_id` đi vào APPLY-PARAM lúc BIÊN DỊCH. All-zero vẫn ra bytes, vẫn
//   ra script hash 28 byte, vẫn deploy êm — và cái ra đời là một quỹ không bao giờ
//   nhìn thấy CARP của chính nó, cùng một vault ghim `paid_fund_hash` của cái quỹ
//   đó. Không giao dịch nào đỏ; hỏng lộ ra lúc có người khoá CARP thật vào.
//
// Nên ở đây cổng phải NÉM, không được đệm. Cùng lý do và cùng hình dạng với
// `requireLampPolicyId` bên trên.
//
// 🔴 VÀ HÌNH DẠNG KHÔNG PHẢI ĐỊNH DANH. Cặp `(policy_id, asset_name)` là định danh;
// asset name một mình không bao giờ là điều kiện đủ (BOUNDARIES.md §1). Mọi chuỗi
// 56 ký tự hex đều qua được một phép kiểm hình dạng, kể cả policy của một đời CARP
// đã bị thay. Nên cổng dưới đây đối chiếu với cặp CANONICAL, không chỉ đo hình dạng.
//
// Bản trước của khối này viết "Trên Preprod hiện có HAI dòng tài sản cùng hiện ra
// chữ tCARP dưới hai policy khác nhau" và KHÔNG neo vào đâu. Kiểm kê trọn của chính
// kho (`scripts/DEPLOYED.md`, đo 2026-09-14 qua Blockfrost `/assets/policy/`) trả
// **0 dòng** mang tên `tCARP`; dòng duy nhất mang tên CARP là `43415250` trên
// **Preview** (`DEPLOYED.md:49`). Câu đó bị XOÁ chứ không giữ kèm đính chính — nó
// còn là LÝ LẼ giữ cổng ở mức chỉ-đo-hình-dạng ("hình dạng không phân biệt được hai
// policy, nên thôi"), tức một dữ kiện sai đang chống đỡ một cổng lỏng.
// 🔴 CẶP CANONICAL ĐÃ CÓ TRONG KHO — cổng này KHÔNG được dựng lại nó.
//
// `PrepaidGen/offchain/src/constants.ts` ▸ `carpAssetClass(network)` là cửa DUY
// NHẤT của cặp `(policy_id, asset_name)`, fail-closed sẵn (mạng chưa có CARP thì
// NÉM, không trả chuỗi rỗng). Bản trước của hàm dưới đây đọc thẳng hai biến môi
// trường rồi tự kiểm hình dạng — tức một NGUỒN THỨ HAI cho cùng một sự thật, và
// là nguồn lỏng hơn. Ba chỗ nó lỏng hơn, đo được:
//
//   · `/^[0-9a-f]{56}$/` cho `"00".repeat(28)` ĐI QUA — đúng giá trị mà chú thích
//     ngay trên nó cảnh báo là chết người. Và thành ngữ đó có sẵn cách 98 dòng
//     (`backing` ở trên dùng all-zero làm mặc định HỢP LỆ), nên chép sang là việc
//     tự nhiên nhất người vận hành làm.
//   · `/^([0-9a-f]{2})+$/` cho `"7443415250"` (hex ASCII của "tCARP") ĐI QUA, trong
//     khi `HEX28` bên PrepaidGen chặn — asset name CARP là một BĂM 28 byte, không
//     phải ticker mã hoá. Đó đúng là lớp lỗi đã vá 2026-09-11.
//   · Không đối chiếu với giá trị canonical nào, dù kho đã giữ sẵn cặp Preprod.
//
// Nên hàm này nay chỉ còn hai việc: gọi cửa canonical, và gác đường ĐÈ bằng biến
// môi trường ở cùng mức nghiêm với `requireLampAssetName` bên trên.
export interface CarpIdentity { policyId: string; assetName: string }

const CARP_HEX28 = /^[0-9a-f]{56}$/;
const CARP_ALL_ZERO = "00".repeat(28);

export function requireCarpIdentity(): CarpIdentity {
  // Ném ở đây khi mạng chưa có CARP — câu của `carpAssetClass` đã nói rõ phải làm gì.
  const canonical = carpAssetClass(NETWORK as CarpNetwork);

  const rawPolicy = process.env.CARP_POLICY_ID;
  const rawName   = process.env.CARP_ASSET_NAME;
  if (rawPolicy === undefined && rawName === undefined) return canonical;

  // Đè một vế mà bỏ vế kia là trộn hai đời CARP: policy của đời này, tên của đời kia.
  if (rawPolicy === undefined || rawName === undefined) {
    throw new Error(
      `CARP_POLICY_ID và CARP_ASSET_NAME phải đi THÀNH CẶP — đang có đúng một vế.\n` +
      `  · Định danh tài sản là CẶP; asset name một mình không bao giờ là điều kiện đủ ` +
      `(BOUNDARIES.md §1).\n` +
      `  · Đè một vế thì vế kia lặng lẽ lấy giá trị canonical, và cái ra đời là một quỹ ` +
      `ghim policy của một đời CARP với tên của một đời khác.\n` +
      `  · Bỏ hẳn CẢ HAI biến thì cặp canonical của mạng ${NETWORK} được dùng.`,
    );
  }

  for (const [ten, gt] of [["CARP_POLICY_ID", rawPolicy], ["CARP_ASSET_NAME", rawName]] as const) {
    if (!CARP_HEX28.test(gt)) {
      throw new Error(
        `${ten} sai hình dạng (nhận ${JSON.stringify(gt)}). Phải là 56 ký tự hex thường ` +
        `— 28 byte, cả policy id lẫn asset name.\n` +
        `  · Asset name CARP là một BĂM 28 byte do nhà CarpetMint phát, KHÔNG phải hex của ` +
        `chuỗi "CARP"/"tCARP". Một ticker mã hoá (\`7443415250\`) đi lọt phép kiểm "hex chẵn" ` +
        `và bị \`HEX28\` bên PrepaidGen chặn — hai cổng cho cùng một sự thật thì bản lỏng hơn ` +
        `là bản quyết định.\n` +
        `  · Chuỗi rỗng vẫn ra script hash hợp lệ, rồi quỹ gọi \`quantity_of(value, policy, "")\` ` +
        `và luôn nhận 0: CARP khoá vào nằm TRONG SÂN quỹ và NGOÀI SỔ quỹ.`,
      );
    }
    if (gt === CARP_ALL_ZERO) {
      throw new Error(
        `${ten} toàn số 0. Đây là apply-param lúc BIÊN DỊCH, không phải một biến cấu hình ` +
        `điền sau.\n` +
        `  · All-zero vẫn ra bytes, vẫn ra script hash 28 byte hợp lệ, vẫn deploy êm — cái ` +
        `ra đời là một quỹ không bao giờ nhìn thấy CARP của chính nó, và không giao dịch nào ` +
        `báo đỏ.\n` +
        `  · Mặc định all-zero của \`backing\` ở trên là hợp lệ vì \`backing\` đi vào REFERENCE ` +
        `INPUT lúc CHẠY: all-zero ⟹ tra hỏng ⟹ cửa ĐÓNG. Hai cách fail-closed đó khác nhau; ` +
        `đừng chép thành ngữ từ chỗ kia sang chỗ này.`,
      );
    }
  }

  if (rawPolicy !== canonical.policyId || rawName !== canonical.assetName) {
    if (process.env.CARP_IDENTITY_NONCANONICAL !== "1") {
      throw new Error(
        `Cặp CARP đang đè KHÁC cặp canonical của mạng ${NETWORK}.\n` +
        `  · canonical : ${canonical.policyId} / ${canonical.assetName}\n` +
        `  · đang đè   : ${rawPolicy} / ${rawName}\n` +
        `  · Preprod có HAI dòng tài sản cùng hiện ra chữ \`tCARP\` dưới hai policy khác ` +
        `nhau, và phép kiểm hình dạng cho CẢ HAI đi qua. Hình dạng KHÔNG phải định danh.\n` +
        `  · Sai ở đây là sai script hash ⟹ sai địa chỉ ⟹ không sửa được bằng cách đổi cấu ` +
        `hình về sau, chỉ sửa được bằng biên dịch lại và công bố script tham chiếu mới.\n` +
        `  · Thật sự đang trỏ vào một đời CARP KHÔNG canonical thì khai rõ ý định: đặt ` +
        `CARP_IDENTITY_NONCANONICAL=1 trong cùng một lệnh.`,
      );
    }
  }

  return { policyId: rawPolicy, assetName: rawName };
}

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
//                     (xem `deployParams.ts`). Ta CHỌN giá trị này, chuỗi không áp nó.
//
// 🔴 TỪ 2026-09-20 HAI BẢNG TRÙNG SỐ TRÊN CẢ BA MẠNG — và đó là lúc mục này nguy hiểm
// nhất, không phải lúc nó thành thừa. Preprod đổi `86_400_000 → 432_000_000` nên
// `ms_per_epoch = slots_per_epoch × 1000` nay đúng ở Preview, Preprod lẫn Mainnet.
//
// Bản trước của khối này lập luận "đừng suy ra nhau VÌ công thức sai ở Preprod". Lý do
// đó đã chết, còn KẾT LUẬN thì không — và giữ một kết luận đúng bằng một lý do đã chết
// là cách nhanh nhất để người sau gỡ luôn kết luận. Lý do còn sống:
//
//   · `SLOTS_PER_EPOCH` do chuỗi Cardano quyết, ta ĐO nó, không đặt nó.
//   · `MS_PER_EPOCH` do ta đặt, và nó đi vào bytes của validator.
//   Hai đại lượng khác CHỦ. Chúng đang bằng nhau là một TRÙNG HỢP của bộ giá trị hôm
//   nay, không phải một bất biến — nên không có gì bảo đảm lần sau còn trùng.
//
// Ai thấy hai bảng trùng rồi "gộp cho gọn" bằng công thức × 1000 sẽ biến một giá trị ta
// chọn thành một giá trị chuỗi áp. Kể từ đó, một lần chuỗi đổi nhịp là apply-param tự
// đổi theo ⟹ đổi script hash ⟹ đổi địa chỉ vault ⟹ mọi thứ đang sống trên Preprod
// (`scripts/DEPLOYED.md` ▸ "Preprod — đời tLAMP THẬT, 2026-09-16") thành mồ côi, không
// ai spend được nữa. Không lệnh nào báo, vì cả hai bảng vẫn "đúng".
//
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
