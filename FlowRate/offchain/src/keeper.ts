// FlowRateKeeper — reads all SponsorMeter UTxOs each epoch, aggregates,
// submits FlowRateDatum update to FlowRateBeacon.
// This is the permissionless off-chain keeper (similar to UMKeeper).

import { Q, FlowRateDatum, EpochFlow } from './types.js';

export interface SponsorMeterSummary {
  app_id: string;
  epoch: number;
  global_lamp_epoch: bigint;   // oildrop
  global_magic_epoch: bigint;  // nanogic
}

// Aggregate all SponsorMeter summaries for a given epoch
export function aggregateEpochFlow(meters: SponsorMeterSummary[], epoch: number): EpochFlow {
  let total_lamp = 0n;
  let total_magic = 0n;
  for (const m of meters) {
    if (m.epoch === epoch) {
      total_lamp += m.global_lamp_epoch;
      total_magic += m.global_magic_epoch;
    }
  }
  return { total_lamp_oildrop: total_lamp, total_magic_ng: total_magic, epoch };
}

// Compute implied rate from epoch flow (for logging/monitoring)
export function impliedRate(flow: EpochFlow): bigint {
  if (flow.total_magic_ng === 0n) return 0n;
  return flow.total_lamp_oildrop * Q / flow.total_magic_ng;
}

// Initial state for FlowRate beacon (bootstrap)
// DAO sets initial lamp_per_magic_q as governance parameter
export function bootstrapFlowRate(initial_rate_q: bigint, epoch: number): FlowRateDatum {
  return {
    ema_fast_q: initial_rate_q,
    ema_slow_q: initial_rate_q,
    lamp_per_magic_q: initial_rate_q,
    total_lamp_epoch: 0n,
    total_magic_epoch: 0n,
    last_epoch: epoch - 1,
    div_q: 0n,
    cap_q: 250_000_000n,  // 25% — full cap at bootstrap
  };
}
