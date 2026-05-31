// LampDistribution constants — mirror onchain constants.ak (SPEC §7)
// ALL arithmetic BigInt. Đơn vị oil. Q = 10^9.

export const Q = 1_000_000_000n;

// P parameter (oil/drop)
export const P_GENESIS = 100_000_000n;     // 100 LAMP
export const P_MIN     = 10_000_000n;      // 10 LAMP
export const P_MAX     = 10_000_000_000n;  // 10_000 LAMP

// P adjustment
export const MAX_P_DELTA_Q = 100_000_000n; // ±10% = 0.10 × Q
export const P_EMA_WINDOW  = 3n;           // α = 0.5
// Sensitivity factor: ánh xạ imbalance phân số → P change phân số.
// MVP = 1.0 (Q): raw_delta = ratio − 1 trực tiếp. Clamp ±10% chi phối.
// [Design choice — SPEC §4; điều chỉnh khi có dữ liệu thực ecosystem.]
export const SENSITIVITY_Q = Q;

// Lottery
export const TARGET_RATE_Q = 3_300_000n;   // 0.33% (Q)

// Merkle domain separation
export const MERKLE_LEAF_PREFIX = 0x00;
export const MERKLE_NODE_PREFIX = 0x01;
