/**
 * VietQR service — NAPAS EMVCo Merchant Presented QR (dynamic, one-time use).
 *
 * Spec reference: VietQR 1.0 / NAPAS EMVCo spec v1.2
 * CRC algorithm:  CRC-16/CCITT (polynomial 0x1021, init 0xFFFF, no reflect)
 */
import QRCode from "qrcode";
import { config } from "../lib/config.js";

// ─────────────────────────────────────────────
// Bank directory
// ─────────────────────────────────────────────
export interface BankInfo {
  displayName:     string;
  bankCode:        string;
  napasbin:        string;  // 6-digit BIN
  deeplinkScheme?: string;
}

export const BANKS: Record<string, BankInfo> = {
  VCB:  { displayName: "Vietcombank",   bankCode: "VCB",  napasbin: "970406", deeplinkScheme: "vcb" },
  MB:   { displayName: "MB Bank",       bankCode: "MB",   napasbin: "970422", deeplinkScheme: "mbmobile" },
  VPB:  { displayName: "VPBank",        bankCode: "VPB",  napasbin: "970432", deeplinkScheme: "vpbank" },
  TCB:  { displayName: "Techcombank",   bankCode: "TCB",  napasbin: "970407", deeplinkScheme: "techcombank" },
  ACB:  { displayName: "ACB",           bankCode: "ACB",  napasbin: "970416", deeplinkScheme: "acb" },
  CTG:  { displayName: "Vietinbank",    bankCode: "CTG",  napasbin: "970415", deeplinkScheme: "vietinbank" },
  BIDV: { displayName: "BIDV",          bankCode: "BIDV", napasbin: "970418", deeplinkScheme: "bidv" },
  AGR:  { displayName: "Agribank",      bankCode: "AGR",  napasbin: "970405", deeplinkScheme: "agribank" },
  STB:  { displayName: "Sacombank",     bankCode: "STB",  napasbin: "970403", deeplinkScheme: "sacombank" },
  HDB:  { displayName: "HDBank",        bankCode: "HDB",  napasbin: "970437", deeplinkScheme: "hdbank" },
  SHB:  { displayName: "SHB",           bankCode: "SHB",  napasbin: "970443", deeplinkScheme: "shb" },
  OCB:  { displayName: "OCB",           bankCode: "OCB",  napasbin: "970448", deeplinkScheme: "ocb" },
};

// ─────────────────────────────────────────────
// CRC-16/CCITT (poly 0x1021, init 0xFFFF)
// ─────────────────────────────────────────────
function crc16ccitt(data: string): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

// ─────────────────────────────────────────────
// EMVCo TLV helpers
// ─────────────────────────────────────────────
function tlv(tag: string, value: string): string {
  const len = value.length.toString().padStart(2, "0");
  return `${tag}${len}${value}`;
}

// ─────────────────────────────────────────────
// Build VietQR string per NAPAS EMVCo spec
// ─────────────────────────────────────────────
export interface VietQRParams {
  bankBin:        string;   // 6-digit NAPAS BIN
  accountNumber:  string;
  amount:         number;   // VND integer
  referenceCode:  string;   // max 25 chars — unique per order
  description:    string;   // max 25 chars
  merchantName:   string;   // max 25 chars
}

export function buildVietQRString(params: VietQRParams): string {
  // Truncate to 25 chars as required by spec
  const refCode    = params.referenceCode.slice(0, 25);
  const desc       = params.description.slice(0, 25);
  const merchant   = params.merchantName.slice(0, 25);

  // Tag 38 — NAPAS Merchant Account Information
  // Sub-tag 00: GUID (fixed per NAPAS spec)
  // Sub-tag 01: BIN (6 digits prefixed with "0006")
  // Sub-tag 02: Account number
  const napasGuid    = "A000000727";
  const bankSubId    = `0006${params.bankBin}`;
  const merchantAcct =
    tlv("00", napasGuid) +
    tlv("01", bankSubId) +
    tlv("02", params.accountNumber);

  // Tag 62 — Additional Data Field
  // Sub-tag 05: Reference label (referenceCode)
  // Sub-tag 08: Purpose of transaction (description)
  const additionalData = tlv("05", refCode) + tlv("08", desc);

  // Build body without CRC (tag 63)
  const body =
    tlv("00", "01") +                                         // Payload Format Indicator
    tlv("01", "12") +                                         // Point of Initiation: dynamic
    tlv("38", merchantAcct) +                                  // NAPAS Merchant Account
    tlv("52", "4212") +                                        // Merchant Category Code (financial services)
    tlv("53", "704") +                                         // Transaction Currency: VND
    tlv("54", String(params.amount)) +                         // Transaction Amount
    tlv("59", merchant) +                                      // Merchant Name
    tlv("60", "HO CHI MINH") +                                 // Merchant City
    tlv("62", additionalData) +                                // Additional Data
    "6304";                                                    // CRC tag (value appended below)

  const crc = crc16ccitt(body).toString(16).toUpperCase().padStart(4, "0");
  return body + crc;
}

// ─────────────────────────────────────────────
// Generate QR code PNG as base64
// ─────────────────────────────────────────────
export async function generateQRCodeBase64(qrString: string): Promise<string> {
  const dataUrl = await QRCode.toDataURL(qrString, {
    errorCorrectionLevel: "M",
    type:  "image/png",
    width: 400,
    margin: 2,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  // Strip the "data:image/png;base64," prefix
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

// ─────────────────────────────────────────────
// Build deep links for popular Vietnamese banking apps
// ─────────────────────────────────────────────
export function buildDeeplinks(params: {
  bankCode:      string;
  accountNumber: string;
  accountName:   string;
  amount:        number;
  referenceCode: string;
  qrString:      string;
}): Record<string, string> {
  const encodedQr   = encodeURIComponent(params.qrString);
  const encodedName = encodeURIComponent(params.accountName);
  const encodedRef  = encodeURIComponent(params.referenceCode);

  const bank = BANKS[params.bankCode];
  const result: Record<string, string> = {};

  // VietQR universal image link (works for all banks)
  result["vietqr"] = `https://img.vietqr.io/image/${params.bankCode}-${params.accountNumber}-qr_only.png?amount=${params.amount}&addInfo=${encodedRef}`;

  if (bank) {
    switch (params.bankCode) {
      case "VCB":
        result["vcb"] = `vcb://payment?amount=${params.amount}&desc=${encodedRef}&toAccNum=${params.accountNumber}&toAccName=${encodedName}`;
        break;
      case "MB":
        result["mb"] = `mbmobile://payment?bankBin=${bank.napasbin}&amount=${params.amount}&qrData=${encodedQr}`;
        break;
      case "VPB":
        result["vpbank"] = `vpbank://payment?amount=${params.amount}&desc=${encodedRef}&accountNumber=${params.accountNumber}`;
        break;
      case "TCB":
        result["tcb"] = `techcombank://qr?qrCode=${encodedQr}`;
        break;
      case "ACB":
        result["acb"] = `acb://qr?data=${encodedQr}`;
        break;
      case "CTG":
        result["ctg"] = `vietinbank://qr?amount=${params.amount}&content=${encodedRef}&bankNumber=${params.accountNumber}`;
        break;
      case "BIDV":
        result["bidv"] = `bidv://payment?amount=${params.amount}&desc=${encodedRef}&toAccNum=${params.accountNumber}`;
        break;
      case "AGR":
        result["agr"] = `agribank://qr?data=${encodedQr}`;
        break;
      case "STB":
        result["stb"] = `sacombank://qr?data=${encodedQr}`;
        break;
      case "HDB":
        result["hdb"] = `hdbank://qr?data=${encodedQr}`;
        break;
      case "SHB":
        result["shb"] = `shb://qr?data=${encodedQr}`;
        break;
      case "OCB":
        result["ocb"] = `ocb://qr?data=${encodedQr}`;
        break;
    }
  }

  return result;
}

// ─────────────────────────────────────────────
// High-level helper: build full payment QR payload
// ─────────────────────────────────────────────
export interface QRPayload {
  qrString:     string;
  qrImageUrl:   string;
  qrBase64:     string;
  deeplinks:    Record<string, string>;
}

export async function buildPaymentQR(params: {
  orderId:       string;
  bankCode:      string;
  accountNumber: string;
  accountName:   string;
  amount:        number;
  referenceCode: string;
  tokenSymbol:   string;
}): Promise<QRPayload> {
  const bank = BANKS[params.bankCode];
  if (!bank) throw new Error(`Unsupported bank code: ${params.bankCode}`);

  const description  = `Mua ${params.tokenSymbol} ${params.referenceCode}`.slice(0, 25);
  const merchantName = config.bank.defaultMerchantName.slice(0, 25);

  const qrString = buildVietQRString({
    bankBin:       bank.napasbin,
    accountNumber: params.accountNumber,
    amount:        params.amount,
    referenceCode: params.referenceCode,
    description,
    merchantName,
  });

  const [qrBase64] = await Promise.all([generateQRCodeBase64(qrString)]);

  const deeplinks = buildDeeplinks({
    bankCode:      params.bankCode,
    accountNumber: params.accountNumber,
    accountName:   params.accountName,
    amount:        params.amount,
    referenceCode: params.referenceCode,
    qrString,
  });

  const qrImageUrl = `${config.baseUrl}/v1/orders/${params.orderId}/qr.png`;

  return { qrString, qrImageUrl, qrBase64, deeplinks };
}
