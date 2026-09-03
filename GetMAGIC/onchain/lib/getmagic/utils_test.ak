// lib/getmagic/utils_test.ak — tests for the message-framing rule (nợ #26)
//
// Three groups:
//   A. INJECTIVITY  — a concrete collision under the OLD raw-concat scheme,
//                     then the SAME two field-sets under the new framing.
//                     Group A is the proof that the patch does something.
//   B. LENGTH GUARD — build_voucher_msg rejects a non-32-byte alloc_id.
//   C. VECTORS      — pinned input → pinned output for all three builders,
//                     shared with tests/vectors.ts (P8 arbitration).

use aiken/crypto
use aiken/primitive/bytearray
use getmagic/utils.{
  build_alloc_id, build_oracle_settle_msg, build_voucher_msg, domain_alloc_id,
  domain_oracle_settle, domain_voucher, encode_int_8bytes, length_prefixed,
}

// ══ Group A — injectivity ════════════════════════════════════════════════
//
// Collision recipe: move bytes across a field boundary. The concatenation is
// unchanged, the field-set is not.
//
//   order_a = "ORD-AAAAAAAAAAAA"            (16 bytes)
//   pkh_a   = aa*4 ++ bb*24                 (28 bytes)
//   order_b = order_a ++ aa*4               (20 bytes)  ← 4 bytes stolen
//   pkh_b   = bb*24                         (24 bytes)
//
//   order_a ++ pkh_a == order_b ++ pkh_b     (same 44 bytes)

const order_a: ByteArray = #"4f52442d414141414141414141414141"

const pkh_a: ByteArray =
  #"aaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const order_b: ByteArray = #"4f52442d414141414141414141414141aaaaaaaa"

const pkh_b: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

/// The premise. If this ever stops holding, group A proves nothing and the
/// collision pair below must be rebuilt.
test a1_alloc_old_scheme_preimages_collide() {
  bytearray.concat(order_a, pkh_a) == bytearray.concat(order_b, pkh_b)
}

/// … therefore the OLD alloc_id (blake2b_256 of that raw concat) is the SAME
/// identifier for two different allocations. Silent key collision.
test a2_alloc_old_scheme_ids_collide() {
  crypto.blake2b_256(bytearray.concat(order_a, pkh_a)) == crypto.blake2b_256(
    bytearray.concat(order_b, pkh_b),
  )
}

/// The patch: same two field-sets, two different alloc_ids.
test a3_alloc_new_scheme_separates() {
  build_alloc_id(order_a, pkh_a) != build_alloc_id(order_b, pkh_b)
}

/// Same recipe on the settle message, but the stolen bytes are taken so that
/// pkh_settle_b is still a VALID-length 28-byte key hash — i.e. one oracle
/// signature authorising settlement to two different users.
///
///   order_settle_a = "ORD-AAAAAAAAAAAA"       (16)
///   pkh_settle_a   = aa*28                    (28)
///   nonce_settle_a = cc*32                    (32)
///   order_settle_b = order_settle_a ++ aa*4   (20)
///   pkh_settle_b   = aa*24 ++ cc*4            (28)  ← different pkh, valid length
///   nonce_settle_b = cc*28                    (28)

const order_settle_a: ByteArray = #"4f52442d414141414141414141414141"

const pkh_settle_a: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const nonce_settle_a: ByteArray =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

const order_settle_b: ByteArray = #"4f52442d414141414141414141414141aaaaaaaa"

const pkh_settle_b: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaacccccccc"

const nonce_settle_b: ByteArray =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

const settle_ts: Int = 1700000000000

/// Reconstruct the OLD builder (order_id ++ user_pkh ++ nonce ++ ts(8))
/// and show the two field-sets produce one identical signed payload.
fn old_settle_msg(
  order_id: ByteArray,
  user_pkh: ByteArray,
  nonce: ByteArray,
  ts: Int,
) -> ByteArray {
  bytearray.concat(
    bytearray.concat(order_id, user_pkh),
    bytearray.concat(nonce, encode_int_8bytes(ts)),
  )
}

test a4_settle_old_scheme_msgs_collide() {
  and {
    pkh_settle_a != pkh_settle_b,
    bytearray.length(pkh_settle_b) == 28,
    old_settle_msg(order_settle_a, pkh_settle_a, nonce_settle_a, settle_ts) == old_settle_msg(
      order_settle_b,
      pkh_settle_b,
      nonce_settle_b,
      settle_ts,
    ),
  }
}

test a5_settle_new_scheme_separates() {
  build_oracle_settle_msg(
    order_settle_a,
    pkh_settle_a,
    nonce_settle_a,
    settle_ts,
  ) != build_oracle_settle_msg(
    order_settle_b,
    pkh_settle_b,
    nonce_settle_b,
    settle_ts,
  )
}

/// Empty-field edge: ("", "ab") vs ("ab", "") collide under raw concat.
test a6_alloc_empty_field_shift_separates() {
  and {
    bytearray.concat(#"", #"abcd") == bytearray.concat(#"abcd", #""),
    build_alloc_id(#"", #"abcd") != build_alloc_id(#"abcd", #""),
  }
}

/// Cross-message separation: no settle payload can ever equal a voucher
/// payload or an alloc_id preimage, because the domain tags differ.
test a7_domain_tags_pairwise_distinct() {
  and {
    domain_alloc_id != domain_oracle_settle,
    domain_alloc_id != domain_voucher,
    domain_oracle_settle != domain_voucher,
    bytearray.length(domain_alloc_id) == 17,
    bytearray.length(domain_oracle_settle) == 22,
    bytearray.length(domain_voucher) == 16,
  }
}

// ══ Group B — alloc_id length guard ══════════════════════════════════════

const alloc_ok: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

test b1_voucher_accepts_32_byte_alloc_id() {
  bytearray.length(build_voucher_msg(alloc_ok, 100, 10000000000, 51840000000)) == 78
}

test b2_voucher_rejects_short_alloc_id() fail {
  build_voucher_msg(#"aabbccdd", 100, 10000000000, 51840000000) != #""
}

test b3_voucher_rejects_empty_alloc_id() fail {
  build_voucher_msg(#"", 100, 10000000000, 51840000000) != #""
}

test b4_voucher_rejects_33_byte_alloc_id() fail {
  build_voucher_msg(
    #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    100,
    10000000000,
    51840000000,
  ) != #""
}

// ══ Group C — pinned vectors ═════════════════════════════════════════════
// Change a framing byte and these go red immediately.
// Same numbers live in GetMAGIC/tests/vectors.ts — keep both sides in sync.

test c1_length_prefixed_vector() {
  and {
    length_prefixed(#"") == #"00000000",
    length_prefixed(#"41") == #"0000000141",
    length_prefixed(#"4142434431323334") == #"000000084142434431323334",
  }
}

test c2_encode_int_8bytes_vector() {
  and {
    encode_int_8bytes(0) == #"0000000000000000",
    encode_int_8bytes(100) == #"0000000000000064",
    encode_int_8bytes(10000000000) == #"00000002540be400",
    encode_int_8bytes(1700000000000) == #"0000018bcfe56800",
  }
}

/// TV-ORACLE-01: order_id = hex("ABCD1234"), user_pkh = 28×00,
/// nonce = 32×00, timestamp = 1_700_000_000_000 → 112 bytes.
test c3_settle_msg_vector() {
  build_oracle_settle_msg(
    #"4142434431323334",
    #"00000000000000000000000000000000000000000000000000000000",
    #"0000000000000000000000000000000000000000000000000000000000000000",
    1700000000000,
  ) == #"4d414749435f4f5241434c455f534554544c453a763100040000000841424344313233340000001c000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000018bcfe56800"
}

/// TV-ORACLE-02: alloc_id = 32×00, epoch = 100, nanogic = 10_000_000_000,
/// expiry_posix = 51_840_000_000 → 78 bytes.
test c4_voucher_msg_vector() {
  build_voucher_msg(
    #"0000000000000000000000000000000000000000000000000000000000000000",
    100,
    10000000000,
    51840000000,
  ) == #"4d414749435f564f55434845523a76310004000000200000000000000000000000000000000000000000000000000000000000000000000000000000006400000002540be4000000000c11e7a000"
}

/// TV-ALLOCID-01: order_id = hex("ABCD1234"), user_pkh = 28×00.
test c5_alloc_id_vector() {
  build_alloc_id(
    #"4142434431323334",
    #"00000000000000000000000000000000000000000000000000000000",
  ) == #"65ba533961f913bccaabda9474bd7eba947602564f5a883faf3a296bf41db2cd"
}

test c6_alloc_id_is_32_bytes() {
  bytearray.length(build_alloc_id(#"4142434431323334", #"aabb")) == 32
}

/// Sanity: the voucher builder still separates the fixed-width fields.
test c7_voucher_fields_bind() {
  and {
    build_voucher_msg(alloc_ok, 100, 1, 1) != build_voucher_msg(
      alloc_ok,
      101,
      1,
      1,
    ),
    build_voucher_msg(alloc_ok, 100, 1, 1) != build_voucher_msg(
      alloc_ok,
      100,
      2,
      1,
    ),
    build_voucher_msg(alloc_ok, 100, 1, 1) != build_voucher_msg(
      alloc_ok,
      100,
      1,
      2,
    ),
  }
}
