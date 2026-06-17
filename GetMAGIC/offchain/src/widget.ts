// src/widget.ts — GetMAGIC Widget public API
// Embeddable flow: find sponsor → create order → return QR data → poll for settlement → claim.

import {
  type LucidEvolution,
  Data,
  validatorToAddress,
  getAddressDetails,
} from "@lucid-evolution/lucid";

import {
  MAGIC_PER_EPOCH,
  DEFAULT_TOTAL_EPOCHS,
  FIAT_AMOUNT_VND,
  ORDER_EXPIRY_MS,
  MAGIC_ALLOCATION_HASH,
  AllocationDatumSchema,
  type AllocationDatum,
} from "./types.js";

// 0.4.34 removed `lucid.utils.*`; network must be read from the instance config.
function requireNetwork(lucid: LucidEvolution) {
  const network = lucid.config().network;
  if (network === undefined) {
    throw new Error("LucidEvolution instance has no network configured");
  }
  return network;
}
import { buildClaimEpochTx, getAllocationsForUser } from "./allocation.js";

// ── Public types ──────────────────────────────────────────────

export interface GetMAGICResult {
  allocId:       string;
  magicPerEpoch: bigint;   // 10_000_000_000n nanogic
  totalEpochs:   number;   // 6
  startEpoch:    bigint;
  sponsor:       string;   // OrgDID display name
  txHash:        string;
  bankQrData:    string;   // VietQR data string
  orderId:       string;
}

export interface GetMAGICConfig {
  apiEndpoint: string;   // VeData oracle API URL
  network:     "Preview" | "Mainnet";
}

// ── VeData API shapes ─────────────────────────────────────────

interface SponsorInfo {
  orgName:    string;
  orgPkh:     string;
  oracleVkey: string;
  bankQrData: string;
}

interface InitOrderResponse {
  orderId:       string;
  orderIdHex:    string;  // hex encoding of orderId bytes
  bankQrData:    string;
  expiresAt:     string;  // ISO8601
  sponsor: {
    orgName:  string;
    orgPkh:   string;
  };
}

interface OrderStatusResponse {
  status:    "pending" | "settled" | "expired" | "cancelled";
  txHash?:   string;
  allocId?:  string;
  result?:   GetMAGICResult;
}

// ── Widget class ──────────────────────────────────────────────

export class GetMAGICWidget {
  private readonly config: GetMAGICConfig;

  constructor(config: GetMAGICConfig) {
    this.config = config;
  }

  /**
   * Main flow entry point.
   *
   * Steps:
   *   1. POST to VeData API to match user with a sponsor Org and create an order UTxO.
   *   2. Return orderId, bankQrData (VietQR), expiry, and sponsor info to caller.
   *
   * The caller displays the QR code; the user pays via bank app.
   * Then call pollUntilSettled() to wait for oracle confirmation.
   */
  async initOrder(params: {
    lucid:          LucidEvolution;
    userAddress:    string;
    magicPerEpoch?: bigint;
    totalEpochs?:   number;
  }): Promise<{
    orderId:    string;
    bankQrData: string;
    expiresAt:  Date;
    sponsor:    { orgName: string; orgPkh: string };
  }> {
    const {
      lucid, userAddress,
      magicPerEpoch = MAGIC_PER_EPOCH,
      totalEpochs   = Number(DEFAULT_TOTAL_EPOCHS),
    } = params;

    const addrDetails = getAddressDetails(userAddress);
    const userPkh     = addrDetails.paymentCredential?.hash ?? "";

    const body = JSON.stringify({
      userPkh,
      userAddress,
      magicPerEpoch:  magicPerEpoch.toString(),
      totalEpochs,
      fiatAmountVnd:  FIAT_AMOUNT_VND.toString(),
      network:        this.config.network,
    });

    const resp = await fetch(`${this.config.apiEndpoint}/orders`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`VeData API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as InitOrderResponse;

    return {
      orderId:    data.orderId,
      bankQrData: data.bankQrData,
      expiresAt:  new Date(data.expiresAt),
      sponsor: {
        orgName: data.sponsor.orgName,
        orgPkh:  data.sponsor.orgPkh,
      },
    };
  }

  /**
   * Poll VeData API until the order is settled or times out.
   *
   * @param orderId    16-char order ID string
   * @param timeoutMs  default 4 hours (ORDER_EXPIRY_MS)
   * @returns          GetMAGICResult when settled
   * @throws           if order expires or API errors
   */
  async pollUntilSettled(
    orderId:    string,
    timeoutMs?: number,
  ): Promise<GetMAGICResult> {
    const deadline   = Date.now() + (timeoutMs ?? ORDER_EXPIRY_MS);
    const pollIntervalMs = 15_000; // poll every 15 seconds

    while (Date.now() < deadline) {
      const resp = await fetch(
        `${this.config.apiEndpoint}/orders/${encodeURIComponent(orderId)}`,
      );

      if (!resp.ok) {
        throw new Error(`VeData status API error ${resp.status}`);
      }

      const data = (await resp.json()) as OrderStatusResponse;

      if (data.status === "settled" && data.result !== undefined) {
        return data.result;
      }

      if (data.status === "expired") {
        throw new Error(`Order ${orderId} expired without settlement`);
      }

      if (data.status === "cancelled") {
        throw new Error(`Order ${orderId} was cancelled`);
      }

      // status === "pending" — wait and retry
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`pollUntilSettled: timeout after ${timeoutMs ?? ORDER_EXPIRY_MS}ms`);
  }

  /**
   * Claim one epoch from an existing AllocationDatum UTxO.
   *
   * @returns transaction hash of the claim transaction
   */
  async claimEpoch(params: {
    lucid:   LucidEvolution;
    allocId: string;
    epoch:   bigint;
  }): Promise<string> {
    const { lucid, allocId, epoch } = params;

    // Find the allocation UTxO by scanning for the alloc_id in datum
    const userAddress = await lucid.wallet().address();
    const addrDetails = getAddressDetails(userAddress);
    const userPkh     = addrDetails.paymentCredential?.hash ?? "";

    const allocAddress = validatorToAddress(requireNetwork(lucid), {
      type:   "PlutusV3",
      script: MAGIC_ALLOCATION_HASH,
    });

    const utxos = await lucid.utxosAt(allocAddress);
    const utxo  = utxos.find(u => {
      if (!u.datum) return false;
      try {
        const d = Data.from<AllocationDatum>(u.datum, AllocationDatumSchema as unknown as AllocationDatum);
        return d.alloc_id === allocId && d.beneficiary_pkh === userPkh;
      } catch {
        return false;
      }
    });

    if (utxo === undefined) {
      throw new Error(`UTxO for allocId=${allocId} not found on-chain for user=${userPkh}`);
    }

    const tx      = await buildClaimEpochTx({ lucid, allocationUtxo: utxo, epoch });
    const signed  = await tx.sign.withWallet().complete();
    const txHash  = await signed.submit();
    return txHash;
  }
}
