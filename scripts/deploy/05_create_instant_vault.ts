// scripts/deploy/05_create_instant_vault.ts — Create initial InstantGen vault UTxO.
// Run: npx tsx deploy/05_create_instant_vault.ts
// Prereq: 01 (LAMP), 02 (UM datum + UM NFT) done; .env has LAMP_POLICY_ID, UM_NFT_POLICY_ID.
// Optional (§6.3): BACKING_NFT_POLICY_ID + BACKING_SCRIPT_HASH — omit them and the
// vault deploys with an unsatisfiable beacon pin, i.e. InstantGen stays SHUT.
//
// Tham số apply-param KHÔNG còn khai tay ở đây: danh sách tên + thứ tự đọc
// thẳng từ InstantGen/onchain/plutus.json qua scripts/applyParams.ts, giá trị
// lấy từ scripts/deployParams.ts. Đổi chữ ký `validator vault(...)` ⇒ script
// này gãy ồn ào, không còn sinh hash sai im lặng.
//
// Tx này MINT luôn NFT danh-tính vault (INV-VAULT-IDENTITY): validator đòi NFT
// ở MỌI đường spend (`validate_vault_value` → `single_nft_name`), nên một vault
// tạo ra mà không có NFT là vault KHÔNG AI SPEND ĐƯỢC. Không validator nào chạy
// lúc TẠO UTxO, nên thiếu mint thì tx vẫn vào chuỗi và log vẫn in "đã tạo".
//
// Env (ngoài bộ khoá deploy đọc qua config.ts):
//   LAMP_DEPOSIT      — LAMP nạp vào vault, số nguyên DƯƠNG (đơn vị LAMP, mặc định 10000).
//                       Sai hình dạng (0, âm, rỗng, "1e3") ⟹ ném trước khi dựng gì.
//   PROFILE           — Ember | Flame | Lantern (mặc định Flame).
//   DRY_RUN=1         — dựng + chạy thử validator, KHÔNG ký, KHÔNG gửi, KHÔNG công bố
//                       ref-script, KHÔNG in dòng cho sổ. Vẫn in RESULT (dry_run:true).
//   WRITE_STATE_BOOK  — "1"/"0": có in khối dòng cho sổ + công bố ref-script hay không.
//                       Vắng thì quyết theo ví ký — xem `runResult.ts ▸ decideStateBook`.
//
// Chủ vault LUÔN là khoá của ví ký (PRIVATE_KEY, hoặc WALLET_SEED khi không có
// PRIVATE_KEY — `config.ts ▸ selectWallet`). Không có biến đặt chủ khác: cổng đúc đòi
// chữ ký của chủ, nên một chủ khác ví ký là giao dịch không ký nổi.
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
  POLICY_IDS, ASSET_NAMES, PROTOCOL, SCRIPT_HASHES,
  lampToOildrop,
} from "../config.js";
import {
  parsePositiveInteger, parseFlag, decideStateBook, resultLine, assertTxHash,
} from "../runResult.js";
import { outputIndexWithUnit } from "../txOutputIndex.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { instantVaultParams } from "../deployParams.js";
import { vaultIdAssetName, mintVaultIdRedeemer, pickSeedUtxo } from "../vaultId.js";
import { parkAddressFor, publishRefScript } from "../refScripts.js";
import { minAdaForRefScriptWithMargin } from "../minAda.js";
import { OwnerCredentialSchema } from "../../InstantGen/offchain/src/types.js";

// ── CHÉP CÓ NHÃN (Forall §Một nguồn, mức 3) ────────────────────────────────
// Nguồn: `InstantGen/onchain/lib/magiclamp/protocol/constants.ak` ▸
// `wakeme_seed_credit`, và bản gương TypeScript ở
// `InstantGen/offchain/src/constants.ts` ▸ `WAKEME_SEED_CREDIT`. Chép 2026-09-16.
//
// Vì sao chép chứ không trỏ: `scripts/` là gói npm riêng và KHÔNG phụ thuộc
// `InstantGen/offchain` (xem `scripts/package.json` ▸ dependencies) — không có
// module nào để trỏ tới.
//
// Bản sao này KHÔNG chết im lặng, và đó là lý do chép được: cổng genesis là một
// dấu BẰNG trên chuỗi (`InstantGen/onchain/validators/vault.ak` ▸ nhánh mint).
// Lệch một nanogic thì giao dịch bị validator từ chối ngay, trước khi có gì lên
// chuỗi. Người báo cho bản sao này biết nguồn đã đổi chính là validator.
const WAKEME_SEED_CREDIT = 1_001_000_000_000n;   // 1001 MAGIC in nanogic

// VaultDatum schema — bản của InstantGen, 18 trường, gương của
// `InstantGen/onchain/lib/magiclamp/protocol/types.ak` ▸ `VaultDatum`.
//
// 🔴 KHÔNG còn "dùng chung cho mọi loại vault" (bản trước của dòng này khai thế).
// Két ScheduleGen/PrepaidGen giữ 17 trường; chỉ két Instant có `instant_unlock_ms`.
// `07_create_schedule_vault.ts` và `10_deploy_prepaid.ts` vì thế KHÔNG chép theo.
const VaultDatumSchema = Data.Object({
  owner:                 OwnerCredentialSchema,   // Credential — nguồn: InstantGen/offchain/src/types.ts
  lamp_balance:          Data.Integer(),
  lamp_locked:           Data.Integer(),
  loyalty_holdings:      Data.Array(Data.Object({
    amount:         Data.Integer(),
    acquired_epoch: Data.Integer(),
    is_locked:      Data.Boolean(),
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
    order_id:    Data.Bytes(),
    commit_epoch:Data.Integer(),
    fire_epoch:  Data.Integer(),
    lamp_amount: Data.Integer(),
  })),
  gen_schedules:         Data.Array(Data.Object({
    schedule_id:            Data.Bytes(),
    commit_epoch:           Data.Integer(),
    start_fire_epoch:       Data.Integer(),
    end_fire_epoch:         Data.Integer(),
    schedule_length:        Data.Integer(),
    lamp_per_epoch:         Data.Integer(),
    rate_locked_q:          Data.Integer(),
    baseline_at_commit_q:   Data.Integer(),
    multiplier_at_commit_q: Data.Integer(),
    fired_count:            Data.Integer(),
    auto_burn_target:       Data.Nullable(Data.Object({
      delegate:          Data.Bytes(),
      target_app_id:     Data.Nullable(Data.Bytes()),
      max_burn_per_fire: Data.Integer(),
    })),
  })),
  profile:               Data.Enum([Data.Literal("Ember"), Data.Literal("Flame"), Data.Literal("Lantern")]),
  profile_changed_epoch: Data.Integer(),
  pending_profile:       Data.Nullable(Data.Object({
    new_profile:     Data.Enum([Data.Literal("Ember"), Data.Literal("Flame"), Data.Literal("Lantern")]),
    effective_epoch: Data.Integer(),
  })),
  last_updated_epoch:    Data.Integer(),
  delegation_cert:       Data.Object({
    current:                 Data.Array(Data.Object({ app_id: Data.Bytes(), weight_bps: Data.Integer() })),
    pending:                 Data.Nullable(Data.Object({
      allocations:     Data.Array(Data.Object({ app_id: Data.Bytes(), weight_bps: Data.Integer() })),
      effective_epoch: Data.Integer(),
    })),
    current_effective_epoch: Data.Integer(),
    last_changed_epoch:      Data.Integer(),
  }),
  activity_state:        Data.Object({
    recent_burn_epochs: Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
    consumed_credit:    Data.Integer(),   // was total_burns_count (same slot)
  }),
  streak_state:          Data.Object({
    current_streak:    Data.Integer(),
    last_active_epoch: Data.Integer(),
  }),
  personal_delegate:     Data.Nullable(Data.Bytes()),
  attribution:           Data.Object({
    attribution_root:  Data.Bytes(),
    last_event_epoch:  Data.Integer(),
    total_events:      Data.Integer(),
  }),
  instant_unlock_ms:     Data.Integer(),
});
type VaultDatum = Data.Static<typeof VaultDatumSchema>;
// Codec companion — xem chú thích ở InstantGen/offchain/src/types.ts.
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
// LAMP_LOCKED / LAST_UPDATED_OFFSET đã BỎ: `validate_mint_vault_id` ép datum
// khởi sinh SẠCH — `lamp_locked == 0` và `last_updated_epoch == 0`. Ai còn đặt
// env cũ sẽ bị chặn ngay dưới đây thay vì tạo ra một vault không spend được.
const LEGACY_ENV = ["LAMP_LOCKED", "LAST_UPDATED_OFFSET"] as const;

async function main() {
  // Đọc + kiểm env TRƯỚC mọi lệnh gọi mạng: sai hình dạng thì ném, không dựng gì.
  const INITIAL_LAMP_DEPOSIT = lampToOildrop(parsePositiveInteger(process.env.LAMP_DEPOSIT, "LAMP_DEPOSIT", 10_000n));
  const INITIAL_PROFILE      = parseProfile(process.env.PROFILE);
  const dryRun = parseFlag(process.env.DRY_RUN, "DRY_RUN");
  const book   = decideStateBook({
    dryRun, flag: process.env.WRITE_STATE_BOOK, signsWithPrivateKey: PRIVATE_KEY !== "",
  });

  console.log(`=== Step 5: Create InstantGen Vault UTxO${dryRun ? " · DRY RUN" : ""} ===\n`);

  // LAMP: cổng nằm ở `config.ts` ▸ `requireLampPolicyId`, tự ném khi thiếu.
  if (POLICY_IDS.um_nft === "FILL_AFTER_DEPLOY_UM") throw new Error("Run step 02 first; missing UM_NFT_POLICY_ID.");
  if (SCRIPT_HASHES.um_datum === "FILL_AFTER_AIKEN_BUILD") throw new Error("Run step 02 first; missing UM_DATUM_HASH (= um_script_hash).");
  for (const k of LEGACY_ENV) {
    if (process.env[k] !== undefined) {
      throw new Error(
        `${k} không còn dùng được. validate_mint_vault_id ép datum khởi sinh sạch ` +
        `(lamp_locked == 0, last_updated_epoch == 0). Bỏ biến này khỏi môi trường.`,
      );
    }
  }
  // NOTE: TREASURY_ADDRESS is NO LONGER a parameter of this validator.
  // PHA 2 / I-ACT-7 — InstantGen never moves LAMP, so there is no Treasury leg.
  if (POLICY_IDS.backing === "00".repeat(28) || SCRIPT_HASHES.backing_beacon === "00".repeat(28)) {
    console.warn(
      "⚠  BackingBeacon not configured (BACKING_NFT_POLICY_ID / BACKING_SCRIPT_HASH).\n" +
      "   The vault will still deploy, but InstantGen is SHUT: no reference input can\n" +
      "   satisfy the beacon lookup, so cap_surplus can never be evaluated.\n" +
      "   This is the intended fail-closed state until this repo's own GreenBack-tier\n" +
      "   keeper writes the beacon (BOUNDARIES.md; signing key `greenback_beacon_writer`,\n" +
      "   SPEC v2.0 §6.3) — it is NOT something the CARP side has to ship.",
    );
  }

  // Lucid + wallet
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  // Apply params THEO TÊN — thứ tự do blueprint quyết định, không do file này.
  const blueprint = await loadBlueprint("InstantGen");
  const unapplied = findValidator(blueprint, "vault.vault.spend");
  const { script: vaultScript, hash: vaultScriptHash } = appliedScript(
    unapplied,
    instantVaultParams({
      lampPolicyId:      POLICY_IDS.lamp,
      lampAssetName:     ASSET_NAMES.lamp,        // PARAM theo mạng, không hardcode
      umNftPolicy:       POLICY_IDS.um_nft,
      umScriptHash:      SCRIPT_HASHES.um_datum,      // pins the UM ref input (layer b)
      backingNftPolicy:  POLICY_IDS.backing,          // pins the BackingBeacon NFT (§6.3)
      backingScriptHash: SCRIPT_HASHES.backing_beacon, // pins the BackingBeacon address (§6.3)
      msPerEpoch:        PROTOCOL.MS_PER_EPOCH,
    }),
  );
  const vaultScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(vaultScriptHash));

  console.log(`Network:            ${NETWORK}`);
  console.log(`ms_per_epoch:       ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`LAMP policy:        ${POLICY_IDS.lamp}`);
  console.log(`LAMP asset name:    ${ASSET_NAMES.lamp}`);
  console.log(`UM NFT policy:      ${POLICY_IDS.um_nft}`);
  console.log(`UM script hash:     ${SCRIPT_HASHES.um_datum}`);
  console.log(`Backing NFT policy: ${POLICY_IDS.backing}`);
  console.log(`Backing script:     ${SCRIPT_HASHES.backing_beacon}`);
  console.log(`Vault script hash:  ${vaultScriptHash}`);
  console.log(`Vault address:      ${vaultScriptAddress}`);
  console.log(`Profile:            ${INITIAL_PROFILE}`);
  console.log(`LAMP deposit:       ${INITIAL_LAMP_DEPOSIT / 1_000_000n} LAMP`);

  // Tip POSIX ms for current epoch.
  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await tipRes.json() as { slot: number; time: number };
  const tipPosixMs   = BigInt(tip.time) * 1000n;
  const currentEpoch = tipPosixMs / PROTOCOL.MS_PER_EPOCH;

  // Check wallet LAMP balance.
  const lampUnit = toUnit(POLICY_IDS.lamp, ASSET_NAMES.lamp);
  const utxos    = await lucid.wallet().getUtxos();
  const lampBal  = utxos.reduce((s, u) => s + (u.assets[lampUnit] ?? 0n), 0n);
  console.log(`Wallet LAMP:        ${lampBal / 1_000_000n} LAMP`);
  if (lampBal < INITIAL_LAMP_DEPOSIT) throw new Error(`Need ${INITIAL_LAMP_DEPOSIT / 1_000_000n} LAMP`);

  // ── Danh tính vault (INV-VAULT-IDENTITY) ───────────────────────────────────
  // seed phải là input THẬT của chính tx này (`expect list.any(tx.inputs, ...)`
  // trong validate_mint_vault_id) ⇒ ép vào bằng .collectFrom, không để coin
  // selection quyết định. policy id = chính vault script hash đã apply params.
  const seedUtxo    = pickSeedUtxo(utxos);
  const vaultIdName = vaultIdAssetName({
    txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex,
  });
  const vaultIdUnit = toUnit(vaultScriptHash, vaultIdName);
  const mintRedeemer = mintVaultIdRedeemer({
    txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex,
  });
  console.log(`Seed UTxO:          ${seedUtxo.txHash}#${seedUtxo.outputIndex}`);
  console.log(`Vault-ID NFT:       ${vaultScriptHash}.${vaultIdName}`);

  // Initial vault datum — hình dạng 18 trường của InstantGen (xem lược đồ ở trên).
  // MỌI hằng số dưới đây là một điều kiện on-chain của `validate_mint_vault_id`
  // (InstantGen/onchain/validators/vault.ak), không phải sở thích.
  const initialVault = {
    owner:                 { VerificationKey: [ownerPkh] as [string] },   // chủ = khoá của ví chạy script
    lamp_balance:          INITIAL_LAMP_DEPOSIT,
    lamp_locked:           0n,                 // PIN: `expect vd.lamp_locked == 0`
    loyalty_holdings:      [{
      amount:         INITIAL_LAMP_DEPOSIT,
      acquired_epoch: currentEpoch,
      is_locked:      false,                   // PIN: list.all(..., !h.is_locked)
    }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [],
    profile:               INITIAL_PROFILE,
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    0n,                 // PIN: `expect vd.last_updated_epoch == 0`
    delegation_cert:       {
      current: [], pending: null,
      current_effective_epoch: 0n, last_changed_epoch: 0n,
    },
    // PIN: `expect vd.activity_state == ActivityState { [], wakeme_seed_credit }`.
    // KHÔNG phải 0 — đó là giá trị cổng cũ ép, và nó khoá vault lại ở Nợ #19.
    // Cổng là dấu BẰNG nên mọi giá trị khác, kể cả 0, bị từ chối trên chuỗi.
    activity_state:        { recent_burn_epochs: [], consumed_credit: WAKEME_SEED_CREDIT },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution:           {
      // PIN: `attribution_root: #""` — chuỗi byte RỖNG, KHÔNG phải 32 byte 0.
      attribution_root: "",
      last_event_epoch: 0n,
      total_events:     0n,
    },
    // PIN: `expect vd.instant_unlock_ms == 0` — két mới chưa từng sinh nên không
    // khoá gì. Một giá trị khác 0 ở genesis bị cổng đúc từ chối (dấu BẰNG).
    instant_unlock_ms:     0n,
  };

  const vaultDatum = Data.to(initialVault, VaultDatum);

  // 4 mảnh BẮT BUỘC khớp nhau (validate_mint_vault_id):
  //   (1) seed UTxO trong inputs           (2) mint đúng 1 NFT policy = vault hash
  //   (3) NFT nằm ở output tại vault addr  (4) owner ký
  const tx = await lucid
    .newTx()
    .collectFrom([seedUtxo])                            // (1)
    .mintAssets({ [vaultIdUnit]: 1n }, mintRedeemer)    // (2)
    .attach.MintingPolicy(vaultScript)
    .pay.ToAddressWithData(                             // (3)
      vaultScriptAddress,
      { kind: "inline", value: vaultDatum },
      {
        lovelace:      2_000_000n,
        [lampUnit]:    INITIAL_LAMP_DEPOSIT,
        [vaultIdUnit]: 1n,
      },
    )
    .addSignerKey(ownerPkh)                             // (4)
    .complete();

  // Chỉ số output vault đọc từ THÂN tx, TRƯỚC khi ký/gửi: chữ ký không đổi thân nên chỉ số
  // này là chỉ số thật sau khi gửi. Đặt trước `submit` để một lần đọc hỏng ném khi CHƯA
  // có gì lên chuỗi, không phải sau khi vault đã tạo mà không in được RESULT.
  const vaultOutIndex = outputIndexWithUnit(tx, vaultScriptAddress, vaultIdUnit);
  const bodyHash      = assertTxHash(tx.toHash(), "tx.toHash()");
  // Owner in ra được SUY TỪ datum vừa mã hoá, không gõ lại: RESULT nói đúng thứ nằm trên chuỗi.
  const ownerRef      = ownerRefOf(initialVault.owner);

  if (dryRun) {
    // `complete()` đã chạy thử validator cục bộ. `vault_outref` dùng hash THÂN tx chưa ký
    // (`TxSignBuilder.toHash()` = `hash_transaction(body)`), chính là tx id nếu ký và gửi
    // nguyên thân này — nhưng không có UTxO nào tồn tại, nên `dry_run:true` là bắt buộc để
    // đọc đúng. Không in "TX hash:" để runner nào bắt nhãn đó không ghi nhầm vào sổ.
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

  console.log(`\n✅ InstantGen vault created!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);

  const result = resultLine({
    vault_outref: `${txHash}#${vaultOutIndex}`, vault_nft: vaultIdUnit, owner: ownerRef, dry_run: false,
  });

  if (!book.write) {
    // Ref-script vault là CỦA LOẠI vault, không của từng vault: hash vault chỉ phụ thuộc
    // apply-param (BOUNDARIES.md ▸ "Apply-param được phép thay đổi theo LOẠI script"), nên
    // bản ví deploy đã công bố dùng được cho mọi vault Instant. Mỗi ví riêng tự công bố
    // thêm một bản ở bãi đỗ của nó là chôn ~49 ADA cho một thứ đã có.
    console.log(`\nSổ trạng thái: không ghi, không công bố ref-script — ${book.reason}`);
    console.log(result);
    return;
  }

  // ── Ref-script CIP-33 của chính vault này (tx riêng, idempotent) ─────────────
  //   Bước nào tính ra hash thì bước đó công bố ref-script — cùng lối với bước 09
  //   (ref-script `consume`) và bước 06 (vault+shard ScheduleGen). Đặt ở đây, chuỗi
  //   e2e consume KHÔNG phải chạm gì tới ScheduleGen mới có đủ ref.
  //   Vì sao cần: tx consume tiêu HAI UTxO script (Engage + vault). Đính kèm cả hai
  //   validator cho 17.310 byte, vượt trần 16.384 ⟹ phải readFrom, không attach.
  const parkAddr = parkAddressFor(NETWORK, address);
  console.log(`\n⏳ Công bố ref-script vault tại bãi đỗ ${parkAddr} …`);
  // min-ADA TÍNH từ script đã apply-param — xem `scripts/minAda.ts`. Con số cũ
  // 35 ADA thấp hơn min-ADA thật (đo 2026-09-21: ≈49,2 ADA cho bản chưa
  // apply-param, tức cận dưới), nên bước này không gửi nổi giao dịch.
  const refLovelace = minAdaForRefScriptWithMargin(vaultScript.script);
  console.log(`   min-ADA ref-script: ${refLovelace / 1_000_000n} ADA (script ${vaultScript.script.length / 2} byte)`);
  const vaultRef = await publishRefScript({
    lucid, parkAddr, label: "vault instant ref",
    script: vaultScript, hash: vaultScriptHash, lovelace: refLovelace,
  });

  console.log(`\n📋 Copy to .env:`);
  console.log(`   VAULT_INSTANT_HASH=${vaultScriptHash}   # applied for NETWORK=${NETWORK}`);
  console.log(`   VAULT_INSTANT_ID_UNIT=${vaultIdUnit}    # NFT danh-tính vault (policy = vault hash)`);
  console.log(`   REF_VAULT_INSTANT_UTXO=${vaultRef}      # chân vault của tx consume`);
  console.log(result);   // PHẢI là dòng cuối stdout
}

// Xem lý do ở `02_deploy_um.ts` cùng đợt vá. Riêng tệp này đã có một bản vá VÒNG
// TRÁNH sống trong `scripts/keeper/keeper.ts` (*"Bước 05 nuốt lỗi và thoát 0, nên
// phải đọc tx hash trong output, không tin mã thoát"*) — tức kho đã BIẾT lỗi này
// và đi vòng qua nó ở một tệp khác thay vì vá tại gốc. Nay vá tại gốc; chỗ vòng
// tránh kia vô hại nhưng không còn cần thiết.
main().catch((e) => { console.error(e); process.exit(1); });
