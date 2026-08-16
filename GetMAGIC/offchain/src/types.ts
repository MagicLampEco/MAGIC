// src/types.ts — TypeScript mirror of Aiken types + Lucid Evolution Data schemas
// Constructor indices must match Aiken type ordering (Plutus Data encoding).
// Source of truth: GetMAGIC/onchain/lib/getmagic/types.ak

import { Data } from "@lucid-evolution/lucid";

// ── Primitive ────────────────────────────────────────────────
export type Natural = bigint;

// ── Constants ────────────────────────────────────────────────
export const MAGIC_PER_EPOCH      = 10_000_000_000n; // 10 MAGIC in nanogic
export const DEFAULT_TOTAL_EPOCHS = 6n;
export const FIAT_AMOUNT_VND      = 200_000n;
export const ORDER_EXPIRY_MS      = 4 * 60 * 60 * 1000;   // 4 hours in ms
export const ORACLE_TTL_MS        = 3_600_000;              // 1 hour
export const Q                    = 1_000_000_000n;

// Validator hashes (from GetMAGIC/onchain/plutus.json)
export const MAGIC_ALLOCATION_HASH = "b3cf144bd30656a102d164004a024db36b7c0af2ac315ea3bb3c82ee";
export const OTC_ORDER_HASH_PARAM  = "e16945d77f247fb02379ec84a940f3b0fdd08278104b9fadf6497619";

// ── Credential (mirrors Aiken cardano/address.Credential) ────
// Constr 0=VerificationKey, 1=Script
export const CredentialSchema = Data.Enum([
  Data.Object({ VerificationKey: Data.Object({ hash: Data.Bytes() }) }),  // constr 0
  Data.Object({ Script:           Data.Object({ hash: Data.Bytes() }) }), // constr 1
]);
export type Credential = Data.Static<typeof CredentialSchema>;

// ── OrderDatum ───────────────────────────────────────────────
// Mirrors Aiken: getmagic/types.ak :: OrderDatum
// Fields order must match Aiken constructor ordering.
export const OrderDatumSchema = Data.Object({
  order_id:         Data.Bytes(),               // 16-char unique ID in bytes
  org_pkh:          Data.Bytes(),               // 28-byte payment key hash
  user_pkh:         Data.Bytes(),               // 28-byte payment key hash
  user_stake_cred:  Data.Nullable(CredentialSchema),
  magic_per_epoch:  Data.Integer(),             // nanogic
  total_epochs:     Data.Integer(),             // 6
  fiat_amount_vnd:  Data.Integer(),             // e.g. 200_000
  created_posix_ms: Data.Integer(),
  expiry_posix_ms:  Data.Integer(),             // created + 14_400_000
  oracle_vkey:      Data.Bytes(),               // 32-byte Ed25519 vkey
});
export type OrderDatum = Data.Static<typeof OrderDatumSchema>;

// ── OrderRedeemer ─────────────────────────────────────────────
// Constr 0=Settle, 1=Expire, 2=Cancel (match Aiken enum ordering)
export const OrderRedeemerSchema = Data.Enum([
  Data.Object({                                 // constr 0
    Settle: Data.Object({
      oracle_nonce:     Data.Bytes(),
      oracle_timestamp: Data.Integer(),
      oracle_signature: Data.Bytes(),
      epoch_vouchers:   Data.Array(Data.Bytes()),
    }),
  }),
  Data.Literal("Expire"),                       // constr 1
  Data.Literal("Cancel"),                       // constr 2
]);
export type OrderRedeemer = Data.Static<typeof OrderRedeemerSchema>;

// ── AllocationDatum ──────────────────────────────────────────
// Mirrors Aiken: getmagic/types.ak :: AllocationDatum
export const AllocationDatumSchema = Data.Object({
  alloc_id:             Data.Bytes(),           // deriveAllocId() — 32 bytes, framed (nợ #26)
  order_id:             Data.Bytes(),
  org_pkh:              Data.Bytes(),
  org_vault_nft_policy: Data.Bytes(),
  beneficiary_pkh:      Data.Bytes(),
  beneficiary_stake:    Data.Nullable(CredentialSchema),
  magic_per_epoch:      Data.Integer(),         // 10_000_000_000 nanogic
  total_epochs:         Data.Integer(),         // 6
  claimed_epochs:       Data.Array(Data.Integer()), // sorted ascending
  start_epoch:          Data.Integer(),
  expiry_epoch:         Data.Integer(),         // start_epoch + total_epochs
  vouchers:             Data.Array(Data.Bytes()),
  oracle_vkey:          Data.Bytes(),
});
export type AllocationDatum = Data.Static<typeof AllocationDatumSchema>;

// ── AllocationRedeemer ────────────────────────────────────────
// Constr 0=ClaimEpoch, 1=ReclaimExpired, 2=Surrender
// Note: um_ref is Data (opaque) in Aiken — use Data.Any()
export const AllocationRedeemerSchema = Data.Enum([
  Data.Object({                                 // constr 0
    ClaimEpoch: Data.Object({
      epoch:  Data.Integer(),
      um_ref: Data.Any(),                       // OutputReference (reserved Phase 2)
    }),
  }),
  Data.Literal("ReclaimExpired"),               // constr 1
  Data.Literal("Surrender"),                    // constr 2
]);
export type AllocationRedeemer = Data.Static<typeof AllocationRedeemerSchema>;

// ── OrgDatum ─────────────────────────────────────────────────
// Mirrors Aiken: getmagic/types.ak :: OrgDatum
export const OrgDatumSchema = Data.Object({
  org_pkh:                Data.Bytes(),
  lamp_locked_oil:        Data.Integer(),       // LAMP locked as collateral
  magic_quota_nanogic:    Data.Integer(),       // total MAGIC quota
  magic_reserved_nanogic: Data.Integer(),       // reserved in active orders
  bank_account_hash:      Data.Bytes(),         // blake2b_256(account_no ++ bank_name)
  alepay_merchant_hash:   Data.Bytes(),         // blake2b_256(merchant_id)
  oracle_vkey:            Data.Bytes(),
  released_nonces:        Data.Array(Data.Bytes()), // anti-replay
  is_active:              Data.Boolean(),
  min_fiat_vnd:           Data.Integer(),       // 50_000
  max_fiat_vnd:           Data.Integer(),       // 1_000_000
});
export type OrgDatum = Data.Static<typeof OrgDatumSchema>;
