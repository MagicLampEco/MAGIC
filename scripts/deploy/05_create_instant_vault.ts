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

import {
  Lucid, Blockfrost, Data, toUnit,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, PROTOCOL, SCRIPT_HASHES,
  lampToOildrop,
} from "../config.js";
import { loadBlueprint, findValidator, appliedScript } from "../applyParams.js";
import { instantVaultParams } from "../deployParams.js";
import { vaultIdAssetName, mintVaultIdRedeemer, pickSeedUtxo } from "../vaultId.js";

// VaultDatum schema (same across all 4 modules — matches Aiken).
const VaultDatumSchema = Data.Object({
  owner:                 Data.Bytes(),
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
});
type VaultDatum = Data.Static<typeof VaultDatumSchema>;
// Codec companion — xem chú thích ở InstantGen/offchain/src/types.ts.
// Giá trị thời-chạy y nguyên, chỉ gắn lại nhãn kiểu tĩnh.
const VaultDatum = VaultDatumSchema as unknown as VaultDatum;

const INITIAL_LAMP_DEPOSIT = lampToOildrop(BigInt(process.env.LAMP_DEPOSIT ?? "10000"));
const INITIAL_PROFILE      = (process.env.PROFILE ?? "Flame") as "Ember" | "Flame" | "Lantern";
// LAMP_LOCKED / LAST_UPDATED_OFFSET đã BỎ: `validate_mint_vault_id` ép datum
// khởi sinh SẠCH — `lamp_locked == 0` và `last_updated_epoch == 0`. Ai còn đặt
// env cũ sẽ bị chặn ngay dưới đây thay vì tạo ra một vault không spend được.
const LEGACY_ENV = ["LAMP_LOCKED", "LAST_UPDATED_OFFSET"] as const;

async function main() {
  console.log("=== Step 5: Create InstantGen Vault UTxO ===\n");

  if (POLICY_IDS.lamp === "FILL_AFTER_MINT") throw new Error("Run step 01 first; missing LAMP_POLICY_ID.");
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
      "   This is the intended fail-closed state until CARP ships the beacon.",
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

  // Initial vault datum — schema VaultDatum dùng chung cho mọi loại vault.
  // MỌI hằng số dưới đây là một điều kiện on-chain của `validate_mint_vault_id`
  // (InstantGen/onchain/validators/vault.ak), không phải sở thích.
  const initialVault = {
    owner:                 ownerPkh,
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
    activity_state:        { recent_burn_epochs: [], consumed_credit: 0n },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution:           {
      // PIN: `attribution_root: #""` — chuỗi byte RỖNG, KHÔNG phải 32 byte 0.
      attribution_root: "",
      last_event_epoch: 0n,
      total_events:     0n,
    },
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

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  // Chờ xác nhận: bước sau tiêu chính UTxO thối của tx này. Không chờ thì node
  // vẫn thấy UTxO cũ ⟹ BadInputsUTxO. Chuỗi deploy trước đây không bước nào chờ.
  await lucid.awaitTx(txHash);

  console.log(`\n✅ InstantGen vault created!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  console.log(`\n📋 Copy to .env:`);
  console.log(`   VAULT_INSTANT_HASH=${vaultScriptHash}   # applied for NETWORK=${NETWORK}`);
  console.log(`   VAULT_INSTANT_ID_UNIT=${vaultIdUnit}    # NFT danh-tính vault (policy = vault hash)`);
}

main().catch(console.error);
