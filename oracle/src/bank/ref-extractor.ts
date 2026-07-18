/**
 * VeData Oracle — Reference Code Extractor
 *
 * Spec §2.3: parse bank transfer description and extract candidate 16-char
 * [A-Z0-9] tokens, then validate the embedded checksum.
 *
 * Reference code format (§2.1):
 *   [VD][6-char epoch segment][6-char random][2-char SHA256 check] = 16 chars total
 */

import { createHash } from "crypto";

const ALNUM_RE = /[^A-Z0-9]/g;

/**
 * Normalise and extract all 16-char uppercase alphanumeric candidates from a
 * bank transfer description.  Returns an empty array if nothing matches.
 */
export function extractRefCandidates(rawDescription: string): string[] {
  // Uppercase, strip diacritics (simplified ASCII fold), replace non-alnum with space
  const normalized = rawDescription
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(ALNUM_RE, " ");

  const tokens = normalized.split(/\s+/);
  return tokens.filter((t) => t.length === 16);
}

/**
 * Validate the embedded 2-char checksum at positions [14:16].
 * Body = first 14 chars; check = SHA256(body)[0:2] uppercased hex.
 */
export function validateRefChecksum(ref: string): boolean {
  if (ref.length !== 16) return false;
  if (/[^A-Z0-9]/.test(ref)) return false;
  const body = ref.slice(0, 14);
  const expected = createHash("sha256")
    .update(body, "utf8")
    .digest("hex")
    .slice(0, 2)
    .toUpperCase();
  return ref.slice(14) === expected;
}

/**
 * From a raw bank description, extract the first valid VeData reference code.
 * Returns null if none found.
 */
export function extractValidRef(rawDescription: string): string | null {
  const candidates = extractRefCandidates(rawDescription);
  for (const candidate of candidates) {
    if (validateRefChecksum(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Generate a new VeData order reference code.
 * Format: "VD" + 6-char base36 epoch + 6-char random + 2-char SHA256 check
 * Total: 16 chars, [A-Z0-9] only.
 */
export function generateOrderRef(): string {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const PREFIX = "VD";

  // 6-char base36 epoch segment (changes every 64 seconds)
  const epochVal = Math.floor(Date.now() / 1000) >> 6;
  let epochSeg = "";
  let v = epochVal;
  for (let i = 0; i < 6; i++) {
    epochSeg = CHARS[v % 36]! + epochSeg;
    v = Math.floor(v / 36);
  }

  // 6-char cryptographically random segment
  const randBytes = new Uint8Array(6);
  crypto.getRandomValues(randBytes);
  const randSeg = Array.from(randBytes)
    .map((b) => CHARS[b % 36]!)
    .join("");

  const body = PREFIX + epochSeg + randSeg;
  const check = createHash("sha256")
    .update(body, "utf8")
    .digest("hex")
    .slice(0, 2)
    .toUpperCase();

  return body + check; // 16 chars
}
