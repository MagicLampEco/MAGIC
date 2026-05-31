// Test helpers cho LampDistribution.
export { P_GENESIS, Q } from "../offchain/src/constants.js";

/** LAMP → oil (1 LAMP = 10^6 oil). */
export function lampOil(lamp: bigint): bigint {
  return lamp * 1_000_000n;
}
