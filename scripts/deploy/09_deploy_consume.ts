// scripts/deploy/09_deploy_consume.ts — Deploy ConsumeMAGIC infra (1 lần / 1 loại vault).
// Run: npx tsx deploy/09_deploy_consume.ts   (hoặc: npm run deploy:consume nếu thêm script)
//
// Tạo hạ tầng để tiêu MAGIC theo mô hình ENGAGEMENT (KHÔNG mint MAGIC):
//   1. price_nft  one-shot  → mint 1 "PRICE" NFT (xác thực beacon).
//   2. PriceParam beacon    → UTxO tại price_param address, inline PriceParam datum.
//   3. engage_nft one-shot  → mint 1 "ENG" NFT (thread token cho Engage state).
//   4. Engage UTxO          → UTxO tại consume address, inline EngageDatum (state per-app).
//   5. consume validator     → apply-param 8 tham số → in ra hash + address.
// Tất cả trong 1 tx (consume 2 genesis UTxO g1,g2 → 2 one-shot policy phân biệt).
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
// ⚠  THAM SỐ consume validator ĐỌC TỪ consume.ak (8 param, KHÁC bản mô tả cũ 6 param):
//     price_nft_policy, price_nft_name, engage_nft_policy, engage_nft_name,
//     vault_script_hash, burn_batch_constr(=2 InstantGen), max_price_stale, ms_per_epoch.

import {
  Lucid, Blockfrost, Data, Constr,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  mintingPolicyToId, getAddressDetails,
  type UTxO,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, PROTOCOL,
} from "../config.js";
import {
  encodePriceParam, encodeEngageDatum,
  type PriceParamT, type EngageDatumT,
} from "../../ConsumeMAGIC/offchain/src/types.js";

// Asset name const đọc từ validator (.ak `pub const ...`).
const PRICE_NFT_NAME  = "5052494345"; // "PRICE" — price_nft.ak
const ENGAGE_NFT_NAME = "454e47";     // "ENG"   — engage_nft.ak
const BURN_BATCH_CONSTR = 2n;         // InstantGen VaultRedeemer: BurnBatch = constr 2

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function isPureAda(u: UTxO): boolean {
  return Object.keys(u.assets).every((k) => k === "lovelace");
}

async function main() {
  console.log("=== Step 9: Deploy ConsumeMAGIC infra (price NFT + beacon + engage NFT + Engage) ===\n");

  const vaultInstantHash = process.env.VAULT_INSTANT_HASH;
  if (!vaultInstantHash || vaultInstantHash === "FILL_AFTER_AIKEN_BUILD") {
    throw new Error("VAULT_INSTANT_HASH missing — deploy InstantGen vault (05) first.");
  }
  const maxPriceStale = BigInt(process.env.MAX_PRICE_STALE ?? "1");
  const priceThreshold = BigInt(process.env.PRICE_THRESHOLD ?? "1");
  const demandMultQ = BigInt(process.env.PRICE_DEMAND_MULT ?? PROTOCOL.Q.toString());

  // Load ConsumeMAGIC validators.
  const plutus = JSON.parse(
    await readFile(new URL("../../ConsumeMAGIC/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const findV = (title: string) => {
    const v = plutus.validators.find((x: any) => x.title === title);
    if (!v) {
      console.error("Available:", plutus.validators.map((x: any) => x.title));
      throw new Error(`validator ${title} not found in ConsumeMAGIC/onchain/plutus.json`);
    }
    return v;
  };
  const priceNftV  = findV("price_nft.price_nft.mint");
  const engageNftV = findV("engage_nft.engage_nft.mint");
  const priceParamV = findV("price_param.price_param.spend");
  const consumeV   = findV("consume.consume.spend");

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
  const g1 = adaSeeds[0]; // genesis price_nft
  const g2 = adaSeeds[1]; // genesis engage_nft

  // ── price_nft one-shot: apply genesis_ref = Constr(0,[txHash, idx]) ───────────
  const priceNftScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(priceNftV.compiledCode, [
      new Constr(0, [g1.txHash, BigInt(g1.outputIndex)]),
    ]),
  };
  const priceNftPolicy = mintingPolicyToId(priceNftScript);
  const priceNftUnit   = priceNftPolicy + PRICE_NFT_NAME;

  // ── engage_nft one-shot: genesis RIÊNG (g2) → policy id phân biệt ─────────────
  const engageNftScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(engageNftV.compiledCode, [
      new Constr(0, [g2.txHash, BigInt(g2.outputIndex)]),
    ]),
  };
  const engageNftPolicy = mintingPolicyToId(engageNftScript);
  const engageNftUnit   = engageNftPolicy + ENGAGE_NFT_NAME;

  // ── price_param address (4 param: committee, threshold, price_nft_policy, name) ─
  const priceParamScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(priceParamV.compiledCode, [
      committee, priceThreshold, priceNftPolicy, PRICE_NFT_NAME,
    ]),
  };
  const priceParamHash = validatorToScriptHash(priceParamScript);
  const priceParamAddr = credentialToAddress(NETWORK, scriptHashToCredential(priceParamHash));

  // ── consume validator (8 param) → hash + address ─────────────────────────────
  const consumeScript = {
    type: "PlutusV3" as const,
    script: applyParamsToScript(consumeV.compiledCode, [
      priceNftPolicy, PRICE_NFT_NAME,
      engageNftPolicy, ENGAGE_NFT_NAME,
      vaultInstantHash, BURN_BATCH_CONSTR, maxPriceStale, PROTOCOL.MS_PER_EPOCH,
    ]),
  };
  const consumeHash = validatorToScriptHash(consumeScript);
  const consumeAddr = credentialToAddress(NETWORK, scriptHashToCredential(consumeHash));

  // ── PriceParam beacon datum (MVP base-price, khớp pricing.ak / price.ts) ──────
  const priceParam: PriceParamT = {
    op_prices: [
      { op_type: 1n, base_price: 10_000_000n }, // ảnh 0.01 MAGIC
      { op_type: 2n, base_price: 1_000_000n },  // CID  0.001 MAGIC
    ],
    demand_mult: demandMultQ, // 1.0× → price = base
    m_min: 500_000_000n,      // 0.5×
    m_max: 2_000_000_000n,    // 2.0×
    epoch: currentEpoch,
  };
  const priceDatumCbor = encodePriceParam(priceParam);

  // ── Engage genesis datum (state per-app, consumed_count=0, did_commit="") ─────
  const engageDatum: EngageDatumT = {
    owner: ownerPkh,
    consumed_count: 0n,
    last_epoch: currentEpoch,
    did_commit: "", // MVP rỗng — immutable về sau
  };
  const engageDatumCbor = encodeEngageDatum(engageDatum);

  console.log(`Network:              ${NETWORK}`);
  console.log(`Current epoch:        ${currentEpoch}`);
  console.log(`ms_per_epoch:         ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`Vault InstantGen:     ${vaultInstantHash}`);
  console.log(`Genesis price (g1):   ${g1.txHash}#${g1.outputIndex}`);
  console.log(`Genesis engage (g2):  ${g2.txHash}#${g2.outputIndex}`);
  console.log(`Price NFT policy:     ${priceNftPolicy}`);
  console.log(`Engage NFT policy:    ${engageNftPolicy}`);
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
    .mintAssets({ [engageNftUnit]: 1n }, Data.void())
    .attach.MintingPolicy(priceNftScript)
    .attach.MintingPolicy(engageNftScript)
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
}

main().catch((e) => { console.error(e); process.exit(1); });
