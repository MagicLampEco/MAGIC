import { customAlphabet } from "nanoid";
import { v4 as uuidv4 } from "uuid";

// Alphabet: uppercase letters + digits (unambiguous set, no 0/O/1/I)
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const nano8  = customAlphabet(ALPHABET, 8);
const nano12 = customAlphabet(ALPHABET, 12);

/** e.g. "offer_01HXYZ123ABC" */
export function generateOfferId(): string {
  return `offer_${nano12()}`;
}

/** e.g. "ord_01HY001AAABCD" */
export function generateOrderId(): string {
  return `ord_${nano12()}`;
}

/**
 * Generate a unique VietQR reference code.
 * Format: LAMP<amount padded 6>ORD<8-char suffix>  — max 25 chars.
 * e.g. "LAMP005000ORD3X7KQM5A"
 */
export function generateReferenceCode(
  tokenSymbol: string,
  tokenAmount: bigint,
  orderIdSuffix: string,
): string {
  const amountPart  = String(tokenAmount).padStart(6, "0").slice(-6);
  const suffix      = orderIdSuffix.slice(-8).toUpperCase();
  return `${tokenSymbol}${amountPart}ORD${suffix}`;
}

/** Standard UUID v4 */
export function newUUID(): string {
  return uuidv4();
}
