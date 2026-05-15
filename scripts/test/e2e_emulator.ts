// scripts/test/e2e_emulator.ts — In-memory protocol simulator (Tier 1)
//
// ──────────────────────────────────────────────────────────────────────
// SCOPE (đọc trước khi review):
//
// File này là TIER 1 — fast inner loop cho engineer/dev.
// KHÔNG thay thế tx thật trên Preview. KHÔNG cover CBOR encoding, fee,
// min-UTxO, validator onchain execution, hay network confirmation.
//
// Tier 1 (file này — e2e_emulator.ts):   pure math + state machine across
//                                         epoch boundaries, < 1 giây/run.
// Tier 2 (test:e2e — e2e_flow.ts):       tx thật trên Preview. Cần chờ
//                                         epoch (1-5 ngày). Dùng trước
//                                         mỗi release candidate.
// Tier 3 (aiken check):                   validator types/properties.
//
// Nếu bạn cần xem TÍNH NĂNG hoạt động ra sao (user nắm LAMP sinh MAGIC,
// MAGIC decay theo profile), chạy `npm run demo:lamp` thay vì file này —
// demo đó in bảng dễ đọc cho biz/QA review.
// ──────────────────────────────────────────────────────────────────────
//
// Mục đích kỹ thuật: chạy full flow SnapshotGen → InstantGen →
// VacuumGen commit → (nhảy 2 epoch) → VacuumGen fire trong < 1 giây,
// không cần testnet, không cần aiken build, không cần Blockfrost.
//
// Cách hoạt động:
//   - State (vault datum + UM datum) giữ in-memory.
//   - "Time" là biến `epoch` mà ta tự tăng — không phụ thuộc Cardano clock.
//   - Math/quy tắc dùng đúng các pure function của SDK (computeSnapshotMagic,
//     computeVacuumMagic, computeInstantMagic, getUmForInstant/Vacuum, ...).
//   - State transition (datum mới sau mỗi op) viết minimal inline ở đây.
//
// Run: npm run test:emulator (từ thư mục scripts/)

import {
  computeSnapshotMagic, computeLfQ, computeOacQ, isExpired,
} from "../../SnapshotGen/offchain/src/math.js";
import { PROFILE_PARAMS as SS_PROFILE_PARAMS } from "../../SnapshotGen/offchain/src/constants.js";

import {
  computeInstantMagic, getUmForInstant, shouldHalve, applyHalving,
  isExpired as instantIsExpired,
} from "../../InstantGen/offchain/src/math.js";
import {
  PM_Q, INSTANT_DECAY_WINDOW, MAX_BATCHES_PER_VAULT,
} from "../../InstantGen/offchain/src/constants.js";

import {
  computeVacuumMagic, getUmForVacuum, computeSmQ, isVacuumExpired,
} from "../../VacuumGen/offchain/src/math.js";
import {
  VACUUM_DELAY, VACUUM_DECAY_WINDOW,
} from "../../VacuumGen/offchain/src/constants.js";

import {
  selectLampForLock, removeLockedAmount, nanogicToMagicStr, qToStr,
  lampToOil,
  type LoyaltyHolding,
} from "@magiclamp/protocol-utils";

// ══════════════════════════════════════════════════════════════
// In-memory types (subset of VaultDatum/UMDatum — only fields the
// flows actually touch). Keeps the harness focused.
// ══════════════════════════════════════════════════════════════

type Profile = "Ember" | "Flame" | "Lantern";

interface MagicBatch {
  batch_id       : string;
  source         : "Snapshot" | "Instant" | "Vacuum" | "Schedule";
  created_epoch  : bigint;
  initial_amount : bigint;
  current_amount : bigint;
  decay_window   : bigint;
  halved         : boolean;
  profile_at_creation: Profile | null;
}

interface VacuumOrder {
  order_id     : string;
  commit_epoch : bigint;
  fire_epoch   : bigint;
  lamp_amount  : bigint;  // in oil
}

interface VaultDatum {
  owner                : string;
  lamp_balance         : bigint;
  lamp_locked          : bigint;
  loyalty_holdings     : LoyaltyHolding[];
  magic_batches        : MagicBatch[];
  next_batch_index     : bigint;
  vacuum_orders        : VacuumOrder[];
  profile              : Profile;
  last_updated_epoch   : bigint;
  activity_state       : { recent_burn_epochs: [string, bigint][]; total_burns_count: bigint };
  streak_state         : { current_streak: bigint; last_active_epoch: bigint };
}

interface UMDatum {
  smoothed_q         : bigint;
  last_updated_epoch : bigint;
}

interface SimState {
  epoch         : bigint;
  vault         : VaultDatum;
  um            : UMDatum;
  treasury_lamp : bigint;     // oil cumulatively delivered to Treasury
  burned_magic  : bigint;     // for completeness (not exercised here)
}

// ══════════════════════════════════════════════════════════════
// Tiny test framework
// ══════════════════════════════════════════════════════════════

let failures = 0;
let checks   = 0;

function check(label: string, cond: boolean, detail?: string): void {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? "  →  " + detail : ""}`);
  }
}

function eq(label: string, actual: bigint, expected: bigint): void {
  check(label, actual === expected, `actual=${actual} expected=${expected}`);
}

function section(title: string): void {
  console.log("\n" + "═".repeat(60));
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function logEpoch(s: SimState, note: string): void {
  console.log(`\n— epoch ${s.epoch}  ${note} —`);
}

// ══════════════════════════════════════════════════════════════
// Time control — the whole point of this harness
// ══════════════════════════════════════════════════════════════

function advanceEpochs(s: SimState, n: bigint): void {
  if (n <= 0n) throw new Error("advanceEpochs n must be positive");
  s.epoch += n;
}

// ══════════════════════════════════════════════════════════════
// Initial state
// ══════════════════════════════════════════════════════════════

function makeInitialState(opts: {
  startEpoch: bigint;
  profile   : Profile;
  lampOil   : bigint;
  umQ       : bigint;
}): SimState {
  return {
    epoch: opts.startEpoch,
    vault: {
      owner: "owner_pkh_placeholder",
      lamp_balance:    opts.lampOil,
      lamp_locked:     0n,
      loyalty_holdings: [{
        amount:         opts.lampOil,
        acquired_epoch: opts.startEpoch,
        is_locked:      false,
      }],
      magic_batches:    [],
      next_batch_index: 0n,
      vacuum_orders:    [],
      profile:          opts.profile,
      last_updated_epoch: opts.startEpoch,
      activity_state:   { recent_burn_epochs: [], total_burns_count: 0n },
      streak_state:     { current_streak: 0n, last_active_epoch: 0n },
    },
    um: {
      smoothed_q:         opts.umQ,
      last_updated_epoch: opts.startEpoch,
    },
    treasury_lamp: 0n,
    burned_magic:  0n,
  };
}

function fakeBatchId(s: SimState, idx: bigint): string {
  return `batch_${s.vault.owner.slice(0, 6)}_${idx}_e${s.epoch}`;
}

function fakeOrderId(s: SimState, lambda: bigint): string {
  return `order_${s.vault.owner.slice(0, 6)}_${s.epoch}_${lambda}`;
}

// ══════════════════════════════════════════════════════════════
// SnapshotGen (§8) — minimal state transition
// ══════════════════════════════════════════════════════════════

function runSnapshotGen(s: SimState): { mGenerated: bigint; deltaEpochs: bigint; batchAdded: boolean } {
  const v = s.vault;
  if (s.epoch <= v.last_updated_epoch)
    throw new Error(`C-SS-1: epoch ${s.epoch} ≤ last_updated ${v.last_updated_epoch}`);

  const deltaEpochs = s.epoch - v.last_updated_epoch;
  const lfQ         = computeLfQ(v.loyalty_holdings, s.epoch);
  const oacQ        = computeOacQ(v.activity_state, s.epoch);
  const mPerEpoch   = computeSnapshotMagic(v.lamp_balance, lfQ, oacQ, v.profile);
  const mTotal      = mPerEpoch * deltaEpochs;

  // Prune expired (Snapshot batches: by profile N)
  const surviving = v.magic_batches.filter(b =>
    !isExpired(b.created_epoch, b.decay_window, s.epoch),
  );

  const canAdd = surviving.length < MAX_BATCHES_PER_VAULT && mTotal > 0n;
  if (canAdd) {
    const { N } = SS_PROFILE_PARAMS[v.profile]!;
    surviving.push({
      batch_id:        fakeBatchId(s, v.next_batch_index),
      source:          "Snapshot",
      created_epoch:   s.epoch,
      initial_amount:  mTotal,
      current_amount:  mTotal,
      decay_window:    BigInt(N),
      halved:          false,
      profile_at_creation: v.profile,
    });
    v.next_batch_index += 1n;
  }
  v.magic_batches = surviving;
  v.last_updated_epoch = s.epoch;

  return { mGenerated: mTotal, deltaEpochs, batchAdded: canAdd };
}

// ══════════════════════════════════════════════════════════════
// InstantGen (§9) — minimal state transition
// ══════════════════════════════════════════════════════════════

function runInstantGen(s: SimState, lampPaidOil: bigint): {
  mGenerated: bigint; umUsedQ: bigint; fallback: boolean;
} {
  const v = s.vault;
  const avail = v.lamp_balance - v.lamp_locked;
  if (lampPaidOil > avail) throw new Error(`C-INST-3: paid ${lampPaidOil} > avail ${avail}`);

  const umUsedQ  = getUmForInstant(s.um, s.epoch);
  const fallback = umUsedQ !== s.um.smoothed_q;

  const pmQ          = PM_Q[v.profile]!;
  const expectedMagic = computeInstantMagic(lampPaidOil, umUsedQ, pmQ);

  // C-PRUNE-2: halve Instant batches at k=1 BEFORE prune
  let batches: MagicBatch[] = v.magic_batches.map(b => {
    if (shouldHalve(b.source, b.created_epoch, s.epoch, b.halved)) {
      return { ...b, current_amount: applyHalving(b.current_amount), halved: true };
    }
    return b;
  });
  batches = batches.filter(b => !instantIsExpired(b.created_epoch, b.decay_window, s.epoch));

  if (batches.length >= MAX_BATCHES_PER_VAULT)
    throw new Error(`GEN-VAULT-001: batches=${batches.length} ≥ ${MAX_BATCHES_PER_VAULT}`);

  batches.push({
    batch_id:        fakeBatchId(s, v.next_batch_index),
    source:          "Instant",
    created_epoch:   s.epoch,
    initial_amount:  expectedMagic,
    current_amount:  expectedMagic,
    decay_window:    INSTANT_DECAY_WINDOW,
    halved:          false,
    profile_at_creation: null,
  });

  // Spend LAMP: remove from holdings, decrement balance, send to treasury
  v.loyalty_holdings = subtractFromHoldings(v.loyalty_holdings, lampPaidOil);
  v.lamp_balance     -= lampPaidOil;
  v.next_batch_index += 1n;
  v.magic_batches    = batches;
  v.last_updated_epoch = s.epoch;
  s.treasury_lamp    += lampPaidOil;

  return { mGenerated: expectedMagic, umUsedQ, fallback };
}

// ══════════════════════════════════════════════════════════════
// VacuumGen (§10) — Commit + Fire
// ══════════════════════════════════════════════════════════════

function runVacuumCommit(s: SimState, lambdaOil: bigint): {
  orderId: string; fireEpoch: bigint;
} {
  const v = s.vault;
  const avail = v.lamp_balance - v.lamp_locked;
  if (lambdaOil > avail) throw new Error(`GEN-VAC-001: λ=${lambdaOil} > avail=${avail}`);

  const orderId   = fakeOrderId(s, lambdaOil);
  const fireEpoch = s.epoch + VACUUM_DELAY;

  // Lock youngest-first (§6.8)
  v.loyalty_holdings = selectLampForLock(v.loyalty_holdings, lambdaOil);
  v.lamp_locked     += lambdaOil;
  v.vacuum_orders.push({
    order_id:     orderId,
    commit_epoch: s.epoch,
    fire_epoch:   fireEpoch,
    lamp_amount:  lambdaOil,
  });
  v.last_updated_epoch = s.epoch;

  return { orderId, fireEpoch };
}

function runVacuumFire(s: SimState, orderId: string): {
  mGenerated: bigint; batchCreated: boolean; umUsedQ: bigint; smUsedQ: bigint;
} {
  const v = s.vault;
  const order = v.vacuum_orders.find(o => o.order_id === orderId);
  if (!order) throw new Error(`order ${orderId} not found`);
  if (s.epoch !== order.fire_epoch)
    throw new Error(`GEN-VAC-004: current_epoch ${s.epoch} ≠ fire_epoch ${order.fire_epoch}`);

  const umQ = getUmForVacuum(s.um);
  const smQ = computeSmQ(v.streak_state);

  // Prune Vacuum-expired (cliff at k=1, so anything ≥1 old is gone)
  v.magic_batches = v.magic_batches.filter(b =>
    !(b.source === "Vacuum" && isVacuumExpired(b.created_epoch, s.epoch)),
  );

  let mGenerated   = 0n;
  let batchCreated = false;
  if (v.magic_batches.length < MAX_BATCHES_PER_VAULT) {
    mGenerated = computeVacuumMagic(order.lamp_amount, umQ, smQ);
    v.magic_batches.push({
      batch_id:        fakeBatchId(s, v.next_batch_index),
      source:          "Vacuum",
      created_epoch:   s.epoch,
      initial_amount:  mGenerated,
      current_amount:  mGenerated,
      decay_window:    VACUUM_DECAY_WINDOW,
      halved:          false,
      profile_at_creation: null,
    });
    v.next_batch_index += 1n;
    batchCreated = true;
  }

  // Apply transfer: LAMP leaves vault → Treasury (§10.2, INV-43)
  v.loyalty_holdings = removeLockedAmount(v.loyalty_holdings, order.lamp_amount);
  v.lamp_balance    -= order.lamp_amount;
  v.lamp_locked     -= order.lamp_amount;
  v.vacuum_orders    = v.vacuum_orders.filter(o => o.order_id !== orderId);
  v.last_updated_epoch = s.epoch;
  s.treasury_lamp   += order.lamp_amount;

  return { mGenerated, batchCreated, umUsedQ: umQ, smUsedQ: smQ };
}

// ══════════════════════════════════════════════════════════════
// Helper: subtract LAMP from free (unlocked) holdings, oldest-first
// (mirrors §A.9 InstantGen consumption — free LAMP only).
// ══════════════════════════════════════════════════════════════

function subtractFromHoldings(holdings: LoyaltyHolding[], amount: bigint): LoyaltyHolding[] {
  // Spend oldest free LAMP first (keeps youngest free for future LF).
  const sorted = [...holdings].sort((a, b) =>
    a.acquired_epoch < b.acquired_epoch ? -1 : a.acquired_epoch > b.acquired_epoch ? 1 : 0,
  );
  let remaining = amount;
  const out: LoyaltyHolding[] = [];
  for (const h of sorted) {
    if (h.is_locked || remaining === 0n) { out.push(h); continue; }
    if (h.amount <= remaining) { remaining -= h.amount; continue; } // fully consumed
    out.push({ ...h, amount: h.amount - remaining });
    remaining = 0n;
  }
  if (remaining > 0n) throw new Error(`Not enough free LAMP: short ${remaining}`);
  return out;
}

// ══════════════════════════════════════════════════════════════
// Scenarios
// ══════════════════════════════════════════════════════════════

function scenario1_SnapshotAcrossEpochs(): void {
  section("SCENARIO 1 — SnapshotGen across 4 epochs (Flame profile)");

  const s = makeInitialState({
    startEpoch: 100n,
    profile:    "Flame",
    lampOil:    lampToOil(1000n),   // 1000 LAMP
    umQ:        1_000_000_000n,     // 1.0×
  });

  console.log(`Initial: ${s.vault.lamp_balance / 1_000_000n} LAMP @ epoch ${s.epoch}, profile=${s.vault.profile}`);

  // Snapshot at epoch 101 (1 epoch elapsed)
  advanceEpochs(s, 1n);
  logEpoch(s, "trigger SnapshotGen (Δe=1)");
  const r1 = runSnapshotGen(s);
  console.log(`  M generated: ${nanogicToMagicStr(r1.mGenerated)} MAGIC (Δe=${r1.deltaEpochs})`);
  check("batch added", r1.batchAdded);
  check("Δe=1", r1.deltaEpochs === 1n);

  // Snapshot at epoch 103 (2-epoch catch-up — KEY: tests C-SS-6).
  // Note: M(Δe=2) is NOT exactly 2 × M(Δe=1) because LF grows with age:
  // at epoch 103 the holding is older → LF higher → per-epoch M higher.
  // C-SS-6 uses the current epoch's LF × Δe (not historic averaging).
  advanceEpochs(s, 2n);
  logEpoch(s, "trigger SnapshotGen (Δe=2 catch-up)");
  const r2 = runSnapshotGen(s);
  console.log(`  M generated: ${nanogicToMagicStr(r2.mGenerated)} MAGIC (Δe=${r2.deltaEpochs})`);
  check("catch-up: M(Δe=2) ≥ 2 × M(Δe=1)  [LF grows monotone]",
    r2.mGenerated >= r1.mGenerated * 2n,
    `actual=${r2.mGenerated} need ≥ ${r1.mGenerated * 2n}`);
  check("Δe=2 reflected in result", r2.deltaEpochs === 2n);

  // Snapshot at epoch 110 — first batch (created at 101, N=6) should be pruned
  advanceEpochs(s, 7n);
  logEpoch(s, "trigger SnapshotGen — first Flame batch must be expired (N=6)");
  const beforeBatches = s.vault.magic_batches.length;
  runSnapshotGen(s);
  const afterBatches  = s.vault.magic_batches.length;
  check("batch created at epoch 101 pruned (age=9 > N=6)",
    !s.vault.magic_batches.some(b => b.created_epoch === 101n));
  console.log(`  batches before/after: ${beforeBatches} → ${afterBatches}`);
}

function scenario2_InstantStaleUm(): void {
  section("SCENARIO 2 — InstantGen with fresh & stale UM (C-UM-6)");

  const s = makeInitialState({
    startEpoch: 200n,
    profile:    "Flame",
    lampOil:    lampToOil(1000n),
    umQ:        1_500_000_000n,    // smoothed = 1.5×
  });

  // Fresh UM: staleness = 0 (UM updated same epoch)
  logEpoch(s, "Instant with FRESH UM (staleness=0)");
  const a = runInstantGen(s, lampToOil(100n));
  console.log(`  M=${nanogicToMagicStr(a.mGenerated)} | UM_used=${qToStr(a.umUsedQ)}× | fallback=${a.fallback}`);
  check("fresh UM: used smoothed=1.5",   a.umUsedQ === 1_500_000_000n);
  check("fresh UM: no fallback applied", !a.fallback);

  // Jump 2 epochs WITHOUT updating UM → staleness=2 > MAX(1) → fallback
  advanceEpochs(s, 2n);
  logEpoch(s, "Instant with STALE UM (staleness=2 > MAX=1)");
  const b = runInstantGen(s, lampToOil(100n));
  console.log(`  M=${nanogicToMagicStr(b.mGenerated)} | UM_used=${qToStr(b.umUsedQ)}× | fallback=${b.fallback}`);
  check("stale UM: fallback to 0.5",     b.umUsedQ === 500_000_000n);
  check("stale UM: fallback applied",    b.fallback);
  check("stale Instant M < fresh Instant M (same LAMP)", b.mGenerated < a.mGenerated);
}

function scenario3_VacuumCommitFire(): void {
  section("SCENARIO 3 — VacuumGen commit → +2 epochs → fire (THE 2-DAY TEST)");

  const s = makeInitialState({
    startEpoch: 300n,
    profile:    "Flame",
    lampOil:    lampToOil(1000n),
    umQ:        1_500_000_000n,
  });
  // Give some streak so SM > base
  s.vault.streak_state.current_streak = 6n;  // SM_Q = 1.1B

  const lambda = lampToOil(50n);   // commit 50 LAMP
  logEpoch(s, "VacuumCommit λ=50 LAMP");

  const balanceBefore = s.vault.lamp_balance;
  const treasuryBefore = s.treasury_lamp;
  const { orderId, fireEpoch } = runVacuumCommit(s, lambda);

  console.log(`  order: ${orderId.slice(0,20)}…`);
  console.log(`  fire_epoch: ${fireEpoch}  (commit=${s.epoch})`);
  eq("fire_epoch = commit_epoch + 2", fireEpoch, s.epoch + 2n);
  eq("balance unchanged at commit",   s.vault.lamp_balance, balanceBefore);
  eq("locked = λ",                    s.vault.lamp_locked,  lambda);
  eq("treasury unchanged at commit",  s.treasury_lamp,      treasuryBefore);
  check("1 order in vault",           s.vault.vacuum_orders.length === 1);

  // Try to fire too early — should reject
  let earlyFireRejected = false;
  try { runVacuumFire(s, orderId); }
  catch (e) { earlyFireRejected = true; }
  check("C-VAC-6: fire BEFORE fire_epoch rejected", earlyFireRejected);

  // ⏰ THE TIME JUMP — 2 epochs.
  // On Preview Cardano: this would be ~2 real days (or ~10 days on mainnet).
  // Here: nanoseconds.
  console.log("\n  ⏰  Advancing 2 epochs (real-time: ~2 days on Preview)…");
  advanceEpochs(s, VACUUM_DELAY);

  logEpoch(s, "VacuumFire (permissionless)");
  const fr = runVacuumFire(s, orderId);
  console.log(`  M minted:     ${nanogicToMagicStr(fr.mGenerated)} MAGIC`);
  console.log(`  UM used:      ${qToStr(fr.umUsedQ)}× (C-UM-7: always smoothed)`);
  console.log(`  SM used:      ${qToStr(fr.smUsedQ)}× (streak=6)`);
  console.log(`  LAMP→Treasury: ${lambda / 1_000_000n} LAMP`);

  check("batch created on fire",     fr.batchCreated);
  eq("M = λ × VBR(0.5) × UM(1.5) × SM(1.1)",
    fr.mGenerated,
    lambda * 500_000_000n / 1_000_000_000n
          * 1_500_000_000n / 1_000_000_000n
          * 1_100_000_000n / 1_000_000_000n);
  eq("LAMP balance = initial - λ",   s.vault.lamp_balance, balanceBefore - lambda);
  eq("locked back to 0",             s.vault.lamp_locked,  0n);
  eq("treasury got λ",               s.treasury_lamp,      treasuryBefore + lambda);
  check("order removed",             s.vault.vacuum_orders.length === 0);

  // Fire again must fail (order already consumed)
  let doubleFireRejected = false;
  try { runVacuumFire(s, orderId); }
  catch (e) { doubleFireRejected = true; }
  check("double-fire same order rejected", doubleFireRejected);

  // Cliff decay check: vacuum batch expires at k=1
  advanceEpochs(s, 1n);
  logEpoch(s, "1 epoch after fire — vacuum batch should be expired");
  const beforePrune = s.vault.magic_batches.length;
  // Trigger pruning indirectly by running a SnapshotGen
  runSnapshotGen(s);  // this prunes by per-batch decay_window
  // Vacuum batch had decay_window=1 → isExpired at k≥1 → gone
  check("vacuum batch (cliff at k=1) pruned",
    !s.vault.magic_batches.some(b => b.source === "Vacuum"));
  console.log(`  batches: ${beforePrune} → ${s.vault.magic_batches.length}`);
}

function scenario4_StaleAcrossEpoch(): void {
  section("SCENARIO 4 — Stale-UM regression: epoch boundary doesn't break Vacuum");

  const s = makeInitialState({
    startEpoch: 400n,
    profile:    "Flame",
    lampOil:    lampToOil(1000n),
    umQ:        1_500_000_000n,
  });

  // Make UM very stale (10 epochs old)
  s.um.last_updated_epoch = s.epoch - 10n;

  const lambda = lampToOil(20n);
  const { orderId } = runVacuumCommit(s, lambda);
  advanceEpochs(s, VACUUM_DELAY);
  const fr = runVacuumFire(s, orderId);

  console.log(`  staleness=12 epochs; UM_used=${qToStr(fr.umUsedQ)}× (must stay smoothed)`);
  eq("C-UM-7: Vacuum uses smoothed regardless of staleness",
    fr.umUsedQ, s.um.smoothed_q);
  check("Vacuum batch created despite stale UM", fr.batchCreated);
  check("M > 0 despite stale UM",                fr.mGenerated > 0n);
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║       MagicLamp Protocol Simulator (in-memory)            ║");
  console.log("║   Bypasses Cardano epoch wait — runs in milliseconds       ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  scenario1_SnapshotAcrossEpochs();
  scenario2_InstantStaleUm();
  scenario3_VacuumCommitFire();
  scenario4_StaleAcrossEpoch();

  const elapsedMs = Date.now() - t0;
  console.log("\n" + "═".repeat(60));
  console.log(`  Result: ${checks - failures}/${checks} checks passed in ${elapsedMs} ms`);
  console.log("═".repeat(60));
  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\n✅ All scenarios passed.");
  console.log(`   Equivalent real-time on Cardano Preview: ~${approxRealtimeDays()} days`);
}

function approxRealtimeDays(): number {
  // Scenarios advance: 1+2+7 (S1) + 2 (S2) + 2+1 (S3) + 2 (S4) = 17 epochs
  // Preview = 1 day/epoch → ~17 days. Mainnet (5d/ep) → ~85 days.
  return 17;
}

main().catch(e => { console.error(e); process.exit(1); });
