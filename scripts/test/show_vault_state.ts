// scripts/test/show_vault_state.ts — Read-only vault inspector
//
// Query vault datum trên Preview và in pretty table:
//   • Profile, LAMP balance, holdings + ages, LF của từng holding
//   • Tất cả magic_batches: source, age, initial, current, % decay
//   • Comparison với công thức: current_amount thực tế vs "what it SHOULD be"
//     theo công thức decay (10-r)^k / 10^k cho Snapshot, halving cho Instant
//   • Link cardanoscan cho từng asset
//
// KHÔNG submit tx — chỉ đọc. Chạy bất kỳ lúc nào để xem decay tiến triển.
//
// Run: npm run test:show-vault

import { Lucid, Blockfrost, Data } from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PRIVATE_KEY,
  SCRIPT_HASHES, PROTOCOL,
} from "../config.js";
import { snapshotBatchBalance, lfPwlQ } from "../../SnapshotGen/offchain/src/math.js";
import { PROFILE_PARAMS as SS_PROFILE_PARAMS } from "../../SnapshotGen/offchain/src/constants.js";
import { VaultDatumSchema } from "../../SnapshotGen/offchain/src/types.js";
import { INSTANT_DECAY_WINDOW } from "../../InstantGen/offchain/src/constants.js";
import { qToStr } from "@magiclamp/protocol-utils";

const Q = PROTOCOL.Q;
const SLOTS_PER_EPOCH = PROTOCOL.SLOTS_PER_EPOCH;

function magicStr(nanogic: bigint): string {
  const whole = nanogic / Q;
  const frac  = (nanogic % Q).toString().padStart(9, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

function pctStr(n: bigint, d: bigint): string {
  if (d === 0n) return "  N/A";
  return (Number((n * 10000n) / d) / 100).toFixed(1) + "%";
}

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  MagicLamp Vault State Inspector — read-only (Preview testnet)       ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

  const address = await lucid.wallet().address();
  const { paymentCredential } = lucid.utils.getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;

  const tip = await (lucid.provider as any).getBlock("latest");
  const currentEpoch = BigInt(tip.slot ?? 0) / SLOTS_PER_EPOCH;

  console.log(`  Wallet:        ${address}`);
  console.log(`  Owner pkh:     ${ownerPkh}`);
  console.log(`  Current epoch: ${currentEpoch}\n`);

  const vaultAddr = lucid.utils.validatorToAddress({
    type: "PlutusV3", script: SCRIPT_HASHES.vault_snapshot,
  });
  const utxos = await lucid.utxosAt(vaultAddr);
  const vaultUtxo = utxos.find((u: any) => {
    if (!u.datum) return false;
    try { return Data.from(u.datum, VaultDatumSchema).owner === ownerPkh; } catch { return false; }
  });
  if (!vaultUtxo) {
    console.log(`  Không tìm thấy vault của owner ${ownerPkh.slice(0, 16)}…`);
    console.log(`  Chạy 'npm run deploy:vault' để tạo vault.`);
    process.exit(0);
  }

  const v: any = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  const profile = v.profile as string;
  const profParams = SS_PROFILE_PARAMS[profile]!;
  const lampBal = v.lamp_balance as bigint;
  const lampLocked = v.lamp_locked as bigint;
  const lastUpdated = v.last_updated_epoch as bigint;

  console.log("─── Vault summary " + "─".repeat(52));
  console.log(`  Profile:     ${profile}  (B=${qToStr(profParams.B_Q)}, PM=${qToStr(profParams.PM_Q)}, r=${profParams.r}, N=${profParams.N})`);
  console.log(`  LAMP:        ${lampBal / 1_000_000n} (locked: ${lampLocked / 1_000_000n})`);
  console.log(`  Last update: epoch ${lastUpdated}  (Δ to now: ${currentEpoch - lastUpdated})`);

  // Holdings
  const holdings = v.loyalty_holdings as Array<{ amount: bigint; acquired_epoch: bigint; is_locked: boolean }>;
  console.log(`\n─── Loyalty holdings (${holdings.length}) ` + "─".repeat(42));
  if (holdings.length === 0) {
    console.log(`  (empty)`);
  } else {
    console.log(`  acquired_epoch | age | LAMP    | LF      | locked`);
    console.log(`  ` + "-".repeat(54));
    for (const h of holdings) {
      const age = currentEpoch - h.acquired_epoch;
      const lf = lfPwlQ(age);
      console.log(`  ${h.acquired_epoch.toString().padStart(14)} | ${age.toString().padStart(3)} | ${(h.amount / 1_000_000n).toString().padStart(7)} | ${qToStr(lf).padStart(7)} | ${h.is_locked ? "yes" : "no"}`);
    }
  }

  // Batches — with expected decay
  const batches = v.magic_batches as Array<any>;
  console.log(`\n─── Magic batches (${batches.length}) ` + "─".repeat(50));
  if (batches.length === 0) {
    console.log(`  (empty — chưa có batch nào)`);
    process.exit(0);
  }

  console.log(`  source   | k | initial    | current    | expected*  | decay% | source_profile`);
  console.log(`  ` + "-".repeat(78));

  let totalLive = 0n;
  for (const b of batches) {
    const k = currentEpoch - (b.created_epoch as bigint);
    const init = b.initial_amount as bigint;
    const cur  = b.current_amount as bigint;
    const srcProf = b.profile_at_creation ?? null;

    // Compute "expected" current based on decay formula
    let expected = cur;
    if (b.source === "Snapshot" && srcProf) {
      expected = snapshotBatchBalance(init, srcProf as string, k);
    } else if (b.source === "Instant") {
      if (k >= INSTANT_DECAY_WINDOW) expected = 0n;
      else if (k >= 1n) expected = init / 2n;  // halved hoặc sẽ halve next tx
      else expected = init;
    }

    const decayPct = pctStr(init - cur, init);
    const srcProfStr = (srcProf ?? "—").padEnd(8);
    console.log(`  ${String(b.source).padEnd(8)} | ${k.toString().padStart(1)} | ${magicStr(init).padStart(10)} | ${magicStr(cur).padStart(10)} | ${magicStr(expected).padStart(10)} | ${decayPct.padStart(6)} | ${srcProfStr}`);

    totalLive += cur;
  }

  console.log(`\n  Tổng MAGIC sống: ${magicStr(totalLive)} MAGIC`);
  console.log(`  * "expected" = giá trị tính từ công thức decay (SDK pure func), so với "current" để verify`);
  console.log(`     onchain math khớp offchain. Nếu lệch → có bug ở 1 trong 2 phía.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
