// lib/getmagic/types.ak — GetMAGIC Data Structures
// Phase 1: Allocation tracking layer (no BurnBatch integration yet)
// All field names and ordering must match on-chain encoding exactly.

use cardano/address.{Credential}

// ── OTC Order ────────────────────────────────────────────────

/// Datum attached to an OTC Order UTxO while awaiting VeData oracle settlement.
///
/// Lifecycle: Created off-chain → Settled (→ AllocationDatum minted) | Expired | Cancelled
pub type OrderDatum {
  order_id:         ByteArray,        // 16-char unique [A-Z0-9]
  org_pkh:          ByteArray,        // Org payment key hash (28 bytes)
  user_pkh:         ByteArray,        // User payment key hash (28 bytes)
  user_stake_cred:  Option<Credential>,
  magic_per_epoch:  Int,              // nanogic (10 MAGIC = 10_000_000_000)
  total_epochs:     Int,              // 6
  fiat_amount_vnd:  Int,              // e.g. 200_000
  created_posix_ms: Int,
  expiry_posix_ms:  Int,              // created + 14_400_000 (4 hours)
  oracle_vkey:      ByteArray,        // 32-byte Ed25519 vkey
}

/// Redeemer for the OTC Order validator.
pub type OrderRedeemer {
  // Oracle confirmed VeData payment → produce AllocationDatum
  Settle {
    oracle_nonce:     ByteArray,
    oracle_timestamp: Int,            // Unix ms when VeData signed
    oracle_signature: ByteArray,      // 64-byte Ed25519 sig
    epoch_vouchers:   List<ByteArray>, // total_epochs pre-signed vouchers
  }
  // Unlock after expiry_posix_ms (no payment received)
  Expire
  // Org cancels before user pays (oracle has not signed)
  Cancel
}

// ── Magic Allocation ─────────────────────────────────────────

/// Datum on an AllocationDatum UTxO — tracks per-epoch claim rights.
///
/// Invariants:
///   G-ALLOC-2: claimed_epochs grows monotonically; entries cannot be removed
///   G-ALLOC-4: total claimable = total_epochs - len(claimed_epochs)
///   G-ALLOC-5: voucher at index (epoch - start_epoch) authorises that epoch
pub type AllocationDatum {
  alloc_id:             ByteArray,    // blake2b_256(order_id ++ user_pkh)
  order_id:             ByteArray,
  org_pkh:              ByteArray,
  org_vault_nft_policy: ByteArray,   // PolicyId of Org's vault NFT
  beneficiary_pkh:      ByteArray,
  beneficiary_stake:    Option<Credential>,
  magic_per_epoch:      Int,          // 10_000_000_000 nanogic
  total_epochs:         Int,          // 6
  claimed_epochs:       List<Int>,    // epochs already claimed (sorted ascending)
  start_epoch:          Int,
  expiry_epoch:         Int,          // start_epoch + total_epochs
  vouchers:             List<ByteArray>, // pre-signed epoch vouchers from oracle
  oracle_vkey:          ByteArray,
}

/// Redeemer for the Allocation validator.
pub type AllocationRedeemer {
  // Claim rights for a specific epoch (voucher-verified)
  ClaimEpoch {
    epoch:  Int,                      // epoch to claim; must be in [start_epoch, expiry_epoch)
    um_ref: Data,                     // OutputReference to UMKeeper UTxO (reserved for Phase 2)
  }
  // Org reclaims the UTxO after expiry_epoch passes
  ReclaimExpired
  // Beneficiary surrenders all remaining epochs
  Surrender
}

// ── Org Registry ─────────────────────────────────────────────

/// Datum for an Organisation registry UTxO (simplified Phase 1).
pub type OrgDatum {
  org_pkh:                ByteArray,
  lamp_locked_oil:        Int,        // LAMP locked as collateral
  magic_quota_nanogic:    Int,        // total MAGIC quota
  magic_reserved_nanogic: Int,        // currently reserved in active orders
  bank_account_hash:      ByteArray,  // blake2b_256(account_no ++ bank_name)
  alepay_merchant_hash:   ByteArray,  // blake2b_256(merchant_id) — off-chain ref
  oracle_vkey:            ByteArray,
  released_nonces:        List<ByteArray>, // anti-replay (prune after 4h TTL)
  is_active:              Bool,
  min_fiat_vnd:           Int,        // 50_000
  max_fiat_vnd:           Int,        // 1_000_000
}

/// Redeemer for the Org registry validator.
pub type OrgRedeemer {
  Register
  ReserveQuota { order_id: ByteArray, nanogic: Int }
  SettleOrder  { order_id: ByteArray, nonce: ByteArray }
  ExpireOrder  { order_id: ByteArray }
  Suspend
  Withdraw     { lamp_amount: Int }
}
