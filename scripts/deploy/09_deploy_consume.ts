// scripts/deploy/09_deploy_consume.ts — Deploy ConsumeMAGIC infra (1 lần / 1 loại vault).
// Run: npx tsx deploy/09_deploy_consume.ts   (hoặc: npm run deploy:consume nếu thêm script)
//
// Tạo hạ tầng để tiêu MAGIC theo mô hình ENGAGEMENT (KHÔNG mint MAGIC):
//   1. price_nft  one-shot  → mint 1 "PRICE" NFT (xác thực beacon).
//   2. PriceParam beacon    → UTxO tại price_param address, inline PriceParam datum.
//   3. consume validator    → apply-param theo blueprint → hash + address.
//   4. Engage thread token  → MINT bằng CHÍNH handler `mint` của consume
//                             (policy id == consume script hash), tên asset
//                             = blake2b_256(cbor(seed)) — không còn engage_nft.ak.
//   5. Engage UTxO          → UTxO tại consume address, inline EngageDatum SẠCH.
// Tất cả trong 1 tx (tiêu 2 UTxO seed: g1 cho price_nft, g2 cho thread Engage).
//   6. ref-script `consume` → tx RIÊNG sau đó, đỗ ở bãi chung (scripts/refScripts.ts).
//
// Vì sao bước 6 nằm ở đây chứ không ở bước 06: hash của `consume` chỉ tính được
// SAU khi biết price_nft_policy và price_param_script_hash — hai thứ do chính bước
// này đúc ra. Bước 06 lo chân vault, bước này lo chân consume; tx consume cần CẢ
// HAI đã đỗ vì đính kèm cả hai validator cho 17.310 byte, vượt trần 16.384.
//
// PREREQ (đã deploy trước, nạp qua env — xem config.ts):
//   VAULT_KIND           — schedule | instant | prepaid. BẮT BUỘC, không mặc định.
//   VAULT_SCHEDULE_HASH (bước 07), VAULT_INSTANT_HASH (bước 05) hoặc VAULT_PREPAID_HASH
//   (bước 10), theo VAULT_KIND.
// RA: bộ khoá có hậu tố `_SCHEDULE` / `_INSTANT` / `_PREPAID` (scripts/consumeBook.ts). Mỗi
//   loại vault một lượt, các bộ khoá nằm cạnh nhau trong sổ, không đè nhau.
//   NETWORK, BLOCKFROST_KEY, WALLET_SEED/PRIVATE_KEY.
//
// KNOB (env, có default):
//   MAX_PRICE_STALE   — số epoch cho phép giá cũ (default 1). Baked vào consume hash.
//   PRICE_COMMITTEE   — danh sách pkh (hex, phẩy) được post giá về sau (default = ví deploy).
//   PRICE_THRESHOLD   — M-of-N committee threshold (default 1).
//   (PRICE_DEMAND_MULT đã BỎ: demand_mult nay nằm trên từng dòng OpPrice — CC-LOAD-COUNT-UNIT.
//    Đặt biến đó thì kịch bản ném lỗi, không lặng lẽ bỏ qua.)
//
// SEED CHO TRƯỚC (env tuỳ chọn, `scripts/deploySeeds.ts`):
//   DEPLOY_SEED_PRICE_NFT_<INSTANT|SCHEDULE|PREPAID> — seed g1 của price_nft cho loại két đang
//     dựng, `<tx>#<ix>`, ở bãi đỗ của ví (ở ví thì chỉ nhận khi KHÔNG có DEPLOY_EXPECT_HASHES).
//     Đã tiêu / chỗ khác / mang token / trùng seed vai khác / trùng seed sổ két ⟹ ném, không lùi
//     về chọn tự động. Vắng ⟹ như cũ (UTxO thuần ADA đầu tiên).
//   DEPLOY_EXPECT_HASHES — tệp JSON hash kỳ vọng (`clusterHashes.ts --out`); so price_nft_<loại> ·
//     price_param_<loại> · consume_<loại>, lệch ⟹ ném trước khi nộp. Chỉ nhận cùng seed cho trước.
//     Có seed cho trước mà vắng tệp ⟹ ném, trừ DEPLOY_EXPECT_NONE=1.
//
// ⚠  DANH SÁCH THAM SỐ KHÔNG khai tay ở file này nữa — đọc thẳng
//     `parameters[].title` từ ConsumeMAGIC/onchain/plutus.json qua
//     scripts/applyParams.ts. Chuỗi bake TUYẾN TÍNH, đổi thứ tự là sai hash:
//        price_nft (genesis_ref)
//          → price_param (committee, threshold, price_nft_policy, price_nft_name, ms_per_epoch)
//            → consume (…, price_param_script_hash)

import { wakemeVaultHash, windowOf } from "@magiclamp/protocol-utils";
import {
  Lucid, Blockfrost, Data,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, PROTOCOL, requireCarpIdentity,
} from "../config.js";
import { loadBlueprint, findValidator } from "../applyParams.js";
import {
  prepaidScriptPair, PRICE_NFT_NAME,
} from "../deployParams.js";
import { consumeChainChecked } from "../deployHashChecks.js";
import {
  assertDistinctPresetSeeds, loadExpectedHashes, parkFor, presetSeedAllowWallet, priceNftSeedRole,
  readPresetSeed, REGISTRY_SEED_BOOK_KEY, requireExpectInPresetMode, requirePresetForExpect,
  resolvePresetSeed, SEED_ENV, type Park,
} from "../deploySeeds.js";
import { readBookEntries } from "./11_deploy_gen_beacons.js";
import { stateBookPath } from "../stateBookPath.js";
import {
  encodePriceParam, EngageDatumSchema, type PriceParamT,
} from "../../ConsumeMAGIC/offchain/src/types.js";
import { vaultIdAssetName, mintVaultIdRedeemer } from "../vaultId.js";
import { parkAddressFor, publishRefScript } from "../refScripts.js";
import { assertValidPriceParam } from "@magiclamp/consumemagic-pricing";
import {
  consumeKey, parseVaultKind, requireConsumeVaultHash, vaultRefKey, type ConsumeKeyName,
} from "../consumeBook.js";

// EngageDatum lấy thẳng từ codec của module (5 trường, khớp `pub type EngageDatum`
// trong ConsumeMAGIC/onchain/lib/magiclamp/consume/types.ak). Từng có một bản khai
// TẠI CHỖ ở đây khi codec offchain còn trễ một trường — đã xoá: hai bản schema cho
// cùng một datum là đúng thứ sẽ trôi khỏi nhau trong im lặng.

// `PRICE_NFT_NAME` ("PRICE") và `BURN_BATCH_CONSTR` (= 2, BurnBatch của cả hai vault sinh MAGIC)
// nay ở `deployParams.ts`, cạnh `consumeScriptChain` — chuỗi bake mà bước này và
// `clusterHashes.ts` cùng gọi.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function isPureAda(u: UTxO): boolean {
  return Object.keys(u.assets).every((k) => k === "lovelace");
}

async function main() {
  console.log("=== Step 9: Deploy ConsumeMAGIC infra (price NFT + beacon + engage NFT + Engage) ===\n");

  // `consume` được apply-param bởi hash của MỘT loại vault sinh MAGIC. Nó KHÔNG giải
  // mã `VaultDatum` — chỉ đọc trường 0 (`owner`) qua `un_constr_data`
  // (ConsumeMAGIC/onchain/validators/consume.ak:443-461) — nên cùng mã nguồn phục vụ
  // được cả vault InstantGen lẫn vault ScheduleGen, mỗi loại một instance, hash riêng.
  //
  // Loại vault là tham số BẮT BUỘC, không suy từ biến nào đang có mặt. Bản trước lấy
  // `VAULT_HASH ?? VAULT_SCHEDULE_HASH ?? VAULT_INSTANT_HASH`: sổ có cả hai vault thì mọi
  // lượt đều ra bản cho ScheduleGen, kể cả lượt định dựng cho InstantGen; và khoá in ra
  // không hậu tố nên lượt thứ hai đè lượt thứ nhất trong sổ. Xem `scripts/consumeBook.ts`.
  // (Bản trước còn nói InstantGen "chưa cấp nổi 1 nanogic" — Nợ #19 đã đóng 2026-09-16,
  // `DevStatus.md` bảng module ▸ InstantGen.)
  const vaultKind = parseVaultKind(process.env.VAULT_KIND);
  // Két Prepaid: dựng lại hash từ ĐỜI CARP hiện hành rồi đối chiếu với sổ, TRƯỚC khi chạm
  // ví hay mạng (`consumeBook.ts` ▸ `requireConsumeVaultHash` nói vì sao bắt buộc).
  let derivedPrepaidVaultHash: string | undefined;
  if (vaultKind === "prepaid") {
    const carp = requireCarpIdentity();
    derivedPrepaidVaultHash = prepaidScriptPair(await loadBlueprint("PrepaidGen"), {
      carpPolicyId: carp.policyId, carpAssetName: carp.assetName,
      msPerEpoch: PROTOCOL.MS_PER_EPOCH, windowOriginMs: PROTOCOL.WINDOW_ORIGIN_MS,
      wakemeVaultHash: wakemeVaultHash(NETWORK),
    }).vaultHash;
  }
  const vaultScriptHash = requireConsumeVaultHash(process.env, vaultKind, derivedPrepaidVaultHash);
  console.log(`Loại vault:           ${vaultKind}`);
  const maxPriceStale = BigInt(process.env.MAX_PRICE_STALE ?? "1");
  const priceThreshold = BigInt(process.env.PRICE_THRESHOLD ?? "1");
  if (process.env.PRICE_DEMAND_MULT !== undefined) {
    throw new Error(
      "PRICE_DEMAND_MULT đã bỏ: demand_mult nay là trường của từng dòng OpPrice (CC-LOAD-COUNT-UNIT). " +
      "Bỏ biến đó đi; bảng khởi tạo đặt demand_mult = Q cho mọi dòng.",
    );
  }
  const Q = PROTOCOL.Q;

  // Seed `price_nft` cho trước (`DEPLOY_SEED_PRICE_NFT_<LOẠI>`) + hash kỳ vọng
  // (`DEPLOY_EXPECT_HASHES`) — `deploySeeds.ts`. Đọc + kiểm hình dạng TRƯỚC mọi lệnh gọi mạng.
  const seedRole     = priceNftSeedRole(vaultKind);
  const presetSeed   = readPresetSeed(process.env, seedRole);
  const expectHashes = loadExpectedHashes(process.env);
  requirePresetForExpect("bước 09", expectHashes, presetSeed !== undefined, [SEED_ENV[seedRole]]);
  requireExpectInPresetMode("bước 09", process.env, expectHashes);
  // Seed khác vai phải khác outref, và seed `price_nft` không được là seed sổ két đang chờ pha
  // registry (đọc cả sổ lẫn env) — tiêu nó ở đây là sổ két không bao giờ đúc được nữa.
  assertDistinctPresetSeeds(process.env, [
    ...readBookEntries(stateBookPath(NETWORK)).filter((e) => e.key === REGISTRY_SEED_BOOK_KEY).map((e) => e.value),
    ...(process.env[REGISTRY_SEED_BOOK_KEY] ? [process.env[REGISTRY_SEED_BOOK_KEY]!] : []),
  ]);

  // Load ConsumeMAGIC validators. Ba lệnh tra dưới đây chỉ để hỏng SỚM khi blueprint thiếu
  // validator — chuỗi apply thật ở `deployParams.ts` ▸ `consumeScriptChain`.
  const blueprint   = await loadBlueprint("ConsumeMAGIC");
  for (const t of ["price_nft.price_nft.mint", "price_param.price_param.spend", "consume.consume.spend"]) {
    findValidator(blueprint, t);
  }

  // Lucid + wallet
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  const committee: string[] = (process.env.PRICE_COMMITTEE ?? ownerPkh)
    .split(",").map((s) => s.trim()).filter(Boolean);

  // Current epoch từ tip (khớp semantics validator: POSIX ms / ms_per_epoch).
  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, { headers: { project_id: BLOCKFROST_KEY } });
  const tip = await tipRes.json() as { time: number };
  const currentEpoch = windowOf(BigInt(tip.time) * 1000n, PROTOCOL.MS_PER_EPOCH, PROTOCOL.WINDOW_ORIGIN_MS);

  // ── Chọn 2 genesis UTxO pure-ADA phân biệt (2 one-shot policy) ────────────────
  // g1 = seed one-shot price_nft (quyết hash cả chuỗi); g2 = seed thread token Engage (đặt TÊN
  // asset, không đặt policy — nên không cần cho trước). Seed g1 cho trước: kiểm còn chưa tiêu, ở
  // ví hoặc bãi đỗ của ví, output trơn — không thì NÉM, không lùi về chọn tự động.
  const walletUtxos = await lucid.wallet().getUtxos();
  let g1: UTxO;
  let g1Parked: Park | undefined;   // có ⟹ g1 nằm ở bãi đỗ này, tx phải gắn witness
  let adaSeeds: UTxO[];
  if (presetSeed) {
    const park = parkFor(NETWORK, address);
    const r = await resolvePresetSeed(lucid, park, seedRole, presetSeed, { allowWallet: presetSeedAllowWallet(expectHashes) });
    g1 = r.utxo;
    if (r.atPark) g1Parked = park;
    adaSeeds = walletUtxos.filter((u) =>
      isPureAda(u) && (u.assets.lovelace ?? 0n) >= 5_000_000n &&
      !(u.txHash === g1.txHash && u.outputIndex === g1.outputIndex));
    if (adaSeeds.length < 1) {
      throw new Error(
        `Cần ≥1 UTxO thuần ADA (≥5 ADA) ngoài seed price_nft cho trước để làm seed Engage. Hiện có 0. ` +
        `Tách bớt UTxO trước khi chạy.`,
      );
    }
  } else {
    adaSeeds = walletUtxos.filter((u) => isPureAda(u) && (u.assets.lovelace ?? 0n) >= 5_000_000n);
    if (adaSeeds.length < 2) {
      throw new Error(
        `Cần ≥2 UTxO thuần ADA (≥5 ADA) làm genesis one-shot (price + engage). Hiện có ${adaSeeds.length}. ` +
        `Tách bớt UTxO trước khi chạy.`,
      );
    }
    g1 = adaSeeds.shift()!;
  }
  const g2 = adaSeeds[0]!; // seed thread token Engage (đặt TÊN asset, không đặt policy)

  // ── Chuỗi bake price_nft(g1) → price_param → consume (`deployParams.ts`) ──────
  // `consumeChainChecked` so ba hash với tệp kỳ vọng — lệch ⟹ ném ở đây, trước khi dựng và nộp
  // tx đúc.
  const { priceNftScript, priceNftPolicy, priceParamHash, consumeScript, consumeHash } = consumeChainChecked(blueprint, vaultKind, {
    priceNftSeed:   { txHash: g1.txHash, outputIndex: g1.outputIndex },
    committee,
    threshold:      priceThreshold,
    vaultScriptHash,
    maxPriceStale,
    msPerEpoch:     PROTOCOL.MS_PER_EPOCH,
    windowOriginMs: PROTOCOL.WINDOW_ORIGIN_MS,
  }, expectHashes);
  const priceNftUnit   = priceNftPolicy + PRICE_NFT_NAME;
  const priceParamAddr = credentialToAddress(NETWORK, scriptHashToCredential(priceParamHash));
  const consumeAddr = credentialToAddress(NETWORK, scriptHashToCredential(consumeHash));

  // ── Thread token Engage: policy = CHÍNH consume script hash ──────────────────
  // `validate_mint_engage_id` đòi: seed nằm trong inputs, đúng 1 asset dưới policy
  // này với tên = blake2b_256(cbor.serialise(seed)), NFT nằm ở output tại địa chỉ
  // consume, datum genesis SẠCH, owner ký. Phép băm dùng chung với NFT danh-tính
  // vault (scripts/vaultId.ts) vì công thức on-chain y hệt.
  const engageNftPolicy = consumeHash;
  const engageNftName   = vaultIdAssetName({ txHash: g2.txHash, outputIndex: g2.outputIndex });
  const engageNftUnit   = engageNftPolicy + engageNftName;
  const engageMintRedeemer = mintVaultIdRedeemer({
    txHash: g2.txHash, outputIndex: g2.outputIndex,
  });

  // ── PriceParam beacon datum (MVP base-price, khớp pricing.ak / price.ts) ──────
  const priceParam: PriceParamT = {
    op_prices: [
      // Bảng phải TĂNG NGẶT theo op_type (pricing.ak: sorted_strict_op_types) và
      // mỗi dòng phải thoả base_price × m_min ≥ Q (pricing.ak:127-135) ⟹ base_price ≥ 2.
      // Trần 16 dòng (pricing.ak:53) — đang dùng 4.
      // Nghĩa của từng `op_type` tra ở sổ gốc: MagicLampEco/Registry ▸
      // Specs/Resource-Dictionary.md §2, neo main@8a23f72 (2026-09-24).
      // Bốn dòng dưới đây là bảng giá THẬT đang
      // deploy, và CHÍNH TỆP NÀY là nguồn của nó — CONTRACT.md §A chỉ chép lại để
      // đọc nhanh, lệch thì tệp này thắng.
      // demand_mult nằm trên TỪNG dòng (CC-LOAD-COUNT-UNIT), khởi tạo = Q (1,0×) cho mọi dòng.
      // Mã trong dải giá cố định (pricing.ak ▸ fixed_price_op_types, hiện [7]) BẮT BUỘC = Q.
      { op_type: 1n, base_price:    10_000_000n, demand_mult: Q }, // ảnh          0.01 MAGIC
      { op_type: 2n, base_price:     1_000_000n, demand_mult: Q }, // neo CID      0.001 MAGIC
      // ĐƠN VỊ LÀ LẦN, KHÔNG PHẢI MB. `required_for` nhân `op_count` như bội số thuần
      // (pricing.ak:204) — không có chỗ nào quy đổi byte. Chú thích "/MB" cũ ở đây
      // mô tả một đơn vị mà mã chưa bao giờ tính. Xem CONTRACT.md §A sổ op_type.
      { op_type: 3n, base_price: 1_000_000_000n, demand_mult: Q }, // lưu trữ  /lần  1 MAGIC
      { op_type: 4n, base_price: 1_000_000_000n, demand_mult: Q }, // tính toán/lần  1 MAGIC
      // 7 · 8: chủ dự án gật 2026-09-25, giá TẠM cho giai đoạn test (M₀ = 2 MAGIC).
      { op_type: 7n, base_price:  2_000_000_000n, demand_mult: Q }, // did.rotate    2 MAGIC, giá cố định
      { op_type: 8n, base_price: 10_000_000_000n, demand_mult: Q }, // did.transfer 10 MAGIC
    ],
    m_min: 500_000_000n,      // 0.5×
    m_max: 2_000_000_000n,    // 2.0×
    epoch: currentEpoch,
  };
  // Cổng off-chain chạy TRƯỚC để hỏng sớm; on-chain `price_nft` cũng ép valid_param lúc đúc.
  assertValidPriceParam(priceParam);
  const priceDatumCbor = encodePriceParam(priceParam);

  // ── Engage genesis datum — MỌI trục kế toán = 0 (validate_mint_engage_id) ────
  //   expect ed.consumed_count == 0 / ed.consumed_nanogic == 0 / ed.last_epoch == 0
  const engageDatumCbor = Data.to({
    owner:            { VerificationKey: [ownerPkh] },   // Credential; nhánh khoá ⟹ ví ký
    consumed_count:   0n,
    last_epoch:       0n,   // PIN: state tích luỹ, genesis PHẢI 0 (không phải epoch hiện tại)
    did_commit:       "",   // rỗng lúc tạo; điền MỘT LẦN sau bằng redeemer BindDID
                            // (constr 1). Bất biến trên nhánh Consume, KHÔNG bất biến
                            // tuyệt đối — câu "immutable về sau" ở đây từng đúng và nay sai.
    consumed_nanogic: 0n,
  } as never, EngageDatumSchema);

  console.log(`Network:              ${NETWORK}`);
  console.log(`Current epoch:        ${currentEpoch}`);
  console.log(`ms_per_epoch:         ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`Vault phục vụ:        ${vaultScriptHash}`);
  console.log(`Genesis price (g1):   ${g1.txHash}#${g1.outputIndex}`);
  console.log(`Seed engage  (g2):    ${g2.txHash}#${g2.outputIndex}`);
  console.log(`Price NFT policy:     ${priceNftPolicy}`);
  console.log(`Engage thread policy: ${engageNftPolicy}  (== consume hash)`);
  console.log(`Engage thread name:   ${engageNftName}`);
  console.log(`PriceParam address:   ${priceParamAddr}`);
  console.log(`Consume hash:         ${consumeHash}`);
  console.log(`Consume address:      ${consumeAddr}`);
  console.log(`max_price_stale:      ${maxPriceStale}`);
  console.log(`Bảng giá khởi tạo:    ${priceParam.op_prices.map((r) => `${r.op_type}=${r.base_price}×${r.demand_mult}`).join(" ")}\n`);

  // ── 1 tx: consume g1+g2, mint 2 NFT, tạo beacon + Engage ─────────────────────
  //    g1 ở bãi đỗ ⟹ gắn script native `sig(ví)`; chữ ký ví đã có sẵn qua `addSignerKey(ownerPkh)`
  //    (ownerPkh = khoá payment của chính ví đó — `parkFor` dựng script trên đúng khoá này).
  let builder = lucid.newTx().collectFrom([g1, g2]);
  if (g1Parked) builder = builder.attach.SpendingValidator(g1Parked.parkScript);
  const tx = await builder
    .mintAssets({ [priceNftUnit]: 1n }, Data.void())
    .mintAssets({ [engageNftUnit]: 1n }, engageMintRedeemer)
    .attach.MintingPolicy(priceNftScript)
    .attach.MintingPolicy(consumeScript)
    .pay.ToAddressWithData(
      priceParamAddr,
      { kind: "inline", value: priceDatumCbor },
      { lovelace: 2_000_000n, [priceNftUnit]: 1n },
    )
    .pay.ToAddressWithData(
      consumeAddr,
      { kind: "inline", value: engageDatumCbor },
      { lovelace: 2_000_000n, [engageNftUnit]: 1n },
    )
    .addSignerKey(ownerPkh)      // validate_mint_engage_id: owner phải ký
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log(`\n✅ ConsumeMAGIC infra submitted!`);
  console.log(`   TX hash:  ${txHash}`);
  console.log(`   Explorer: https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);

  // ── Poll Blockfrost tới khi thấy 2 output (bài học index-lag) ────────────────
  console.log("\n⏳ Polling Blockfrost for beacon + Engage UTxOs...");
  let beaconUtxo: UTxO | undefined;
  let engageUtxo: UTxO | undefined;
  for (let i = 0; i < 30; i++) {
    await sleep(10_000);
    try {
      if (!beaconUtxo) {
        const bs = await lucid.utxosAt(priceParamAddr);
        beaconUtxo = bs.find((u) => u.txHash === txHash && (u.assets[priceNftUnit] ?? 0n) === 1n);
      }
      if (!engageUtxo) {
        const es = await lucid.utxosAt(consumeAddr);
        engageUtxo = es.find((u) => u.txHash === txHash && (u.assets[engageNftUnit] ?? 0n) === 1n);
      }
    } catch (e) {
      // Nuốt được vì vùng `try` này CHỈ có lệnh gọi mạng — không phép khẳng định nào rơi
      // vào đây (đối lại `scripts/test/consume_only.ts`, nơi một `catch` cùng chú thích
      // từng nuốt mất một câu báo sai số). Nhưng vẫn phải IN: một chuỗi lỗi lặp lại là
      // dấu của khoá sai hoặc sai mạng, và nếu im thì nó đội lốt "chỉ mục chậm" đủ 5 phút
      // rồi kết bằng câu "UTxO chưa thấy" — đúng nhưng trỏ sai chỗ.
      process.stdout.write(`   (chỉ mục chưa trả lời: ${String((e as Error)?.message ?? e).slice(0, 160)})\n`);
    }
    process.stdout.write(`   attempt ${i + 1}: beacon=${!!beaconUtxo} engage=${!!engageUtxo}\n`);
    if (beaconUtxo && engageUtxo) break;
  }
  if (!beaconUtxo || !engageUtxo) {
    throw new Error("Beacon/Engage UTxO chưa thấy sau ~5 phút — kiểm tra tx trên explorer rồi query lại.");
  }

  // ── Công bố ref-script `consume` (tx riêng) ──────────────────────────────────
  //   Không gộp vào tx trên: tx đó đã bê CBOR của consume vào làm minting policy,
  //   thêm một bản nữa dưới dạng ref-script là trả tiền hai lần cho cùng một script.
  const parkAddr = parkAddressFor(NETWORK, address);
  console.log(`\n⏳ Công bố ref-script consume tại bãi đỗ ${parkAddr} …`);
  const consumeRef = await publishRefScript({
    lucid, parkAddr, label: "consume ref",
    script: consumeScript, hash: consumeHash, lovelace: 35_000_000n,
  });

  console.log(`\n✅ Confirmed.`);
  console.log(`\n📋 Copy vào env (cho scripts/test/consume_only.ts):`);
  // Khoá mang hậu tố loại vault — `scripts/consumeBook.ts` nói vì sao.
  const out = (name: ConsumeKeyName, v: string, note = "") =>
    console.log(`export ${consumeKey(name, vaultKind)}=${v}${note ? `   # ${note}` : ""}`);
  out("CONSUME_SCRIPT_HASH", consumeHash);
  out("CONSUME_ADDRESS", consumeAddr);
  out("PRICE_NFT_POLICY", priceNftPolicy);
  out("PRICE_NFT_UNIT", priceNftUnit);
  out("PRICE_PARAM_HASH", priceParamHash);
  out("PRICE_BEACON_UTXO", `${beaconUtxo.txHash}#${beaconUtxo.outputIndex}`);
  out("ENGAGE_NFT_POLICY", engageNftPolicy);
  out("ENGAGE_NFT_UNIT", engageNftUnit);
  out("ENGAGE_UTXO", `${engageUtxo.txHash}#${engageUtxo.outputIndex}`);
  out("MAX_PRICE_STALE", String(maxPriceStale), "PHẢI khớp lúc reconstruct consume hash");
  out("REF_CONSUME_UTXO", consumeRef, "chân consume của tx consume");
  const vRef = vaultRefKey(vaultKind);
  console.log(`#  chân còn lại: ${vRef.key} — lấy từ ${vRef.step}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
