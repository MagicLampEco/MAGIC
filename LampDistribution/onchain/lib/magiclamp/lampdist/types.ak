// LampDistribution onchain types — interface contract (SPEC §5)
// Phải khớp byte-perfect với offchain types.ts (Constr index theo thứ tự khai báo).

/// Per-wallet account tại claim_account script (QĐ5).
/// Mọi giá trị là oil. Bất biến: 0 ≤ redeemed_cumulative ≤ claimed_cumulative.
pub type ClaimAccountDatum {
  owner               : ByteArray,   // PKH chủ ví
  claimed_cumulative  : Int,         // tổng đã claim (committee confirm)
  redeemed_cumulative : Int,         // tổng đã rút ra ví
  last_claim_epoch    : Int,
}

pub type ClaimAccountRedeemer {
  // committee 2/3 confirm activity → claimed_cumulative += amount
  Claim { amount: Int }
  // user redeem với Merkle proof của won_cumulative (cumulative, QĐ6)
  Redeem { won_cumulative: Int, lottery_epoch: Int, proof: List<ByteArray> }
}

pub type BeaconKind {
  PParam
  Randomness
  MerkleRoot
}

/// Beacon UTxO do committee post (QĐ2/QĐ3). value:
///   PParam     → P (oil) big-endian
///   Randomness → epoch nonce (32 bytes)
///   MerkleRoot → merkle root (32 bytes)
pub type BeaconDatum {
  epoch : Int,
  kind  : BeaconKind,
  value : ByteArray,
}

pub type BeaconRedeemer {
  // committee post giá trị mới cho epoch kế tiếp
  PostBeacon
}

/// Treasury UTxO giữ LAMP pool (QĐ7).
pub type TreasuryDatum {
  committee_hash : ByteArray,
}

pub type TreasuryRedeemer {
  // release LAMP cho các Redeem trong cùng tx
  ReleaseForRedeem
}
