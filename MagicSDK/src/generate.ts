// MagicSDK/src/generate.ts — the MAGIC generation surface for integrators (Gen v2.0).
//
// WHY THIS FILE EXISTS
// -------------------
// The gen builders live inside the per-module offchain packages
// (`InstantGen/offchain/src/instant.ts`, `ScheduleGen/offchain/src/schedule.ts`).
// An integrating app cannot import a repo path, so this module re-exports those
// builders by NAME through `@magiclamp/sdk`, the single entry point every
// integrator is allowed to depend on. SDK không bọc lại logic nào ở đây.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
// * VacuumGen và SnapshotGen — đã dời sang `Legacy/`.
// * `diagnoseCeilings` — đã BỎ ở InstantGen Gen v2.0. Thay bằng `instantGenLimits(ctx)`:
//   trả `maxM` (m lớn nhất qua được cả bốn trần IG-8/9/11/12) cùng từng trần riêng.
//
// Named re-exports only (no `export *`): the module packages each ship their own
// `createLucid`, `Q`, `TESTNET_CONFIG`, `VaultDatum`, … and a wildcard would collide.

// ── InstantGen ────────────────────────────────────────────────
//
// Gen v2.0: chủ két CHỌN lượng sinh `m` (nanogic); validator ép `m` qua cổng IG-1..IG-14
// chứ không tự tính. Lượt sinh TIÊU shard GreenBack của két (`vaultShardId(owner)`) và trả
// shard với `remaining` giảm đúng `m`; đọc beacon GB + sổ két (+ beacon ρ và két Wakeme khi
// lượt này làm mới checkpoint). LAMP không rời két (I-ACT-7).
//
// `buildRefreshCheckpointTx` — làm mới năm ô checkpoint (đầu epoch, hoặc nối/gỡ két Wakeme)
// mà không làm gì khác. Chủ ký; luôn cần beacon ρ.
export {
  buildInstantGenTx,
  buildRefreshCheckpointTx,
  instantGenLimits,
  computeInstantGenOutputs,
  computeRefreshCheckpointOutput,
  applyInstantVaultParams,
  vaultShardId,
  shardNftName,
  readWakemeVault,
  expectedCheckpoint,
  expectedCheckpointForGen,
  currentCheckpoint,
  INSTANT_VAULT_PARAM_TITLES,
  type InstantGenParams,
  type InstantGenResult,
  type InstantGenContext,
  type InstantGenLimits,
  type InstantGenOutputs,
  type RefreshCheckpointParams,
  type RefreshCheckpointResult,
  type InstantVaultParams,
  type Checkpoint,
  type WakemeRead,
  type LentReadContext,
  type RateParam,
  type GreenBackBeacon,
  type GbShard,
} from "@magiclamp/instantgen-sdk";

// ── ScheduleGen ───────────────────────────────────────────────
//
// Two phases. Commit locks the rate and the LAMP; Fire releases the lock and
// mints the batch. I-ACT-7 holds on both. Fire is permissionless and Gen v2.0
// Fire đọc `m_per_epoch` đã chốt, KHÔNG đọc beacon.
//
// Gen v2.0: két uỷ TOÀN BỘ luật ký cho validator withdraw-zero `commit`. Commit đòi
// `commitScript` (từ `applyVaultValidator("Schedule", …).commitScript`), hai beacon (ρ, GB),
// sổ két và 16 shard GB. Stake credential của `commit` phải ĐĂNG KÝ một lần trước
// (`buildRegisterCommitStakeTx`), nếu không ledger bác mọi lượt ký.
export {
  buildScheduleCommitTx,
  buildScheduleFireTx,
  buildRegisterCommitStakeTx,
  applyScheduleScripts,
  SCHEDULE_COMMIT_PARAM_NAMES,
  SCHEDULE_VAULT_PARAM_NAMES,
  type CommitParams,
  type CommitResult,
  type FireParams,
  type FireResult,
  type GenBeaconParams,
  type RegisterCommitStakeParams,
  type ScheduleScriptParams,
  type ScheduleScripts,
} from "@magiclamp/schedulegen-sdk";

// ── Units ─────────────────────────────────────────────────────
//
// MAGIC amounts crossing this boundary are ALWAYS raw nanogic (BigInt).
// 1 MAGIC = 10^9 nanogic; display = amount / 10^NANOGIC_DECIMALS.
// LAMP amounts are raw oildrop: 1 LAMP = 10^6 oildrop.
// Never convert with `Number` — see C-OVERFLOW.
export const NANOGIC_DECIMALS = 9;
export const NANOGIC_PER_MAGIC = 1_000_000_000n;
export const OILDROP_DECIMALS = 6;
export const OILDROP_PER_LAMP = 1_000_000n;
