// scripts/deploy/05_create_instant_vault.ts — Create initial InstantGen vault UTxO.
// Run: npx tsx deploy/05_create_instant_vault.ts
// Prereq: 01 (LAMP), 02 (UM datum + UM NFT) done; .env has LAMP_POLICY_ID, UM_NFT_POLICY_ID.
// Optional (§6.3): BACKING_NFT_POLICY_ID + BACKING_SCRIPT_HASH — omit them and the
// vault deploys with an unsatisfiable beacon pin, i.e. InstantGen stays SHUT.
//
// InstantGen validator is parameterized with 5 args:
//   lamp_policy_id: PolicyId  — required for asset checks
//   (treasury_addr REMOVED in PHA 2 — InstantGen moves no LAMP, I-ACT-7)
//   um_nft_policy:  PolicyId  — identifies the canonical UM UTxO via NFT
//   um_script_hash: ByteArray — pins the UM ref input to the UM script address
//                               (MAINNET-BLOCK fix, defense-in-depth layer b)
//   ms_per_epoch:   Int       — POSIX-ms epoch math (network-specific)

import {
  Lucid, Blockfrost, Data, Constr, toUnit,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, ADDRESSES, PROTOCOL, SCRIPT_HASHES,
  lampToOildrop,
} from "../config.js";

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

const INITIAL_LAMP_DEPOSIT = lampToOildrop(BigInt(process.env.LAMP_DEPOSIT ?? "10000"));
const INITIAL_LAMP_LOCKED  = lampToOildrop(BigInt(process.env.LAMP_LOCKED ?? "0"));
const INITIAL_PROFILE      = (process.env.PROFILE ?? "Flame") as "Ember" | "Flame" | "Lantern";
const LAST_UPDATED_OFFSET  = BigInt(process.env.LAST_UPDATED_OFFSET ?? "1");

async function main() {
  console.log("=== Step 5: Create InstantGen Vault UTxO ===\n");

  if (POLICY_IDS.lamp === "FILL_AFTER_MINT") throw new Error("Run step 01 first; missing LAMP_POLICY_ID.");
  if (POLICY_IDS.um_nft === "FILL_AFTER_DEPLOY_UM") throw new Error("Run step 02 first; missing UM_NFT_POLICY_ID.");
  if (SCRIPT_HASHES.um_datum === "FILL_AFTER_AIKEN_BUILD") throw new Error("Run step 02 first; missing UM_DATUM_HASH (= um_script_hash).");
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

  // Load InstantGen validator with 4 params.
  const plutusJson = JSON.parse(
    await readFile(new URL("../../InstantGen/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) {
    console.error("Available validators:", plutusJson.validators.map((v: any) => v.title));
    throw new Error("vault.vault.spend not found in InstantGen/onchain/plutus.json");
  }

  // Apply params in order (PHA 2 — 6 params, treasury_addr REMOVED):
  //   lamp_policy_id, um_nft_policy, um_script_hash,
  //   backing_nft_policy, backing_script_hash, ms_per_epoch
  const appliedCbor = applyParamsToScript(unapplied.compiledCode, [
    POLICY_IDS.lamp,
    POLICY_IDS.um_nft,
    SCRIPT_HASHES.um_datum,        // pins the UM ref input (layer b)
    POLICY_IDS.backing,            // pins the BackingBeacon NFT (§6.3)
    SCRIPT_HASHES.backing_beacon,  // pins the BackingBeacon address (§6.3)
    PROTOCOL.MS_PER_EPOCH,
  ]);
  const vaultScript     = { type: "PlutusV3" as const, script: appliedCbor };
  const vaultScriptHash = validatorToScriptHash(vaultScript);
  const vaultScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(vaultScriptHash));

  console.log(`Network:            ${NETWORK}`);
  console.log(`ms_per_epoch:       ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`LAMP policy:        ${POLICY_IDS.lamp}`);
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

  console.log(`LAMP locked:        ${INITIAL_LAMP_LOCKED / 1_000_000n} LAMP`);

  // Initial vault datum — schema VaultDatum dùng chung cho mọi loại vault.
  const initialVault = {
    owner:                 ownerPkh,
    lamp_balance:          INITIAL_LAMP_DEPOSIT,
    lamp_locked:           INITIAL_LAMP_LOCKED,
    loyalty_holdings:      [{
      amount:         INITIAL_LAMP_DEPOSIT,
      acquired_epoch: currentEpoch,
      is_locked:      INITIAL_LAMP_LOCKED > 0n,
    }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [],
    profile:               INITIAL_PROFILE,
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    currentEpoch - LAST_UPDATED_OFFSET,
    delegation_cert:       {
      current: [], pending: null,
      current_effective_epoch: 0n, last_changed_epoch: 0n,
    },
    activity_state:        { recent_burn_epochs: [], consumed_credit: 0n },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution:           {
      attribution_root: "00".repeat(32),
      last_event_epoch: 0n,
      total_events:     0n,
    },
  };

  const vaultDatum = Data.to(initialVault, VaultDatumSchema);

  const tx = await lucid
    .newTx()
    .pay.ToAddressWithData(
      vaultScriptAddress,
      { kind: "inline", value: vaultDatum },
      {
        lovelace:  2_000_000n,
        [lampUnit]: INITIAL_LAMP_DEPOSIT,
      },
    )
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log(`\n✅ InstantGen vault created!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://preview.cardanoscan.io/transaction/${txHash}`);
  console.log(`\n📋 Copy to .env:`);
  console.log(`   VAULT_INSTANT_HASH=${vaultScriptHash}   # applied for NETWORK=${NETWORK}`);
}

main().catch(console.error);
