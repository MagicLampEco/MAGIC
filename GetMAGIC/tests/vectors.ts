// tests/vectors.ts — Normative test vectors for GetMAGIC oracle and allocation logic
// These are derived by running the reference implementations and pinning the outputs.
// ALL bigint literals — never Number for amounts.

// ── FRAMING (nợ #26) ──────────────────────────────────────────
// Every hashed/signed payload is domain-tagged and length-prefixed:
//   LP(s)    = u32be(len(s)) ++ s
//   alloc_id = blake2b_256("MAGIC_ALLOC_ID:v1" ++ 00 ++ u8(2) ++ LP(order_id) ++ LP(user_pkh))
//   settle   = "MAGIC_ORACLE_SETTLE:v1" ++ 00 ++ u8(4) ++ LP(order_id) ++ LP(user_pkh)
//                ++ LP(nonce) ++ u64be(timestamp)
//   voucher  = "MAGIC_VOUCHER:v1" ++ 00 ++ u8(4) ++ LP(alloc_id)
//                ++ u64be(epoch) ++ u64be(nanogic) ++ u64be(expiry_posix)
// The same vectors are pinned on the Aiken side in
// onchain/lib/getmagic/utils_test.ak (group C) — change one, change both.
//
// Domain tags in hex:
//   MAGIC_ALLOC_ID:v1      = 4d414749435f414c4c4f435f49443a7631            (17 B)
//   MAGIC_ORACLE_SETTLE:v1 = 4d414749435f4f5241434c455f534554544c453a7631  (22 B)
//   MAGIC_VOUCHER:v1       = 4d414749435f564f55434845523a7631              (16 B)

// ── TV-ORACLE-01: Oracle settle message construction ──────────
// Inputs:
//   orderId      = hex("ABCD1234") — 8 bytes
//   userPkh      = 28 zero bytes
//   nonce        = 32 zero bytes
//   timestampMs  = 1_700_000_000_000n (Unix ms)
// Layout: 22 tag + 1 sep + 1 u8(fields) + (4+8) + (4+28) + (4+32) + 8 = 112 bytes
// Field offsets: orderId [28,36) · userPkh [40,68) · nonce [72,104) · ts [104,112)

export const TV_ORACLE_01_CLEAN = {
  orderId:        "4142434431323334",  // 8 bytes = "ABCD1234"
  userPkh:        "00".repeat(28),
  nonce:          "00".repeat(32),
  timestampMs:    1_700_000_000_000n,
  expectedLength: 112,
  // Field offsets under the framed layout
  orderIdOffset:  28,
  userPkhOffset:  40,
  nonceOffset:    72,
  tsOffset:       104,
  // Timestamp 1_700_000_000_000n = 0x0000_018B_CFE5_6800
  timestampHex:   "0000018bcfe56800",
  // Whole message, pinned
  expectedMsgHex:
    "4d414749435f4f5241434c455f534554544c453a7631" + // tag
    "00" +                                            // separator
    "04" +                                            // u8(field_count)
    "00000008" + "4142434431323334" +                 // LP(order_id)
    "0000001c" + "00".repeat(28) +                    // LP(user_pkh)
    "00000020" + "00".repeat(32) +                    // LP(nonce)
    "0000018bcfe56800",                               // u64be(timestamp)
} as const;

// ── TV-ORACLE-02: Epoch voucher message construction ──────────
// Inputs:
//   allocId      = 32 zero bytes
//   epoch        = 100n
//   nanogic      = 10_000_000_000n (10 MAGIC)
//   expiryPosix  = 600n * 86_400_000n = 51_840_000_000n
// Layout: 16 tag + 1 sep + 1 u8(fields) + (4+32) + 8 + 8 + 8 = 78 bytes
// Field offsets: allocId [22,54) · epoch [54,62) · nanogic [62,70) · expiry [70,78)

export const TV_ORACLE_02 = {
  allocId:       "00".repeat(32),
  epoch:         100n,
  nanogic:       10_000_000_000n,  // NEVER Number — C-OVERFLOW check
  expiryPosixMs: 51_840_000_000n,  // epoch 600 * 86_400_000
  expectedLength: 78,
  allocIdOffset:  22,
  epochOffset:    54,
  nanogicOffset:  62,
  expiryOffset:   70,
  // epoch(100n) in 8 BE: 0000000000000064
  epochHex:      "0000000000000064",
  // nanogic(10_000_000_000n) = 0x0000_0002_540B_E400 in 8 BE
  nanogicHex:    "00000002540be400",
  // expiryPosixMs(51_840_000_000n) = 600 * 86_400_000 = 0x0000_000C_11E7_A000 in 8 BE
  expiryHex:     "0000000c11e7a000",
  // Whole message, pinned
  expectedMsgHex:
    "4d414749435f564f55434845523a7631" +  // tag
    "00" +                                 // separator
    "04" +                                 // u8(field_count)
    "00000020" + "00".repeat(32) +         // LP(alloc_id)
    "0000000000000064" +                   // u64be(epoch)
    "00000002540be400" +                   // u64be(nanogic)
    "0000000c11e7a000",                    // u64be(expiry_posix)
} as const;

// ── TV-ALLOCID-01: alloc_id derivation ────────────────────────
// Pinned against the Aiken side (utils_test.ak c5_alloc_id_vector).

export const TV_ALLOCID_01 = {
  orderId:  "4142434431323334",
  userPkh:  "00".repeat(28),
  expected: "65ba533961f913bccaabda9474bd7eba947602564f5a883faf3a296bf41db2cd",
} as const;

// ── TV-FRAMING-01: injectivity — the collision the framing closes ──
// Moving 4 bytes across the order_id / user_pkh boundary leaves the RAW
// concatenation unchanged, so the OLD scheme hashed/signed one payload for
// two different field-sets. Mirrors utils_test.ak group A.

export const TV_FRAMING_01 = {
  // alloc_id pair
  orderA: "4f52442d" + "41".repeat(12),          // "ORD-AAAAAAAAAAAA", 16 bytes
  pkhA:   "aa".repeat(4) + "bb".repeat(24),      // 28 bytes
  orderB: "4f52442d" + "41".repeat(12) + "aa".repeat(4),  // 20 bytes
  pkhB:   "bb".repeat(24),                       // 24 bytes
  // OLD alloc_id shared by both pairs — kept as evidence the hole was real
  oldAllocIdBoth:
    "7be1e3ac911bee32191a4a833c2bf226f137118be5871870867d5f51e002e98c",

  // settle-message pair — here pkhSettleB is still a VALID 28-byte key hash,
  // i.e. one oracle signature authorising settlement to a different user.
  orderSettleA: "4f52442d" + "41".repeat(12),                     // 16 bytes
  pkhSettleA:   "aa".repeat(28),                                  // 28 bytes
  nonceSettleA: "cc".repeat(32),                                  // 32 bytes
  orderSettleB: "4f52442d" + "41".repeat(12) + "aa".repeat(4),    // 20 bytes
  pkhSettleB:   "aa".repeat(24) + "cc".repeat(4),                 // 28 bytes
  nonceSettleB: "cc".repeat(28),                                  // 28 bytes
  timestampMs:  1_700_000_000_000n,
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
