/**
 * FlowRate Preview Simulation — 2 price scenarios + MECE attack suite
 *
 * Đơn vị:
 *   oildrop      = LAMP × 10^6   (1 LAMP = 1_000_000 oildrop)
 *   nanogic  = MAGIC × 10^9  (1 MAGIC = 1_000_000_000 nanogic)
 *
 * Q-format: lamp_per_magic_q = Q × oildrop / nanogic
 *   → Q = 10^9 → 1 oildrop/nanogic → 1 LAMP per 10^3 MAGIC → 0.001 LAMP/MAGIC? No:
 *   Đúng: rate = Q → lamp_cap(1 MAGIC) = Q oildrop = 1000 LAMP
 *         rate = Q/10 → lamp_cap(1 MAGIC) = 100 LAMP
 *         rate = Q/100 → lamp_cap(1 MAGIC) = 10 LAMP
 *         HARD_FLOOR = 10M → lamp_cap(1 MAGIC) = 10 LAMP (= 10 LAMP/MAGIC)
 *
 * Governance initial rate = Q/10 = 100_000_000 (= 100 LAMP/MAGIC)
 * LampNet 1MB permanent = 204,800 nanogic × 100M/Q = 20,480 oildrop = 0.02 LAMP
 * At LAMP = $5: $0.10/MB permanent = $100/GB — cao vì permanently on-chain
 *
 * Scenario A: LAMP = $5 (stable), Apps pay at governance rate Q/10
 * Scenario B: LAMP drops 50% → $2.5, Apps must pay 2× → rate = Q/5
 */

import { updateFlowRate, HARD_FLOOR_Q, HARD_CEIL_Q, MIN_MAGIC_EPOCH } from '../offchain/src/math.js';
import { Q, FlowRateDatum, EpochFlow } from '../offchain/src/types.js';
import { bootstrapFlowRate } from '../offchain/src/keeper.js';

// ── Pure BigInt helpers ────────────────────────────────────────────────────
const absBig = (x: bigint) => (x < 0n ? -x : x);
const clampN = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

const fmtLampPerMagic = (q: bigint): string => {
  // rate_q / Q × 1000 = LAMP/MAGIC  (1 MAGIC = 10^9 ng, 1 LAMP = 10^6 oildrop)
  // oildrop/ng × Q = rate_q → oildrop/ng = rate_q/Q → LAMP/MAGIC = rate_q/Q × 10^9/10^6 = rate_q × 1000 / Q
  const lpm = Number(q) * 1000 / Number(Q);
  return `${lpm.toFixed(2)} LAMP/MAGIC (q=${q})`;
};
const fmtPct = (before: bigint, after: bigint): string => {
  if (before === 0n) return 'N/A';
  const pct = Number(after - before) * 100 / Number(before);
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
};
const hr = (label: string) => console.log(`\n${'═'.repeat(64)}\n${label}\n${'═'.repeat(64)}`);
const row = (label: string, val: string) => console.log(`  ${label.padEnd(34)} ${val}`);

// ── LampNet app cluster volume ──────────────────────────────────────────────
// 500 clusters; mỗi cluster = 5 app types
const MB    = 1024n;           // KB per MB
const PERM  = 200n;            // nanogic/KB permanent
const TEMP  = 1000n;           // nanogic/KB temporary

const PER_CLUSTER_NG =
    MB * 100n   * PERM           //  Storage-S:  100MB perm
  + MB * 1024n  * PERM           //  Storage-L:  1GB perm
  + MB * 500n   * TEMP           //  CDN:        500MB temp
  + MB * 10n    * PERM + MB * 50n * TEMP  // DeFi
  + MB * 2048n  * TEMP;          //  Social:     2GB temp

const CLUSTERS      = 500n;
const TOTAL_MAGIC_NG = PER_CLUSTER_NG * CLUSTERS;  // nanogic/epoch

// Governance initial rate: Q/10 = 100_000_000 (100 LAMP/MAGIC)
const RATE_A = Q / 10n;         // 100 LAMP/MAGIC — Scenario A (LAMP ổn định)
const RATE_B = Q / 5n;          // 200 LAMP/MAGIC — Scenario B (LAMP drops 50%)

// oildrop/epoch = magic_ng × rate_q / Q
const oildropAtRate = (rate_q: bigint): bigint => TOTAL_MAGIC_NG * rate_q / Q;
const makeFlow  = (epoch: number, rate_q: bigint): EpochFlow => ({
  total_lamp_oildrop: oildropAtRate(rate_q),
  total_magic_ng: TOTAL_MAGIC_NG,
  epoch,
});

// ── Init ───────────────────────────────────────────────────────────────────
hr('KHỞI TẠO HỆ THỐNG');
console.log('\nLampNet pricing (per KB):');
row('  Permanent',  '200 nanogic/KB');
row('  Temporary', '1000 nanogic/KB');
console.log('\nCluster app mix (mỗi cluster):');
[['Storage-S (100MB perm)', 100n * MB * PERM],
 ['Storage-L (1GB perm)', 1024n * MB * PERM],
 ['CDN (500MB temp)', 500n * MB * TEMP],
 ['DeFi (10MB perm + 50MB temp)', 10n * MB * PERM + 50n * MB * TEMP],
 ['Social-App (2GB temp)', 2048n * MB * TEMP],
].forEach(([name, ng]) =>
  console.log(`  ${String(name).padEnd(34)} ${(Number(ng)/1e9).toFixed(4)} MAGIC`)
);
console.log();
row('MAGIC/epoch (1 cluster)', `${(Number(PER_CLUSTER_NG)/1e9).toFixed(4)} MAGIC`);
row('× Clusters (500)', `${(Number(TOTAL_MAGIC_NG)/1e9).toFixed(2)} MAGIC/epoch`);
row('MIN_MAGIC_EPOCH', `${Number(MIN_MAGIC_EPOCH)/1e9} MAGIC`);
row('Vượt threshold?', TOTAL_MAGIC_NG >= MIN_MAGIC_EPOCH
  ? `✅ ${(Number(TOTAL_MAGIC_NG)/1e9).toFixed(0)} ≥ 1000`
  : `❌ ${(Number(TOTAL_MAGIC_NG)/1e9).toFixed(0)} < 1000`);
console.log('\nEconomics check (tại LAMP = $5/LAMP):');
row('  1MB permanent cost (nanogic)', `${(1024 * 200).toLocaleString()} = 0.0002048 MAGIC`);
const cost_mb_oildrop = Number(1024n * PERM * RATE_A / Q);
row('  1MB permanent cost (oildrop)', `${cost_mb_oildrop.toFixed(0)} oildrop = ${(cost_mb_oildrop/1e6).toFixed(6)} LAMP = $${(cost_mb_oildrop/1e6*5).toFixed(4)}`);
row('  HARD_FLOOR_Q', fmtLampPerMagic(HARD_FLOOR_Q));
row('  Rate Scenario A (governance)', fmtLampPerMagic(RATE_A));
row('  Rate Scenario B (post-drop)', fmtLampPerMagic(RATE_B));

// Bootstrap
const INITIAL = bootstrapFlowRate(RATE_A, 0);
console.log('\n  Bootstrap:', fmtLampPerMagic(INITIAL.lamp_per_magic_q));

// ── Scenario runner ────────────────────────────────────────────────────────
function runScenario(label: string, init: FlowRateDatum, flows: EpochFlow[]): FlowRateDatum {
  hr(label);
  let s = init;
  for (const f of flows) {
    const prev = s.lamp_per_magic_q;
    const raw_q = f.total_lamp_oildrop * Q / f.total_magic_ng;
    s = updateFlowRate(s, f);
    const pct = Number(s.lamp_per_magic_q - prev) * 100 / Number(prev);
    const dir = pct > 0.005 ? '▲' : pct < -0.005 ? '▼' : '─';
    console.log(`  Epoch ${String(f.epoch).padStart(2)} ${dir}`);
    row('    LAMP paid', `${(Number(f.total_lamp_oildrop)/1e6).toFixed(0).padStart(8)} LAMP / epoch`);
    row('    MAGIC consumed', `${(Number(f.total_magic_ng)/1e9).toFixed(2)} MAGIC / epoch`);
    row('    Raw rate',   fmtLampPerMagic(raw_q));
    row('    EMA fast',   fmtLampPerMagic(s.ema_fast_q));
    row('    EMA slow',   fmtLampPerMagic(s.ema_slow_q));
    row('    Divergence', `${(Number(s.div_q)/Number(Q)*100).toFixed(2)}%`);
    row('    Adaptive cap', `${(Number(s.cap_q)/Number(Q)*100).toFixed(2)}%`);
    row('    Rate output', `${fmtLampPerMagic(s.lamp_per_magic_q)} [${fmtPct(prev, s.lamp_per_magic_q)}]`);
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO A: ổn định 3 epoch tại Q/10 (100 LAMP/MAGIC)
// ═══════════════════════════════════════════════════════════════════════════
const stateA = runScenario(
  'SCENARIO A — LAMP ổn định ($5/LAMP), rate = 100 LAMP/MAGIC — 3 epoch',
  INITIAL,
  [1, 2, 3].map(e => makeFlow(e, RATE_A))
);

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO B: LAMP giảm 50% → Apps trả 2× LAMP → rate mới = 200 LAMP/MAGIC
// ═══════════════════════════════════════════════════════════════════════════
const stateB = runScenario(
  'SCENARIO B — LAMP giảm 50% ($5→$2.5), Apps tăng LAMP 2×, rate mới = 200 LAMP/MAGIC — 10 epoch',
  stateA,
  [4,5,6,7,8,9,10,11,12,13].map(e => makeFlow(e, RATE_B))
);

console.log('\n── Kết luận Scenario A→B ──');
row('Rate ban đầu (governance)', fmtLampPerMagic(RATE_A));
row('Rate sau 3 epoch ổn định', fmtLampPerMagic(stateA.lamp_per_magic_q));
row('Rate sau 10 epoch thích nghi', fmtLampPerMagic(stateB.lamp_per_magic_q));
row('Target lý thuyết mới', fmtLampPerMagic(RATE_B));
row('Tiến độ thích nghi', `${fmtPct(RATE_A, stateB.lamp_per_magic_q)} / mục tiêu +100%`);
row('Hướng đúng (rate ↑)?', stateB.lamp_per_magic_q > RATE_A ? '✅ Tăng đúng hướng' : '❌ Sai');

// ═══════════════════════════════════════════════════════════════════════════
// MECE ATTACK SUITE — 8 attack vectors toàn diện
// ═══════════════════════════════════════════════════════════════════════════
hr('MECE ATTACK SUITE (8 vectors)');

interface Res { name: string; maxDelta: number; finalDev: number; verdict: string; }
const results: Res[] = [];

function attack(
  name: string,
  desc: string,
  attack_flows: EpochFlow[],
  recovery_flows: EpochFlow[],
  accept_pct = 50,
): void {
  let s = { ...INITIAL };
  let maxDelta = 0;
  for (const f of attack_flows) {
    const prev = s.lamp_per_magic_q;
    s = updateFlowRate(s, f);
    const d = Number(absBig(s.lamp_per_magic_q - prev)) * 100 / Number(prev);
    if (d > maxDelta) maxDelta = d;
  }
  const rateAfterAttack = s.lamp_per_magic_q;
  for (const f of recovery_flows) s = updateFlowRate(s, f);
  const finalDev = Number(absBig(s.lamp_per_magic_q - RATE_A)) * 100 / Number(RATE_A);
  const verdict = finalDev < accept_pct ? '✅ RESIST' : finalDev < 100 ? '⚠️ PARTIAL' : '❌ FAIL';
  results.push({ name, maxDelta, finalDev, verdict });

  const bar = '█'.repeat(clampN(Math.round(maxDelta / 5), 0, 20));
  console.log(`\n  [${verdict}] ${name}`);
  console.log(`    ${desc}`);
  row('    Max Δ per epoch', `${maxDelta.toFixed(2)}%  ${bar}`);
  row('    Rate setelah attack', fmtLampPerMagic(rateAfterAttack));
  row('    Rate setelah recovery', fmtLampPerMagic(s.lamp_per_magic_q));
  row('    Lệch so với baseline', `${fmtPct(RATE_A, s.lamp_per_magic_q)} (threshold ${accept_pct}%)`);
}

// A-1: Flash pump 10× — 1 epoch spike mạnh
attack(
  'A-1: Flash pump 10× (1 epoch spike)',
  'Attacker nộp 10× LAMP trong 1 epoch. Adaptive cap siết khi divergence cao.',
  [{ ...makeFlow(1, RATE_A * 10n) }],
  [2,3,4,5,6].map(e => makeFlow(e, RATE_A))
);

// A-2: Flash dump 90% — 1 epoch LAMP gần 0
attack(
  'A-2: Flash dump 90% (1 epoch rate collapse)',
  'MAGIC tiêu thật nhưng LAMP trả gần 0. Kiểm tra floor và slow-EMA resistance.',
  [{ total_lamp_oildrop: oildropAtRate(RATE_A) / 10n, total_magic_ng: TOTAL_MAGIC_NG, epoch: 1 }],
  [2,3,4,5,6].map(e => makeFlow(e, RATE_A))
);

// A-3: Sustained pump 5× — 6 epoch liên tục
attack(
  'A-3: Sustained pump 5× (6 epochs)',
  '6 epoch liên tục 5× rate. Attacker phải chi LAMP thật → expensive. Slow EMA resists.',
  [1,2,3,4,5,6].map(e => makeFlow(e, RATE_A * 5n)),
  [7,8,9,10,11].map(e => makeFlow(e, RATE_A))
);

// A-4: Oscillation — pump/dump mỗi epoch
attack(
  'A-4: Oscillation pump/dump (8 epochs alternating)',
  'Rate dao động ×5 / ÷5 mỗi epoch. Trung bình = baseline nhưng EMA bị nhiễu.',
  [1,2,3,4,5,6,7,8].map(e => ({
    total_lamp_oildrop: e % 2 === 1 ? oildropAtRate(RATE_A * 5n) : oildropAtRate(RATE_A / 5n),
    total_magic_ng: TOTAL_MAGIC_NG,
    epoch: e,
  })),
  []
);

// A-5: Sybil 100 apps phối hợp (3× rate tổng)
attack(
  'A-5: Sybil 100 apps phối hợp 3× (3 epochs)',
  '100 app ảo nộp 3× LAMP/MAGIC. Volume MAGIC cũng ×100 (cần tiêu MAGIC thật).',
  [1,2,3].map(e => ({
    total_lamp_oildrop: oildropAtRate(RATE_A) * 300n,  // 100 apps × 3× rate
    total_magic_ng: TOTAL_MAGIC_NG * 100n,      // 100 apps × magic
    epoch: e,
  })),
  [4,5,6,7,8].map(e => makeFlow(e, RATE_A))
);

// A-6: Keeper offline 8 epoch rồi jump lên 5×
attack(
  'A-6: Keeper stale 8 epochs rồi jump 5×',
  'Guard "epoch must advance" ngăn retroactive update. Epoch 9 submit 5× rate.',
  [makeFlow(9, RATE_A * 5n)],   // chỉ epoch 9, bỏ qua 1-8
  [10,11,12,13,14].map(e => makeFlow(e, RATE_A))
);

// A-7: Dust magic — dưới MIN_MAGIC_EPOCH guard
attack(
  'A-7: Dust MAGIC (below 1000 MAGIC threshold)',
  'total_magic < MIN_MAGIC_EPOCH → guard skip update, rate không đổi.',
  [{ total_lamp_oildrop: 10_000_000_000n, total_magic_ng: MIN_MAGIC_EPOCH - 1n, epoch: 1 }],
  [2,3,4].map(e => makeFlow(e, RATE_A))
);

// A-8: Overflow — HARD_CEIL_Q clamp
attack(
  'A-8: Overflow — HARD_CEIL_Q clamp',
  'lamp_oildrop = 10^16 → raw rate_q = 10^13 >> HARD_CEIL (10^10) → clamp + rapid recovery.',
  [{ total_lamp_oildrop: 10_000_000_000_000_000n, total_magic_ng: TOTAL_MAGIC_NG, epoch: 1 }],
  [2,3,4,5,6,7,8,9,10].map(e => makeFlow(e, RATE_A))
);

// ── Final summary ──────────────────────────────────────────────────────────
hr('TỔNG KẾT');
console.log('\nScenario A→B (LAMP $5 → $2.5, 13 epoch):');
row('  Rate khởi đầu (governance)', fmtLampPerMagic(RATE_A));
row('  Rate sau 3 epoch ổn định', fmtLampPerMagic(stateA.lamp_per_magic_q));
row('  Rate sau 13 epoch thích nghi', fmtLampPerMagic(stateB.lamp_per_magic_q));
row('  Mục tiêu lý thuyết', fmtLampPerMagic(RATE_B));
const adaption_pct = Number(stateB.lamp_per_magic_q - RATE_A) * 100 / Number(RATE_A);
row('  Thích nghi', `${adaption_pct.toFixed(1)}% / mục tiêu 100% (EMA cần 20+ epoch hội tụ)`);

console.log('\nMECE Attack Results:');
console.log('  Vector'.padEnd(50) + 'MaxΔ'.padStart(8) + '  Verdict');
console.log('  ' + '─'.repeat(68));
results.forEach(r => {
  console.log(`  ${r.name.padEnd(50)}${r.maxDelta.toFixed(1).padStart(6)}%  ${r.verdict}`);
});
const pass = results.filter(r => r.verdict.includes('RESIST')).length;
const warn = results.filter(r => r.verdict.includes('PARTIAL')).length;
const fail = results.filter(r => r.verdict.includes('FAIL')).length;
console.log(`\n  RESIST ${pass}/${results.length}   PARTIAL ${warn}   FAIL ${fail}`);
console.log(fail === 0 ? '\n  ✅ HỆ THỐNG ỔN ĐỊNH — FlowRate math xác nhận sẵn sàng Preview deploy' :
  '\n  ⚠️ CÒN VẤN ĐỀ — kiểm tra trước deploy');
