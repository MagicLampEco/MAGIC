// MagicSDK/src/generate.ts — the MAGIC generation surface for integrators.
//
// WHY THIS FILE EXISTS
// -------------------
// Until now the gen builders lived only inside the per-module offchain packages
// (`InstantGen/offchain/src/instant.ts`, `ScheduleGen/offchain/src/schedule.ts`).
// An integrating app cannot import a repo path, so there was no way for any app
// to trigger InstantGen / ScheduleGen — a contract gap, not missing code.
// This module re-exports those builders by NAME through `@magiclamp/sdk`, which
// is the single entry point every integrator is allowed to depend on.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
// * VacuumGen — its validator still moves LAMP out of the vault to a treasury
//   address. That contradicts I-ACT-7 (LAMP never changes hands when MAGIC is
//   generated). It stays unexported until it is brought onto the PHA-2 model.
// * SnapshotGen — not yet converged onto the PHA-2 unified vault datum.
//
// Named re-exports only (no `export *`): the module packages each ship their own
// `createLucid`, `Q`, `TESTNET_CONFIG`, … and a wildcard would collide.

// ── InstantGen ────────────────────────────────────────────────
//
// I-ACT-7: LAMP does NOT leave the vault. There is no `lampPaid` and no
// treasury leg — the grant is keyed to `consumed_credit`, and
// `InstantGenResult.newLampBalance` always equals the balance before the tx.
//
// FAIL-CLOSED: `backingBeaconUtxo` is REQUIRED. While CARP has not shipped the
// beacon, no reference input can satisfy the lookup, `cap_surplus` cannot be
// evaluated, and the gen door stays SHUT by design. Building the tx will fail —
// that is the intended state, not a bug to route around.
export {
  buildInstantGenTx,
  diagnoseCeilings,
  type InstantGenParams,
  type InstantGenResult,
} from "@magiclamp/instantgen-sdk";

// ── ScheduleGen ───────────────────────────────────────────────
//
// Two phases. Commit locks the rate and the LAMP; Fire releases the lock and
// mints the batch. I-ACT-7 holds on both: `FireResult.lampReleased` leaves the
// LOCKED pool but stays in the vault. Fire is permissionless (no owner sig), so
// an app, a keeper, or anyone else may drive it.
//
// ScheduleGen needs no BackingBeacon, so this is the generation path that is
// reachable today.
export {
  buildScheduleCommitTx,
  buildScheduleFireTx,
  type CommitParams,
  type CommitResult,
  type FireParams,
  type FireResult,
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
