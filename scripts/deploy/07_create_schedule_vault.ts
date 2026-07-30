// scripts/deploy/07_create_schedule_vault.ts — Create initial ScheduleGen vault UTxO.
// Run: npx tsx deploy/07_create_schedule_vault.ts
// Prereq: 01 LAMP, 02 UM, 03 Shards.
//
// ScheduleGen vault validator has 3 params: lamp_policy_id, shard_policy_id, ms_per_epoch.
// (`treasury_addr` was removed in PHA 2 — no handler moves LAMP any more, I-ACT-7.)
//
// Env vars:
//   PROFILE              — Ember/Flame/Lantern (default Flame)
//   LAMP_DEPOSIT         — initial LAMP (default 10_000)
//   LAST_UPDATED_OFFSET  — offset from currentEpoch (default 1)
//   PRESEED_SCHEDULE_L   — preseed a GenSchedule with this schedule_length (default 0 = none).
//                          When > 0, pre-seeds a schedule with start_fire_epoch = currentEpoch (fire NOW).
//                          Useful for testing Fire without waiting 2 epochs.
//   PRESEED_SCHEDULE_LAM — lamp_per_epoch for the preseed schedule (default 1 tLAMP = 1_000_000 oil)

import {
  Lucid, Blockfrost, Data, Constr, toUnit,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import { blake2b } from "@noble/hashes/blake2b";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, ADDRESSES, PROTOCOL,
  lampToOil,
} from "../config.js";

// (Schema duplicated from 05/06 — same VaultDatum across all 4 vault modules.)
const VaultDatumSchema = Data.Object({
  owner:                 Data.Bytes(),
  lamp_balance:          Data.Integer(),
  lamp_locked:           Data.Integer(),
  loyalty_holdings:      Data.Array(Data.Object({
    amount: Data.Integer(), acquired_epoch: Data.Integer(), is_locked: Data.Boolean(),
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

const INITIAL_LAMP_DEPOSIT  = lampToOil(BigInt(process.env.LAMP_DEPOSIT ?? "10000"));
const INITIAL_PROFILE       = (process.env.PROFILE ?? "Flame") as "Ember" | "Flame" | "Lantern";
const LAST_UPDATED_OFFSET   = BigInt(process.env.LAST_UPDATED_OFFSET ?? "1");
const PRESEED_SCHEDULE_L    = BigInt(process.env.PRESEED_SCHEDULE_L   ?? "0");      // count of fires; 0 = no preseed
const PRESEED_SCHEDULE_LAM  = lampToOil(BigInt(process.env.PRESEED_SCHEDULE_LAM ?? "1"));

// Constants matching Aiken (R_snap × Q = 2_000_000_000 for Flame baseline rate).
const SNAPSHOT_BASE_RATE_Q = 2_000_000_000n;

async function main() {
  console.log("=== Step 7: Create ScheduleGen Vault UTxO ===\n");

  if (POLICY_IDS.lamp === "FILL_AFTER_MINT") throw new Error("Step 01 missing");
  if (POLICY_IDS.shard_nft === "FILL_AFTER_STEP_03") throw new Error("Step 03 missing");
  // NOTE: TREASURY_ADDRESS is NO LONGER a parameter of this validator.
  // PHA 2 / I-ACT-7 — a fire RELEASES the lock; it moves no LAMP.

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  // Load ScheduleGen vault validator (PHA 2 — 3 params, treasury_addr REMOVED:
  //   lamp_policy_id, shard_policy_id, ms_per_epoch).
  const plutusJson = JSON.parse(
    await readFile(new URL("../../ScheduleGen/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) {
    console.error("Validators:", plutusJson.validators.map((v: any) => v.title));
    throw new Error("vault.vault.spend not found");
  }

  const appliedCbor = applyParamsToScript(unapplied.compiledCode, [
    POLICY_IDS.lamp,
    POLICY_IDS.shard_nft,
    PROTOCOL.MS_PER_EPOCH,
  ]);
  const vaultScript = { type: "PlutusV3" as const, script: appliedCbor };
  const vaultScriptHash = validatorToScriptHash(vaultScript);
  const vaultScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(vaultScriptHash));

  console.log(`Network:            ${NETWORK}`);
  console.log(`Vault script hash:  ${vaultScriptHash}`);
  console.log(`Vault address:      ${vaultScriptAddress}`);
  console.log(`Profile:            ${INITIAL_PROFILE}`);
  console.log(`LAMP deposit:       ${INITIAL_LAMP_DEPOSIT / 1_000_000n} tLAMP`);
  console.log(`Preseed schedule:   L=${PRESEED_SCHEDULE_L}, λ=${PRESEED_SCHEDULE_LAM / 1_000_000n} tLAMP`);

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

  // Pre-seed schedule with start_fire_epoch = currentEpoch so Fire fires NOW.
  // Schedule_id is opaque to validator (only verified at Commit time, looked up by ID at Fire).
  function placeholderHash(suffix: string, n: number): string {
    return (suffix + n.toString(16).padStart(2, "0")).padEnd(64, "f");
  }
  const gen_schedules = PRESEED_SCHEDULE_L > 0n ? [{
    schedule_id:              placeholderHash("aa", 1),
    commit_epoch:             currentEpoch - 2n,                   // commit + delay = current
    start_fire_epoch:         currentEpoch,
    end_fire_epoch:           currentEpoch + PRESEED_SCHEDULE_L - 1n,
    schedule_length:          PRESEED_SCHEDULE_L,
    lamp_per_epoch:           PRESEED_SCHEDULE_LAM,
    rate_locked_q:            SNAPSHOT_BASE_RATE_Q,                 // 2.0× (frozen at commit)
    baseline_at_commit_q:     SNAPSHOT_BASE_RATE_Q,
    multiplier_at_commit_q:   1_000_000_000n,                       // 1.0×
    fired_count:              0n,
    auto_burn_target:         null,
  }] : [];

  const totalLocked = gen_schedules.reduce(
    (s, g) => s + g.schedule_length * g.lamp_per_epoch, 0n,
  );

  const initialVault = {
    owner:                 ownerPkh,
    lamp_balance:          INITIAL_LAMP_DEPOSIT,
    lamp_locked:           totalLocked,
    loyalty_holdings:      [{
      amount: INITIAL_LAMP_DEPOSIT, acquired_epoch: currentEpoch,
      is_locked: totalLocked > 0n,
    }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules,
    profile:               INITIAL_PROFILE,
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    currentEpoch - LAST_UPDATED_OFFSET,
    delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state:        { recent_burn_epochs: [], consumed_credit: 0n },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution:           { attribution_root: "00".repeat(32), last_event_epoch: 0n, total_events: 0n },
  };

  const vaultDatum = Data.to(initialVault, VaultDatumSchema);

  const tx = await lucid
    .newTx()
    .pay.ToAddressWithData(
      vaultScriptAddress,
      { kind: "inline", value: vaultDatum },
      { lovelace: 2_000_000n, [lampUnit]: INITIAL_LAMP_DEPOSIT },
    )
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  console.log(`\n✅ ScheduleGen vault created!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://preview.cardanoscan.io/transaction/${txHash}`);
  if (gen_schedules.length > 0) {
    console.log(`   Preseed schedule_id: ${gen_schedules[0].schedule_id}`);
    console.log(`   start_fire_epoch:    ${gen_schedules[0].start_fire_epoch} (current=${currentEpoch})`);
  }
  console.log(`\n📋 Copy to .env:`);
  console.log(`   VAULT_SCHEDULE_HASH=${vaultScriptHash}    # applied for NETWORK=${NETWORK}`);
}

main().catch(console.error);
