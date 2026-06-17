// scripts/deploy/04_create_vault.ts — Create initial Vault UTxO
// Chạy: npx ts-node deploy/04_create_vault.ts
// Prerequisite: 01-03 đã xong + tất cả config đã điền

import {
  Lucid, Blockfrost, Data, toUnit,
  applyParamsToScript, validatorToScriptHash,
  credentialToAddress, scriptHashToCredential,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet,
  POLICY_IDS, ASSET_NAMES, PROTOCOL,
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

// Config: adjust as needed. Env-var overrides allow case-by-case testing
// without editing the script. Keys (all optional):
//   PROFILE                 — "Ember" | "Flame" (default) | "Lantern"
//   LAMP_DEPOSIT            — initial LAMP (integer, default 10_000)
//   LAMP_LOCKED             — locked LAMP at deploy (default 0)
//   LAST_UPDATED_OFFSET     — pre-seed offset from currentEpoch (default 1 = fire-immediately)
//   LOYALTY_AGE_EPOCHS      — set loyalty.acquired_epoch = currentEpoch - this (default 0)
//   PRESEED_BATCHES         — number of fresh Snapshot batches to pre-seed (default 0)
//   PRESEED_EXPIRED         — number of expired Snapshot batches (default 0, created_epoch = current - 100)
//   PRESEED_BURNS           — number of recent burn entries in activity_state (default 0)
const INITIAL_LAMP_DEPOSIT = lampToOil(BigInt(process.env.LAMP_DEPOSIT ?? "10000"));
const INITIAL_LAMP_LOCKED  = lampToOil(BigInt(process.env.LAMP_LOCKED ?? "0"));
const INITIAL_PROFILE      = (process.env.PROFILE ?? "Flame") as "Ember" | "Flame" | "Lantern";
const LAST_UPDATED_OFFSET  = BigInt(process.env.LAST_UPDATED_OFFSET ?? "1");
const LOYALTY_AGE_EPOCHS   = BigInt(process.env.LOYALTY_AGE_EPOCHS ?? "0");
const PRESEED_BATCHES      = Number(process.env.PRESEED_BATCHES ?? "0");
const PRESEED_EXPIRED      = Number(process.env.PRESEED_EXPIRED ?? "0");
const PRESEED_BURNS        = Number(process.env.PRESEED_BURNS   ?? "0");

// Profile N values must match Aiken `snapshot_decay_window` (Ember=3, Flame=6, Lantern=9).
const N_BY_PROFILE = { Ember: 3n, Flame: 6n, Lantern: 9n } as const;

/** Generate a deterministic 32-byte hex string for placeholder batch_id / burn_id. */
function placeholderHash(prefix: string, i: number): string {
  const p = (prefix + i.toString().padStart(2, "0")).padEnd(64, "0");
  return p.slice(0, 64);
}

async function main() {
  console.log("=== Step 4: Create initial Vault UTxO ===\n");

  if (POLICY_IDS.lamp === "FILL_AFTER_MINT") {
    throw new Error("Run step 01 first. LAMP_POLICY_ID missing.");
  }

  // Load unapplied vault validator and bake in network-specific slots_per_epoch
  const plutusJson = JSON.parse(
    await readFile(new URL("../../SnapshotGen/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) throw new Error("vault.vault.spend not found in SnapshotGen/onchain/plutus.json");

  // v1.0: SnapshotGen vault signature thêm lamp_policy_id (cho W-6 value check
  // trong WithdrawLamp). Order phải khớp với Aiken `validator vault(lamp_policy_id, ms_per_epoch)`.
  const appliedCbor = applyParamsToScript(unapplied.compiledCode, [POLICY_IDS.lamp, ASSET_NAMES.lamp, PROTOCOL.MS_PER_EPOCH]);
  const vaultScript = { type: "PlutusV3" as const, script: appliedCbor };
  const vaultScriptHash = validatorToScriptHash(vaultScript);
  console.log(`Network:           ${NETWORK}`);
  console.log(`ms_per_epoch:      ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`lamp_policy_id:    ${POLICY_IDS.lamp}`);
  console.log(`Vault script hash: ${vaultScriptHash}`);

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  // Current PROTOCOL epoch from Blockfrost tip block time (POSIX ms).
  // Must match validator semantics: epoch = posix_ms / ms_per_epoch.
  const tipRes = await fetch(`${BLOCKFROST_URL}/blocks/latest`, {
    headers: { project_id: BLOCKFROST_KEY },
  });
  const tip = await tipRes.json() as { slot: number; time: number };
  const tipPosixMs   = BigInt(tip.time) * 1000n;  // Blockfrost returns seconds
  const currentEpoch = tipPosixMs / PROTOCOL.MS_PER_EPOCH;

  // Check LAMP balance
  const lampUnit  = toUnit(POLICY_IDS.lamp, ASSET_NAMES.lamp);
  const utxos     = await lucid.wallet().getUtxos();
  const lampBal   = utxos.reduce((s, u) => s + (u.assets[lampUnit] ?? 0n), 0n);
  console.log(`LAMP balance: ${lampBal / 1_000_000n} LAMP`);
  if (lampBal < INITIAL_LAMP_DEPOSIT) {
    throw new Error(`Need ${INITIAL_LAMP_DEPOSIT / 1_000_000n} LAMP. Have ${lampBal / 1_000_000n}.`);
  }

  console.log(`Profile:           ${INITIAL_PROFILE}`);
  console.log(`LAMP deposit:      ${INITIAL_LAMP_DEPOSIT / 1_000_000n} LAMP`);
  console.log(`LAMP locked:       ${INITIAL_LAMP_LOCKED / 1_000_000n} LAMP`);
  console.log(`last_updated_off:  -${LAST_UPDATED_OFFSET}`);
  console.log(`loyalty_age:       -${LOYALTY_AGE_EPOCHS} epoch`);
  console.log(`preseed batches:   ${PRESEED_BATCHES} fresh + ${PRESEED_EXPIRED} expired`);
  console.log(`preseed burns:     ${PRESEED_BURNS}`);

  const N = N_BY_PROFILE[INITIAL_PROFILE];

  // Fresh fake batches (not expired, will be kept on snapshot)
  const freshBatches = Array.from({ length: PRESEED_BATCHES }, (_, i) => ({
    batch_id:            placeholderHash("aa", i),
    source:              "Snapshot" as const,
    created_epoch:       currentEpoch,
    initial_amount:      1_000_000_000n,   // 1 MAGIC placeholder
    current_amount:      1_000_000_000n,
    decay_window:        N,
    profile_at_creation: INITIAL_PROFILE,
    contract_id:         null,
    halved:              false,
  }));

  // Expired fake batches (created_epoch far in past, decay window passed)
  const expiredBatches = Array.from({ length: PRESEED_EXPIRED }, (_, i) => ({
    batch_id:            placeholderHash("ee", i),
    source:              "Snapshot" as const,
    created_epoch:       currentEpoch - 100n,
    initial_amount:      1_000_000_000n,
    current_amount:      1_000_000_000n,
    decay_window:        N,
    profile_at_creation: INITIAL_PROFILE,
    contract_id:         null,
    halved:              false,
  }));

  const allBatches = [...freshBatches, ...expiredBatches];

  // Pre-seeded burns within OAC window [current-12, current)
  const burns = Array.from({ length: PRESEED_BURNS }, (_, i) => [
    placeholderHash("bb", i),
    currentEpoch - 1n - BigInt(i),   // currentEpoch-1, -2, -3, …
  ] as [string, bigint]);

  // Initial VaultDatum (§20.2)
  const initialVault = {
    owner:                 ownerPkh,
    lamp_balance:          INITIAL_LAMP_DEPOSIT,
    lamp_locked:           INITIAL_LAMP_LOCKED,
    loyalty_holdings:      [{
      amount:         INITIAL_LAMP_DEPOSIT,
      acquired_epoch: currentEpoch - LOYALTY_AGE_EPOCHS,
      is_locked:      INITIAL_LAMP_LOCKED > 0n,
    }],
    magic_batches:         allBatches,
    next_batch_index:      BigInt(allBatches.length),
    vacuum_orders:         [],
    gen_schedules:         [],
    profile:               INITIAL_PROFILE,
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    currentEpoch - LAST_UPDATED_OFFSET,
    delegation_cert:       {
      current:                 [],
      pending:                 null,
      current_effective_epoch: 0n,
      last_changed_epoch:      0n,
    },
    activity_state:        { recent_burn_epochs: burns, total_burns_count: BigInt(burns.length) },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution:           {
      attribution_root:  "00".repeat(32),  // 32 zero bytes
      last_event_epoch:  0n,
      total_events:      0n,
    },
  };

  // Vault script address from applied SnapshotGen validator (network-specific hash)
  const vaultScriptAddress = credentialToAddress(
    NETWORK,
    scriptHashToCredential(vaultScriptHash),
  );

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
  console.log(`   VAULT_SNAPSHOT_HASH=${vaultScriptHash}   # applied for NETWORK=${NETWORK}`);
  console.log(`   VAULT_OWNER_PKH=${ownerPkh}`);
  console.log(`\n✅ All 4 deploy steps complete!`);
  console.log(`\nNext: Start UMKeeper, then run: npx ts-node test/e2e_flow.ts`);
}

main().catch(console.error);
