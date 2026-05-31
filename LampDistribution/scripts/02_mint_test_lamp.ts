// LampDistribution/scripts/02_mint_test_lamp.ts — Mint test-LAMP để fund treasury.
//
// Chạy: npm run mint-lamp   (sau 01_deploy)
//
// SELF-CONTAINED: KHÔNG phụ thuộc tLAMP của Tuân. Mint 1 lượng test-LAMP bằng native
// sig policy của ví deploy (cùng policy id mà 01 đã bake vào claim_account/treasury là
// lamp_policy). Ghi policyId + assetName + minted vào deployed.json.
//
// Lưu ý: lamp_policy đã được 01 chốt (deployed.params.lampPolicy). Policy này PHẢI là
// native sig của ví deploy thì mint mới hợp lệ. Nếu anh override LAMP_POLICY_ID ở 01
// bằng policy ngoài (tLAMP Tuân) → bỏ qua bước này, tự fund treasury bằng token đó.

import { Data } from "@lucid-evolution/lucid";
import {
  NETWORK, makeLucid, walletPkh, nativeSigPolicy, nativeSigPolicyId,
  loadDeployed, saveDeployed, toUnit, lampToOil, explorerTx, awaitTx,
} from "./config.js";

// Lượng test-LAMP mint (oil). Mặc định 1_000_000 LAMP — dư fund treasury pool test.
const MINT_LAMP = lampToOil(BigInt(process.env.TEST_LAMP_MINT ?? "1000000"));

async function main(): Promise<void> {
  console.log("=== LampDistribution Step 2: Mint test-LAMP ===\n");

  const state = await loadDeployed();
  const lucid = await makeLucid();
  const pkh   = await walletPkh(lucid);

  const expectedPolicy = nativeSigPolicyId(pkh);
  const lampPolicy = state.params.lampPolicy;
  const lampName   = state.params.lampName;

  if (lampPolicy !== expectedPolicy) {
    throw new Error(
      `lamp_policy trong deployed.json (${lampPolicy}) ≠ native sig policy của ví deploy ` +
      `(${expectedPolicy}). Ví này KHÔNG mint được policy đó. ` +
      `Nếu dùng token ngoài (tLAMP), fund treasury thủ công + bỏ qua bước này.`,
    );
  }

  const policy   = nativeSigPolicy(pkh);
  const lampUnit = toUnit(lampPolicy, lampName);

  console.log(`Network:    ${NETWORK}`);
  console.log(`Wallet PKH: ${pkh}`);
  console.log(`LAMP unit:  ${lampUnit}`);
  console.log(`Minting:    ${MINT_LAMP} oil = ${MINT_LAMP / 1_000_000n} LAMP\n`);

  const utxos   = await lucid.wallet().getUtxos();
  const balance = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  console.log(`tADA balance: ${balance / 1_000_000n} ADA`);
  if (balance < 5_000_000n) {
    throw new Error("cần ≥ 5 tADA — lấy từ https://docs.cardano.org/cardano-testnet/tools/faucet");
  }

  const tx = await lucid
    .newTx()
    .mintAssets({ [lampUnit]: MINT_LAMP }, Data.void())
    .attach.MintingPolicy(policy)
    .pay.ToAddress(await lucid.wallet().address(), { [lampUnit]: MINT_LAMP })
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log(`\n✅ test-LAMP minted!`);
  console.log(`   TX hash:  ${txHash}`);
  console.log(`   Explorer: ${explorerTx(txHash)}`);

  await awaitTx(lucid, txHash, "mint test-LAMP");

  state.testLamp = { policyId: lampPolicy, assetName: lampName, minted: MINT_LAMP.toString() };
  await saveDeployed(state);

  console.log("\n✅ Đã cập nhật deployed.json. Tiếp theo: npm run genesis");
}

main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
