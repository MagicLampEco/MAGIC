// LampDistribution/scripts/01_deploy.ts — Apply params cho 3 validator + in hash/address.
//
// Chạy: npm run deploy
//
// Validator params (theo onchain/plutus.json):
//   beacon.beacon.spend          : [committee:List<ByteArray>, threshold:Int, beacon_nft_policy:ByteArray]
//   claim_account.claim_account.spend
//        : [committee, threshold, ms_per_epoch:Int, lamp_policy:ByteArray, lamp_name:ByteArray, beacon_nft_policy:ByteArray]
//   treasury.treasury.spend      : [claim_account_hash:ByteArray, lamp_policy:ByteArray, lamp_name:ByteArray]
//
// Phụ thuộc compile-time:
//   - treasury cần claim_account_hash → apply claim_account TRƯỚC để lấy hash.
//   - claim_account/beacon cần beacon_nft_policy + lamp_policy → tính TRƯỚC từ ví deploy
//     (native one-shot sig policy, id deterministic theo keyhash). Self-test:
//     lamp_policy == beacon_nft_policy == nativeSigPolicyId(walletPkh); phân biệt theo
//     asset name. Production: truyền LAMP_POLICY_ID / BEACON_NFT_POLICY qua .env.
//
// Ghi kết quả vào deployed.json để 02/03/04 dùng lại.

import {
  NETWORK, MS_PER_EPOCH, LAMP_ASSET_NAME,
  makeLucid, walletPkh, resolveCommittee,
  rawValidator, applyValidator, scriptAddress, scriptHash,
  nativeSigPolicyId,
  saveDeployed, type DeployedState,
} from "./config.js";

async function main(): Promise<void> {
  console.log("=== LampDistribution Step 1: Deploy (apply params) ===\n");

  const lucid = await makeLucid();
  const pkh   = await walletPkh(lucid);
  const committee = await resolveCommittee(lucid);

  console.log(`Network:           ${NETWORK}`);
  console.log(`ms_per_epoch:      ${MS_PER_EPOCH}`);
  console.log(`Deploy wallet PKH: ${pkh}`);
  console.log(`Committee source:  ${committee.source}`);
  console.log(`Committee keys:    ${committee.keyHashes.length} (threshold ${committee.threshold})`);
  committee.keyHashes.forEach((k, i) => console.log(`   [${i}] ${k}`));
  console.log();

  // ── Resolve lamp_policy + beacon_nft_policy ──────────────────
  // Production override qua env; self-test = native sig policy của ví deploy.
  const lampPolicy = (process.env.LAMP_POLICY_ID ?? "").trim() || nativeSigPolicyId(pkh);
  const lampName   = (process.env.LAMP_ASSET_NAME ?? "").trim() || LAMP_ASSET_NAME;
  const beaconNftPolicy = (process.env.BEACON_NFT_POLICY ?? "").trim() || nativeSigPolicyId(pkh);

  console.log(`lamp_policy:       ${lampPolicy}`);
  console.log(`lamp_name:         ${lampName} ("${Buffer.from(lampName, "hex").toString("utf8")}")`);
  console.log(`beacon_nft_policy: ${beaconNftPolicy}`);
  if (process.env.BEACON_NFT_POLICY) {
    console.log("   (beacon_nft_policy từ env — agent beacon_nft đã ship)");
  } else {
    console.log("   ⚠ TODO: beacon_nft minting validator chưa có trong blueprint;");
    console.log("     dùng native one-shot sig policy (ví deploy). Thay BEACON_NFT_POLICY qua .env khi sẵn.");
  }
  console.log();

  const committeeData = committee.keyHashes;   // List<ByteArray> = array of hex strings
  const thresholdData = BigInt(committee.threshold);

  // ── claim_account (apply trước để lấy hash cho treasury) ─────
  const rawClaim = await rawValidator("claim_account.claim_account.spend");
  const claimScript = applyValidator(rawClaim.compiledCode, [
    committeeData,
    thresholdData,
    MS_PER_EPOCH,
    lampPolicy,
    lampName,
    beaconNftPolicy,
  ]);
  const claimHash = scriptHash(claimScript);
  const claimAddr = scriptAddress(claimScript);

  // ── beacon ────────────────────────────────────────────────────
  const rawBeacon = await rawValidator("beacon.beacon.spend");
  const beaconScript = applyValidator(rawBeacon.compiledCode, [
    committeeData,
    thresholdData,
    beaconNftPolicy,
  ]);
  const beaconHash = scriptHash(beaconScript);
  const beaconAddr = scriptAddress(beaconScript);

  // ── treasury (cần claim_account_hash) ────────────────────────
  const rawTreasury = await rawValidator("treasury.treasury.spend");
  const treasuryScript = applyValidator(rawTreasury.compiledCode, [
    claimHash,
    lampPolicy,
    lampName,
  ]);
  const treasuryHash = scriptHash(treasuryScript);
  const treasuryAddr = scriptAddress(treasuryScript);

  console.log("── Applied validators ──");
  console.log(`claim_account hash: ${claimHash}`);
  console.log(`   addr:            ${claimAddr}`);
  console.log(`beacon hash:        ${beaconHash}`);
  console.log(`   addr:            ${beaconAddr}`);
  console.log(`treasury hash:      ${treasuryHash}`);
  console.log(`   addr:            ${treasuryAddr}`);
  console.log();

  const state: DeployedState = {
    network: NETWORK,
    msPerEpoch: MS_PER_EPOCH.toString(),
    committee: {
      keyHashes: committee.keyHashes,
      threshold: committee.threshold,
      source: committee.source,
    },
    claimAccount: { hash: claimHash, address: claimAddr },
    beacon:       { hash: beaconHash, address: beaconAddr },
    treasury:     { hash: treasuryHash, address: treasuryAddr },
    params: {
      msPerEpoch: MS_PER_EPOCH.toString(),
      lampPolicy,
      lampName,
      beaconNftPolicy,
      claimAccountHash: claimHash,
    },
  };
  await saveDeployed(state);

  console.log("✅ Đã ghi deployed.json. Tiếp theo: npm run mint-lamp");
}

main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
