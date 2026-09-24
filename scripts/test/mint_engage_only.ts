// scripts/test/mint_engage_only.ts — đúc ĐÚNG MỘT thread Engage cho ví đang ký, trên
// instance `consume` ĐÃ deploy. Không đụng price NFT, không đổi hash nào.
// Run: npx tsx test/mint_engage_only.ts
//
// Vì sao tách khỏi bước 09: nhánh chi của `consume` ép owner vault == owner thread Engage
// (`consume.ak` ▸ `all_vault_owners_are`), nên mỗi ví muốn tiêu MAGIC cần một thread của
// chính nó. Nơi duy nhất từng đúc thread là `deploy/09_deploy_consume.ts`, mà bước đó đúc
// kèm price NFT one-shot ⟹ đổi hash `consume` ⟹ mọi thread cũ mồ côi. Tệp này chỉ gọi
// handler `mint` của `consume` (`validate_mint_engage_id`): seed bị tiêu, đúng 1 NFT tên
// blake2b_256(cbor(seed)), output tại địa chỉ enterprise của `consume`, datum genesis sạch,
// owner ký.
//
// ENV bắt buộc (đúng bộ dựng lại hash `consume` của consume_only.ts):
//   NETWORK · BLOCKFROST_KEY · WALLET_SEED (hoặc PRIVATE_KEY)
//   VAULT_KIND=instant|schedule  (chọn VAULT_INSTANT_HASH hoặc VAULT_SCHEDULE_HASH)
//   CONSUME_SCRIPT_HASH · PRICE_NFT_POLICY · PRICE_PARAM_HASH · MAX_PRICE_STALE — mỗi khoá
//     mang hậu tố `_SCHEDULE` / `_INSTANT` theo VAULT_KIND (scripts/consumeBook.ts)
// ENV tuỳ chọn:
//   DID_COMMIT   hex 32 byte, hoặc bỏ trống (validator chỉ nhận rỗng hoặc đúng 32 byte)
//   DRY_RUN=1    dựng + chạy thử validator (evaluate) nhưng KHÔNG ký, KHÔNG gửi
//
// In ra: ENGAGE_NFT_UNIT_<LOẠI>, ENGAGE_UTXO_<LOẠI> — nạp vào consume_only.ts.

import {
  Lucid, Blockfrost, Data,
  credentialToAddress, scriptHashToCredential, getAddressDetails,
  type UTxO,
} from "@lucid-evolution/lucid";
import { NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, PROTOCOL } from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { consumeParams } from "../deployParams.js";
import { EngageDatumSchema } from "../../ConsumeMAGIC/offchain/src/types.js";
import { vaultIdAssetName, mintVaultIdRedeemer } from "../vaultId.js";
import { consumeKey, parseVaultKind, selectConsumeBook, vaultHashKey } from "../consumeBook.js";

const PRICE_NFT_NAME    = "5052494345"; // "PRICE" — price_nft.ak
const BURN_BATCH_CONSTR = 2n;           // cùng giá trị với deploy/09_deploy_consume.ts

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Thiếu ${name} — không gửi gì.`);
  return v;
}

async function main() {
  console.log(`=== Đúc thread Engage cho ví đang ký · ${NETWORK}${process.env.DRY_RUN === "1" ? " · DRY RUN" : ""} ===\n`);

  const kind = parseVaultKind(process.env.VAULT_KIND);
  const vaultScriptHash = req(vaultHashKey(kind));
  // Bộ khoá consume theo hậu tố của loại vault (`scripts/consumeBook.ts`); `req(...)` phía
  // dưới đọc tên không hậu tố đã được chép từ đúng bộ đó.
  selectConsumeBook(process.env, kind, [
    "CONSUME_SCRIPT_HASH", "PRICE_NFT_POLICY", "PRICE_PARAM_HASH", "MAX_PRICE_STALE",
  ]);
  const expectedConsume = req("CONSUME_SCRIPT_HASH");

  // Dựng lại `consume` từ tham số rồi ĐỐI CHIẾU hash. Lệch ⟹ bộ biến trỏ sang một instance
  // khác; đúc ở đó là đúc thread cho một `consume` không ai dùng.
  const blueprint = await loadBlueprint("ConsumeMAGIC");
  const { script: consumeScript, hash: consumeHash } = appliedScript(
    findValidator(blueprint, "consume.consume.spend"),
    consumeParams({
      priceNftPolicy:       req("PRICE_NFT_POLICY"),
      priceNftName:         PRICE_NFT_NAME,
      vaultScriptHash,
      burnBatchConstr:      BURN_BATCH_CONSTR,
      maxPriceStale:        BigInt(req("MAX_PRICE_STALE")),
      msPerEpoch:           PROTOCOL.MS_PER_EPOCH,
      priceParamScriptHash: req("PRICE_PARAM_HASH"),
    }),
  );
  if (consumeHash !== expectedConsume) {
    throw new Error(
      `Dựng lại consume ra ${consumeHash} ≠ CONSUME_SCRIPT_HASH ${expectedConsume}. ` +
      `Bộ biến không khớp instance đã deploy — không gửi gì.`,
    );
  }
  // Địa chỉ ENTERPRISE (không stake credential): validator so cả địa chỉ, không chỉ payment.
  const consumeAddr = credentialToAddress(NETWORK, scriptHashToCredential(consumeHash));

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const ownerPkh = getAddressDetails(await lucid.wallet().address()).paymentCredential?.hash;
  if (!ownerPkh) throw new Error("Không lấy được payment credential của ví");

  // Seed: một UTxO thuần ADA của ví. Tiêu nó là thứ làm thread one-shot.
  const utxos = await lucid.wallet().getUtxos();
  const seed: UTxO | undefined = utxos
    .filter((u) => Object.keys(u.assets).every((k) => k === "lovelace"))
    .sort((a, b) => Number((b.assets.lovelace ?? 0n) - (a.assets.lovelace ?? 0n)))[0];
  if (!seed) throw new Error("Ví không có UTxO thuần ADA nào để làm seed — nạp tADA trước.");

  const seedRef   = { txHash: seed.txHash, outputIndex: seed.outputIndex };
  const nftName   = vaultIdAssetName(seedRef);
  const nftUnit   = consumeHash + nftName;
  const didCommit = (process.env.DID_COMMIT ?? "").toLowerCase();
  if (didCommit !== "" && !/^[0-9a-f]{64}$/.test(didCommit)) {
    throw new Error("DID_COMMIT phải rỗng hoặc đúng 32 byte hex (64 ký tự) — validator từ chối độ dài khác.");
  }

  const datum = Data.to({
    owner:            ownerPkh,
    consumed_count:   0n,
    last_epoch:       0n,
    did_commit:       didCommit,
    consumed_nanogic: 0n,
  } as never, EngageDatumSchema);

  console.log(`consume hash:  ${consumeHash}  (khớp)`);
  console.log(`consume addr:  ${consumeAddr}`);
  console.log(`owner pkh:     ${ownerPkh}`);
  console.log(`seed:          ${seed.txHash}#${seed.outputIndex}`);
  console.log(`thread unit:   ${nftUnit}\n`);

  // `complete()` chạy thử validator cục bộ — tx sai hình dạng dừng ở đây, chưa gửi gì.
  const tx = await lucid.newTx()
    .collectFrom([seed])
    .mintAssets({ [nftUnit]: 1n }, mintVaultIdRedeemer(seedRef))
    .attach.MintingPolicy(consumeScript)
    .pay.ToContract(consumeAddr, { kind: "inline", value: datum }, { lovelace: 2_000_000n, [nftUnit]: 1n })
    .addSignerKey(ownerPkh)
    .complete();

  if (process.env.DRY_RUN === "1") {
    console.log("✔ DRY RUN: tx dựng xong và qua validator khi chạy thử. Không ký, không gửi.");
    return;
  }

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Đã gửi: ${txHash}`);
  await lucid.awaitTx(txHash);

  // Đọc lại UTxO thread thay vì tin `submit()`.
  let out: UTxO | undefined;
  for (let i = 1; i <= 6 && !out; i++) {
    out = (await lucid.utxosAt(consumeAddr)).find((u) => u.txHash === txHash && (u.assets[nftUnit] ?? 0n) === 1n);
    if (!out) await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!out) {
    console.error(`⚠ Tx ${txHash} đã vào khối nhưng chưa đọc lại được thread — soi explorer, ĐỪNG đúc lại.`);
    process.exit(2);
  }
  console.log("\n✔ Thread Engage đã nằm trên chuỗi. Nạp vào consume_only.ts:");
  console.log(`export ${consumeKey("ENGAGE_NFT_UNIT", kind)}=${nftUnit}`);
  console.log(`export ${consumeKey("ENGAGE_UTXO", kind)}=${out.txHash}#${out.outputIndex}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
