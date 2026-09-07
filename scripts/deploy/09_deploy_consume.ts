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
//   VAULT_INSTANT_HASH   — hash vault InstantGen (deploy 05). BẮT BUỘC.
//   NETWORK, BLOCKFROST_KEY, WALLET_SEED/PRIVATE_KEY.
//
// KNOB (env, có default):
//   MAX_PRICE_STALE   — số epoch cho phép giá cũ (default 1). Baked vào consume hash.
//   PRICE_COMMITTEE   — danh sách pkh (hex, phẩy) được post giá về sau (default = ví deploy).
//   PRICE_THRESHOLD   — M-of-N committee threshold (default 1).
//   PRICE_DEMAND_MULT — demand_mult Q-format của beacon (default Q = 1_000_000_000 = 1.0×).
//
// ⚠  DANH SÁCH THAM SỐ KHÔNG khai tay ở file này nữa — đọc thẳng
//     `parameters[].title` từ ConsumeMAGIC/onchain/plutus.json qua
//     scripts/applyParams.ts. Chuỗi bake TUYẾN TÍNH, đổi thứ tự là sai hash:
//        price_nft (genesis_ref)
//          → price_param (committee, threshold, price_nft_policy, price_nft_name, ms_per_epoch)
//            → consume (…, price_param_script_hash)

import {
  Lucid, Blockfrost, Data,
  credentialToAddress, scriptHashToCredential,
  mintingPolicyToId, getAddressDetails,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, PROTOCOL,
} from "../config.js";
import {
  loadBlueprint, findValidator, appliedScript, appliedValidator,
} from "../applyParams.js";
import {
  oneShotGenesisParams, priceParamParams, consumeParams,
} from "../deployParams.js";
import {
  encodePriceParam, EngageDatumSchema, type PriceParamT,
} from "../../ConsumeMAGIC/offchain/src/types.js";
import { vaultIdAssetName, mintVaultIdRedeemer } from "../vaultId.js";
import { parkAddressFor, publishRefScript } from "../refScripts.js";

// EngageDatum lấy thẳng từ codec của module (5 trường, khớp `pub type EngageDatum`
// trong ConsumeMAGIC/onchain/lib/magiclamp/consume/types.ak). Từng có một bản khai
// TẠI CHỖ ở đây khi codec offchain còn trễ một trường — đã xoá: hai bản schema cho
// cùng một datum là đúng thứ sẽ trôi khỏi nhau trong im lặng.

// Asset name const đọc từ validator (.ak `pub const ...`).
const PRICE_NFT_NAME  = "5052494345"; // "PRICE" — price_nft.ak
// BurnBatch = constr 2 trong VaultRedeemer của CẢ HAI vault sinh MAGIC:
//   InstantGen  — InstantGen/onchain/lib/magiclamp/protocol/types.ak:219-220
//   ScheduleGen — ScheduleGen/onchain/lib/magiclamp/protocol/types.ak:160-163
// Nên một giá trị dùng chung được. (Bản cũ của `scripts/README.md` nói hai module
// khác constr — SAI, và cái sai đó làm việc dễ trông như việc khó.)
const BURN_BATCH_CONSTR = 2n;

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
  // VÌ SAO CẦN ĐƯỜNG ScheduleGen: InstantGen hiện chưa cấp nổi 1 nanogic (Nợ #19 —
  // `consumed_credit` chỉ tăng ở BurnBatch, mà BurnBatch cần `magic_batches` khác rỗng,
  // mà nhánh InstantGen là nơi duy nhất ghi nó). ScheduleGen KHÔNG có vòng đó:
  // `ScheduleFire` ghi thẳng `magic_batches` (ScheduleGen/onchain/validators/vault.ak:483)
  // và `BurnBatch` nằm ngay trong cùng validator (vault.ak:512). Nên cửa sinh–tiêu
  // MAGIC đóng kín trong ScheduleGen, và đó là đường DUY NHẤT đã chạy thật trên chuỗi.
  const vaultScriptHash =
    process.env.VAULT_HASH ??
    process.env.VAULT_SCHEDULE_HASH ??
    process.env.VAULT_INSTANT_HASH;
  if (!vaultScriptHash || vaultScriptHash === "FILL_AFTER_AIKEN_BUILD") {
    throw new Error(
      "Thiếu hash vault. Đặt MỘT trong ba, theo loại vault mà instance consume này phục vụ:\n" +
      "  VAULT_SCHEDULE_HASH — đường ScheduleGen (chạy được hôm nay); deploy bằng bước 07\n" +
      "  VAULT_INSTANT_HASH  — đường InstantGen  (đang kẹt Nợ #19);   deploy bằng bước 05\n" +
      "  VAULT_HASH          — ghi đè tường minh, thắng cả hai biến trên",
    );
  }
  const maxPriceStale = BigInt(process.env.MAX_PRICE_STALE ?? "1");
  const priceThreshold = BigInt(process.env.PRICE_THRESHOLD ?? "1");
  const demandMultQ = BigInt(process.env.PRICE_DEMAND_MULT ?? PROTOCOL.Q.toString());

  // Load ConsumeMAGIC validators.
  const blueprint   = await loadBlueprint("ConsumeMAGIC");
  const priceNftV   = findValidator(blueprint, "price_nft.price_nft.mint");
  const priceParamV = findValidator(blueprint, "price_param.price_param.spend");
  const consumeV    = findValidator(blueprint, "consume.consume.spend");

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
  const currentEpoch = (BigInt(tip.time) * 1000n) / PROTOCOL.MS_PER_EPOCH;

  // ── Chọn 2 genesis UTxO pure-ADA phân biệt (2 one-shot policy) ────────────────
  const walletUtxos = await lucid.wallet().getUtxos();
  const adaSeeds = walletUtxos.filter((u) => isPureAda(u) && (u.assets.lovelace ?? 0n) >= 5_000_000n);
  if (adaSeeds.length < 2) {
    throw new Error(
      `Cần ≥2 UTxO thuần ADA (≥5 ADA) làm genesis one-shot (price + engage). Hiện có ${adaSeeds.length}. ` +
      `Tách bớt UTxO trước khi chạy.`,
    );
  }
  const g1 = adaSeeds[0]!; // seed one-shot price_nft
  const g2 = adaSeeds[1]!; // seed thread token Engage (đặt TÊN asset, không đặt policy)

  // ── price_nft one-shot: apply genesis_ref = Constr(0,[txHash, idx]) ───────────
  const priceNftScript = appliedValidator(
    priceNftV,
    oneShotGenesisParams({ txHash: g1.txHash, outputIndex: g1.outputIndex }),
  );
  const priceNftPolicy = mintingPolicyToId(priceNftScript);
  const priceNftUnit   = priceNftPolicy + PRICE_NFT_NAME;

  // ── price_param (mắt xích 2 của chuỗi bake) ──────────────────────────────────
  const { hash: priceParamHash } = appliedScript(
    priceParamV,
    priceParamParams({
      committee,
      threshold:      priceThreshold,
      priceNftPolicy,
      priceNftName:   PRICE_NFT_NAME,
      msPerEpoch:     PROTOCOL.MS_PER_EPOCH,
    }),
  );
  const priceParamAddr = credentialToAddress(NETWORK, scriptHashToCredential(priceParamHash));

  // ── consume (mắt xích 3) → hash + address ────────────────────────────────────
  const { script: consumeScript, hash: consumeHash } = appliedScript(
    consumeV,
    consumeParams({
      priceNftPolicy,
      priceNftName:         PRICE_NFT_NAME,
      vaultScriptHash,
      burnBatchConstr:      BURN_BATCH_CONSTR,
      maxPriceStale,
      msPerEpoch:           PROTOCOL.MS_PER_EPOCH,
      priceParamScriptHash: priceParamHash,   // neo beacon giá vào đúng script
    }),
  );
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
      // Giá lấy từ sổ op_type chuẩn ở ConsumeMAGIC/CONTRACT.md §A.
      { op_type: 1n, base_price:    10_000_000n }, // ảnh          0.01 MAGIC
      { op_type: 2n, base_price:     1_000_000n }, // neo CID      0.001 MAGIC
      // ĐƠN VỊ LÀ LẦN, KHÔNG PHẢI MB. `required_for` nhân `op_count` như bội số thuần
      // (pricing.ak:204) — không có chỗ nào quy đổi byte. Chú thích "/MB" cũ ở đây
      // mô tả một đơn vị mà mã chưa bao giờ tính. Xem CONTRACT.md §A sổ op_type.
      { op_type: 3n, base_price: 1_000_000_000n }, // lưu trữ  /lần  1 MAGIC
      { op_type: 4n, base_price: 1_000_000_000n }, // tính toán/lần  1 MAGIC
    ],
    demand_mult: demandMultQ, // 1.0× → price = base
    m_min: 500_000_000n,      // 0.5×
    m_max: 2_000_000_000n,    // 2.0×
    epoch: currentEpoch,
  };
  const priceDatumCbor = encodePriceParam(priceParam);

  // ── Engage genesis datum — MỌI trục kế toán = 0 (validate_mint_engage_id) ────
  //   expect ed.consumed_count == 0 / ed.consumed_nanogic == 0 / ed.last_epoch == 0
  const engageDatumCbor = Data.to({
    owner:            ownerPkh,
    consumed_count:   0n,
    last_epoch:       0n,   // PIN: state tích luỹ, genesis PHẢI 0 (không phải epoch hiện tại)
    did_commit:       "",   // MVP rỗng — immutable về sau
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
  console.log(`demand_mult (Q):      ${demandMultQ}\n`);

  // ── 1 tx: consume g1+g2, mint 2 NFT, tạo beacon + Engage ─────────────────────
  const tx = await lucid
    .newTx()
    .collectFrom([g1, g2])
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
    } catch { /* index lag — retry */ }
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
  console.log(`export CONSUME_SCRIPT_HASH=${consumeHash}`);
  console.log(`export CONSUME_ADDRESS=${consumeAddr}`);
  console.log(`export PRICE_NFT_POLICY=${priceNftPolicy}`);
  console.log(`export PRICE_NFT_UNIT=${priceNftUnit}`);
  console.log(`export PRICE_PARAM_HASH=${priceParamHash}`);
  console.log(`export PRICE_BEACON_UTXO=${beaconUtxo.txHash}#${beaconUtxo.outputIndex}`);
  console.log(`export ENGAGE_NFT_POLICY=${engageNftPolicy}`);
  console.log(`export ENGAGE_NFT_UNIT=${engageNftUnit}`);
  console.log(`export ENGAGE_UTXO=${engageUtxo.txHash}#${engageUtxo.outputIndex}`);
  console.log(`export MAX_PRICE_STALE=${maxPriceStale}   # PHẢI khớp lúc reconstruct consume hash`);
  console.log(`export REF_CONSUME_UTXO=${consumeRef}      # chân consume của tx consume`);
  console.log(`#  chân còn lại: REF_VAULT_INSTANT_UTXO — lấy từ bước 05`);
}

main().catch((e) => { console.error(e); process.exit(1); });
