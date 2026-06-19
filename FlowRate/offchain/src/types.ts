export const Q = 1_000_000_000n;

// On-chain beacon datum (matches Aiken FlowRateDatum when deployed)
export interface FlowRateDatum {
  ema_fast_q: bigint;        // Fast EMA, Q-format (oil/nanogic × Q)
  ema_slow_q: bigint;        // Slow EMA, Q-format
  lamp_per_magic_q: bigint;  // Current output rate, Q-format
  total_lamp_epoch: bigint;  // Last epoch Σ global_lamp_epoch (oil)
  total_magic_epoch: bigint; // Last epoch Σ global_magic_epoch (nanogic)
  last_epoch: number;        // Epoch of last update
  div_q: bigint;             // Current divergence |fast-slow|/slow × Q
  cap_q: bigint;             // Current adaptive cap in Q-format
}

// Per-epoch input from keeper (aggregated from all SponsorMeter UTxOs)
export interface EpochFlow {
  total_lamp_oil: bigint;    // Σ global_lamp_epoch across ALL apps
  total_magic_ng: bigint;    // Σ global_magic_epoch across ALL apps
  epoch: number;
}
