// scripts/deploy/06_create_vacuum_vault.ts — Create initial VacuumGen vault UTxO.
// Run: npx tsx deploy/06_create_vacuum_vault.ts
// Prereq: 01 LAMP, 02 UM datum + UM NFT, .env: LAMP_POLICY_ID, UM_NFT_POLICY_ID, TREASURY_ADDRESS.
//
// VacuumGen validator parameterized with 5 args (same as InstantGen):
//   lamp_policy_id, treasury_addr, um_nft_policy, um_script_hash, ms_per_epoch
//   um_script_hash pins the UM ref input to the UM script address
//   (MAINNET-BLOCK fix, defense-in-depth layer b).
//
// Env vars:
//   PROFILE                  — Ember/Flame/Lantern (default Flame)
//   LAMP_DEPOSIT             — initial LAMP (default 10_000)
//   LAMP_LOCKED              — pre-locked LAMP (default 0)
//   LAST_UPDATED_OFFSET      — offset from currentEpoch (default 1)
//   PRESEED_ORDER_LAMBDA     — pre-seed VacuumOrder with this λ (in tLAMP). 0 = no order. Default 0.
//   PRESEED_ORDER_FIRE_AGE   — order.fire_epoch = currentEpoch - this. Default 0 (fire NOW).
//                              Used to test VacuumFire without waiting 2 epochs.

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
  POLICY_IDS, ASSET_NAMES, ADDRESSES, PROTOCOL, SCRIPT_HASHES,
  lampToOildrop,
} from "../config.js";

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

const INITIAL_LAMP_DEPOSIT = lampToOildrop(BigInt(process.env.LAMP_DEPOSIT ?? "10000"));
const INITIAL_LAMP_LOCKED  = lampToOildrop(BigInt(process.env.LAMP_LOCKED ?? "0"));
const INITIAL_PROFILE      = (process.env.PROFILE ?? "Flame") as "Ember" | "Flame" | "Lantern";
const LAST_UPDATED_OFFSET  = BigInt(process.env.LAST_UPDATED_OFFSET ?? "1");
const PRESEED_ORDER_LAMBDA = lampToOildrop(BigInt(process.env.PRESEED_ORDER_LAMBDA ?? "0"));
const PRESEED_ORDER_FIRE_AGE = BigInt(process.env.PRESEED_ORDER_FIRE_AGE ?? "0");

function bigIntToBytesBE(n: bigint, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let x = n;
  for (let i = len - 1; i >= 0; i--) { buf[i] = Number(x & 0xffn); x >>= 8n; }
  return buf;
}

function computeOrderId(txHash: string, outputIndex: bigint, commitEpoch: bigint, lambda: bigint): string {
  const txHashBytes = Buffer.from(txHash, "hex");
  const outIdxBytes = bigIntToBytesBE(outputIndex, 8);
  const commitBytes = bigIntToBytesBE(commitEpoch, 8);
  const lambdaBytes = bigIntToBytesBE(lambda, 8);
  const preimage = Buffer.concat([txHashBytes, outIdxBytes, commitBytes, lambdaBytes]);
  return Buffer.from(blake2b(preimage, { dkLen: 32 })).toString("hex");
}

async function main() {
  console.log("=== Step 6: Create VacuumGen Vault UTxO ===\n");

  if (POLICY_IDS.lamp === "FILL_AFTER_MINT") throw new Error("Run step 01 first.");
  if (POLICY_IDS.um_nft === "FILL_AFTER_DEPLOY_UM") throw new Error("Run step 02 first.");
  if (SCRIPT_HASHES.um_datum === "FILL_AFTER_AIKEN_BUILD") throw new Error("Run step 02 first; missing UM_DATUM_HASH (= um_script_hash).");
  if (ADDRESSES.treasury === "FILL_AFTER_DEPLOY") throw new Error("Set TREASURY_ADDRESS.");

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  // Load VacuumGen validator with 4 params.
  const plutusJson = JSON.parse(
    await readFile(new URL("../../VacuumGen/onchain/plutus.json", import.meta.url), "utf8"),
  );
  const unapplied = plutusJson.validators.find((v: any) => v.title === "vault.vault.spend");
  if (!unapplied) {
    console.error("Available:", plutusJson.validators.map((v: any) => v.title));
    throw new Error("vault.vault.spend not found in VacuumGen plutus.json");
  }

  // Treasury Address Plutus encoding.
  const treasuryDetails = getAddressDetails(ADDRESSES.treasury);
  if (!treasuryDetails.paymentCredential) throw new Error("Invalid TREASURY_ADDRESS");
  const treasuryPaymentCred = treasuryDetails.paymentCredential.type === "Key"
    ? new Constr(0, [treasuryDetails.paymentCredential.hash])
    : new Constr(1, [treasuryDetails.paymentCredential.hash]);
  const treasuryStakeCred = treasuryDetails.stakeCredential
    ? new Constr(0, [new Constr(0, [new Constr(0, [treasuryDetails.stakeCredential.hash])])])
    : new Constr(1, []);
  const treasuryAddrData = new Constr(0, [treasuryPaymentCred, treasuryStakeCred]);

  const appliedCbor = applyParamsToScript(unapplied.compiledCode, [
    POLICY_IDS.lamp,
    ASSET_NAMES.lamp,
    treasuryAddrData,
    POLICY_IDS.um_nft,
    SCRIPT_HASHES.um_datum,   // um_script_hash — pins UM ref input (layer b)
    PROTOCOL.MS_PER_EPOCH,
  ]);
  const vaultScript = { type: "PlutusV3" as const, script: appliedCbor };
  const vaultScriptHash = validatorToScriptHash(vaultScript);
  const vaultScriptAddress = credentialToAddress(NETWORK, scriptHashToCredential(vaultScriptHash));

  console.log(`Network:            ${NETWORK}`);
  console.log(`ms_per_epoch:       ${PROTOCOL.MS_PER_EPOCH}`);
  console.log(`UM NFT policy:      ${POLICY_IDS.um_nft}`);
  console.log(`UM script hash:     ${SCRIPT_HASHES.um_datum}`);
  console.log(`Treasury:           ${ADDRESSES.treasury}`);
  console.log(`Vault script hash:  ${vaultScriptHash}`);
  console.log(`Vault address:      ${vaultScriptAddress}`);
  console.log(`Profile:            ${INITIAL_PROFILE}`);
  console.log(`LAMP deposit:       ${INITIAL_LAMP_DEPOSIT / 1_000_000n} tLAMP`);
  console.log(`LAMP locked:        ${INITIAL_LAMP_LOCKED / 1_000_000n} tLAMP (preseed lock)`);
  console.log(`Preseed order λ:    ${PRESEED_ORDER_LAMBDA / 1_000_000n} tLAMP (0 = none)`);
  console.log(`Preseed fire age:   -${PRESEED_ORDER_FIRE_AGE} epoch (0 = fire immediately)`);

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

  // Build pre-seeded vacuum_orders (for testing Fire without 2-epoch wait).
  // The order_id uses a placeholder tx hash since we don't know it yet at deploy.
  // For Fire test, this is OK because SDK looks up by order_id (we'll compute the same way).
  // For real Commit flow, this preseed is empty (PRESEED_ORDER_LAMBDA=0).
  const vacuumOrders = PRESEED_ORDER_LAMBDA > 0n
    ? [{
        order_id:     computeOrderId("00".repeat(32), 0n, currentEpoch - PRESEED_ORDER_FIRE_AGE, PRESEED_ORDER_LAMBDA),
        commit_epoch: currentEpoch - PRESEED_ORDER_FIRE_AGE - 2n,   // VACUUM_DELAY = 2
        fire_epoch:   currentEpoch - PRESEED_ORDER_FIRE_AGE,        // fire NOW
        lamp_amount:  PRESEED_ORDER_LAMBDA,
      }]
    : [];

  // If we pre-seed an order, lamp_locked must include it.
  const effectiveLamLocked = INITIAL_LAMP_LOCKED + (vacuumOrders[0]?.lamp_amount ?? 0n);

  const initialVault = {
    owner:                 ownerPkh,
    lamp_balance:          INITIAL_LAMP_DEPOSIT,
    lamp_locked:           effectiveLamLocked,
    loyalty_holdings:      [{
      amount:         INITIAL_LAMP_DEPOSIT,
      acquired_epoch: currentEpoch,
      is_locked:      effectiveLamLocked > 0n,
    }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         vacuumOrders,
    gen_schedules:         [],
    profile:               INITIAL_PROFILE,
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    currentEpoch - LAST_UPDATED_OFFSET,
    delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state:        { recent_burn_epochs: [], total_burns_count: 0n },
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

  console.log(`\n✅ VacuumGen vault created!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://preview.cardanoscan.io/transaction/${txHash}`);
  if (vacuumOrders.length > 0) {
    console.log(`   Pre-seeded order_id: ${vacuumOrders[0].order_id}`);
    console.log(`   Pre-seeded fire_epoch: ${vacuumOrders[0].fire_epoch} (current=${currentEpoch})`);
  }
  console.log(`\n📋 Copy to .env:`);
  console.log(`   VAULT_VACUUM_HASH=${vaultScriptHash}   # applied for NETWORK=${NETWORK}`);
}

main().catch(console.error);
