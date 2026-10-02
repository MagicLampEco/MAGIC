// scripts/deploy/05_create_instant_vault.ts — Tạo UTxO két InstantGen Gen v2.0.
// Run: npx tsx deploy/05_create_instant_vault.ts
// Prereq: 01 (LAMP) · 11 pha `beacons` (RATE_PARAM_HASH, GREENBACK_BEACON_HASH, GB_SHARD_HASH).
// Bắt buộc: két Wakeme của NETWORK (apply-param #8) — lấy từ `config.ts` ▸
// `SCRIPT_HASHES.wakeme_vault`, không qua env. Mạng chưa có két ⟹ ném trước mọi tx.
//
// Gen v2.0: két KHÔNG còn bake UM + BackingBeacon (đời v1). Nhánh sinh đọc beacon ρ ("RHO") và
// beacon GreenBack ("GBB") ở reference input, tiêu một shard GB ("GBS"‖id) — ba hash đó đọc từ
// sổ qua `deployParams.ts` ▸ `genV2BeaconRefsFromBook`, thiếu thì ném nêu tên khoá.
//
// Tham số apply-param KHÔNG khai tay ở đây: danh sách tên + thứ tự đọc thẳng từ
// InstantGen/onchain/plutus.json qua scripts/applyParams.ts, giá trị lấy từ
// scripts/deployParams.ts. Đổi chữ ký `validator vault(...)` ⇒ script này gãy ồn ào.
//
// Tx này MINT luôn NFT danh-tính vault (INV-VAULT-IDENTITY): validator đòi NFT
// ở MỌI đường spend, nên một vault tạo ra mà không có NFT là vault KHÔNG AI SPEND ĐƯỢC.
// Không validator nào chạy lúc TẠO UTxO, nên thiếu mint thì tx vẫn vào chuỗi.
//
// Env (ngoài bộ khoá deploy đọc qua config.ts):
//   LAMP_DEPOSIT      — LAMP nạp vào vault, số nguyên DƯƠNG (đơn vị LAMP, mặc định 10000).
//   PROFILE           — Ember | Flame | Lantern (mặc định Flame).
//   DRY_RUN=1         — dựng + chạy thử validator, KHÔNG ký, KHÔNG gửi, KHÔNG công bố
//                       ref-script, KHÔNG in dòng cho sổ. Vẫn in RESULT (dry_run:true).
//   WRITE_STATE_BOOK  — "1"/"0": có in khối dòng cho sổ + công bố ref-script hay không.
//                       Vắng thì quyết theo ví ký — xem `runResult.ts ▸ decideStateBook`.
//
// Chủ vault LUÔN là khoá của ví ký (PRIVATE_KEY, hoặc WALLET_SEED khi không có
// PRIVATE_KEY — `config.ts ▸ selectWallet`).
//
// Dòng CUỐI stdout, khi thành công, luôn là đúng một dòng máy đọc:
//   RESULT {"vault_outref":"<tx>#<i>","vault_nft":"<unit>","owner":{"type":"key","hash":"<56 hex>"},"dry_run":<bool>}
// Hỏng thì không có dòng RESULT và mã thoát 1.
//
// Tệp xuất phần lõi (`instantGenesisDatum`, `buildInstantVaultCreateTx`) cho bộ kiểm; `main`
// chỉ chạy khi tệp được gọi trực tiếp, và chỉ `main` mới nạp `config.ts`.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Lucid, Blockfrost, Data, toUnit,
  credentialToAddress, scriptHashToCredential, getAddressDetails,
  type LucidEvolution, type Network, type TxSignBuilder, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { ownerRefOf, windowOf } from "@magiclamp/protocol-utils";
import {
  parsePositiveInteger, parseFlag, decideStateBook, resultLine, assertTxHash,
} from "../runResult.js";
import { outputIndexWithUnit } from "../txOutputIndex.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { instantVaultParams, genV2BeaconRefsFromBook } from "../deployParams.js";
import { vaultIdAssetName, mintVaultIdRedeemer, pickSeedUtxo } from "../vaultId.js";
import { parkAddressFor, publishRefScript } from "../refScripts.js";
import { minAdaForRefScriptWithMargin } from "../minAda.js";
// Codec + hằng lấy từ GÓI NỀN, không chép: `WAKEME_SEED_CREDIT` từng là một bản sao có nhãn ở
// đây, và lược đồ 18 trường chép tay chết im lặng khi v2.0 nối hai trường.
import { VaultDatum, type VaultDatum as TVaultDatum } from "../../InstantGen/offchain/src/types.js";
import { WAKEME_SEED_CREDIT, USAGE_WINDOW_LEN } from "../../InstantGen/offchain/src/constants.js";

const PROFILES = ["Ember", "Flame", "Lantern"] as const;
type Profile = (typeof PROFILES)[number];
function parseProfile(raw: string | undefined): Profile {
  const v = raw ?? "Flame";
  if (!(PROFILES as readonly string[]).includes(v)) {
    throw new Error(`PROFILE phải là một trong ${PROFILES.join(" | ")}, nhận "${v}".`);
  }
  return v as Profile;
}
// LAMP_LOCKED / LAST_UPDATED_OFFSET đã BỎ: `validate_mint_vault_id` ép datum khởi sinh SẠCH.
// (UM_* / BACKING_* thì KHÔNG chặn ở đây dù két v2.0 không bake chúng: chúng vẫn là khoá sổ
// của bước 02/04 và của đời v1 đang sống, nên có mặt trong env là bình thường.)
const LEGACY_ENV = ["LAMP_LOCKED", "LAST_UPDATED_OFFSET"] as const;

/**
 * Datum khởi sinh 20 trường. MỌI hằng số là điều kiện on-chain của `validate_mint_vault_id`
 * (InstantGen/onchain/validators/vault.ak) — phần lớn là dấu BẰNG.
 */
export function instantGenesisDatum(i: {
  ownerPkh: string; lampOildrop: bigint; profile: Profile; currentEpoch: bigint;
}): TVaultDatum {
  if (i.lampOildrop <= 0n) throw new Error(`lampOildrop phải > 0, nhận ${i.lampOildrop}`);
  return {
    owner:                 { VerificationKey: [i.ownerPkh] },
    lamp_balance:          i.lampOildrop,
    lamp_locked:           0n,                 // PIN: `expect vd.lamp_locked == 0`
    loyalty_holdings:      [{ amount: i.lampOildrop, acquired_epoch: i.currentEpoch, is_locked: false }],
    magic_batches:         [],
    next_batch_index:      0n,
    wakeme_link:           "",                 // PIN: `expect vd.wakeme_link == #""`
    gen_schedules:         [],
    profile:               i.profile,
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    0n,                 // PIN: `expect vd.last_updated_epoch == 0`
    cap_epoch:             0n,                 // PIN: `expect vd.cap_epoch == 0`
    // PIN: `consumed_credit == wakeme_seed_credit` — KHÔNG phải 0 (dấu BẰNG, Nợ #19).
    activity_state:        { recent_burn_epochs: [], consumed_credit: WAKEME_SEED_CREDIT },
    cap_nanogic:           0n,                 // PIN: `expect vd.cap_nanogic == 0`
    personal_delegate:     null,
    // PIN: `attribution_root: #""` — chuỗi byte RỖNG, KHÔNG phải 32 byte 0.
    attribution:           { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
    instant_unlock_ms:     0n,                 // PIN: `expect vd.instant_unlock_ms == 0`
    // PIN (v2.0): `usage_window == empty_window()` và `usage_window_epoch == 0`.
    usage_window:          Array.from({ length: USAGE_WINDOW_LEN }, () => ({ generated: 0n, consumed: 0n })),
    usage_window_epoch:    0n,
  };
}

export interface InstantVaultCreate {
  tx: TxSignBuilder; vaultAddress: string; vaultIdUnit: string; vaultOutIndex: number;
  datum: TVaultDatum;
}

/** Dựng (chưa ký) tx genesis: seed one-shot + đúc đúng 1 NFT + output két + chủ ký. */
export async function buildInstantVaultCreateTx(i: {
  lucid: LucidEvolution; network: Network;
  vaultScript: Validator; vaultHash: string;
  ownerPkh: string; walletUtxos: UTxO[];
  lampUnit: string; lampOildrop: bigint; profile: Profile; currentEpoch: bigint;
}): Promise<InstantVaultCreate> {
  const vaultAddress = credentialToAddress(i.network, scriptHashToCredential(i.vaultHash));
  // seed phải là input THẬT của chính tx này (`expect list.any(tx.inputs, ...)`) ⇒ ép vào
  // bằng .collectFrom, không để coin selection quyết định.
  const seedUtxo    = pickSeedUtxo(i.walletUtxos);
  const seed        = { txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex };
  const vaultIdUnit = toUnit(i.vaultHash, vaultIdAssetName(seed));
  const datum       = instantGenesisDatum(i);

  // 4 mảnh BẮT BUỘC khớp nhau (validate_mint_vault_id):
  //   (1) seed UTxO trong inputs           (2) mint đúng 1 NFT policy = vault hash
  //   (3) NFT nằm ở output tại vault addr  (4) owner ký
  const tx = await i.lucid
    .newTx()
    .collectFrom([seedUtxo])                                        // (1)
    .mintAssets({ [vaultIdUnit]: 1n }, mintVaultIdRedeemer(seed))   // (2)
    .attach.MintingPolicy(i.vaultScript)
    .pay.ToAddressWithData(                                         // (3)
      vaultAddress,
      { kind: "inline", value: Data.to(datum, VaultDatum) },
      { lovelace: 2_000_000n, [i.lampUnit]: i.lampOildrop, [vaultIdUnit]: 1n },
    )
    .addSignerKey(i.ownerPkh)                                       // (4)
    .complete();
  // Chỉ số output vault đọc từ THÂN tx, TRƯỚC khi ký/gửi: chữ ký không đổi thân nên chỉ số
  // này là chỉ số thật sau khi gửi.
  return { tx, vaultAddress, vaultIdUnit, vaultOutIndex: outputIndexWithUnit(tx, vaultAddress, vaultIdUnit), datum };
}

async function main() {
  const {
    NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PRIVATE_KEY, selectWallet,
    POLICY_IDS, ASSET_NAMES, PROTOCOL, SCRIPT_HASHES, lampToOildrop,
  } = await import("../config.js");
  // Đọc + kiểm env TRƯỚC mọi lệnh gọi mạng: sai hình dạng thì ném, không dựng gì.
  const INITIAL_LAMP_DEPOSIT = lampToOildrop(parsePositiveInteger(process.env.LAMP_DEPOSIT, "LAMP_DEPOSIT", 10_000n));
  const INITIAL_PROFILE      = parseProfile(process.env.PROFILE);
  const dryRun = parseFlag(process.env.DRY_RUN, "DRY_RUN");
  const book   = decideStateBook({
    dryRun, flag: process.env.WRITE_STATE_BOOK, signsWithPrivateKey: PRIVATE_KEY !== "",
  });
  for (const k of LEGACY_ENV) {
    if (process.env[k] !== undefined) {
      throw new Error(
        `${k} không còn dùng được. validate_mint_vault_id ép datum khởi sinh sạch ` +
        `(lamp_locked == 0, last_updated_epoch == 0). Bỏ biến này khỏi môi trường.`,
      );
    }
  }
  // Apply-param #8 (két Wakeme). Không có lối "bỏ qua" bằng hash giả — một hash giả vẫn cho
  // ra một vault hợp lệ, chỉ là vault đó không bao giờ đọc được két thật.
  const wakemeVault = SCRIPT_HASHES.wakeme_vault;
  // Ba hash GenBeacons (bước 11 pha `beacons`). Thiếu ⟹ ném nêu tên khoá, không đệm.
  const beacons = genV2BeaconRefsFromBook(process.env);

  console.log(`=== Step 5: Create InstantGen Vault UTxO (Gen v2.0)${dryRun ? " · DRY RUN" : ""} ===\n`);

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  // Apply params THEO TÊN — thứ tự do blueprint quyết định, không do file này.
  const { script: vaultScript, hash: vaultScriptHash } = appliedScript(
    findValidator(await loadBlueprint("InstantGen"), "vault.vault.spend"),
    instantVaultParams({
      lampPolicyId:    POLICY_IDS.lamp,
      lampAssetName:   ASSET_NAMES.lamp,        // PARAM theo mạng, không hardcode
      ...beacons,
      wakemeVaultHash: wakemeVault,             // #8 — két Wakeme (CC-GEN-LENT-READ)
      msPerEpoch:      PROTOCOL.MS_PER_EPOCH,
      windowOriginMs:      PROTOCOL.WINDOW_ORIGIN_MS,
    }),
  );

  console.log(`Network:            ${NETWORK}`);
  console.log(`Wakeme vault hash:  ${wakemeVault}`);
  console.log(`ms_per_epoch:       ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`LAMP policy:        ${POLICY_IDS.lamp}`);
  console.log(`LAMP asset name:    ${ASSET_NAMES.lamp}`);
  console.log(`GB beacon:          ${beacons.gbBeaconScriptHash}`);
  console.log(`GB shard:           ${beacons.gbShardPolicyId}`);
  console.log(`Rate beacon:        ${beacons.rateScriptHash}`);
  console.log(`Vault script hash:  ${vaultScriptHash}`);
  console.log(`Profile:            ${INITIAL_PROFILE}`);
  console.log(`LAMP deposit:       ${INITIAL_LAMP_DEPOSIT / 1_000_000n} LAMP`);

  // Tip POSIX ms for current epoch.
  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await tipRes.json() as { slot: number; time: number };
  const currentEpoch = windowOf(BigInt(tip.time) * 1000n, PROTOCOL.MS_PER_EPOCH, PROTOCOL.WINDOW_ORIGIN_MS);

  const lampUnit = toUnit(POLICY_IDS.lamp, ASSET_NAMES.lamp);
  const utxos    = await lucid.wallet().getUtxos();
  const lampBal  = utxos.reduce((s, u) => s + (u.assets[lampUnit] ?? 0n), 0n);
  console.log(`Wallet LAMP:        ${lampBal / 1_000_000n} LAMP`);
  if (lampBal < INITIAL_LAMP_DEPOSIT) throw new Error(`Need ${INITIAL_LAMP_DEPOSIT / 1_000_000n} LAMP`);

  const c = await buildInstantVaultCreateTx({
    lucid, network: NETWORK, vaultScript, vaultHash: vaultScriptHash,
    ownerPkh, walletUtxos: utxos, lampUnit, lampOildrop: INITIAL_LAMP_DEPOSIT,
    profile: INITIAL_PROFILE, currentEpoch,
  });
  console.log(`Vault address:      ${c.vaultAddress}`);
  console.log(`Vault-ID NFT:       ${c.vaultIdUnit}`);
  console.log(`Tx size:            ${c.tx.toCBOR().length / 2} byte`);
  const bodyHash = assertTxHash(c.tx.toHash(), "tx.toHash()");
  // Owner in ra được SUY TỪ datum vừa mã hoá, không gõ lại: RESULT nói đúng thứ nằm trên chuỗi.
  const ownerRef = ownerRefOf(c.datum.owner);

  if (dryRun) {
    // `vault_outref` dùng hash THÂN tx chưa ký — không có UTxO nào tồn tại, nên `dry_run:true`
    // là bắt buộc để đọc đúng. Không in "TX hash:" để runner không ghi nhầm vào sổ.
    console.log(`\n✔ DRY RUN: tx dựng xong và qua validator khi chạy thử. Không ký, không gửi.`);
    console.log(`   Hash thân tx (chưa gửi): ${bodyHash}`);
    console.log(`   Sổ trạng thái: không ghi — ${book.reason}`);
    console.log(resultLine({
      vault_outref: `${bodyHash}#${c.vaultOutIndex}`, vault_nft: c.vaultIdUnit, owner: ownerRef, dry_run: true,
    }));
    return;
  }

  const signed = await c.tx.sign.withWallet().complete();
  const txHash = assertTxHash(await signed.submit(), "submit()");
  if (txHash !== bodyHash) {
    throw new Error(`Tx hash sau khi gửi (${txHash}) ≠ hash thân tx lúc dựng (${bodyHash}) — chỉ số output ${c.vaultOutIndex} không còn tin được. Soi tx trên explorer.`);
  }
  // Chờ xác nhận: bước sau tiêu chính UTxO thối của tx này.
  await lucid.awaitTx(txHash);

  console.log(`\n✅ InstantGen vault created!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);

  const result = resultLine({
    vault_outref: `${txHash}#${c.vaultOutIndex}`, vault_nft: c.vaultIdUnit, owner: ownerRef, dry_run: false,
  });

  if (!book.write) {
    // Ref-script vault là CỦA LOẠI vault, không của từng vault: mỗi ví riêng tự công bố
    // thêm một bản ở bãi đỗ của nó là chôn ~50 ADA cho một thứ đã có.
    console.log(`\nSổ trạng thái: không ghi, không công bố ref-script — ${book.reason}`);
    console.log(result);
    return;
  }

  // ── Ref-script CIP-33 của chính vault này (tx riêng, idempotent) ─────────────
  // Bước nào tính ra hash thì bước đó công bố ref-script. Tx sinh + tx consume tiêu hai UTxO
  // script (két + shard GB / Engage) ⟹ phải readFrom, không attach.
  const parkAddr = parkAddressFor(NETWORK, address);
  console.log(`\n⏳ Công bố ref-script vault tại bãi đỗ ${parkAddr} …`);
  const refLovelace = minAdaForRefScriptWithMargin(vaultScript.script);
  console.log(`   min-ADA ref-script: ${refLovelace / 1_000_000n} ADA (script ${vaultScript.script.length / 2} byte)`);
  const vaultRef = await publishRefScript({
    lucid, parkAddr, label: "vault instant ref",
    script: vaultScript, hash: vaultScriptHash, lovelace: refLovelace,
  });

  console.log(`\n📋 Copy to .env:`);
  console.log(`   VAULT_INSTANT_HASH=${vaultScriptHash}   # applied for NETWORK=${NETWORK}, Gen v2.0`);
  console.log(`   VAULT_INSTANT_ADDR=${c.vaultAddress}`);
  console.log(`   WAKEME_VAULT_HASH=${wakemeVault}    # apply-param #8 đã nướng vào VAULT_INSTANT_HASH`);
  console.log(`   VAULT_INSTANT_ID_UNIT=${c.vaultIdUnit}    # NFT danh-tính vault (policy = vault hash)`);
  console.log(`   REF_VAULT_INSTANT_UTXO=${vaultRef}      # chân vault của tx sinh + consume`);
  console.log(result);   // PHẢI là dòng cuối stdout
}

// Mã thoát 0 sau một lỗi làm mọi vòng lặp và mọi `set -e` mù đúng ở lượt hỏng (lý do ở
// `02_deploy_um.ts`). `main` chỉ chạy khi gọi trực tiếp — bộ kiểm import phần lõi.
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
