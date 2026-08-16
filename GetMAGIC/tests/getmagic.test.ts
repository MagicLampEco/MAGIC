// tests/getmagic.test.ts — GetMAGIC SDK unit tests
// Covers: oracle messages, voucher signing, nonce generation, epoch claims, datum roundtrips.

import { describe, it, expect } from "vitest";
import { Data, Constr } from "@lucid-evolution/lucid";
import { ed25519 } from "@noble/curves/ed25519";

import {
  buildOracleSettleMsg,
  buildVoucherMsg,
  generateNonce,
  generateEpochVouchers,
  verifyMsg,
  signMsg,
  hexToBytes,
  bytesToHex,
  deriveAllocId,
} from "../offchain/src/oracle.js";

import {
  getClaimableEpochs,
} from "../offchain/src/allocation.js";

import {
  OrderDatumSchema,
  AllocationDatumSchema,
  OrderRedeemerSchema,
  AllocationRedeemerSchema,
  MAGIC_PER_EPOCH,
  DEFAULT_TOTAL_EPOCHS,
  type OrderDatum,
  type AllocationDatum,
  type OrderRedeemer,
  type AllocationRedeemer,
} from "../offchain/src/types.js";

import {
  TV_ORACLE_01_CLEAN,
  TV_ORACLE_02,
  TV_ALLOCID_01,
  TV_FRAMING_01,
  TV_VOUCHER_01,
  TV_NONCE_01,
  TV_ALLOC_01,
  TV_ALLOC_02,
  TV_ALLOC_03,
  TV_OVERFLOW_01,
} from "./vectors.js";

// ── Helpers ───────────────────────────────────────────────────

/** Build a minimal OrderDatum for roundtrip tests */
function makeOrderDatum(overrides: Partial<OrderDatum> = {}): OrderDatum {
  return {
    order_id:         "4142434431323334",    // 8 bytes
    org_pkh:          "01".repeat(28),
    user_pkh:         "02".repeat(28),
    user_stake_cred:  null,
    magic_per_epoch:  MAGIC_PER_EPOCH,
    total_epochs:     DEFAULT_TOTAL_EPOCHS,
    fiat_amount_vnd:  200_000n,
    created_posix_ms: 1_700_000_000_000n,
    expiry_posix_ms:  1_700_014_400_000n,
    oracle_vkey:      "03".repeat(32),
    ...overrides,
  };
}

/** Build a minimal AllocationDatum for roundtrip tests */
function makeAllocationDatum(overrides: Partial<AllocationDatum> = {}): AllocationDatum {
  return {
    alloc_id:             "aa".repeat(32),
    order_id:             "4142434431323334",
    org_pkh:              "01".repeat(28),
    org_vault_nft_policy: "04".repeat(28),
    beneficiary_pkh:      "02".repeat(28),
    beneficiary_stake:    null,
    magic_per_epoch:      MAGIC_PER_EPOCH,
    total_epochs:         DEFAULT_TOTAL_EPOCHS,
    claimed_epochs:       [],
    start_epoch:          100n,
    expiry_epoch:         106n,
    vouchers:             [],
    oracle_vkey:          "03".repeat(32),
    ...overrides,
  };
}

// ── TV-ORACLE-01: buildOracleSettleMsg ────────────────────────
describe("TV-ORACLE-01: buildOracleSettleMsg", () => {
  const build = () =>
    buildOracleSettleMsg(
      TV_ORACLE_01_CLEAN.orderId,   // 8 bytes
      TV_ORACLE_01_CLEAN.userPkh,   // 28 bytes
      TV_ORACLE_01_CLEAN.nonce,     // 32 bytes
      TV_ORACLE_01_CLEAN.timestampMs,
    );

  it("produces bytes of correct length", () => {
    // 22 tag + 1 sep + (4+8) + (4+28) + (4+32) + 8 = 111 bytes
    expect(build().length).toBe(TV_ORACLE_01_CLEAN.expectedLength);
  });

  it("matches the pinned vector byte-for-byte (P8 vs utils_test.ak c3)", () => {
    expect(bytesToHex(build())).toBe(TV_ORACLE_01_CLEAN.expectedMsgHex);
  });

  it("starts with the domain tag and separator", () => {
    const prefix = bytesToHex(build().slice(0, 23));
    expect(prefix).toBe("4d414749435f4f5241434c455f534554544c453a763100");
  });

  it("length-prefixes each variable field", () => {
    const msg = build();
    expect(bytesToHex(msg.slice(23, 27))).toBe("00000008"); // len(order_id)
    expect(bytesToHex(msg.slice(35, 39))).toBe("0000001c"); // len(user_pkh) = 28
    expect(bytesToHex(msg.slice(67, 71))).toBe("00000020"); // len(nonce) = 32
  });

  it("places orderId at its framed offset", () => {
    const msg = build();
    const o   = TV_ORACLE_01_CLEAN.orderIdOffset;
    expect(bytesToHex(msg.slice(o, o + 8))).toBe(TV_ORACLE_01_CLEAN.orderId);
  });

  it("encodes timestamp as big-endian 8 bytes", () => {
    const msg     = build();
    const tsBytes = msg.slice(msg.length - 8);
    // 1_700_000_000_000n = 0x0000_018B_CFE5_6800
    expect(bytesToHex(tsBytes)).toBe(TV_ORACLE_01_CLEAN.timestampHex);
  });

  it("is deterministic — same inputs same output", () => {
    const msg1 = buildOracleSettleMsg("4142434431323334", "00".repeat(28), "00".repeat(32), 1n);
    const msg2 = buildOracleSettleMsg("4142434431323334", "00".repeat(28), "00".repeat(32), 1n);
    expect(bytesToHex(msg1)).toBe(bytesToHex(msg2));
  });
});

// ── TV-FRAMING-01: injectivity (nợ #26) ───────────────────────
// Mirrors onchain/lib/getmagic/utils_test.ak group A.
describe("TV-FRAMING-01: message framing is injective", () => {
  const F = TV_FRAMING_01;

  it("premise — the OLD raw concat collides for two different field-sets", () => {
    expect(F.orderA + F.pkhA).toBe(F.orderB + F.pkhB);
    expect(F.pkhA).not.toBe(F.pkhB);
  });

  it("alloc_id: the framed derivation separates that same pair", () => {
    expect(deriveAllocId(F.orderA, F.pkhA)).not.toBe(deriveAllocId(F.orderB, F.pkhB));
  });

  it("premise — the OLD settle payload collides with a VALID 28-byte pkh swap", () => {
    expect(F.orderSettleA + F.pkhSettleA + F.nonceSettleA).toBe(
      F.orderSettleB + F.pkhSettleB + F.nonceSettleB,
    );
    expect(F.pkhSettleB.length / 2).toBe(28);
    expect(F.pkhSettleA).not.toBe(F.pkhSettleB);
  });

  it("settle: the framed message separates that same pair", () => {
    const a = buildOracleSettleMsg(F.orderSettleA, F.pkhSettleA, F.nonceSettleA, F.timestampMs);
    const b = buildOracleSettleMsg(F.orderSettleB, F.pkhSettleB, F.nonceSettleB, F.timestampMs);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("empty-field shift is separated too", () => {
    expect(deriveAllocId("", "abcd")).not.toBe(deriveAllocId("abcd", ""));
  });
});

// ── TV-ALLOCID-01: deriveAllocId pinned vector ────────────────
describe("TV-ALLOCID-01: deriveAllocId pinned vector", () => {
  it("matches the Aiken build_alloc_id output (P8 vs utils_test.ak c5)", () => {
    expect(deriveAllocId(TV_ALLOCID_01.orderId, TV_ALLOCID_01.userPkh)).toBe(
      TV_ALLOCID_01.expected,
    );
  });
});

// ── TV-ORACLE-02: buildVoucherMsg ─────────────────────────────
describe("TV-ORACLE-02: buildVoucherMsg", () => {
  const V = TV_ORACLE_02;
  const build = (nanogic: bigint = V.nanogic) =>
    buildVoucherMsg(V.allocId, V.epoch, nanogic, V.expiryPosixMs);

  it("produces bytes of correct length", () => {
    // 16 tag + 1 sep + (4+32) + 8 + 8 + 8 = 77 bytes
    expect(build().length).toBe(V.expectedLength);
  });

  it("matches the pinned vector byte-for-byte (P8 vs utils_test.ak c4)", () => {
    expect(bytesToHex(build())).toBe(V.expectedMsgHex);
  });

  it("starts with the domain tag, separator and LP(alloc_id)", () => {
    const msg = build();
    expect(bytesToHex(msg.slice(0, 17))).toBe("4d414749435f564f55434845523a763100");
    expect(bytesToHex(msg.slice(17, 21))).toBe("00000020"); // len(alloc_id) = 32
  });

  it("encodes epoch at its framed offset", () => {
    const o = V.epochOffset;
    expect(bytesToHex(build().slice(o, o + 8))).toBe(V.epochHex);
  });

  it("encodes nanogic at its framed offset", () => {
    const o = V.nanogicOffset;
    expect(bytesToHex(build().slice(o, o + 8))).toBe(V.nanogicHex);
  });

  it("encodes expiryPosixMs at its framed offset", () => {
    const o = V.expiryOffset;
    expect(bytesToHex(build().slice(o, o + 8))).toBe(V.expiryHex);
  });

  it("uses BigInt — nanogic value does not lose precision", () => {
    // 10_000_000_000n fits in Number, but 1_000_000_000_000_000_000n does not
    const bigNanogic = 1_000_000_000_000_000_000n;
    const msg     = build(bigNanogic);
    const ngBytes = msg.slice(V.nanogicOffset, V.nanogicOffset + 8);
    const dv      = new DataView(ngBytes.buffer, ngBytes.byteOffset, 8);
    expect(dv.getBigUint64(0, false)).toBe(bigNanogic);
  });

  // Mirrors the on-chain `expect bytearray.length(alloc_id) == 32`
  // (utils_test.ak b2/b3/b4).
  it("rejects an alloc_id that is not 32 bytes", () => {
    expect(() => buildVoucherMsg("aabbccdd", 100n, 1n, 1n)).toThrow();
    expect(() => buildVoucherMsg("", 100n, 1n, 1n)).toThrow();
    expect(() => buildVoucherMsg("aa".repeat(33), 100n, 1n, 1n)).toThrow();
  });
});

// ── TV-VOUCHER-01: generateEpochVouchers roundtrip ───────────
describe("TV-VOUCHER-01: generateEpochVouchers + verifyMsg roundtrip", () => {
  const { privateKeyHex, allocId, startEpoch, totalEpochs, nanogicPerEpoch, expiryEpoch } = TV_VOUCHER_01;

  it("generates the correct number of vouchers", async () => {
    const vouchers = await generateEpochVouchers(
      privateKeyHex, allocId, startEpoch, totalEpochs, nanogicPerEpoch, expiryEpoch,
    );
    expect(vouchers.length).toBe(Number(totalEpochs));
  });

  it("each voucher is 64 bytes (128 hex chars)", async () => {
    const vouchers = await generateEpochVouchers(
      privateKeyHex, allocId, startEpoch, totalEpochs, nanogicPerEpoch, expiryEpoch,
    );
    for (const v of vouchers) {
      expect(v.length).toBe(128);
    }
  });

  it("each voucher verifies against its own epoch message", async () => {
    // Derive public key from private key
    const privBytes = hexToBytes(privateKeyHex);
    const vkeyBytes = ed25519.getPublicKey(privBytes);
    const vkeyHex   = bytesToHex(vkeyBytes);

    const expiryPosixMs = expiryEpoch * 86_400_000n;
    const vouchers = await generateEpochVouchers(
      privateKeyHex, allocId, startEpoch, totalEpochs, nanogicPerEpoch, expiryEpoch,
    );

    for (let i = 0n; i < totalEpochs; i++) {
      const epoch = startEpoch + i;
      const msg   = buildVoucherMsg(allocId, epoch, nanogicPerEpoch, expiryPosixMs);
      const valid = verifyMsg(vkeyHex, msg, vouchers[Number(i)] ?? "");
      expect(valid, `voucher for epoch ${epoch} should verify`).toBe(true);
    }
  });

  it("voucher does NOT verify for wrong epoch", async () => {
    const privBytes = hexToBytes(privateKeyHex);
    const vkeyBytes = ed25519.getPublicKey(privBytes);
    const vkeyHex   = bytesToHex(vkeyBytes);

    const expiryPosixMs = expiryEpoch * 86_400_000n;
    const vouchers = await generateEpochVouchers(
      privateKeyHex, allocId, startEpoch, totalEpochs, nanogicPerEpoch, expiryEpoch,
    );

    // Voucher 0 (epoch 100) should not verify for epoch 101
    const wrongMsg  = buildVoucherMsg(allocId, startEpoch + 1n, nanogicPerEpoch, expiryPosixMs);
    const valid = verifyMsg(vkeyHex, wrongMsg, vouchers[0] ?? "");
    expect(valid).toBe(false);
  });

  it("signMsg + verifyMsg roundtrip", async () => {
    const privBytes = hexToBytes(privateKeyHex);
    const vkeyBytes = ed25519.getPublicKey(privBytes);
    const vkeyHex   = bytesToHex(vkeyBytes);

    const msg = new TextEncoder().encode("test message for roundtrip");
    const sig = await signMsg(privateKeyHex, msg);
    expect(verifyMsg(vkeyHex, msg, sig)).toBe(true);
    expect(verifyMsg(vkeyHex, msg, "00".repeat(64))).toBe(false);
  });
});

// ── TV-NONCE-01: generateNonce determinism ────────────────────
describe("TV-NONCE-01: generateNonce", () => {
  it("is deterministic — same inputs produce same nonce", () => {
    const n1 = generateNonce(TV_NONCE_01.orderId, TV_NONCE_01.bankTxRef);
    const n2 = generateNonce(TV_NONCE_01.orderId, TV_NONCE_01.bankTxRef);
    expect(n1).toBe(n2);
  });

  it("produces 32-byte output (64 hex chars)", () => {
    const nonce = generateNonce(TV_NONCE_01.orderId, TV_NONCE_01.bankTxRef);
    expect(nonce.length).toBe(64);
  });

  it("different bankTxRef produces different nonce", () => {
    const n1 = generateNonce(TV_NONCE_01.orderId, "REF-A");
    const n2 = generateNonce(TV_NONCE_01.orderId, "REF-B");
    expect(n1).not.toBe(n2);
  });

  it("different orderId produces different nonce", () => {
    const n1 = generateNonce("0000000000000001", TV_NONCE_01.bankTxRef);
    const n2 = generateNonce("0000000000000002", TV_NONCE_01.bankTxRef);
    expect(n1).not.toBe(n2);
  });
});

// ── TV-ALLOC-01: getClaimableEpochs empty claimed list ───────
describe("TV-ALLOC-01: getClaimableEpochs with empty claimed list", () => {
  it("returns epochs from start_epoch to currentEpoch inclusive", () => {
    const alloc = makeAllocationDatum({
      start_epoch:    TV_ALLOC_01.startEpoch,
      expiry_epoch:   TV_ALLOC_01.expiryEpoch,
      claimed_epochs: [],
    });
    const result = getClaimableEpochs(alloc, TV_ALLOC_01.currentEpoch);
    expect(result).toEqual([...TV_ALLOC_01.expected]);
  });

  it("returns empty list when currentEpoch < start_epoch", () => {
    const alloc  = makeAllocationDatum({ start_epoch: 100n, expiry_epoch: 106n });
    const result = getClaimableEpochs(alloc, 99n);
    expect(result).toEqual([]);
  });
});

// ── TV-ALLOC-02: getClaimableEpochs with some claimed ─────────
describe("TV-ALLOC-02: getClaimableEpochs with some epochs claimed", () => {
  it("excludes already-claimed epochs", () => {
    const alloc = makeAllocationDatum({
      start_epoch:    TV_ALLOC_02.startEpoch,
      expiry_epoch:   TV_ALLOC_02.expiryEpoch,
      claimed_epochs: [...TV_ALLOC_02.claimedEpochs],
    });
    const result = getClaimableEpochs(alloc, TV_ALLOC_02.currentEpoch);
    expect(result).toEqual([...TV_ALLOC_02.expected]);
  });
});

// ── TV-ALLOC-03: getClaimableEpochs after expiry ─────────────
describe("TV-ALLOC-03: getClaimableEpochs after expiry", () => {
  it("caps at expiry_epoch even if currentEpoch is past it", () => {
    const alloc = makeAllocationDatum({
      start_epoch:    TV_ALLOC_03.startEpoch,
      expiry_epoch:   TV_ALLOC_03.expiryEpoch,
      claimed_epochs: [...TV_ALLOC_03.claimedEpochs],
    });
    const result = getClaimableEpochs(alloc, TV_ALLOC_03.currentEpoch);
    expect(result).toEqual([...TV_ALLOC_03.expected]);
  });

  it("returns empty when all epochs claimed", () => {
    const alloc = makeAllocationDatum({
      start_epoch:    100n,
      expiry_epoch:   106n,
      claimed_epochs: [100n, 101n, 102n, 103n, 104n, 105n],
    });
    expect(getClaimableEpochs(alloc, 110n)).toEqual([]);
  });
});

// ── OrderDatum Data serialization roundtrip ───────────────────
describe("OrderDatum Data roundtrip", () => {
  it("serializes and deserializes correctly", () => {
    const original = makeOrderDatum();
    const cbor     = Data.to<OrderDatum>(original, OrderDatumSchema as unknown as OrderDatum);
    const decoded  = Data.from<OrderDatum>(cbor, OrderDatumSchema as unknown as OrderDatum);
    expect(decoded.order_id).toBe(original.order_id);
    expect(decoded.org_pkh).toBe(original.org_pkh);
    expect(decoded.magic_per_epoch).toBe(original.magic_per_epoch);
    expect(decoded.total_epochs).toBe(original.total_epochs);
    expect(decoded.fiat_amount_vnd).toBe(original.fiat_amount_vnd);
    expect(decoded.created_posix_ms).toBe(original.created_posix_ms);
    expect(decoded.expiry_posix_ms).toBe(original.expiry_posix_ms);
    expect(decoded.oracle_vkey).toBe(original.oracle_vkey);
    expect(decoded.user_stake_cred).toBeNull();
  });

  it("roundtrips OrderDatum with stake credential", () => {
    const original = makeOrderDatum({
      user_stake_cred: { VerificationKey: { hash: "05".repeat(28) } },
    });
    const cbor    = Data.to<OrderDatum>(original, OrderDatumSchema as unknown as OrderDatum);
    const decoded = Data.from<OrderDatum>(cbor, OrderDatumSchema as unknown as OrderDatum);
    expect(decoded.user_stake_cred).not.toBeNull();
    // @ts-expect-error - narrowing
    expect(decoded.user_stake_cred?.VerificationKey?.hash).toBe("05".repeat(28));
  });

  it("roundtrips OrderRedeemer Settle variant", () => {
    const redeemer = {
      Settle: {
        oracle_nonce:     "aa".repeat(32),
        oracle_timestamp: 1_700_000_000_000n,
        oracle_signature: "bb".repeat(64),
        epoch_vouchers:   ["cc".repeat(64), "dd".repeat(64)],
      },
    };
    const cbor    = Data.to<OrderRedeemer>(redeemer, OrderRedeemerSchema as unknown as OrderRedeemer);
    const decoded = Data.from<OrderRedeemer>(cbor, OrderRedeemerSchema as unknown as OrderRedeemer);
    expect(decoded).toMatchObject(redeemer);
  });

  it("roundtrips OrderRedeemer Expire literal", () => {
    const cbor    = Data.to<OrderRedeemer>("Expire", OrderRedeemerSchema as unknown as OrderRedeemer);
    const decoded = Data.from<OrderRedeemer>(cbor, OrderRedeemerSchema as unknown as OrderRedeemer);
    expect(decoded).toBe("Expire");
  });

  it("roundtrips OrderRedeemer Cancel literal", () => {
    const cbor    = Data.to<OrderRedeemer>("Cancel", OrderRedeemerSchema as unknown as OrderRedeemer);
    const decoded = Data.from<OrderRedeemer>(cbor, OrderRedeemerSchema as unknown as OrderRedeemer);
    expect(decoded).toBe("Cancel");
  });
});

// ── AllocationDatum Data serialization roundtrip ──────────────
describe("AllocationDatum Data roundtrip", () => {
  it("serializes and deserializes correctly", () => {
    const original = makeAllocationDatum();
    const cbor     = Data.to<AllocationDatum>(original, AllocationDatumSchema as unknown as AllocationDatum);
    const decoded  = Data.from<AllocationDatum>(cbor, AllocationDatumSchema as unknown as AllocationDatum);
    expect(decoded.alloc_id).toBe(original.alloc_id);
    expect(decoded.magic_per_epoch).toBe(original.magic_per_epoch);
    expect(decoded.total_epochs).toBe(original.total_epochs);
    expect(decoded.claimed_epochs).toEqual([]);
    expect(decoded.start_epoch).toBe(original.start_epoch);
    expect(decoded.expiry_epoch).toBe(original.expiry_epoch);
    expect(decoded.oracle_vkey).toBe(original.oracle_vkey);
  });

  it("roundtrips with non-empty claimed_epochs (sorted ascending)", () => {
    const original = makeAllocationDatum({
      claimed_epochs: [100n, 102n, 104n],
    });
    const cbor     = Data.to<AllocationDatum>(original, AllocationDatumSchema as unknown as AllocationDatum);
    const decoded  = Data.from<AllocationDatum>(cbor, AllocationDatumSchema as unknown as AllocationDatum);
    expect(decoded.claimed_epochs).toEqual([100n, 102n, 104n]);
  });

  it("roundtrips with vouchers", () => {
    const original = makeAllocationDatum({
      vouchers: ["ee".repeat(64), "ff".repeat(64)],
    });
    const cbor     = Data.to<AllocationDatum>(original, AllocationDatumSchema as unknown as AllocationDatum);
    const decoded  = Data.from<AllocationDatum>(cbor, AllocationDatumSchema as unknown as AllocationDatum);
    expect(decoded.vouchers.length).toBe(2);
    expect(decoded.vouchers[0]).toBe("ee".repeat(64));
  });

  it("roundtrips AllocationRedeemer ClaimEpoch", () => {
    const redeemer = {
      ClaimEpoch: {
        epoch:  103n,
        um_ref: new Constr(0, []),
      },
    };
    const cbor    = Data.to<AllocationRedeemer>(redeemer, AllocationRedeemerSchema as unknown as AllocationRedeemer);
    const decoded = Data.from<AllocationRedeemer>(cbor, AllocationRedeemerSchema as unknown as AllocationRedeemer);
    // @ts-expect-error — narrowing dynamic union
    expect(decoded.ClaimEpoch?.epoch).toBe(103n);
  });

  it("roundtrips AllocationRedeemer ReclaimExpired literal", () => {
    const cbor    = Data.to<AllocationRedeemer>("ReclaimExpired", AllocationRedeemerSchema as unknown as AllocationRedeemer);
    const decoded = Data.from<AllocationRedeemer>(cbor, AllocationRedeemerSchema as unknown as AllocationRedeemer);
    expect(decoded).toBe("ReclaimExpired");
  });

  it("roundtrips AllocationRedeemer Surrender literal", () => {
    const cbor    = Data.to<AllocationRedeemer>("Surrender", AllocationRedeemerSchema as unknown as AllocationRedeemer);
    const decoded = Data.from<AllocationRedeemer>(cbor, AllocationRedeemerSchema as unknown as AllocationRedeemer);
    expect(decoded).toBe("Surrender");
  });
});

// ── BigInt overflow checks ────────────────────────────────────
describe("BigInt overflow checks", () => {
  it("MAGIC_PER_EPOCH is BigInt", () => {
    expect(typeof MAGIC_PER_EPOCH).toBe("bigint");
  });

  it("large nanogic values exceed Number.MAX_SAFE_INTEGER", () => {
    const large = TV_OVERFLOW_01.largeMagicNanogic;
    // Confirm this exceeds Number.MAX_SAFE_INTEGER
    expect(large > TV_OVERFLOW_01.maxSafeInteger).toBe(true);
    // Number would lose precision here — BigInt preserves it
    expect(large).toBe(1_000_000_000_000_000_000n);
  });

  it("encodeInt8Bytes preserves large nanogic value precisely", () => {
    const bigNanogic = TV_OVERFLOW_01.largeMagicNanogic;
    const msg = buildVoucherMsg("00".repeat(32), 1n, bigNanogic, 1n);
    // Extract nanogic bytes at the framed offset [61,69)
    const dv      = new DataView(msg.buffer, msg.byteOffset);
    const decoded = dv.getBigUint64(TV_ORACLE_02.nanogicOffset, false);
    expect(decoded).toBe(bigNanogic);
  });

  it("DEFAULT_TOTAL_EPOCHS is BigInt", () => {
    expect(typeof DEFAULT_TOTAL_EPOCHS).toBe("bigint");
    expect(DEFAULT_TOTAL_EPOCHS).toBe(6n);
  });
});

// ── deriveAllocId ─────────────────────────────────────────────
describe("deriveAllocId", () => {
  it("is deterministic", () => {
    const a1 = deriveAllocId("4142434431323334", "00".repeat(28));
    const a2 = deriveAllocId("4142434431323334", "00".repeat(28));
    expect(a1).toBe(a2);
  });

  it("produces 32-byte output", () => {
    const id = deriveAllocId("4142434431323334", "00".repeat(28));
    expect(id.length).toBe(64);
  });

  it("different inputs produce different IDs", () => {
    const a1 = deriveAllocId("4142434431323334", "01".repeat(28));
    const a2 = deriveAllocId("4142434431323334", "02".repeat(28));
    expect(a1).not.toBe(a2);
  });
});
