// LampDistribution committee helpers — M-of-N native multisig (SPEC §5/§7).
//
// COMMITTEE_THRESHOLD = ⌈2N/3⌉ (Byzantine 2/3). Dùng cho Claim + mọi beacon post
// + treasury release. Redeem KHÔNG cần committee (chỉ owner sign).

/** ⌈2N/3⌉ — số chữ ký committee tối thiểu cho Byzantine 2/3. */
export function committeeThreshold(committeeSize: number): number {
  if (committeeSize <= 0) throw new Error("COMMITTEE-000: committeeSize must be > 0");
  return Math.ceil((2 * committeeSize) / 3);
}

/**
 * Kiểm tra subset signer có đạt threshold không + mọi signer thuộc committee.
 * Trả về threshold đã dùng (để log).
 */
export function assertCommitteeSigners(
  committeeKeyHashes: string[],
  signerKeyHashes:    string[],
  threshold?:         number,
): number {
  if (committeeKeyHashes.length === 0) {
    throw new Error("COMMITTEE-001: committeeKeyHashes must be non-empty");
  }
  const th = threshold ?? committeeThreshold(committeeKeyHashes.length);
  if (signerKeyHashes.length < th) {
    throw new Error(`COMMITTEE-002: need ≥ ${th} signers, got ${signerKeyHashes.length}`);
  }
  for (const s of signerKeyHashes) {
    if (!committeeKeyHashes.includes(s)) {
      throw new Error(`COMMITTEE-003: signer ${s} not in committee set`);
    }
  }
  return th;
}
