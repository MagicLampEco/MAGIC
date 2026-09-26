// scripts/deploy/07_create_schedule_vault.ts — Create initial ScheduleGen vault UTxO.
// Run: npx tsx deploy/07_create_schedule_vault.ts
// Prereq: 01 LAMP, 02 UM, 03 Shards.
//
// Tham số apply-param KHÔNG còn khai tay ở đây: tên + thứ tự đọc thẳng từ
// ScheduleGen/onchain/plutus.json qua scripts/applyParams.ts.
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

import {
  Lucid, Blockfrost, Data, toUnit,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import { ownerRefOf } from "@magiclamp/protocol-utils";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PRIVATE_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, PROTOCOL,
  lampToOildrop,
} from "../config.js";
import {
  parsePositiveInteger, parseFlag, decideStateBook, resultLine, assertTxHash,
} from "../runResult.js";
import { outputIndexWithUnit } from "../txOutputIndex.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { scheduleVaultParams } from "../deployParams.js";
import { vaultIdAssetName, mintVaultIdRedeemer, pickSeedUtxo } from "../vaultId.js";
import { OwnerCredentialSchema } from "../../ScheduleGen/offchain/src/types.js";

// (Schema duplicated from 05/06 — same VaultDatum across all 4 vault modules.)
const VaultDatumSchema = Data.Object({
  owner:                 OwnerCredentialSchema,   // Credential — nguồn: ScheduleGen/offchain/src/types.ts
  lamp_balance:          Data.Integer(),
  lamp_locked:           Data.Integer(),
  loyalty_holdings:      Data.Array(Data.Object({
    amount: Data.Integer(), acquired_epoch: Data.Integer(), is_locked: Data.Boolean(),
  })),
  magic_batches:         Data.Array(Data.Object({
    batch_id:            Data.Bytes(),
    // BIA MỘ — "Snapshot"/"Vacuum" đã bỏ khỏi mô hình nhưng PHẢI giữ trong enum:
    // đây là constructor index của Plutus Data trong các vault ĐÃ TẠO trên
    // Preview. Bỏ variant là dịch chỉ số ⇒ vỡ decode toàn bộ.
    source:              Data.Enum([Data.Literal("Snapshot"), Data.Literal("Instant"), Data.Literal("Vacuum"), Data.Literal("Schedule")]),
    created_epoch:       Data.Integer(),
    initial_amount:      Data.Integer(),
    current_amount:      Data.Integer(),
    decay_window:        Data.Integer(),
    profile_at_creation: Data.Nullable(Data.Enum([Data.Literal("Ember"), Data.Literal("Flame"), Data.Literal("Lantern")])),
    contract_id:         Data.Nullable(Data.Bytes()),
    halved:              Data.Boolean(),
  })),
  next_batch_index:      Data.Integer(),
  // BIA MỘ — VacuumGen đã bỏ, nhưng trường này giữ nguyên vị trí trong datum
  // (arity + thứ tự field là một phần của Plutus Data đã ghi on-chain).
  vacuum_orders:         Data.Array(Data.Object({
    order_id: Data.Bytes(), commit_epoch: Data.Integer(),
    fire_epoch: Data.Integer(), lamp_amount: Data.Integer(),
  })),
  gen_schedules:         Data.Array(Data.Object({
    schedule_id: Data.Bytes(), commit_epoch: Data.Integer(),
    start_fire_epoch: Data.Integer(), end_fire_epoch: Data.Integer(),
    schedule_length: Data.Integer(), lamp_per_epoch: Data.Integer(),
    rate_locked_q: Data.Integer(), baseline_at_commit_q: Data.Integer(),
    multiplier_at_commit_q: Data.Integer(), fired_count: Data.Integer(),
    auto_burn_target: Data.Nullable(Data.Object({
      delegate: Data.Bytes(),
      target_app_id: Data.Nullable(Data.Bytes()),
      max_burn_per_fire: Data.Integer(),
    })),
  })),
  profile:               Data.Enum([Data.Literal("Ember"), Data.Literal("Flame"), Data.Literal("Lantern")]),
  profile_changed_epoch: Data.Integer(),
  pending_profile:       Data.Nullable(Data.Object({
    new_profile: Data.Enum([Data.Literal("Ember"), Data.Literal("Flame"), Data.Literal("Lantern")]),
    effective_epoch: Data.Integer(),
  })),
  last_updated_epoch:    Data.Integer(),
  delegation_cert:       Data.Object({
    current: Data.Array(Data.Object({ app_id: Data.Bytes(), weight_bps: Data.Integer() })),
    pending: Data.Nullable(Data.Object({
      allocations: Data.Array(Data.Object({ app_id: Data.Bytes(), weight_bps: Data.Integer() })),
      effective_epoch: Data.Integer(),
    })),
    current_effective_epoch: Data.Integer(),
    last_changed_epoch:      Data.Integer(),
  }),
  activity_state:        Data.Object({
    recent_burn_epochs: Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
    consumed_credit:    Data.Integer(),   // was total_burns_count (same slot)
  }),
  streak_state:          Data.Object({ current_streak: Data.Integer(), last_active_epoch: Data.Integer() }),
  personal_delegate:     Data.Nullable(Data.Bytes()),
  attribution:           Data.Object({
    attribution_root: Data.Bytes(), last_event_epoch: Data.Integer(), total_events: Data.Integer(),
  }),
});
type VaultDatum = Data.Static<typeof VaultDatumSchema>;
// Codec companion — xem chú thích ở ScheduleGen/offchain/src/types.ts.
// Giá trị thời-chạy y nguyên, chỉ gắn lại nhãn kiểu tĩnh.
const VaultDatum = VaultDatumSchema as unknown as VaultDatum;

const PROFILES = ["Ember", "Flame", "Lantern"] as const;
type Profile = (typeof PROFILES)[number];
function parseProfile(raw: string | undefined): Profile {
  const v = raw ?? "Flame";
  if (!(PROFILES as readonly string[]).includes(v)) {
    throw new Error(`PROFILE phải là một trong ${PROFILES.join(" | ")}, nhận "${v}".`);
  }
  return v as Profile;
}

// `validate_mint_vault_id` (ScheduleGen/onchain/validators/vault.ak:878-914) ép
// datum khởi sinh SẠCH: lamp_locked == 0, gen_schedules == [],
// last_updated_epoch == 0, attribution_root == #"". Preseed một GenSchedule
// (và cái khoá LAMP kèm theo) nay là ĐIỀU KHÔNG THỂ tại lúc tạo vault: NFT danh
// tính không mint được ⇒ vault không spend được. Muốn thử Fire thì Commit thật
// qua ScheduleGen rồi chờ, không nhét trước vào genesis.
const LEGACY_ENV = [
  "LAST_UPDATED_OFFSET", "PRESEED_SCHEDULE_L", "PRESEED_SCHEDULE_LAM",
] as const;

async function main() {
  // Đọc + kiểm env TRƯỚC mọi lệnh gọi mạng: sai hình dạng thì ném, không dựng gì.
  const INITIAL_LAMP_DEPOSIT = lampToOildrop(parsePositiveInteger(process.env.LAMP_DEPOSIT, "LAMP_DEPOSIT", 10_000n));
  const INITIAL_PROFILE      = parseProfile(process.env.PROFILE);
  const dryRun = parseFlag(process.env.DRY_RUN, "DRY_RUN");
  const book   = decideStateBook({
    dryRun, flag: process.env.WRITE_STATE_BOOK, signsWithPrivateKey: PRIVATE_KEY !== "",
  });

  console.log(`=== Step 7: Create ScheduleGen Vault UTxO${dryRun ? " · DRY RUN" : ""} ===\n`);

  // `POLICY_IDS.lamp` nay là cổng ở `config.ts` ▸ `requireLampPolicyId` — nó tự ném
  // khi thiếu, nên ở đây không còn chuỗi giữ chỗ nào để so.
  // 🔴 Dòng cũ so với "FILL_AFTER_STEP_03", mà mặc định thật ở config.ts:46 là
  //   "FILL_AFTER_DEPLOY_SHARDS" — hai chuỗi không bằng nhau nên chốt NÀY CHƯA
  //   TỪNG NỔ. Hậu quả nếu lọt: `shard_policy_id` mang nguyên chuỗi chữ đi vào
  //   apply-param, `applyParams.ts:146-155` chỉ chặn undefined/null chứ không kiểm
  //   hex, và vault ra đời ở một địa chỉ "trông hợp lệ" đã ăn LAMP_DEPOSIT mà
  //   không lịch nào commit nổi. Nay kiểm HÌNH DẠNG, không so chuỗi giữ chỗ — cách
  //   đó không hỏng lại được khi ai đó đổi tên hằng giữ chỗ.
  if (!/^[0-9a-f]{56}$/.test(POLICY_IDS.shard_nft)) {
    throw new Error(
      `Step 03 chưa chạy: SHARD_NFT_POLICY_ID phải là 56 ký tự hex, nhận "${POLICY_IDS.shard_nft}".`,
    );
  }
  // NOTE: TREASURY_ADDRESS is NO LONGER a parameter of this validator.
  // PHA 2 / I-ACT-7 — a fire RELEASES the lock; it moves no LAMP.
  for (const k of LEGACY_ENV) {
    if (process.env[k] !== undefined) {
      throw new Error(
        `${k} không còn dùng được. validate_mint_vault_id ép datum khởi sinh sạch ` +
        `(lamp_locked == 0, gen_schedules == [], last_updated_epoch == 0), nên không ` +
        `preseed được lịch vào genesis. Bỏ biến này khỏi môi trường.`,
      );
    }
  }

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  // Apply params THEO TÊN — thứ tự do blueprint quyết định, không do file này.
  const blueprint = await loadBlueprint("ScheduleGen");
  const unapplied = findValidator(blueprint, "vault.vault.spend");
  const { script: vaultScript, hash: vaultScriptHash } = appliedScript(
    unapplied,
    scheduleVaultParams({
      lampPolicyId:  POLICY_IDS.lamp,
      lampAssetName: ASSET_NAMES.lamp,   // PARAM theo mạng, không hardcode
      shardPolicyId: POLICY_IDS.shard_nft,
      msPerEpoch:    PROTOCOL.MS_PER_EPOCH,
    }),
  );
  const vaultScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(vaultScriptHash));

  console.log(`Network:            ${NETWORK}`);
  console.log(`LAMP policy:        ${POLICY_IDS.lamp}`);
  console.log(`LAMP asset name:    ${ASSET_NAMES.lamp}`);
  console.log(`Shard NFT policy:   ${POLICY_IDS.shard_nft}`);
  console.log(`ms_per_epoch:       ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`Vault script hash:  ${vaultScriptHash}`);
  console.log(`Vault address:      ${vaultScriptAddress}`);
  console.log(`Profile:            ${INITIAL_PROFILE}`);
  console.log(`LAMP deposit:       ${INITIAL_LAMP_DEPOSIT / 1_000_000n} tLAMP`);

  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await tipRes.json() as { slot: number; time: number };
  const tipPosixMs   = BigInt(tip.time) * 1000n;
  const currentEpoch = tipPosixMs / PROTOCOL.MS_PER_EPOCH;

  const lampUnit = toUnit(POLICY_IDS.lamp, ASSET_NAMES.lamp);
  const utxos    = await lucid.wallet().getUtxos();
  const lampBal  = utxos.reduce((s, u) => s + (u.assets[lampUnit] ?? 0n), 0n);
  if (lampBal < INITIAL_LAMP_DEPOSIT) throw new Error(`Need ${INITIAL_LAMP_DEPOSIT / 1_000_000n} LAMP`);

  // ── Danh tính vault (INV-VAULT-IDENTITY) ───────────────────────────────────
  const seedUtxo    = pickSeedUtxo(utxos);
  const vaultIdName = vaultIdAssetName({
    txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex,
  });
  const vaultIdUnit  = toUnit(vaultScriptHash, vaultIdName);
  const mintRedeemer = mintVaultIdRedeemer({
    txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex,
  });
  console.log(`Seed UTxO:          ${seedUtxo.txHash}#${seedUtxo.outputIndex}`);
  console.log(`Vault-ID NFT:       ${vaultScriptHash}.${vaultIdName}`);

  // MỌI hằng số dưới đây là điều kiện on-chain của `validate_mint_vault_id`
  // (ScheduleGen/onchain/validators/vault.ak:878-914), không phải sở thích.
  const initialVault = {
    owner:                 { VerificationKey: [ownerPkh] as [string] },   // chủ = khoá của ví chạy script
    lamp_balance:          INITIAL_LAMP_DEPOSIT,
    lamp_locked:           0n,               // PIN: `expect vd.lamp_locked == 0`
    loyalty_holdings:      [{
      amount: INITIAL_LAMP_DEPOSIT, acquired_epoch: currentEpoch,
      is_locked: false,                      // PIN: list.all(..., !h.is_locked)
    }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [],               // PIN: `expect vd.gen_schedules == []`
    profile:               INITIAL_PROFILE,
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    0n,               // PIN: `expect vd.last_updated_epoch == 0`
    delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state:        { recent_burn_epochs: [], consumed_credit: 0n },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    // PIN: `attribution_root: #""` — chuỗi byte RỖNG, KHÔNG phải 32 byte 0.
    attribution:           { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
  };

  const vaultDatum = Data.to(initialVault, VaultDatum);

  const tx = await lucid
    .newTx()
    .collectFrom([seedUtxo])                          // (1) one-shot seed
    .mintAssets({ [vaultIdUnit]: 1n }, mintRedeemer)  // (2) đúng 1 NFT
    .attach.MintingPolicy(vaultScript)
    .pay.ToAddressWithData(                           // (3) NFT ở output vault
      vaultScriptAddress,
      { kind: "inline", value: vaultDatum },
      { lovelace: 2_000_000n, [lampUnit]: INITIAL_LAMP_DEPOSIT, [vaultIdUnit]: 1n },
    )
    .addSignerKey(ownerPkh)                           // (4) owner ký
    .complete();

  // Chỉ số output vault đọc từ THÂN tx trước khi ký/gửi — lý do ở bước 05 cùng chỗ.
  const vaultOutIndex = outputIndexWithUnit(tx, vaultScriptAddress, vaultIdUnit);
  const bodyHash      = assertTxHash(tx.toHash(), "tx.toHash()");
  const ownerRef      = ownerRefOf(initialVault.owner);

  if (dryRun) {
    // `vault_outref` = hash THÂN tx chưa ký (tx id nếu ký và gửi nguyên thân này); không
    // có UTxO nào tồn tại nên `dry_run:true`. Không in "TX hash:" — runner bắt nhãn đó
    // (`grab_txhash`) sẽ ghi nhầm vào sổ.
    console.log(`\n✔ DRY RUN: tx dựng xong và qua validator khi chạy thử. Không ký, không gửi.`);
    console.log(`   Hash thân tx (chưa gửi): ${bodyHash}`);
    console.log(`   Sổ trạng thái: không ghi — ${book.reason}`);
    console.log(resultLine({
      vault_outref: `${bodyHash}#${vaultOutIndex}`, vault_nft: vaultIdUnit, owner: ownerRef, dry_run: true,
    }));
    return;
  }

  const signed = await tx.sign.withWallet().complete();
  const txHash = assertTxHash(await signed.submit(), "submit()");
  if (txHash !== bodyHash) {
    throw new Error(`Tx hash sau khi gửi (${txHash}) ≠ hash thân tx lúc dựng (${bodyHash}) — chỉ số output ${vaultOutIndex} không còn tin được. Soi tx trên explorer.`);
  }
  // Chờ xác nhận: bước sau tiêu chính UTxO thối của tx này. Không chờ thì node
  // vẫn thấy UTxO cũ ⟹ BadInputsUTxO. Chuỗi deploy trước đây không bước nào chờ.
  await lucid.awaitTx(txHash);

  console.log(`\n✅ ScheduleGen vault created!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  if (book.write) {
    console.log(`\n📋 Copy to .env:`);
    console.log(`   VAULT_SCHEDULE_HASH=${vaultScriptHash}    # applied for NETWORK=${NETWORK}`);
    console.log(`   VAULT_SCHEDULE_ID_UNIT=${vaultIdUnit}     # NFT danh-tính vault (policy = vault hash)`);
  } else {
    console.log(`\nSổ trạng thái: không ghi — ${book.reason}`);
  }
  // PHẢI là dòng cuối stdout.
  console.log(resultLine({
    vault_outref: `${txHash}#${vaultOutIndex}`, vault_nft: vaultIdUnit, owner: ownerRef, dry_run: false,
  }));
}

// Xem lý do ở `02_deploy_um.ts` cùng đợt vá: mã thoát 0 sau một lỗi làm mọi vòng
// lặp và mọi `set -e` mù đúng ở lượt hỏng — và vòng dựng vault cho 12 ví mô phỏng
// là đúng loại vòng lặp đó.
main().catch((e) => { console.error(e); process.exit(1); });
