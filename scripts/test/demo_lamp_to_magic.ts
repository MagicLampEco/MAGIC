// scripts/test/demo_lamp_to_magic.ts — UX demo: LAMP → MAGIC mechanics
//
// Mục tiêu: cho Tuân (hoặc bất kỳ ai không phải dev onchain) THẤY trực tiếp:
//   • Cùng 1 lượng LAMP, profile khác nhau sinh MAGIC như nào (SnapshotGen).
//   • Tuổi holding (LF) và độ active (OAC) ảnh hưởng tốc độ sinh ra sao.
//   • Mỗi batch MAGIC tan dần theo epoch như nào — decay curve cụ thể.
//   • InstantGen: trả ngay X LAMP nhận về bao nhiêu MAGIC, halving k=1, hết hạn k=2.
//   • User journey 10 epoch: nắm 1000 LAMP, làm gì → tổng MAGIC sống là bao nhiêu.
//
// Khác với e2e_emulator.ts (chạy correctness checks cho dev), script này
// là FEATURE WALKTHROUGH — output dạng bảng, đọc được như spec sheet.
//
// Run: npm run demo:lamp  (từ thư mục scripts/)

import {
  computeSnapshotMagic, computeLfQ, computeOacQ, snapshotBatchBalance,
} from "../../SnapshotGen/offchain/src/math.js";
import { PROFILE_PARAMS as SS_PROFILE_PARAMS } from "../../SnapshotGen/offchain/src/constants.js";

import {
  computeInstantMagic, applyHalving,
} from "../../InstantGen/offchain/src/math.js";
import { PM_Q, INSTANT_DECAY_WINDOW } from "../../InstantGen/offchain/src/constants.js";

import { lampToOil } from "@magiclamp/protocol-utils";

type Profile = "Ember" | "Flame" | "Lantern";
const PROFILES: Profile[] = ["Ember", "Flame", "Lantern"];

const Q = 1_000_000_000n;

// ── Pretty printers ────────────────────────────────────────────

/** Format nanogic → "X.XXXX MAGIC" with 4 decimals (right-aligned). */
function magic(n: bigint, width = 12): string {
  const whole = n / Q;
  const frac  = n % Q;
  const fracStr = frac.toString().padStart(9, "0").slice(0, 4);
  return `${whole}.${fracStr}`.padStart(width);
}

function pct(n: bigint, d: bigint): string {
  if (d === 0n) return "  0.0%";
  const p = Number((n * 10000n) / d) / 100;
  return `${p.toFixed(1).padStart(5)}%`;
}

function bar(value: bigint, max: bigint, width = 20): string {
  if (max === 0n) return " ".repeat(width);
  const fill = Number((value * BigInt(width)) / max);
  return "█".repeat(Math.max(0, Math.min(width, fill))).padEnd(width);
}

function h1(title: string): void {
  console.log("\n" + "═".repeat(70));
  console.log("  " + title);
  console.log("═".repeat(70));
}
function h2(title: string): void {
  console.log("\n── " + title + " " + "─".repeat(Math.max(0, 67 - title.length)));
}

// ── Section A: per-profile generation rate ─────────────────────

function sectionA_RatePerProfile(): void {
  h1("A. CÙNG 1000 LAMP — MỖI PROFILE SINH MAGIC MỖI EPOCH BAO NHIÊU?");

  const lamp = lampToOil(1000n);  // 1000 LAMP, in oil

  // Baseline scenario: holding fresh (age=0 → LF=1.00), 0 apps active (OAC=0.80)
  console.log("\nScenario 1 — User vừa nhận LAMP (age=0, chưa hoạt động app nào):");
  console.log("              LF=1.00  OAC=0.80\n");
  console.log("  Profile  | MAGIC/epoch  | ELV(annual) | vs Lantern");
  console.log("  " + "-".repeat(57));

  const lantern1 = computeSnapshotMagic(lamp, Q, 800_000_000n, "Lantern");
  for (const p of PROFILES) {
    const m = computeSnapshotMagic(lamp, Q, 800_000_000n, p);
    const ratio = lantern1 > 0n ? (m * 100n) / lantern1 : 0n;
    console.log(`  ${p.padEnd(8)} | ${magic(m)} | ${SS_PROFILE_PARAMS[p]!.N}-epoch    | ${ratio}%`);
  }

  // Scenario 2: holding mature (age=24 → LF=1.50), 4+ apps active (OAC=1.00)
  console.log("\nScenario 2 — User trung thành (age=24+, dùng đủ 4 apps):");
  console.log("              LF=1.50  OAC=1.00\n");
  console.log("  Profile  | MAGIC/epoch  | × so với Scenario 1");
  console.log("  " + "-".repeat(47));

  for (const p of PROFILES) {
    const s1 = computeSnapshotMagic(lamp, Q, 800_000_000n, p);
    const s2 = computeSnapshotMagic(lamp, 3n * Q / 2n, Q, p);
    const mult = s1 > 0n ? Number((s2 * 100n) / s1) / 100 : 0;
    console.log(`  ${p.padEnd(8)} | ${magic(s2)} | ×${mult.toFixed(2)}`);
  }

  console.log(`
  📌 Đọc thế nào:
     • Ember sinh nhanh nhất MỖI epoch (B=1.30, PM=1.15) nhưng decay nhanh (r=3, N=3 epoch).
     • Lantern sinh chậm nhất nhưng giữ lâu (r=1, N=9 epoch).
     • Flame ở giữa (cân bằng). Dùng làm baseline mọi nơi.
     • Trung thành (LF) + active (OAC) cộng dồn → 1.875× ngay từ epoch sau.`);
}

// ── Section B: loyalty / activity sweep ────────────────────────

function sectionB_LfOacSweep(): void {
  h1("B. TUỔI HOLDING & ĐỘ ACTIVE TÁC ĐỘNG THẾ NÀO (Flame profile, 1000 LAMP)");

  const lamp = lampToOil(1000n);
  const profile = "Flame";

  console.log("\n  LF tăng theo tuổi LAMP (epoch user nắm coin):");
  console.log("  Age (epoch) | LF      | MAGIC/epoch  | bar");
  console.log("  " + "-".repeat(58));

  const ages = [0n, 3n, 6n, 12n, 18n, 24n, 30n];
  // compute reference (max) for bar scaling
  let maxM = 0n;
  const rows: { age: bigint; lf: bigint; m: bigint }[] = [];
  for (const age of ages) {
    const lf = lfForAge(age);
    const m = computeSnapshotMagic(lamp, lf, 800_000_000n, profile);
    if (m > maxM) maxM = m;
    rows.push({ age, lf, m });
  }
  for (const { age, lf, m } of rows) {
    console.log(`  ${age.toString().padStart(11)} | ${(Number(lf) / 1e9).toFixed(2)}    | ${magic(m)} | ${bar(m, maxM, 22)}`);
  }

  console.log("\n  OAC tăng theo số app user đã dùng (lookback 12 epoch):");
  console.log("  Apps active | OAC     | MAGIC/epoch  | bar");
  console.log("  " + "-".repeat(58));

  const apps = [0, 1, 2, 3, 4];
  let maxM2 = 0n;
  const rows2: { n: number; oac: bigint; m: bigint }[] = [];
  for (const n of apps) {
    const oac = 800_000_000n + 50_000_000n * BigInt(Math.min(n, 4));
    const m = computeSnapshotMagic(lamp, Q, oac, profile);
    if (m > maxM2) maxM2 = m;
    rows2.push({ n, oac, m });
  }
  for (const { n, oac, m } of rows2) {
    console.log(`  ${n.toString().padStart(11)} | ${(Number(oac) / 1e9).toFixed(2)}    | ${magic(m)} | ${bar(m, maxM2, 22)}`);
  }

  console.log(`
  📌 Đọc thế nào:
     • Tuổi holding 0 → 24+ epoch: MAGIC/epoch tăng 1.50× (LF cap = 1.50).
     • Apps active 0 → 4+: MAGIC/epoch tăng 1.25× (OAC: 0.80 → 1.00).
     • Hai effect này NHÂN nhau → user lâu + active được tổng 1.875× so với người mới.`);
}

// ── Section C: snapshot batch decay curves ─────────────────────

function sectionC_SnapshotDecay(): void {
  h1("C. SAU KHI SINH RA — BATCH MAGIC TAN DẦN THEO EPOCH (decay)");

  console.log(`
  Công thức (§4.2): balance(k) = ⌊ m₀ × (10-r)^k / 10^k ⌋   với k < N
                    balance(k) = 0                            với k ≥ N

  Mỗi profile có r (decay rate) và N (số epoch sống) khác nhau:
     Ember:   r=3, N=3 epoch  → mỗi epoch còn 7/10 (70%), 3 epoch là sạch
     Flame:   r=2, N=6 epoch  → mỗi epoch còn 8/10 (80%), 6 epoch là sạch
     Lantern: r=1, N=9 epoch  → mỗi epoch còn 9/10 (90%), 9 epoch là sạch
`);

  // Use m0 = 1.0000 MAGIC for clean display
  const m0 = 1_000_000_000n;
  const maxK = 10n;

  console.log("  k (epoch sau khi mint) | Ember          | Flame          | Lantern");
  console.log("  " + "-".repeat(68));
  for (let k = 0n; k <= maxK; k++) {
    const e = snapshotBatchBalance(m0, "Ember",   k);
    const f = snapshotBatchBalance(m0, "Flame",   k);
    const l = snapshotBatchBalance(m0, "Lantern", k);
    const row = `  ${k.toString().padStart(2)}                     | ${magic(e, 8)} (${pct(e, m0)}) | ${magic(f, 8)} (${pct(f, m0)}) | ${magic(l, 8)} (${pct(l, m0)})`;
    console.log(row);
  }

  console.log(`
  📌 Đọc thế nào:
     • Bắt đầu cùng 1.0000 MAGIC.
     • Ember "đốt" nhanh: sau 1 epoch còn 70%, sau 2 còn 49%, epoch 3 = 0.
     • Lantern bền: sau 1 epoch còn 90%, epoch 9 mới = 0.
     • Trade-off rõ ràng: Ember M/epoch cao nhưng đời ngắn — chỉ "có lợi" nếu burn ngay.`);
}

// ── Section D: InstantGen (halving + cliff expiry) ─────────────

function sectionD_InstantGen(): void {
  h1("D. INSTANTGEN — TRẢ NGAY LAMP NHẬN NGAY MAGIC (decay 2 epoch + halving k=1)");

  const lampPaid = lampToOil(100n);  // 100 LAMP

  console.log(`
  Trả ngay ${lampPaid / 1_000_000n} LAMP với UM=1.0× (market trung lập):

  Profile  | MAGIC nhận (k=0) | sau 1 epoch (halving) | sau 2 epoch (cliff)
  ` + "-".repeat(75));

  for (const p of PROFILES) {
    const m0 = computeInstantMagic(lampPaid, Q, PM_Q[p]!);
    const m1 = applyHalving(m0);
    const m2 = 0n;  // cliff at k=2
    console.log(`  ${p.padEnd(8)} | ${magic(m0)}     | ${magic(m1)}          | ${magic(m2)}`);
  }

  console.log(`
  Cùng 100 LAMP, UM stale (fallback 0.5×) vs UM cao (1.5×):

  UM dùng  | Profile  | MAGIC nhận    | vs UM=1.0
  ` + "-".repeat(50));

  const baseline = computeInstantMagic(lampPaid, Q, PM_Q.Flame!);
  for (const um of [{ label: "0.50× (stale)", q: 500_000_000n },
                    { label: "1.00× (norm)",  q: 1_000_000_000n },
                    { label: "1.50× (hot)",   q: 1_500_000_000n }]) {
    const m = computeInstantMagic(lampPaid, um.q, PM_Q.Flame!);
    const ratio = baseline > 0n ? (m * 100n) / baseline : 0n;
    console.log(`  ${um.label.padEnd(8)} | Flame    | ${magic(m)}  | ${ratio}%`);
  }

  console.log(`
  📌 Đọc thế nào:
     • InstantGen KHÔNG dùng Loyalty Factor (B/N tier) — chỉ R_inst × UM × PM.
     • Tại k=1, batch bị HALVING (÷2) một lần — không phải decay từ từ.
     • Tại k=2 (=INSTANT_DECAY_WINDOW=${INSTANT_DECAY_WINDOW}) → cliff về 0. Khác hẳn Snapshot (tan dần).
     • UM stale (>1 epoch không update) → fallback 0.5× → user mất 50% MAGIC.
       Đây là lý do UMKeeper phải chạy liên tục.`);
}

// ── Section E: 10-epoch user journey ──────────────────────────

function sectionE_UserJourney(): void {
  h1("E. USER JOURNEY 10 EPOCH — TỔNG MAGIC SỐNG SAU MỖI HÀNH ĐỘNG");

  console.log(`
  Setup: user nắm 1000 LAMP từ epoch 0, profile = Flame, UM = 1.0× ổn định.
         OAC = 0.80 (chưa burn app nào).
  Hành động:
     • epoch 1: SnapshotGen (lần 1)
     • epoch 3: SnapshotGen (lần 2, catch-up Δe=2)
     • epoch 4: InstantGen — trả 100 LAMP
     • epoch 7: SnapshotGen (lần 3)
     • Mỗi epoch in tổng MAGIC còn sống trong vault.
`);

  type Batch = {
    source : "Snapshot" | "Instant";
    m0     : bigint;
    cur    : bigint;
    created: bigint;
    N      : bigint;
    halved : boolean;
  };

  const profile = "Flame";
  const N = BigInt(SS_PROFILE_PARAMS[profile]!.N);
  const lampStart = lampToOil(1000n);
  let lampBal = lampStart;
  let lastSnap = 0n;
  const batches: Batch[] = [];
  const totals: { epoch: bigint; total: bigint; note: string; live: number }[] = [];

  function pruneAndHalve(epoch: bigint): void {
    for (const b of batches) {
      const k = epoch - b.created;
      if (b.source === "Instant") {
        if (k === 1n && !b.halved) {
          b.cur = applyHalving(b.cur);
          b.halved = true;
        }
        if (k >= INSTANT_DECAY_WINDOW) b.cur = 0n;
      } else {
        // Snapshot batch
        if (k >= b.N) b.cur = 0n;
        else b.cur = snapshotBatchBalance(b.m0, profile, k);
      }
    }
  }

  function liveTotal(): bigint {
    return batches.reduce((s, b) => s + b.cur, 0n);
  }

  function snapshotAt(epoch: bigint): bigint {
    const dEpoch = epoch - lastSnap;
    // age-from-LF = epoch (holding acquired at 0)
    const lf = lfForAge(epoch);
    const oac = 800_000_000n;
    const mPer = computeSnapshotMagic(lampBal, lf, oac, profile);
    const mTotal = mPer * dEpoch;
    batches.push({
      source: "Snapshot", m0: mTotal, cur: mTotal,
      created: epoch, N, halved: false,
    });
    lastSnap = epoch;
    return mTotal;
  }

  function instantAt(epoch: bigint, paidLamp: bigint): bigint {
    const m = computeInstantMagic(paidLamp, Q, PM_Q[profile]!);
    batches.push({
      source: "Instant", m0: m, cur: m,
      created: epoch, N: INSTANT_DECAY_WINDOW, halved: false,
    });
    lampBal -= paidLamp;
    return m;
  }

  console.log("  Epoch | Action                          | LAMP   | Live MAGIC   | Batches | bar");
  console.log("  " + "-".repeat(86));

  let maxTotal = 1n;
  // Pre-simulate to find max for bar
  // (replay to compute totals, then print)
  const events: Array<{ epoch: bigint; action: () => string }> = [
    { epoch: 1n, action: () => `Snapshot → +${magic(snapshotAt(1n), 8).trim()} MAGIC` },
    { epoch: 3n, action: () => `Snapshot (Δe=2) → +${magic(snapshotAt(3n), 8).trim()} MAGIC` },
    { epoch: 4n, action: () => `Instant 100 LAMP → +${magic(instantAt(4n, lampToOil(100n)), 8).trim()} MAGIC` },
    { epoch: 7n, action: () => `Snapshot → +${magic(snapshotAt(7n), 8).trim()} MAGIC` },
  ];

  let eventIdx = 0;
  for (let e = 0n; e <= 10n; e++) {
    pruneAndHalve(e);
    let note = "—";
    while (eventIdx < events.length && events[eventIdx]!.epoch === e) {
      note = events[eventIdx]!.action();
      eventIdx++;
    }
    pruneAndHalve(e);  // re-prune in case event just added a batch (no-op for k=0)
    const total = liveTotal();
    if (total > maxTotal) maxTotal = total;
    const live = batches.filter(b => b.cur > 0n).length;
    totals.push({ epoch: e, total, note, live });
  }

  for (const { epoch, total, note, live } of totals) {
    const lampStr  = epoch >= 4n ? "900" : "1000";
    console.log(`  ${epoch.toString().padStart(5)} | ${note.padEnd(31)} | ${lampStr.padStart(6)} | ${magic(total)} | ${live.toString().padStart(7)} | ${bar(total, maxTotal, 16)}`);
  }

  console.log(`
  📌 Đọc thế nào:
     • Mỗi SnapshotGen tạo 1 batch mới. Các batch cũ vẫn tiếp tục decay song song.
     • Instant batch (epoch 4) sang epoch 5 bị halve, epoch 6 hết hẳn (cliff).
     • Lúc đỉnh, tổng live MAGIC = tổng của các batch còn sống. Sau đó giảm dần
       khi user ngừng thao tác.
     • Đây là lý do tại sao user CẦN SnapshotGen định kỳ — không hành động = mất MAGIC.`);
}

// ── helpers ───────────────────────────────────────────────────

function lfForAge(age: bigint): bigint {
  // mirror lfPwlQ
  if (age <= 0n) return Q;
  if (age <= 6n)  return Q + (Q / 10n) * age / 6n;
  if (age <= 12n) return Q + Q / 10n + (Q / 10n) * (age - 6n) / 6n;
  if (age <= 24n) return Q + Q / 5n + (3n * Q / 10n) * (age - 12n) / 12n;
  return 3n * Q / 2n;
}

// ── Main ──────────────────────────────────────────────────────

function main(): void {
  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║   MagicLamp UX Demo — LAMP nắm trong tay → MAGIC sinh ra & decay     ║");
  console.log("║   (Không tạo tx, chạy thẳng pure functions của SDK — < 1 giây)      ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  sectionA_RatePerProfile();
  sectionB_LfOacSweep();
  sectionC_SnapshotDecay();
  sectionD_InstantGen();
  sectionE_UserJourney();

  console.log("\n" + "═".repeat(70));
  console.log("  Kết thúc demo. Mọi con số trên dùng đúng SDK pure functions");
  console.log("  (computeSnapshotMagic, computeInstantMagic, snapshotBatchBalance, ...)");
  console.log("  cùng codebase với onchain validator. Khớp với spec §3, §6, §8, §9.");
  console.log("═".repeat(70) + "\n");
}

main();
