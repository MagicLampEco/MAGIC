// LampDistribution/scripts/04_e2e.ts — Full flow THẬT trên Preview.
//
// Chạy: npm run e2e   (sau 01 → 02 → 03)
//
// Flow (SPEC §8):
//   a. Claim:  committee 2/3 ký → A claim 250 LAMP, B claim 1000 LAMP.
//   b. Beacon: post P_1 + nonce_1 (đọc nonce Cardano thật qua Blockfrost nếu được).
//   c. Lottery off-chain (runLottery) → won_cumulative A,B → buildMerkleTree → post root.
//   d. Redeem: A submit proof → nhận LAMP thật vào ví.
//   e. Verify: query lại UTxO, in redeemed_cumulative + LAMP balance.
//
// Mỗi tx: in tx hash + explorer link + await confirm trước khi sang bước sau.
//
// LƯU Ý epoch: validator claim_account tính epoch từ validity_range POSIX ms
// (posix_ms_to_epoch). Lucid mặc định set validity range bao quanh slot hiện tại →
// epoch khớp currentEpoch ta tính từ tip. Nếu C-CLAIM-4 fail vì lệch epoch ranh giới
// ngày, chạy lại (epoch ổn định trong ngày Preview = 86_400_000 ms).

import { Data } from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, BEACON_ASSET_NAMES, MS_PER_EPOCH,
  makeLucid, walletPkh, loadDeployed, reapplyValidators,
  toUnit, explorerTx, awaitTx, currentEpoch,
} from "./config.js";
import {
  decodeClaimAccountDatum,
} from "../offchain/src/datum.js";
import { buildClaimTx }      from "../offchain/src/claimBuilder.js";
import { buildPostBeaconTx } from "../offchain/src/beaconBuilder.js";
import { buildRedeemTx }     from "../offchain/src/redeemBuilder.js";
import { runLottery }        from "../offchain/src/lottery.js";
import { buildMerkleTree }   from "../offchain/src/merkle.js";
import { P_GENESIS } from "../offchain/src/constants.js";
import type { LucidEvolution, UTxO, TxSignBuilder } from "@lucid-evolution/lucid";

const LAMP_A = 250_000_000n;   // 250 LAMP (oil)
const LAMP_B = 1_000_000_000n; // 1000 LAMP (oil)

// e2e dùng target rate cao để demo có vé thắng với ít ticket. Override TARGET_RATE_Q_E2E.
// Mặc định = 50% để A (250/100=3 vé) gần như chắc có ≥1 thắng → won>0 → redeem được.
const E2E_TARGET_RATE_Q = BigInt(process.env.TARGET_RATE_Q_E2E ?? (500_000_000n).toString());

const TEST_NONCE_HEX =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

function norm(h: string): string {
  return (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
}

/** Tìm ClaimAccount UTxO theo owner PKH (decode datum). Re-resolve sau mỗi spend. */
async function findClaimAccount(
  lucid: LucidEvolution, address: string, ownerPkh: string,
): Promise<UTxO> {
  const utxos = await lucid.utxosAt(address);
  for (const u of utxos) {
    if (!u.datum) continue;
    try {
      const d = decodeClaimAccountDatum(Data.from(u.datum));
      if (norm(d.owner) === norm(ownerPkh)) return u;
    } catch { /* không phải ClaimAccountDatum */ }
  }
  throw new Error(`không tìm thấy ClaimAccount cho owner ${ownerPkh} tại ${address}`);
}

/** Tìm beacon UTxO theo NFT asset (kind). Re-resolve sau mỗi PostBeacon. */
async function findBeacon(
  lucid: LucidEvolution, address: string, nftUnit: string,
): Promise<UTxO> {
  const utxos = await lucid.utxosAt(address);
  const u = utxos.find((x) => (x.assets[nftUnit] ?? 0n) === 1n);
  if (!u) throw new Error(`không tìm thấy beacon UTxO chứa ${nftUnit}`);
  return u;
}

/** Đọc epoch nonce Cardano thật qua Blockfrost (/epochs/latest/parameters → nonce). */
async function fetchCardanoNonce(): Promise<string | null> {
  try {
    const res = await fetch(`${BLOCKFROST_URL}/epochs/latest/parameters`, {
      headers: { project_id: BLOCKFROST_KEY },
    });
    if (!res.ok) return null;
    const p = (await res.json()) as { nonce?: string };
    if (p.nonce && /^[0-9a-f]{64}$/i.test(p.nonce)) return p.nonce.toLowerCase();
    return null;
  } catch { return null; }
}

/** Sign + submit + await. Trả txHash. */
async function submit(
  lucid: LucidEvolution, txComplete: TxSignBuilder, label: string,
): Promise<string> {
  const signed = await txComplete.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`   TX:       ${txHash}`);
  console.log(`   Explorer: ${explorerTx(txHash)}`);
  await awaitTx(lucid, txHash, label);
  return txHash;
}

async function main(): Promise<void> {
  console.log("=== LampDistribution Step 4: E2E live flow ===\n");

  const state = await loadDeployed();
  if (!state.genesis || !state.wallets || !state.testLamp || !state.beaconNftPolicy) {
    throw new Error("deployed.json thiếu genesis/wallets/testLamp — chạy 01→02→03 trước.");
  }

  const lucid = await makeLucid();
  const aPkh  = await walletPkh(lucid);
  if (norm(aPkh) !== norm(state.wallets.aPkh)) {
    throw new Error(`ví hiện tại (${aPkh}) ≠ ví A genesis (${state.wallets.aPkh}). Dùng đúng ví deploy.`);
  }
  const bPkh = state.wallets.bPkh;

  const { claimScript, beaconScript, treasuryScript } = await reapplyValidators(state);
  const committee = state.committee.keyHashes;
  const threshold = state.committee.threshold;

  const epoch = await currentEpoch();
  // lower_bound POSIX ms cho validity_range Claim tx → validator get_epoch (C-CLAIM-4).
  // = epoch * ms_per_epoch ⇒ floor(validFrom / mspe) == epoch == last_claim_epoch.
  const validFromMs = epoch * MS_PER_EPOCH;
  console.log(`Network: ${NETWORK}   epoch: ${epoch}`);
  console.log(`Committee: ${committee.length} keys (threshold ${threshold}, source ${state.committee.source})`);

  const lampUnit = toUnit(state.testLamp.policyId, state.testLamp.assetName);
  const mrNft    = toUnit(state.beaconNftPolicy, BEACON_ASSET_NAMES.MerkleRoot);
  const ppNft    = toUnit(state.beaconNftPolicy, BEACON_ASSET_NAMES.PParam);
  const rnNft    = toUnit(state.beaconNftPolicy, BEACON_ASSET_NAMES.Randomness);

  // balance A trước flow
  const balBefore = (await lucid.wallet().getUtxos())
    .reduce((s, u) => s + (u.assets[lampUnit] ?? 0n), 0n);
  console.log(`Ví A test-LAMP trước: ${balBefore / 1_000_000n} LAMP\n`);

  // ════════════════════════════════════════════════════════════
  // a. CLAIM (committee confirm) — A 250 LAMP, B 1000 LAMP
  // ════════════════════════════════════════════════════════════
  console.log("── a. Claim ──");

  const accA0 = await findClaimAccount(lucid, state.claimAccount.address, aPkh);
  const claimA = await buildClaimTx({
    lucid, claimScript, network: NETWORK,
    ownerPkh: aPkh, amount: LAMP_A, currentEpoch: epoch,
    claimAccountUtxo: accA0,
    committeeKeyHashes: committee, threshold,
    validFromMs,
  });
  console.log(claimA.summary);
  await submit(lucid, claimA.tx, "claim A");

  const accB0 = await findClaimAccount(lucid, state.claimAccount.address, bPkh);
  const claimB = await buildClaimTx({
    lucid, claimScript, network: NETWORK,
    ownerPkh: bPkh, amount: LAMP_B, currentEpoch: epoch,
    claimAccountUtxo: accB0,
    committeeKeyHashes: committee, threshold,
    validFromMs,
  });
  console.log(claimB.summary);
  await submit(lucid, claimB.tx, "claim B");

  // ════════════════════════════════════════════════════════════
  // b. POST BEACON — P_1 + nonce_1
  // ════════════════════════════════════════════════════════════
  console.log("\n── b. Post beacon (P + nonce) ──");

  // nonce thật nếu lấy được
  let nonceHex = await fetchCardanoNonce();
  if (nonceHex) console.log(`   nonce Cardano thật (epoch latest): ${nonceHex}`);
  else { nonceHex = TEST_NONCE_HEX; console.log(`   nonce fallback test vector: ${nonceHex}`); }

  // PParam beacon: post P_GENESIS cho epoch+1 (announcement). value = P big-endian.
  let pHex = P_GENESIS.toString(16); if (pHex.length % 2) pHex = "0" + pHex;
  const ppUtxo = await findBeacon(lucid, state.beacon.address, ppNft);
  const postP = await buildPostBeaconTx({
    lucid, beaconUtxo: ppUtxo, beaconScript, network: NETWORK,
    beaconNftPolicy: state.beaconNftPolicy,
    newBeacon: { epoch: epoch + 1n, kind: "PParam", value: pHex },
    committeeKeyHashes: committee, threshold,
  });
  console.log(postP.summary);
  await submit(lucid, postP.tx, "post P");

  // Randomness beacon: post nonce cho epoch hiện tại.
  const rnUtxo = await findBeacon(lucid, state.beacon.address, rnNft);
  const postR = await buildPostBeaconTx({
    lucid, beaconUtxo: rnUtxo, beaconScript, network: NETWORK,
    beaconNftPolicy: state.beaconNftPolicy,
    newBeacon: { epoch: epoch + 1n, kind: "Randomness", value: nonceHex },
    committeeKeyHashes: committee, threshold,
  });
  console.log(postR.summary);
  await submit(lucid, postR.tx, "post nonce");

  // ════════════════════════════════════════════════════════════
  // c. LOTTERY off-chain + post MerkleRoot
  // ════════════════════════════════════════════════════════════
  console.log("\n── c. Lottery off-chain + post MerkleRoot ──");

  const results = runLottery(
    [
      { owner: norm(aPkh), claimedCum: LAMP_A, wonCumPrev: 0n },
      { owner: norm(bPkh), claimedCum: LAMP_B, wonCumPrev: 0n },
    ],
    { nonceHex, P: P_GENESIS, targetRateQ: E2E_TARGET_RATE_Q },
  );
  for (const r of results) {
    console.log(`   ${r.owner.slice(0, 12)}…  tickets=${r.tickets} wins=${r.wins} ` +
      `wonThis=${r.wonThis / 1_000_000n} won_cum=${r.wonCumNew / 1_000_000n} LAMP`);
  }

  const wonA = results.find((r) => norm(r.owner) === norm(aPkh))!.wonCumNew;
  if (wonA <= 0n) {
    throw new Error(
      `A won_cumulative = 0 (không trúng vé nào với target ${E2E_TARGET_RATE_Q} Q). ` +
      `Tăng TARGET_RATE_Q_E2E hoặc đổi nonce.`,
    );
  }

  // Merkle leaves: chỉ won > 0.
  const leaves = results
    .filter((r) => r.wonCumNew > 0n)
    .map((r) => ({ owner: norm(r.owner), wonCumulative: r.wonCumNew }));
  const tree = buildMerkleTree(leaves);
  console.log(`   Merkle root: ${tree.rootHex} (${tree.leafCount} lá)`);

  const mrUtxo = await findBeacon(lucid, state.beacon.address, mrNft);
  const postM = await buildPostBeaconTx({
    lucid, beaconUtxo: mrUtxo, beaconScript, network: NETWORK,
    beaconNftPolicy: state.beaconNftPolicy,
    newBeacon: { epoch, kind: "MerkleRoot", value: tree.rootHex },
    committeeKeyHashes: committee, threshold,
  });
  console.log(postM.summary);
  await submit(lucid, postM.tx, "post MerkleRoot");

  // ════════════════════════════════════════════════════════════
  // d. REDEEM — A submit proof → nhận LAMP
  // ════════════════════════════════════════════════════════════
  console.log("\n── d. Redeem (ví A) ──");

  const accA1     = await findClaimAccount(lucid, state.claimAccount.address, aPkh);
  const treasuryU = (await lucid.utxosAt(state.treasury.address))
    .find((u) => (u.assets[lampUnit] ?? 0n) > 0n);
  if (!treasuryU) throw new Error("không tìm thấy treasury UTxO còn LAMP");
  const mrBeacon  = await findBeacon(lucid, state.beacon.address, mrNft);

  const redeem = await buildRedeemTx({
    lucid, network: NETWORK,
    claimAccountUtxo: accA1, claimScript,
    treasuryUtxo: treasuryU, treasuryScript,
    merkleBeaconUtxo: mrBeacon,
    wonCumulative: wonA, lotteryEpoch: epoch,
    lotteryLeaves: leaves,
    lampPolicyId: state.testLamp.policyId, lampAssetName: state.testLamp.assetName,
  });
  console.log(redeem.summary);
  await submit(lucid, redeem.tx, "redeem A");

  // ════════════════════════════════════════════════════════════
  // e. VERIFY on-chain
  // ════════════════════════════════════════════════════════════
  console.log("\n── e. Verify on-chain ──");

  const accA2 = await findClaimAccount(lucid, state.claimAccount.address, aPkh);
  const dA    = decodeClaimAccountDatum(Data.from(accA2.datum!));
  const balAfter = (await lucid.wallet().getUtxos())
    .reduce((s, u) => s + (u.assets[lampUnit] ?? 0n), 0n);

  console.log(`   ClaimAccount A: claimed=${dA.claimed_cumulative / 1_000_000n} ` +
    `redeemed=${dA.redeemed_cumulative / 1_000_000n} LAMP`);
  console.log(`   Ví A test-LAMP: ${balBefore / 1_000_000n} → ${balAfter / 1_000_000n} LAMP ` +
    `(+${(balAfter - balBefore) / 1_000_000n})`);

  if (dA.redeemed_cumulative !== wonA) {
    throw new Error(`redeemed_cumulative ${dA.redeemed_cumulative} ≠ wonA ${wonA}`);
  }
  if (balAfter - balBefore !== redeem.released) {
    console.log(`   ⚠ chênh balance (${balAfter - balBefore}) ≠ released (${redeem.released}) ` +
      `— có thể do change UTxO/min-ADA; kiểm tra explorer.`);
  }

  console.log("\n✅ E2E hoàn tất — claim → beacon → lottery → redeem chạy THẬT trên Preview.");
}

main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
