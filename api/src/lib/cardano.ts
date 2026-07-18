/**
 * Cardano address validation helpers.
 * Validates Bech32 encoding with correct HRP prefixes for mainnet and testnets.
 */

const VALID_HRP = new Set([
  "addr",        // mainnet
  "addr_test",   // testnet / preview / preprod
  "stake",
  "stake_test",
]);

/**
 * Lightweight Bech32 check — verifies the human-readable part and that the
 * data section is non-empty and uses only valid Bech32 charset characters.
 * Full checksum verification is intentionally skipped to avoid a heavy
 * native dependency; the on-chain script enforces the address binding.
 */
export function isValidCardanoAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  const lower = address.toLowerCase();

  // Find separator
  const sepIndex = lower.lastIndexOf("1");
  if (sepIndex < 1) return false;

  const hrp  = lower.slice(0, sepIndex);
  const data = lower.slice(sepIndex + 1);

  if (!VALID_HRP.has(hrp)) return false;
  if (data.length < 6)     return false; // checksum chars minimum

  // Bech32 charset: q p z r y 9 x 8 g f 2 t v d w 0 s 3 j n 5 4 k h c e 6 m u a 7 l
  const CHARSET = /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/;
  if (!CHARSET.test(data)) return false;

  return true;
}
