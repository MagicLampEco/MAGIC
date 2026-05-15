// scripts/deploy/04_create_vault.ts — Create initial Vault UTxO
// Chạy: npx ts-node deploy/04_create_vault.ts
// Prerequisite: 01-03 đã xong + tất cả config đã điền

import { Lucid, Blockfrost, Data, toUnit } from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PRIVATE_KEY,
  SCRIPT_HASHES, POLICY_IDS, ASSET_NAMES, ADDRESSES, PROTOCOL,
  lampToOil,
} from "../config.js";

// VaultDatum schema (full — must match Aiken types exactly)
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
    total_burns_count:  Data.Integer(),
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

// Config: adjust as needed.
// Override profile per-run via env: VAULT_PROFILE=Ember npm run deploy:vault
const INITIAL_LAMP_DEPOSIT = lampToOil(10_000n);  // 10,000 LAMP
const VALID_PROFILES = ["Ember", "Flame", "Lantern"] as const;
const envProfile = process.env.VAULT_PROFILE ?? "Flame";
if (!VALID_PROFILES.includes(envProfile as typeof VALID_PROFILES[number])) {
  throw new Error(`Invalid VAULT_PROFILE=${envProfile}. Must be Ember | Flame | Lantern.`);
}
const INITIAL_PROFILE = envProfile as typeof VALID_PROFILES[number];

async function main() {
  console.log("=== Step 4: Create initial Vault UTxO ===\n");

  if (POLICY_IDS.lamp === "FILL_AFTER_MINT") {
    throw new Error("Run step 01 first. LAMP_POLICY_ID missing.");
  }
  if (SCRIPT_HASHES.vault_snapshot === "FILL_AFTER_AIKEN_BUILD") {
    throw new Error("Run aiken build first. VAULT_SNAPSHOT_HASH missing.");
  }

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

  const address = await lucid.wallet().address();
  const { paymentCredential } = lucid.utils.getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  const tip = await (lucid.provider as any).getBlock("latest");
  const currentEpoch = BigInt(tip.slot ?? 0) / PROTOCOL.SLOTS_PER_EPOCH;

  // Check LAMP balance
  const lampUnit  = toUnit(POLICY_IDS.lamp, ASSET_NAMES.lamp);
  const utxos     = await lucid.wallet().getUtxos();
  const lampBal   = utxos.reduce((s, u) => s + (u.assets[lampUnit] ?? 0n), 0n);
  console.log(`LAMP balance: ${lampBal / 1_000_000n} LAMP`);
  if (lampBal < INITIAL_LAMP_DEPOSIT) {
    throw new Error(`Need ${INITIAL_LAMP_DEPOSIT / 1_000_000n} LAMP. Have ${lampBal / 1_000_000n}.`);
  }

  // Initial VaultDatum (§20.2)
  const initialVault = {
    owner:                 ownerPkh,
    lamp_balance:          INITIAL_LAMP_DEPOSIT,
    lamp_locked:           0n,
    loyalty_holdings:      [{
      amount:         INITIAL_LAMP_DEPOSIT,
      acquired_epoch: currentEpoch,
      is_locked:      false,
    }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [],
    profile:               INITIAL_PROFILE,
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    currentEpoch,
    delegation_cert:       {
      current:                 [],
      pending:                 null,
      current_effective_epoch: 0n,
      last_changed_epoch:      0n,
    },
    activity_state:        { recent_burn_epochs: [], total_burns_count: 0n },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution:           {
      attribution_root:  "00".repeat(32),  // 32 zero bytes
      last_event_epoch:  0n,
      total_events:      0n,
    },
  };

  // All vault operations use the same vault script (they share the same datum type)
  // Using snapshot vault as primary (covers SnapshotGen + others)
  const vaultScriptAddress = lucid.utils.validatorToAddress({
    type:   "PlutusV3",
    script: SCRIPT_HASHES.vault_snapshot,
  });

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

  console.log(`\n✅ Vault created!`);
  console.log(`   Owner:     ${ownerPkh}`);
  console.log(`   Profile:   ${INITIAL_PROFILE}`);
  console.log(`   LAMP:      ${INITIAL_LAMP_DEPOSIT / 1_000_000n} LAMP deposited`);
  console.log(`   Epoch:     ${currentEpoch}`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://preview.cardanoscan.io/transaction/${txHash}`);
  console.log(`\n📋 Copy to .env:`);
  console.log(`   VAULT_OWNER_PKH=${ownerPkh}`);
  console.log(`\n✅ All 4 deploy steps complete!`);
  console.log(`\nNext: Start UMKeeper, then run: npx ts-node test/e2e_flow.ts`);
}

main().catch(console.error);
