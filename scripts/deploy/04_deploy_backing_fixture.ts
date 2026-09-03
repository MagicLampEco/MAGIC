// scripts/deploy/04_deploy_backing_fixture.ts — BackingBeacon DỰNG-TẠM cho testnet.
// Run: npx tsx deploy/04_deploy_backing_fixture.ts
//
// ⚠️ ĐÂY KHÔNG PHẢI BEACON THẬT. Beacon thật (§6.3) do phía CARP/CarpetMint phát
// và cập nhật br = B/S theo dự trữ có thật. Cái này chỉ dựng một UTxO ĐÚNG HÌNH
// DẠNG để cổng fail-closed của InstantGen mở được trên testnet, nhằm tách bạch
// "gen hỏng vì thiếu beacon" khỏi "gen hỏng vì lý do khác". Con số br_q ở đây là
// bịa, không phản ánh dự trữ nào.
//
// CHẶN MAINNET: script tự từ chối chạy khi NETWORK=Mainnet. Dựng beacon giả trên
// mainnet là mở cổng thặng dư bằng một con số không ai bảo chứng.
//
// Hình dạng vault đòi (InstantGen/onchain/validators/vault.ak:732-746):
//   - UTxO mang ≥1 token (backing_nft_policy, #"425251" = "BRQ")
//   - địa chỉ có payment_credential == Script(backing_script_hash)
//   - inline datum decode được thành BackingBeaconDatum
// Không nhánh nào TIÊU beacon trong luồng gen (nó là reference input), nên hai
// script native đủ dùng: một để mint NFT, một để giữ UTxO.
//
// Beacon HẾT HẠN sau max_backing_stale = 1 epoch (constants.ak:49). Chạy lại
// script này sẽ tiêu beacon cũ và dựng lại với epoch hiện tại.
//
// In ra: BACKING_NFT_POLICY_ID, BACKING_SCRIPT_HASH — nạp vào env trước bước 05.

import {
  Lucid, Blockfrost, Data,
  credentialToAddress, scriptHashToCredential,
  mintingPolicyToId, validatorToScriptHash, scriptFromNative,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  ASSET_NAMES, PROTOCOL,
} from "../config.js";

// Field order MUST match InstantGen/onchain/lib/magiclamp/protocol/types.ak:187.
const BackingBeaconDatumSchema = Data.Object({
  br_q:               Data.Integer(),
  magic_supply:       Data.Integer(),
  depeg:              Data.Boolean(),
  last_updated_epoch: Data.Integer(),
});

// br_safe_q = 1.5 (constants.ak:44). br dưới ngưỡng ⟹ cap_surplus = 0 ⟹ gen khoá.
// 2.0 là con số dùng trong test đơn vị ig_pos_* của chính validator.
const BR_Q          = BigInt(process.env.BACKING_BR_Q ?? "2000000000");
const MAGIC_SUPPLY  = BigInt(process.env.BACKING_MAGIC_SUPPLY ?? "1000000000000");

async function main() {
  console.log("=== Step 4: BackingBeacon DỰNG-TẠM (testnet only) ===\n");

  if (NETWORK === "Mainnet") {
    throw new Error(
      "Từ chối: beacon dựng-tạm KHÔNG được lên Mainnet. Cổng thặng dư §6.3 phải " +
      "đọc beacon thật của phía CARP.",
    );
  }

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Không lấy được payment credential của ví");
  const ownerPkh = paymentCredential.hash;

  // Hai script native KHÁC nhau ⟹ policy id ≠ script hash địa chỉ, đúng hình dạng
  // thật (bên mint và bên giữ là hai chỗ).
  const nftScript    = scriptFromNative({ type: "sig", keyHash: ownerPkh });
  const beaconScript = scriptFromNative({ type: "all", scripts: [{ type: "sig", keyHash: ownerPkh }] });

  const nftPolicyId  = mintingPolicyToId(nftScript);
  const beaconHash   = validatorToScriptHash(beaconScript);
  const beaconAddr   = credentialToAddress(NETWORK, scriptHashToCredential(beaconHash));
  const brqUnit      = nftPolicyId + ASSET_NAMES.backing;   // "BRQ" = #"425251"

  // Epoch theo đúng semantics validator: POSIX ms / ms_per_epoch.
  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, { headers: { project_id: BLOCKFROST_KEY } });
  const tip = await tipRes.json() as { time: number };
  const currentEpoch = (BigInt(tip.time) * 1000n) / PROTOCOL.MS_PER_EPOCH;

  console.log(`Network:            ${NETWORK}`);
  console.log(`Backing NFT policy: ${nftPolicyId}`);
  console.log(`Beacon script hash: ${beaconHash}`);
  console.log(`Beacon address:     ${beaconAddr}`);
  console.log(`br_q:               ${BR_Q}  (br_safe = 1_500_000_000)`);
  console.log(`magic_supply:       ${MAGIC_SUPPLY}`);
  console.log(`epoch:              ${currentEpoch}\n`);

  const datum = Data.to(
    { br_q: BR_Q, magic_supply: MAGIC_SUPPLY, depeg: false, last_updated_epoch: currentEpoch } as never,
    BackingBeaconDatumSchema,
  );

  // Beacon cũ (nếu có) — tiêu để dựng lại với epoch mới, không để hai beacon cùng lúc.
  const atBeacon = await lucid.utxosAt(beaconAddr);
  const stale = atBeacon.filter((u) => (u.assets[brqUnit] ?? 0n) > 0n);

  // Blockfrost trả danh sách UTxO trễ vài giây sau tx trước, nên lần dựng đầu hay
  // chọn phải input vừa bị tiêu ("All inputs are spent"). Dựng lại là hết.
  let txHash = "";
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      let tx = lucid.newTx();
      if (stale.length > 0) {
        if (attempt === 1) console.log(`↻ Tiêu ${stale.length} beacon cũ để làm mới epoch.`);
        tx = tx.collectFrom(stale).attach.SpendingValidator(beaconScript);
      } else {
        tx = tx.mintAssets({ [brqUnit]: 1n }).attach.MintingPolicy(nftScript);
      }
      const completed = await tx
        .pay.ToContract(beaconAddr, { kind: "inline", value: datum }, { lovelace: 2_000_000n, [brqUnit]: 1n })
        .addSignerKey(ownerPkh)
        .complete();
      const signed = await completed.sign.withWallet().complete();
      txHash = await signed.submit();
      await lucid.awaitTx(txHash);
      break;
    } catch (e) {
      lastErr = e;
      console.log(`  … lần ${attempt} chưa được, dựng lại sau 15s`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  if (!txHash) throw lastErr;
  console.log(`✔ tx: ${txHash}`);
  console.log("✔ đã xác nhận\n");

  console.log("── nạp vào env trước bước 05 ──");
  console.log(`   BACKING_NFT_POLICY_ID=${nftPolicyId}`);
  console.log(`   BACKING_SCRIPT_HASH=${beaconHash}`);
  console.log(`   BACKING_BEACON_TX=${txHash}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
