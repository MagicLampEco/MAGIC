// scripts/deploy/07_create_schedule_vault.ts — Tạo UTxO két ScheduleGen Gen v2.0.
// Run: npx tsx deploy/07_create_schedule_vault.ts
// Prereq: 01 LAMP · 11 pha `beacons` (RATE_PARAM_HASH, GREENBACK_BEACON_HASH, GB_SHARD_HASH)
//         · 03 Shards (SHARD_NFT_POLICY_ID).
//
// Két Gen v2.0 là MỘT CẶP script: `commit` (withdraw-zero, 9 tham số) apply trước, hash của nó
// là tham số #6 của két (6 tham số). Cặp dựng bằng `deployParams.ts` ▸ `scheduleScriptPair`,
// tên + thứ tự tham số đọc thẳng từ ScheduleGen/onchain/plutus.json qua scripts/applyParams.ts.
// Nhánh ký của két (commit lịch) uỷ cho `commit` qua mục rút 0 ⟹ trước lượt ký đầu tiên phải
// chạy bước 08 (đăng ký stake credential `commit`, một lần mỗi cụm).
//
// Tx này MINT luôn NFT danh-tính vault (INV-VAULT-IDENTITY) — validator đòi NFT
// ở MỌI đường spend, thiếu nó là vault không ai spend được.
//
// Env vars:
//   PROFILE              — Ember/Flame/Lantern (default Flame); giá trị lạ ⟹ ném
//   LAMP_DEPOSIT         — LAMP nạp, số nguyên DƯƠNG (default 10_000); sai hình dạng ⟹ ném
//   DRY_RUN=1            — dựng + chạy thử validator, KHÔNG ký, KHÔNG gửi, KHÔNG in dòng
//                          cho sổ. Vẫn in RESULT (dry_run:true).
//   WRITE_STATE_BOOK     — "1"/"0": có in khối dòng cho sổ hay không. Vắng thì quyết theo
//                          ví ký — xem `runResult.ts ▸ decideStateBook`.
//   (LAST_UPDATED_OFFSET / PRESEED_SCHEDULE_* đã BỎ — xem LEGACY_ENV bên dưới)
//
// Chủ vault LUÔN là khoá của ví ký (PRIVATE_KEY, hoặc WALLET_SEED khi không có
// PRIVATE_KEY). Cổng đúc đòi chữ ký của chủ, nên không có biến đặt chủ khác.
//
// Dòng CUỐI stdout, khi thành công, luôn là đúng một dòng máy đọc:
//   RESULT {"vault_outref":"<tx>#<i>","vault_nft":"<unit>","owner":{"type":"key","hash":"<56 hex>"},"dry_run":<bool>}
// Hỏng thì không có dòng RESULT và mã thoát 1.
//
// Tệp xuất phần lõi (`scheduleGenesisDatum`, `buildScheduleVaultCreateTx`) cho
// `scripts/test_deploy_gen_v2.ts` chạy trên Emulator; `main` chỉ chạy khi tệp được gọi trực
// tiếp, và chỉ `main` mới nạp `config.ts` (nạp nó là đòi khoá mạng + ví).

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
import { loadBlueprint } from "../applyParams.js";
import { scheduleScriptPair, genV2BeaconRefsFromBook } from "../deployParams.js";
import { vaultIdAssetName, mintVaultIdRedeemer, pickSeedUtxo } from "../vaultId.js";
// Codec + hằng lấy từ GÓI NỀN, không chép lược đồ: bản chép cũ ở tệp này (17 trường) chết
// im lặng đúng lúc v2.0 nối thêm hai trường. Lệch với validator thì `Data.to` vẫn chạy —
// nhưng dựng từ lược đồ gói nền thì lệch nằm ở MỘT chỗ, chỗ mà bộ kiểm của gói đó canh.
import { VaultDatum, type VaultDatum as TVaultDatum } from "../../ScheduleGen/offchain/src/types.js";
import { USAGE_WINDOW_LEN } from "../../ScheduleGen/offchain/src/constants.js";

const PROFILES = ["Ember", "Flame", "Lantern"] as const;
type Profile = (typeof PROFILES)[number];
function parseProfile(raw: string | undefined): Profile {
  const v = raw ?? "Flame";
  if (!(PROFILES as readonly string[]).includes(v)) {
    throw new Error(`PROFILE phải là một trong ${PROFILES.join(" | ")}, nhận "${v}".`);
  }
  return v as Profile;
}

// `validate_mint_vault_id` (ScheduleGen/onchain/validators/vault.ak) ép datum khởi sinh
// SẠCH: lamp_locked == 0, gen_schedules == [], last_updated_epoch == 0, attribution_root ==
// #"". Preseed một GenSchedule tại lúc tạo vault là ĐIỀU KHÔNG THỂ. Muốn thử Fire thì Commit
// thật qua ScheduleGen rồi chờ, không nhét trước vào genesis.
const LEGACY_ENV = [
  "LAST_UPDATED_OFFSET", "PRESEED_SCHEDULE_L", "PRESEED_SCHEDULE_LAM",
] as const;

/**
 * Datum khởi sinh 19 trường. MỌI hằng số là điều kiện on-chain của `validate_mint_vault_id`
 * (ScheduleGen/onchain/validators/vault.ak), không phải sở thích.
 */
export function scheduleGenesisDatum(i: {
  ownerPkh: string; lampOildrop: bigint; profile: Profile; currentEpoch: bigint;
}): TVaultDatum {
  if (i.lampOildrop <= 0n) throw new Error(`lampOildrop phải > 0, nhận ${i.lampOildrop}`);
  return {
    owner:                 { VerificationKey: [i.ownerPkh] },   // chủ = khoá của ví chạy script
    lamp_balance:          i.lampOildrop,
    lamp_locked:           0n,               // PIN: `expect vd.lamp_locked == 0`
    loyalty_holdings:      [{
      amount: i.lampOildrop, acquired_epoch: i.currentEpoch,
      is_locked: false,                      // PIN: list.all(..., !h.is_locked)
    }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [],               // PIN: `expect vd.gen_schedules == []`
    profile:               i.profile,
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    0n,               // PIN: `expect vd.last_updated_epoch == 0`
    delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state:        { recent_burn_epochs: [], consumed_credit: 0n },   // Schedule ghim 0
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    // PIN: `attribution_root: #""` — chuỗi byte RỖNG, KHÔNG phải 32 byte 0.
    attribution:           { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
    // PIN (v2.0): `usage_window == list.repeat(EpochUsage{0,0}, 7)` và `usage_window_epoch == 0`
    // — 0, KHÔNG phải epoch hiện tại, để tx tạo không cần validity range hữu hạn.
    usage_window:          Array.from({ length: USAGE_WINDOW_LEN }, () => ({ generated: 0n, consumed: 0n })),
    usage_window_epoch:    0n,
  };
}

export interface ScheduleVaultCreate {
  tx: TxSignBuilder; vaultAddress: string; vaultIdUnit: string; vaultOutIndex: number;
  datum: TVaultDatum;
}

/** Dựng (chưa ký) tx genesis: seed one-shot + đúc đúng 1 NFT + output két + chủ ký. */
export async function buildScheduleVaultCreateTx(i: {
  lucid: LucidEvolution; network: Network;
  vaultScript: Validator; vaultHash: string;
  ownerPkh: string; walletUtxos: UTxO[];
  lampUnit: string; lampOildrop: bigint; profile: Profile; currentEpoch: bigint;
}): Promise<ScheduleVaultCreate> {
  const vaultAddress = credentialToAddress(i.network, scriptHashToCredential(i.vaultHash));
  const seedUtxo     = pickSeedUtxo(i.walletUtxos);
  const seed         = { txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex };
  const vaultIdUnit  = toUnit(i.vaultHash, vaultIdAssetName(seed));
  const datum        = scheduleGenesisDatum(i);

  const tx = await i.lucid
    .newTx()
    .collectFrom([seedUtxo])                                   // (1) one-shot seed
    .mintAssets({ [vaultIdUnit]: 1n }, mintVaultIdRedeemer(seed))   // (2) đúng 1 NFT
    .attach.MintingPolicy(i.vaultScript)
    .pay.ToAddressWithData(                                    // (3) NFT ở output vault
      vaultAddress,
      { kind: "inline", value: Data.to(datum, VaultDatum) },
      { lovelace: 2_000_000n, [i.lampUnit]: i.lampOildrop, [vaultIdUnit]: 1n },
    )
    .addSignerKey(i.ownerPkh)                                  // (4) owner ký
    .complete();
  // Chỉ số output vault đọc từ THÂN tx trước khi ký/gửi — lý do ở bước 05 cùng chỗ.
  return { tx, vaultAddress, vaultIdUnit, vaultOutIndex: outputIndexWithUnit(tx, vaultAddress, vaultIdUnit), datum };
}

async function main() {
  // Đọc + kiểm env TRƯỚC mọi lệnh gọi mạng: sai hình dạng thì ném, không dựng gì.
  const {
    NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PRIVATE_KEY, selectWallet,
    POLICY_IDS, ASSET_NAMES, PROTOCOL, lampToOildrop,
  } = await import("../config.js");
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
        `(lamp_locked == 0, gen_schedules == [], last_updated_epoch == 0), nên không ` +
        `preseed được lịch vào genesis. Bỏ biến này khỏi môi trường.`,
      );
    }
  }
  // Ba hash GenBeacons (bước 11 pha `beacons`). Thiếu ⟹ ném nêu tên khoá, không đệm.
  const beacons = genV2BeaconRefsFromBook(process.env);

  console.log(`=== Step 7: Create ScheduleGen Vault UTxO (Gen v2.0)${dryRun ? " · DRY RUN" : ""} ===\n`);

  // Kiểm HÌNH DẠNG, không so chuỗi giữ chỗ — cách đó không hỏng lại được khi ai đó đổi tên
  // hằng giữ chỗ (bản cũ so với "FILL_AFTER_STEP_03" trong khi mặc định thật khác chuỗi đó).
  if (!/^[0-9a-f]{56}$/.test(POLICY_IDS.shard_nft)) {
    throw new Error(
      `Step 03 chưa chạy: SHARD_NFT_POLICY_ID phải là 56 ký tự hex, nhận "${POLICY_IDS.shard_nft}".`,
    );
  }

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  const pair = scheduleScriptPair(await loadBlueprint("ScheduleGen"), {
    lampPolicyId:  POLICY_IDS.lamp,
    lampAssetName: ASSET_NAMES.lamp,   // PARAM theo mạng, không hardcode
    shardPolicyId: POLICY_IDS.shard_nft,
    msPerEpoch:    PROTOCOL.MS_PER_EPOCH,
    windowOriginMs:    PROTOCOL.WINDOW_ORIGIN_MS,
    ...beacons,
  });

  console.log(`Network:            ${NETWORK}`);
  console.log(`LAMP policy:        ${POLICY_IDS.lamp}`);
  console.log(`LAMP asset name:    ${ASSET_NAMES.lamp}`);
  console.log(`Shard NFT policy:   ${POLICY_IDS.shard_nft}`);
  console.log(`ms_per_epoch:       ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`GB beacon:          ${beacons.gbBeaconScriptHash}`);
  console.log(`GB shard:           ${beacons.gbShardPolicyId}`);
  console.log(`Rate beacon:        ${beacons.rateScriptHash}`);
  console.log(`Commit script hash: ${pair.commitHash}`);
  console.log(`Vault script hash:  ${pair.vaultHash}`);
  console.log(`Profile:            ${INITIAL_PROFILE}`);
  console.log(`LAMP deposit:       ${INITIAL_LAMP_DEPOSIT / 1_000_000n} tLAMP`);

  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await tipRes.json() as { slot: number; time: number };
  const currentEpoch = windowOf(BigInt(tip.time) * 1000n, PROTOCOL.MS_PER_EPOCH, PROTOCOL.WINDOW_ORIGIN_MS);

  const lampUnit = toUnit(POLICY_IDS.lamp, ASSET_NAMES.lamp);
  const utxos    = await lucid.wallet().getUtxos();
  const lampBal  = utxos.reduce((s, u) => s + (u.assets[lampUnit] ?? 0n), 0n);
  if (lampBal < INITIAL_LAMP_DEPOSIT) throw new Error(`Need ${INITIAL_LAMP_DEPOSIT / 1_000_000n} LAMP`);

  const c = await buildScheduleVaultCreateTx({
    lucid, network: NETWORK, vaultScript: pair.vaultScript, vaultHash: pair.vaultHash,
    ownerPkh, walletUtxos: utxos, lampUnit, lampOildrop: INITIAL_LAMP_DEPOSIT,
    profile: INITIAL_PROFILE, currentEpoch,
  });
  console.log(`Vault address:      ${c.vaultAddress}`);
  console.log(`Vault-ID NFT:       ${c.vaultIdUnit}`);
  console.log(`Tx size:            ${c.tx.toCBOR().length / 2} byte`);
  const bodyHash = assertTxHash(c.tx.toHash(), "tx.toHash()");
  const ownerRef = ownerRefOf(c.datum.owner);

  if (dryRun) {
    // `vault_outref` = hash THÂN tx chưa ký; không có UTxO nào tồn tại nên `dry_run:true`.
    // Không in "TX hash:" — runner bắt nhãn đó (`grab_txhash`) sẽ ghi nhầm vào sổ.
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

  console.log(`\n✅ ScheduleGen vault created!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  if (book.write) {
    console.log(`\n📋 Copy to .env:`);
    console.log(`   VAULT_SCHEDULE_HASH=${pair.vaultHash}    # applied for NETWORK=${NETWORK}, Gen v2.0`);
    console.log(`   VAULT_SCHEDULE_ADDR=${c.vaultAddress}`);
    console.log(`   VAULT_SCHEDULE_ID_UNIT=${c.vaultIdUnit}     # NFT danh-tính vault (policy = vault hash)`);
    console.log(`   (tiếp: 06 công bố ref vault/shard/commit · 08 đăng ký stake commit · 11 pha registry)`);
  } else {
    console.log(`\nSổ trạng thái: không ghi — ${book.reason}`);
  }
  // PHẢI là dòng cuối stdout.
  console.log(resultLine({
    vault_outref: `${txHash}#${c.vaultOutIndex}`, vault_nft: c.vaultIdUnit, owner: ownerRef, dry_run: false,
  }));
}

// Mã thoát 0 sau một lỗi làm mọi vòng lặp và mọi `set -e` mù đúng ở lượt hỏng (lý do ở
// `02_deploy_um.ts`). `main` chỉ chạy khi gọi trực tiếp — bộ kiểm import phần lõi.
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
