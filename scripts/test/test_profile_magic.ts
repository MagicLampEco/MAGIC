// scripts/test/test_profile_magic.ts — On-chain Preview test (Tier 2)
//
// Chạy SnapshotGen + InstantGen TRÊN MẠNG THẬT (Preview), in verbose output
// để biz/QA verify:
//
//   • Vault với profile gì? LAMP nắm bao nhiêu? Holding ages?
//   • SnapshotGen sẽ sinh BAO NHIÊU MAGIC — in công thức rõ ràng
//     (L × R_snap × LF × OAC × PM × B), submit tx thật, đọc datum mới,
//     so sánh expected vs actual.
//   • InstantGen 100 LAMP sẽ ra bao nhiêu MAGIC — in công thức
//     (L × R_inst × UM × PM), submit, verify.
//   • In tất cả magic_batches hiện tại: source, age, initial, current, % decay.
//   • Link cardanoscan cho mỗi tx.
//
// Để xem decay: chạy lại script này sau 1 epoch (≈1 ngày trên Preview).
// Batches cũ sẽ có current_amount giảm theo công thức profile (r, N).
//
// Để so sánh 3 profile:
//   VAULT_PROFILE=Ember   npm run deploy:vault   # tạo vault Ember
//   VAULT_PROFILE=Flame   npm run deploy:vault   # tạo vault Flame
//   VAULT_PROFILE=Lantern npm run deploy:vault   # tạo vault Lantern
// Mỗi lần test, set env VAULT_OWNER_PKH tương ứng — nhưng Preview chỉ
// cho phép 1 owner pkh / wallet. Để so sánh 3 profile cần 3 wallet.
// Hoặc dùng ProfileChange module để chuyển vault giữa các profile.
//
// Run: npm run test:profile-magic

import { Lucid, Blockfrost, Data, toUnit } from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PRIVATE_KEY,
  SCRIPT_HASHES, POLICY_IDS, ASSET_NAMES, PROTOCOL,
  lampToOil,
} from "../config.js";

import {
  computeSnapshotMagic, computeLfQ, computeOacQ,
  lfPwlQ,
} from "../../SnapshotGen/offchain/src/math.js";
import {
  PROFILE_PARAMS as SS_PROFILE_PARAMS,
} from "../../SnapshotGen/offchain/src/constants.js";
import { VaultDatumSchema, UMDatumSchema } from "../../SnapshotGen/offchain/src/types.js";

import {
  computeInstantMagic, getUmForInstant,
} from "../../InstantGen/offchain/src/math.js";
import {
  PM_Q, INSTANT_DECAY_WINDOW,
} from "../../InstantGen/offchain/src/constants.js";

import { nanogicToMagicStr, qToStr } from "@magiclamp/protocol-utils";

const SLOTS_PER_EPOCH = PROTOCOL.SLOTS_PER_EPOCH;
const Q = PROTOCOL.Q;
const INSTANT_LAMP = lampToOil(BigInt(process.env.INSTANT_LAMP ?? "100"));

// ── Pretty helpers ────────────────────────────────────────────

function h1(title: string): void {
  console.log("\n" + "═".repeat(70));
  console.log("  " + title);
  console.log("═".repeat(70));
}

function h2(title: string): void {
  console.log("\n── " + title + " " + "─".repeat(Math.max(0, 67 - title.length)));
}

function magicStr(nanogic: bigint): string {
  const whole = nanogic / Q;
  const frac  = (nanogic % Q).toString().padStart(9, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

function pctStr(n: bigint, d: bigint): string {
  if (d === 0n) return "0.0%";
  return (Number((n * 10000n) / d) / 100).toFixed(1) + "%";
}

function scanTx(hash: string): string {
  return `https://preview.cardanoscan.io/transaction/${hash}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Chain access ──────────────────────────────────────────────

async function getCurrentEpoch(lucid: any): Promise<bigint> {
  const tip = await lucid.provider.getBlock("latest");
  return BigInt(tip.slot ?? 0) / SLOTS_PER_EPOCH;
}

async function findVaultUtxo(lucid: any, ownerPkh: string): Promise<any> {
  const vaultAddr = lucid.utils.validatorToAddress({
    type: "PlutusV3", script: SCRIPT_HASHES.vault_snapshot,
  });
  const utxos = await lucid.utxosAt(vaultAddr);
  return utxos.find((u: any) => {
    if (!u.datum) return false;
    try {
      const d = Data.from(u.datum, VaultDatumSchema);
      return d.owner === ownerPkh;
    } catch { return false; }
  });
}

async function findUMUtxo(lucid: any): Promise<any> {
  const umAddr = lucid.utils.validatorToAddress({
    type: "PlutusV3", script: SCRIPT_HASHES.um_datum,
  });
  const utxos = await lucid.utxosAt(umAddr);
  return utxos[0];
}

// ── Datum readers (verbose pretty-print) ──────────────────────

function printVaultSummary(vaultDatum: any, currentEpoch: bigint): void {
  h2(`Vault hiện tại (epoch ${currentEpoch})`);

  const lampBal     = vaultDatum.lamp_balance as bigint;
  const lampLocked  = vaultDatum.lamp_locked  as bigint;
  const profile     = vaultDatum.profile as string;
  const lastUpdated = vaultDatum.last_updated_epoch as bigint;
  const holdings    = vaultDatum.loyalty_holdings as Array<{ amount: bigint; acquired_epoch: bigint; is_locked: boolean }>;
  const batches     = vaultDatum.magic_batches as Array<any>;

  console.log(`  Profile:        ${profile}  (B=${qToStr(SS_PROFILE_PARAMS[profile]!.B_Q)}, PM=${qToStr(SS_PROFILE_PARAMS[profile]!.PM_Q)}, r=${SS_PROFILE_PARAMS[profile]!.r}, N=${SS_PROFILE_PARAMS[profile]!.N})`);
  console.log(`  LAMP balance:   ${lampBal / 1_000_000n} LAMP (locked: ${lampLocked / 1_000_000n})`);
  console.log(`  Last updated:   epoch ${lastUpdated}  (delta to now: ${currentEpoch - lastUpdated})`);

  console.log(`\n  Holdings (LF input):`);
  if (holdings.length === 0) {
    console.log(`    (empty)`);
  } else {
    console.log(`    age | amount(LAMP) | LF       | locked`);
    console.log(`    ` + "-".repeat(48));
    for (const h of holdings) {
      const age = currentEpoch - h.acquired_epoch;
      const lf = lfPwlQ(age);
      console.log(`    ${age.toString().padStart(3)} | ${(h.amount / 1_000_000n).toString().padStart(11)} | ${qToStr(lf).padStart(7)}  | ${h.is_locked ? "yes" : "no"}`);
    }
  }

  console.log(`\n  Magic batches (${batches.length}):`);
  if (batches.length === 0) {
    console.log(`    (empty — chưa có batch nào)`);
  } else {
    console.log(`    source   | k(age) | initial    | current    | decay% | source_profile`);
    console.log(`    ` + "-".repeat(70));
    for (const b of batches) {
      const k = currentEpoch - (b.created_epoch as bigint);
      const init = b.initial_amount as bigint;
      const cur  = b.current_amount as bigint;
      const decayPct = init > 0n ? pctStr(init - cur, init).padStart(6) : "  N/A ";
      const srcProf = b.profile_at_creation ?? "—";
      console.log(`    ${String(b.source).padEnd(8)} | ${k.toString().padStart(6)} | ${magicStr(init).padStart(10)} | ${magicStr(cur).padStart(10)} | ${decayPct} | ${srcProf}`);
    }
  }
}

// ── Step A: SnapshotGen ───────────────────────────────────────

async function runSnapshotGen(lucid: any, vaultUtxo: any, currentEpoch: bigint): Promise<{
  txHash: string; mGenerated: bigint;
}> {
  h1("STEP A — SnapshotGen TRÊN PREVIEW");

  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  const profile = vaultDatum.profile as string;
  const lampBal = vaultDatum.lamp_balance;
  const deltaEpochs = currentEpoch - vaultDatum.last_updated_epoch;

  if (deltaEpochs <= 0n) {
    console.log(`  ⏭  Skip SnapshotGen: deltaEpochs=${deltaEpochs} ≤ 0 (cùng epoch với lần trước).`);
    return { txHash: "", mGenerated: 0n };
  }

  // Compute expected via SDK math (same code path validator will execute)
  const lfQ  = computeLfQ(vaultDatum.loyalty_holdings, currentEpoch);
  const oacQ = computeOacQ(vaultDatum.activity_state, currentEpoch);
  const mPerEpoch = computeSnapshotMagic(lampBal, lfQ, oacQ, profile);
  const mExpected = mPerEpoch * deltaEpochs;

  console.log(`\n  Công thức (§8.1):`);
  console.log(`    M_per_epoch = L × R_snap × LF × OAC × PM × B`);
  console.log(`              = ${lampBal / 1_000_000n} LAMP × 5.0 × ${qToStr(lfQ)} × ${qToStr(oacQ)} × ${qToStr(SS_PROFILE_PARAMS[profile]!.PM_Q)} × ${qToStr(SS_PROFILE_PARAMS[profile]!.B_Q)}`);
  console.log(`              = ${magicStr(mPerEpoch)} MAGIC / epoch`);
  console.log(`    M_total = M_per_epoch × Δepoch = ${magicStr(mPerEpoch)} × ${deltaEpochs}`);
  console.log(`           = ${magicStr(mExpected)} MAGIC  ← expected\n`);

  // Submit
  const { buildSnapshotGenTx } = await import("../../SnapshotGen/offchain/src/snapshot.js");
  const address = await lucid.wallet().address();
  const result = await buildSnapshotGenTx({ lucid, vaultUtxo, userAddress: address });

  console.log(`  SDK summary: ${result.summary}`);

  const txHash = await (await result.tx.sign.withWallet().complete()).submit();
  console.log(`  ✅ TX submitted: ${txHash}`);
  console.log(`     Scan:        ${scanTx(txHash)}`);

  // Verify SDK result matches our re-computation
  if (result.mGenerated !== mExpected) {
    console.log(`  ⚠ Local re-compute (${magicStr(mExpected)}) ≠ SDK result (${magicStr(result.mGenerated)}) — kiểm tra params.`);
  } else {
    console.log(`  ✅ Local re-compute KHỚP SDK: ${magicStr(mExpected)} MAGIC.`);
  }

  return { txHash, mGenerated: result.mGenerated };
}

// ── Step B: InstantGen ────────────────────────────────────────

async function runInstantGen(lucid: any, vaultUtxo: any, umUtxo: any, currentEpoch: bigint): Promise<{
  txHash: string; mGenerated: bigint;
}> {
  h1(`STEP B — InstantGen TRÊN PREVIEW (paid: ${INSTANT_LAMP / 1_000_000n} LAMP)`);

  const vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  const umDatum    = Data.from(umUtxo.datum!, UMDatumSchema);
  const profile = vaultDatum.profile as string;
  const umSmoothed = umDatum.smoothed_q;
  const umLastUpdated = umDatum.last_updated_epoch;
  const staleness = currentEpoch - umLastUpdated;

  const umUsed = getUmForInstant({
    smoothed_q: umSmoothed,
    last_updated_epoch: umLastUpdated,
  }, currentEpoch);
  const umFallback = umUsed !== umSmoothed;

  const mExpected = computeInstantMagic(INSTANT_LAMP, umUsed, PM_Q[profile]!);

  console.log(`\n  Công thức (§9.1):`);
  console.log(`    M_instant = L_paid × R_inst × UM × PM`);
  console.log(`             = ${INSTANT_LAMP / 1_000_000n} LAMP × 3.0 × ${qToStr(umUsed)} × ${qToStr(PM_Q[profile]!)}`);
  console.log(`             = ${magicStr(mExpected)} MAGIC  ← expected\n`);
  console.log(`  UM:`);
  console.log(`    smoothed_q:        ${qToStr(umSmoothed)}  (UMKeeper last set at epoch ${umLastUpdated})`);
  console.log(`    staleness:         ${staleness} epoch${umFallback ? " → FALLBACK 0.5× áp dụng (C-UM-6)" : " ≤ 1 → dùng smoothed"}`);
  console.log(`    UM_used:           ${qToStr(umUsed)}\n`);

  // Submit
  const { buildInstantGenTx } = await import("../../InstantGen/offchain/src/instant.js");
  const address = await lucid.wallet().address();
  const result = await buildInstantGenTx({
    lucid, vaultUtxo, lampPaidOil: INSTANT_LAMP,
    umDatumUtxo: umUtxo, userAddress: address,
  });

  console.log(`  SDK summary: ${result.summary}`);

  const txHash = await (await result.tx.sign.withWallet().complete()).submit();
  console.log(`  ✅ TX submitted: ${txHash}`);
  console.log(`     Scan:        ${scanTx(txHash)}`);

  if (result.expectedMagicNanogic !== mExpected) {
    console.log(`  ⚠ Local re-compute ≠ SDK — kiểm tra UM/PM.`);
  } else {
    console.log(`  ✅ Local re-compute KHỚP SDK: ${magicStr(mExpected)} MAGIC.`);
  }

  return { txHash, mGenerated: result.expectedMagicNanogic };
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  MagicLamp On-Chain Profile + Decay Test (Preview testnet)            ║");
  console.log("║  Tier 2 — submit tx thật, đọc datum thật, so sánh với SDK math.       ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

  const address = await lucid.wallet().address();
  const { paymentCredential } = lucid.utils.getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential");
  const ownerPkh = paymentCredential.hash;
  const currentEpoch = await getCurrentEpoch(lucid);

  console.log(`\n  Wallet:        ${address}`);
  console.log(`  Owner pkh:     ${ownerPkh}`);
  console.log(`  Current epoch: ${currentEpoch}`);

  // PRE: show vault state before any tx
  let vaultUtxo = await findVaultUtxo(lucid, ownerPkh);
  if (!vaultUtxo) {
    throw new Error("Vault UTxO không tìm thấy. Chạy deploy/04_create_vault.ts trước.\n" +
                    "  VAULT_PROFILE=Flame npm run deploy:vault");
  }
  const umUtxo = await findUMUtxo(lucid);
  if (!umUtxo) throw new Error("UM UTxO không tìm thấy. Chạy deploy/02_deploy_um.ts trước.");

  h1("TRƯỚC TX — Trạng thái vault");
  let vaultDatum: any = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  printVaultSummary(vaultDatum, currentEpoch);

  // STEP A: SnapshotGen
  const snapResult = await runSnapshotGen(lucid, vaultUtxo, currentEpoch);

  // Wait for confirmation, re-read vault
  if (snapResult.txHash) {
    console.log(`\n  ⏳ Đợi 8s để tx được confirm...`);
    await sleep(8000);
    vaultUtxo = await findVaultUtxo(lucid, ownerPkh);
    if (!vaultUtxo) throw new Error("Vault biến mất sau Snapshot tx — có gì đó sai.");
  }

  // STEP B: InstantGen
  const instResult = await runInstantGen(lucid, vaultUtxo, umUtxo, currentEpoch);

  if (instResult.txHash) {
    console.log(`\n  ⏳ Đợi 8s để tx được confirm...`);
    await sleep(8000);
    vaultUtxo = await findVaultUtxo(lucid, ownerPkh);
    if (!vaultUtxo) throw new Error("Vault biến mất sau Instant tx — có gì đó sai.");
  }

  // POST: show vault state after both txs
  h1("SAU CẢ 2 TX — Trạng thái vault mới");
  vaultDatum = Data.from(vaultUtxo.datum!, VaultDatumSchema);
  printVaultSummary(vaultDatum, currentEpoch);

  // Final summary
  h1("KẾT QUẢ + WORKFLOW THEO DÕI DECAY");
  console.log(`
  Snapshot tx:   ${snapResult.txHash ? scanTx(snapResult.txHash) : "(skipped)"}
  Snapshot M:    ${magicStr(snapResult.mGenerated)} MAGIC
  Instant  tx:   ${scanTx(instResult.txHash)}
  Instant  M:    ${magicStr(instResult.mGenerated)} MAGIC

  📌 Bước tiếp theo để thấy decay (HẾT EPOCH BAO LÂU CHỜ BẤY NHIÊU):

     1. Chạy 'npm run test:show-vault' bất kỳ lúc nào để xem batches hiện tại.
        Cột "current" sẽ giảm dần qua các epoch theo công thức profile.

     2. Sau 1 epoch (~1 ngày trên Preview), chạy lại lệnh này:
           npm run test:profile-magic
        Sẽ thấy:
           • Batches CŨ có current_amount giảm theo (10-r)^k/10^k
           • SnapshotGen mới tạo thêm 1 batch nữa
           • Instant batch ở k=1 sẽ bị halve (÷2)

     3. Sau ${INSTANT_DECAY_WINDOW} epoch, Instant batch sẽ về 0 (cliff).
        Sau N=${SS_PROFILE_PARAMS[String((vaultDatum as any).profile)]!.N} epoch, Snapshot batch (profile hiện tại) cũng về 0.

  📌 So sánh 3 profile: cần 3 wallet/owner pkh khác nhau, mỗi cái deploy
     vault với profile riêng. Hoặc dùng ProfileChange module để chuyển vault
     hiện tại sang profile khác (sau ${1} epoch buffer).
`);
}

main().catch(e => { console.error(e); process.exit(1); });
