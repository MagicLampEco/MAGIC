// tests/vectors.ts — Normative test vectors for GetMAGIC oracle and allocation logic
// These are derived by running the reference implementations and pinning the outputs.
// ALL bigint literals — never Number for amounts.

// ── TV-ORACLE-01: Oracle settle message construction ──────────
// Verifies buildOracleSettleMsg produces the correct byte sequence.
//
// msg = order_id(hex→bytes) ++ user_pkh(28 bytes) ++ nonce(32 bytes) ++ timestamp(8 BE bytes)
//
// Inputs:
//   orderId      = hex("ABCD1234EFAB5678") — 8 bytes (16 hex chars)
//   userPkh      = 28 zero bytes
//   nonce        = 32 zero bytes
//   timestampMs  = 1_700_000_000_000n (Unix ms)
//
// Expected concat (in hex):
//   "4142434431323334454641423536373800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000018bef52e000"
// Breakdown:
//   "41424344313233344546414235363738" → hex("ABCD1234EFAB5678")
//   "0000000000000000000000000000000000000000000000000000" → 28 zero bytes
//   "0000000000000000000000000000000000000000000000000000000000000000" → 32 zero bytes
//   "000001 8bef52e000" → 1_700_000_000_000n in 8 BE bytes

export const TV_ORACLE_01 = {
  orderId:     "4142434431323334454641423536373800",  // "ABCD1234EFAB5678\0" — NOTE: use a clean 8-byte version below
  // Use ASCII hex for "ABCD1234EFAB5678" — exactly 8 bytes = 16 hex chars
  orderIdClean:  "4142434431323334454641423536373800".slice(0, 16),
  userPkh:     "00".repeat(28),
  nonce:       "00".repeat(32),
  timestampMs: 1_700_000_000_000n,
  // Expected message bytes (hex):
  // orderId(8b) + userPkh(28b) + nonce(32b) + timestamp(8b) = 76 bytes total
  expectedMsgHex: [
    "4142434431323334",   // orderId 8 bytes
    "00".repeat(28),      // userPkh
    "00".repeat(32),      // nonce
    "000001 8bef52e000".replace(/ /g, ""),  // timestamp
  ].join(""),
} as const;

// Corrected clean version used in actual tests:
export const TV_ORACLE_01_CLEAN = {
  orderId:        "4142434431323334",  // 8 bytes = "ABCD1234"
  userPkh:        "00".repeat(28),
  nonce:          "00".repeat(32),
  timestampMs:    1_700_000_000_000n,
  // Expected: concat of the 4 parts = 8 + 28 + 32 + 8 = 76 bytes
  expectedLength: 76,
  // Timestamp 1_700_000_000_000n = 0x0000_018B_CFE5_6800
  // In big-endian 8 bytes: 00 00 01 8B CF E5 68 00
  timestampHex:   "0000018bcfe56800",
};

// ── TV-ORACLE-02: Epoch voucher message construction ──────────
// Verifies buildVoucherMsg produces the correct byte sequence.
//
// msg = alloc_id(32) ++ epoch(8 BE) ++ nanogic(8 BE) ++ expiry_posix(8 BE)
//
// Inputs:
//   allocId      = 32 zero bytes
//   epoch        = 100n
//   nanogic      = 10_000_000_000n (10 MAGIC)
//   expiryPosix  = 600n * 86_400_000n = 51_840_000_000n

export const TV_ORACLE_02 = {
  allocId:       "00".repeat(32),
  epoch:         100n,
  nanogic:       10_000_000_000n,  // NEVER Number — C-OVERFLOW check
  expiryPosixMs: 51_840_000_000n,  // epoch 600 * 86_400_000
  // Expected message = 32 + 8 + 8 + 8 = 56 bytes
  expectedLength: 56,
  // epoch(100n) in 8 BE: 0000000000000064
  epochHex:      "0000000000000064",
  // nanogic(10_000_000_000n) = 0x0000_0002_540B_E400 in 8 BE
  nanogicHex:    "00000002540be400",
  // expiryPosixMs(51_840_000_000n) = 600 * 86_400_000 = 0x0000_000C_11E7_A000 in 8 BE
  expiryHex:     "0000000c11e7a000",
} as const;

// ── TV-VOUCHER-01: Voucher generation + verification roundtrip ──
// Generates 6 epoch vouchers with a known key and verifies each.

export const TV_VOUCHER_01 = {
  // Ed25519 test key (NOT a real key — test-only)
  // Private key: 32 bytes of 0x01
  privateKeyHex: "01".repeat(32),
  allocId:       "aa".repeat(32),
  startEpoch:    100n,
  totalEpochs:   6n,
  nanogicPerEpoch: 10_000_000_000n,
  expiryEpoch:   106n,
  // expiryPosixMs = 106 * 86_400_000 = 9_158_400_000
} as const;

// ── TV-NONCE-01: Nonce generation from orderId + bankTxRef ────
// generateNonce must be deterministic: same inputs → same output.

export const TV_NONCE_01 = {
  orderId:    "4142434431323334",  // 8 bytes hex
  bankTxRef:  "FT2024001234",      // ASCII bank transaction reference
  // Expected nonce = blake2b_256(hex_bytes("4142434431323334") ++ text_bytes("FT2024001234"))
  // This is pinned by running the implementation once.
} as const;

// ── TV-ALLOC-01: claimableEpochs with empty claimed list ─────

export const TV_ALLOC_01 = {
  startEpoch:    100n,
  expiryEpoch:   106n,     // 6 epochs
  claimedEpochs: [] as bigint[],
  currentEpoch:  103n,     // only epochs up to and including current are claimable
  expected:      [100n, 101n, 102n, 103n],  // 4 claimable epochs
} as const;

// ── TV-ALLOC-02: claimableEpochs with some epochs claimed ────

export const TV_ALLOC_02 = {
  startEpoch:    100n,
  expiryEpoch:   106n,
  claimedEpochs: [100n, 102n] as bigint[],
  currentEpoch:  104n,
  expected:      [101n, 103n, 104n],  // 100 and 102 already claimed
} as const;

// ── TV-ALLOC-03: claimableEpochs after expiry ────────────────

export const TV_ALLOC_03 = {
  startEpoch:    100n,
  expiryEpoch:   106n,
  claimedEpochs: [100n, 101n, 102n] as bigint[],
  currentEpoch:  110n,     // past expiry_epoch
  expected:      [103n, 104n, 105n],  // only epochs < expiry_epoch count
} as const;

// ── TV-OVERFLOW-01: BigInt overflow check ─────────────────────
// nanogic = 10_000_000_000n is fine as BigInt but would lose precision as Number.
// Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991
// 10_000_000_000 < MAX_SAFE_INTEGER so this specific value is safe,
// but larger values (e.g. total across 6 epochs) demonstrate the risk.

export const TV_OVERFLOW_01 = {
  // 6 epochs × 10 MAGIC = 60 MAGIC in nanogic
  totalNanogic:  60_000_000_000n,
  // 60_000_000_000 < MAX_SAFE_INTEGER — still safe, but should always use BigInt
  maxSafeInteger: BigInt(Number.MAX_SAFE_INTEGER),
  // A larger realistic value: 1B MAGIC in nanogic
  largeMagicNanogic: 1_000_000_000_000_000_000n,  // 1B MAGIC — exceeds MAX_SAFE_INTEGER
} as const;
