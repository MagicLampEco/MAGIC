// LampDistribution/scripts/03_genesis.ts — Tạo genesis state on-chain.
//
// Chạy: npm run genesis   (sau 01_deploy + 02_mint_test_lamp)
//
// Tạo (trong 1–2 tx):
//   - Mint 3 beacon NFT one-shot (PParam/Randomness/MerkleRoot) bằng native sig policy.
//   - 3 beacon UTxO tại beacon address, mỗi cái giữ 1 NFT + BeaconDatum:
//       PParam     epoch=E   value = P_GENESIS big-endian
//       Randomness epoch=E   value = nonce test (32 bytes) — e2e có thể đọc nonce thật
//       MerkleRoot epoch=0   value = "" (placeholder; e2e post root thật)
//   - 1 treasury UTxO giữ test-LAMP pool + TreasuryDatum{committee_hash}.
//   - 2 ClaimAccount UTxO (ví A, B) claimed_cumulative=0 — genesis empty accounts.
//
// committee_hash (TreasuryDatum): MVP = blake2b_224 của committee key list? KHÔNG —
// SPEC §5 nói "hash của committee multisig policy/script". MVP self-test committee
// 1 key → committee_hash = keyhash[0] (28-byte). Production: hash native multisig
// script. Ghi chú rõ; treasury validator chỉ so khớp committee_hash bảo toàn (C-TRE-2),
// release thực chất gate bởi claim_account redeem (C-TRE-1) nên giá trị cụ thể không
// chặn flow MVP.

import {
  Data, toUnit as lucidToUnit, getAddressDetails,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BEACON_ASSET_NAMES,
  makeLucid, walletPkh, nativeSigPolicy, nativeSigPolicyId,
  loadDeployed, saveDeployed, toUnit, explorerTx, awaitTx, currentEpoch,
} from "./config.js";
import {
  beaconDatumToCbor, treasuryDatumToCbor, claimAccountDatumToCbor,
} from "../offchain/src/datum.js";
import { P_GENESIS } from "../offchain/src/constants.js";

// nonce test cố định (32 bytes) — e2e sẽ thử đọc nonce Cardano thật, fallback cái này.
const TEST_NONCE_HEX =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const BEACON_MIN_ADA   = 2_000_000n;
const TREASURY_MIN_ADA = 2_000_000n;
const ACCOUNT_MIN_ADA  = 2_000_000n;

// test-LAMP fund vào treasury pool (oil). Mặc định 500_000 LAMP — dư cho redeem demo.
const TREASURY_FUND = BigInt(process.env.TREASURY_FUND_OIL ?? (500_000n * 1_000_000n).toString());

/** P (oil) → minimal big-endian hex (khớp Aiken from_int_big_endian không pad). */
function pToBigEndianHex(p: bigint): string {
  if (p <= 0n) throw new Error("P phải > 0");
  let h = p.toString(16);
  if (h.length % 2 !== 0) h = "0" + h;
  return h;
}

/** Ví B test: PRIVATE_KEY_B/WALLET_SEED_B nếu có; else PKH cố định (chỉ để demo 2 lá Merkle). */
async function resolveWalletBPkh(): Promise<{ pkh: string; real: boolean }> {
  const sk   = (process.env.PRIVATE_KEY_B ?? "").trim();
  const seed = (process.env.WALLET_SEED_B ?? "").trim();
  if (sk || seed) {
    const l = await makeLucid();
    if (sk) l.selectWallet.fromPrivateKey(sk);
    else    l.selectWallet.fromSeed(seed.replace(/\s+/g, " "));
    const addr = await l.wallet().address();
    const { paymentCredential } = getAddressDetails(addr);
    if (!paymentCredential) throw new Error("ví B: không lấy được payment credential");
    return { pkh: paymentCredential.hash, real: true };
  }
  // Placeholder PKH (28-byte) — KHÔNG redeem được (không ai ký), chỉ demo claim 2 ví.
  return { pkh: "b0".repeat(28), real: false };
}

async function main(): Promise<void> {
  console.log("=== LampDistribution Step 3: Genesis ===\n");

  const state = await loadDeployed();
  if (!state.testLamp) {
    console.log("⚠ chưa có testLamp trong deployed.json — chạy 'npm run mint-lamp' trước,");
    console.log("  hoặc tự fund treasury bằng token ngoài (sửa state.testLamp thủ công).");
    throw new Error("thiếu testLamp");
  }

  const lucid = await makeLucid();
  const aPkh  = await walletPkh(lucid);
  const b     = await resolveWalletBPkh();
  const epoch = await currentEpoch();

  console.log(`Network:      ${NETWORK}`);
  console.log(`Epoch:        ${epoch}`);
  console.log(`Ví A (PKH):   ${aPkh}  (= ví deploy, redeem được)`);
  console.log(`Ví B (PKH):   ${b.pkh}  (${b.real ? "ví thật" : "placeholder — chỉ demo claim"})`);
  console.log();

  const nftPolicyId = state.beaconNftPolicy ?? nativeSigPolicyId(aPkh);
  const nftPolicy   = nativeSigPolicy(aPkh);
  const lampUnit    = toUnit(state.testLamp.policyId, state.testLamp.assetName);

  // committee_hash MVP = keyhash[0] (xem ghi chú đầu file).
  const committeeHash = state.committee.keyHashes[0]!;

  // ── beacon NFT units ─────────────────────────────────────────
  const ppNft = lucidToUnit(nftPolicyId, BEACON_ASSET_NAMES.PParam);
  const rnNft = lucidToUnit(nftPolicyId, BEACON_ASSET_NAMES.Randomness);
  const mrNft = lucidToUnit(nftPolicyId, BEACON_ASSET_NAMES.MerkleRoot);

  // ── beacon datums ────────────────────────────────────────────
  const ppDatum = beaconDatumToCbor({ epoch, kind: "PParam",     value: pToBigEndianHex(P_GENESIS) });
  const rnDatum = beaconDatumToCbor({ epoch, kind: "Randomness", value: TEST_NONCE_HEX });
  const mrDatum = beaconDatumToCbor({ epoch: 0n, kind: "MerkleRoot", value: "" });

  // ── treasury datum ───────────────────────────────────────────
  const trDatum = treasuryDatumToCbor({ committee_hash: committeeHash });

  // ── claim account datums (genesis empty) ─────────────────────
  const accA = claimAccountDatumToCbor({
    owner: aPkh, claimed_cumulative: 0n, redeemed_cumulative: 0n, last_claim_epoch: epoch,
  });
  const accB = claimAccountDatumToCbor({
    owner: b.pkh, claimed_cumulative: 0n, redeemed_cumulative: 0n, last_claim_epoch: epoch,
  });

  console.log(`Treasury fund: ${TREASURY_FUND / 1_000_000n} LAMP`);
  const utxos   = await lucid.wallet().getUtxos();
  const lampBal = utxos.reduce((s, u) => s + (u.assets[lampUnit] ?? 0n), 0n);
  console.log(`test-LAMP có:  ${lampBal / 1_000_000n} LAMP`);
  if (lampBal < TREASURY_FUND) {
    throw new Error(`thiếu test-LAMP: cần ${TREASURY_FUND}, có ${lampBal}. Mint thêm (02).`);
  }
  console.log();

  // ── 1 tx: mint 3 NFT + tạo 6 output ─────────────────────────
  const tx = await lucid
    .newTx()
    .mintAssets({ [ppNft]: 1n, [rnNft]: 1n, [mrNft]: 1n }, Data.void())
    .attach.MintingPolicy(nftPolicy)
    // 3 beacon UTxO
    .pay.ToAddressWithData(state.beacon.address, { kind: "inline", value: ppDatum },
      { lovelace: BEACON_MIN_ADA, [ppNft]: 1n })
    .pay.ToAddressWithData(state.beacon.address, { kind: "inline", value: rnDatum },
      { lovelace: BEACON_MIN_ADA, [rnNft]: 1n })
    .pay.ToAddressWithData(state.beacon.address, { kind: "inline", value: mrDatum },
      { lovelace: BEACON_MIN_ADA, [mrNft]: 1n })
    // treasury UTxO (pool LAMP)
    .pay.ToAddressWithData(state.treasury.address, { kind: "inline", value: trDatum },
      { lovelace: TREASURY_MIN_ADA, [lampUnit]: TREASURY_FUND })
    // 2 claim account UTxO
    .pay.ToAddressWithData(state.claimAccount.address, { kind: "inline", value: accA },
      { lovelace: ACCOUNT_MIN_ADA })
    .pay.ToAddressWithData(state.claimAccount.address, { kind: "inline", value: accB },
      { lovelace: ACCOUNT_MIN_ADA })
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log(`✅ Genesis tx submitted!`);
  console.log(`   TX hash:  ${txHash}`);
  console.log(`   Explorer: ${explorerTx(txHash)}`);
  await awaitTx(lucid, txHash, "genesis");

  // output index theo thứ tự pay.* ở trên (Lucid giữ thứ tự outputs khai báo;
  // change output thường ở cuối). Resolve chắc chắn bằng cách query UTxO theo datum/asset.
  console.log("\n   resolve genesis UTxO indices…");
  const beaconUtxos   = await lucid.utxosAt(state.beacon.address);
  const treasuryUtxos = await lucid.utxosAt(state.treasury.address);
  const accountUtxos  = await lucid.utxosAt(state.claimAccount.address);

  const findByAsset = (us: typeof beaconUtxos, unit: string) => {
    const u = us.find((x) => (x.assets[unit] ?? 0n) === 1n && x.txHash === txHash);
    if (!u) throw new Error(`không tìm thấy UTxO chứa ${unit} trong tx ${txHash}`);
    return { txHash: u.txHash, outputIndex: u.outputIndex };
  };
  const treasuryRef = (() => {
    const u = treasuryUtxos.find((x) => x.txHash === txHash && (x.assets[lampUnit] ?? 0n) > 0n);
    if (!u) throw new Error("không tìm thấy treasury UTxO");
    return { txHash: u.txHash, outputIndex: u.outputIndex };
  })();
  // 2 account UTxO: phân biệt theo owner trong datum.
  const accUtxosThisTx = accountUtxos.filter((x) => x.txHash === txHash);
  const accountARef = (() => {
    const u = accUtxosThisTx.find((x) => x.datum && x.datum === accA);
    if (!u) throw new Error("không tìm thấy ClaimAccount A");
    return { txHash: u.txHash, outputIndex: u.outputIndex };
  })();
  const accountBRef = (() => {
    const u = accUtxosThisTx.find((x) => x.datum && x.datum === accB);
    if (!u) throw new Error("không tìm thấy ClaimAccount B");
    return { txHash: u.txHash, outputIndex: u.outputIndex };
  })();

  state.beaconNftPolicy = nftPolicyId;
  state.wallets = { aPkh, bPkh: b.pkh };
  state.genesis = {
    pparamBeacon:     findByAsset(beaconUtxos, ppNft),
    randomnessBeacon: findByAsset(beaconUtxos, rnNft),
    merkleBeacon:     findByAsset(beaconUtxos, mrNft),
    treasuryUtxo:     treasuryRef,
    claimAccountA:    accountARef,
    claimAccountB:    accountBRef,
  };
  await saveDeployed(state);

  console.log("\n── Genesis UTxO map ──");
  console.log(`   PParam beacon:     ${state.genesis.pparamBeacon.txHash}#${state.genesis.pparamBeacon.outputIndex}`);
  console.log(`   Randomness beacon: ${state.genesis.randomnessBeacon.txHash}#${state.genesis.randomnessBeacon.outputIndex}`);
  console.log(`   MerkleRoot beacon: ${state.genesis.merkleBeacon.txHash}#${state.genesis.merkleBeacon.outputIndex}`);
  console.log(`   Treasury:          ${state.genesis.treasuryUtxo.txHash}#${state.genesis.treasuryUtxo.outputIndex}`);
  console.log(`   ClaimAccount A:    ${state.genesis.claimAccountA.txHash}#${state.genesis.claimAccountA.outputIndex}`);
  console.log(`   ClaimAccount B:    ${state.genesis.claimAccountB.txHash}#${state.genesis.claimAccountB.outputIndex}`);
  console.log("\n✅ Đã cập nhật deployed.json. Tiếp theo: npm run e2e");
}

main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
