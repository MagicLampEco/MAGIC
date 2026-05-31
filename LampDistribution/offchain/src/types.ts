// LampDistribution offchain types — mirror onchain types.ak (SPEC §5)

export interface ClaimAccountDatum {
  owner               : string;  // PKH hex
  claimed_cumulative  : bigint;  // oil
  redeemed_cumulative : bigint;  // oil
  last_claim_epoch    : bigint;
}

export type BeaconKind = "PParam" | "Randomness" | "MerkleRoot";

export interface BeaconDatum {
  epoch : bigint;
  kind  : BeaconKind;
  value : string;  // hex
}

export interface TreasuryDatum {
  committee_hash : string;  // hex
}

/** 1 dòng account đưa vào lottery engine. */
export interface LotteryAccount {
  owner        : string;  // PKH hex
  claimedCum   : bigint;  // oil
  wonCumPrev   : bigint;  // oil (won_cumulative tới epoch trước)
}

/** Kết quả lottery 1 epoch cho 1 wallet. */
export interface LotteryResult {
  owner      : string;
  wonCumNew  : bigint;   // won_cumulative tới epoch này (đơn điệu tăng)
  wonThis    : bigint;   // phần thắng trong epoch này
  tickets    : bigint;   // D
  wins       : bigint;   // d
}

/** Tín hiệu P parameter (SPEC §4). */
export interface PSignals {
  magicConsumed   : bigint;  // S1
  magicGenerated  : bigint;  // S2
  lampnetUtil     : bigint;  // S3 (đã quy về cùng đơn vị demand)
  claimedUnredeemed: bigint; // S4 (latent supply; chưa dùng MVP, để mở rộng)
}
