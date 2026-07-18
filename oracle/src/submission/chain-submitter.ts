/**
 * VeData Oracle — Cardano Transaction Submitter (Option A: oracle submits)
 *
 * Spec §5 Option A: Oracle builds the Release transaction and pays Cardano fees
 * from its own fee wallet. This delivers the full zero-friction UX where the buyer
 * only needs to transfer VND.
 *
 * Transaction structure:
 *   Inputs:  OTC Escrow UTxO (contains offer tokens + bond ADA)
 *   Redeemer: Release { orderId, buyerAddr, tokenQty, vndAmount, oracleSig }
 *   Outputs:
 *     [0] → buyerWallet: tokenAmount of policyId.assetName + minUTxO ADA
 *     [1] → OTC Escrow script: remaining tokens + bond (datum unchanged minus qty)
 *   Fee:     Paid from oracle fee wallet
 *   Validity: [now, now + 15 min]
 *
 * Retry strategy (spec §7.4):
 *   - Fee insufficient: recalculate with current protocol params, rebuild, retry
 *   - Mempool full: exponential backoff (30s, 60s, 120s, 300s, 600s)
 *   - Expired signature: re-sign via signer.resignRelease, rebuild
 *   - ExUnit exceeded: halt + alert (contract performance regression)
 */

import {
  Lucid,
  Blockfrost,
  type UTxO,
  type Tx,
  Data,
  toHex,
  type Network,
} from "@lucid-evolution/lucid";
import axios from "axios";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { prisma } from "../db.js";
import { bus } from "../events.js";
import { sendAlert } from "../alerting.js";
import { resignRelease } from "../signing/signer.js";
import type { Order, ReleaseSignature } from "@prisma/client";

// ─── Redeemer schema (matches Aiken contract) ─────────────────────────────────
// data ReleaseRedeemer = ReleaseRedeemer
//   { signedMessageCbor :: BuiltinByteString
//   , oracleSignature   :: BuiltinByteString
//   }

const ReleaseRedeemerSchema = Data.Object({
  signedMessageCbor: Data.Bytes(),
  oracleSignature: Data.Bytes(),
});
type ReleaseRedeemer = Data.Static<typeof ReleaseRedeemerSchema>;
const ReleaseRedeemerData = ReleaseRedeemerSchema as unknown as ReleaseRedeemer;

// ─── Retry config ─────────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const SUBMISSION_TIMEOUT_MS = 30_000;

// ─── Lucid instance (lazy init) ───────────────────────────────────────────────

let _lucid: Awaited<ReturnType<typeof Lucid>> | null = null;

async function getLucid(): Promise<Awaited<ReturnType<typeof Lucid>>> {
  if (_lucid) return _lucid;

  const network = config.CARDANO_NETWORK as Network;
  const blockfrostUrl =
    config.BLOCKFROST_BASE_URL ??
    (network === "mainnet"
      ? "https://cardano-mainnet.blockfrost.io/api/v0"
      : network === "preview"
      ? "https://cardano-preview.blockfrost.io/api/v0"
      : "https://cardano-preprod.blockfrost.io/api/v0");

  _lucid = await Lucid(
    new Blockfrost(blockfrostUrl, config.BLOCKFROST_API_KEY),
    network === "mainnet" ? "Mainnet" : network === "preview" ? "Preview" : "Preprod"
  );

  // Load oracle fee wallet signing key (extended Ed25519 cborHex)
  _lucid.selectWallet.fromPrivateKey(config.ORACLE_FEE_WALLET_SKEY);

  logger.info({ network, blockfrostUrl }, "Lucid initialized");
  return _lucid;
}

// ─── UTxO fetching ────────────────────────────────────────────────────────────

async function findContractUtxo(
  lucid: Awaited<ReturnType<typeof Lucid>>,
  offerId: string
): Promise<UTxO | null> {
  const utxos = await lucid.utxosAt(config.OTC_SCRIPT_ADDRESS);

  // offerId format: "txHash#outputIndex"
  const [txHash, indexStr] = offerId.split("#");
  if (!txHash || !indexStr) {
    throw new Error(`Invalid offerId format "${offerId}" — expected "txHash#index"`);
  }
  const outputIndex = parseInt(indexStr, 10);

  const utxo = utxos.find(
    (u) => u.txHash === txHash && u.outputIndex === outputIndex
  );

  return utxo ?? null;
}

// ─── Transaction builder ──────────────────────────────────────────────────────

/**
 * Build the Release transaction.
 * Returns an unsigned Tx (oracle fee wallet will sign it).
 */
async function buildReleaseTx(
  lucid: Awaited<ReturnType<typeof Lucid>>,
  order: Order,
  contractUtxo: UTxO,
  sig: ReleaseSignature
): Promise<Tx> {
  const childLog = logger.child({ orderId: order.id, component: "tx-builder" });

  // Validity interval: [now, now + 15 min]
  const nowMs = Date.now();
  const validFrom = nowMs - 60_000;     // 1 min in the past to handle clock skew
  const validTo = nowMs + 15 * 60_000; // 15 min

  // Redeemer
  const redeemer: ReleaseRedeemer = {
    signedMessageCbor: toHex(sig.messageBytes),
    oracleSignature: sig.signatureHex,
  };
  const redeemerData = Data.to(redeemer, ReleaseRedeemerData);

  // Token unit: policyId + assetName (hex)
  const assetUnit = order.tokenPolicy + order.tokenName;
  const tokenAmount = order.tokenAmount;

  // Determine how many tokens remain in contract after release
  const contractTokens = contractUtxo.assets[assetUnit] ?? BigInt(0);
  if (contractTokens < tokenAmount) {
    throw new Error(
      `Contract UTxO has insufficient tokens: needs ${tokenAmount}, has ${contractTokens}`
    );
  }
  const remainingTokens = contractTokens - tokenAmount;

  childLog.info(
    {
      contractTokens: contractTokens.toString(),
      releasing: tokenAmount.toString(),
      remaining: remainingTokens.toString(),
    },
    "Building release transaction"
  );

  let tx = lucid
    .newTx()
    .collectFrom([contractUtxo], redeemerData)
    .attach.Script({ type: "PlutusV3", script: config.OTC_SCRIPT_CBOR })
    .validFrom(validFrom)
    .validTo(validTo);

  // Output 0: tokens to buyer
  const buyerValue: Record<string, bigint> = {
    lovelace: BigInt(2_000_000), // 2 ADA min UTxO
    [assetUnit]: tokenAmount,
  };
  tx = tx.pay.ToAddress(order.buyerWallet, buyerValue);

  // Output 1: remaining tokens back to contract (if any remain)
  if (remainingTokens > BigInt(0)) {
    const contractValue: Record<string, bigint> = {
      lovelace: contractUtxo.assets["lovelace"] ?? BigInt(2_000_000),
      [assetUnit]: remainingTokens,
    };

    // Preserve datum (inline) for remaining escrow
    if (contractUtxo.datum) {
      tx = tx.pay.ToAddressWithData(
        config.OTC_SCRIPT_ADDRESS,
        { kind: "inline", value: contractUtxo.datum },
        contractValue
      );
    } else if (contractUtxo.datumHash) {
      tx = tx.pay.ToAddress(config.OTC_SCRIPT_ADDRESS, contractValue);
    }
  }

  return tx;
}

// ─── Submission with retry ────────────────────────────────────────────────────

async function submitWithTimeout(
  signedTxCbor: string,
  lucid: Awaited<ReturnType<typeof Lucid>>
): Promise<string> {
  // Lucid's submit returns the tx hash or throws
  const submissionPromise = lucid.wallet().submitTx(signedTxCbor);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Submission timeout")), SUBMISSION_TIMEOUT_MS)
  );
  return Promise.race([submissionPromise, timeoutPromise]);
}

// ─── Main public interface ────────────────────────────────────────────────────

export class ChainSubmitter {
  private readonly childLog = logger.child({ component: "chain-submitter" });

  /**
   * Submit a signed release and handle retries.
   * Called after 'order.signed' event is emitted by the processor.
   */
  async submitRelease(orderId: string): Promise<void> {
    const childLog = this.childLog.child({ orderId });

    // Load order + signature
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      childLog.error("Order not found — cannot submit");
      return;
    }
    if (order.status !== "SIGNED") {
      childLog.warn({ status: order.status }, "Order not in SIGNED state — skipping submission");
      return;
    }

    const sig = await prisma.releaseSignature.findUnique({ where: { orderId } });
    if (!sig) {
      childLog.error("No signature found for order");
      return;
    }

    // Check signature not yet expired (give 30s buffer)
    const nowPosix = Math.floor(Date.now() / 1000);
    if (Number(sig.expiryPosix) < nowPosix + 30) {
      childLog.warn("Signature expired — requesting re-sign before submission");
      const freshSig = await resignRelease(order, sig);
      childLog.info(
        { newExpiry: freshSig.expiryPosix.toString() },
        "Re-signed successfully"
      );
      await this.submitRelease(orderId); // Recurse once with fresh sig
      return;
    }

    const lucid = await getLucid();

    // Find contract UTxO
    const contractUtxo = await findContractUtxo(lucid, order.offerId);
    if (!contractUtxo) {
      childLog.error(
        { offerId: order.offerId },
        "Contract UTxO not found — offer may be depleted or cancelled"
      );
      await sendAlert(
        `SUBMISSION_FAILED: Order ${orderId} — contract UTxO ${order.offerId} not found. ` +
          "Offer may be depleted or cancelled. Manual review required.",
        { orderId, offerId: order.offerId }
      );
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "EXCEPTION" },
      });
      return;
    }

    // Attempt submission with exponential backoff
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      try {
        childLog.info({ attempt }, "Building release transaction");

        const tx = await buildReleaseTx(lucid, order, contractUtxo, sig);
        const signedTx = await tx.sign.withWallet().complete();
        const txCbor = signedTx.toCBOR();

        childLog.info({ attempt }, "Submitting transaction");

        await prisma.releaseSignature.update({
          where: { orderId },
          data: {
            submissionAttempts: { increment: 1 },
            submittedAt: new Date(),
          },
        });

        await prisma.order.update({
          where: { id: orderId },
          data: { status: "SUBMITTED" },
        });

        const txHash = await submitWithTimeout(txCbor, lucid);

        childLog.info({ txHash }, "Transaction submitted successfully");

        await prisma.releaseSignature.update({
          where: { orderId },
          data: { cardanoTxHash: txHash },
        });

        // Start confirmation monitoring
        void this.monitorConfirmation(orderId, txHash);
        return;
      } catch (err) {
        const errMsg = String(err);
        childLog.warn({ attempt, err: errMsg }, "Submission attempt failed");

        // Classify error
        if (errMsg.includes("Script execution units exceeded")) {
          childLog.error("ExUnit budget exceeded — halting, alerting engineering");
          await sendAlert(
            `CRITICAL: ExUnit budget exceeded for order ${orderId}. ` +
              "Possible contract performance regression. PAUSING SUBMISSIONS.",
            { orderId, error: errMsg }
          );
          await prisma.order.update({
            where: { id: orderId },
            data: { status: "EXCEPTION" },
          });
          return; // Do not retry
        }

        if (errMsg.includes("Transaction already in mempool")) {
          // Tx is queued — treat as success
          childLog.info("Transaction already in mempool — waiting for confirmation");
          const txHash = await this.extractTxHashFromError(errMsg);
          if (txHash) {
            await prisma.releaseSignature.update({
              where: { orderId },
              data: { cardanoTxHash: txHash },
            });
            void this.monitorConfirmation(orderId, txHash);
          }
          return;
        }

        // Signature expiry during retry loop
        if (errMsg.includes("outside validity interval") || errMsg.includes("slot")) {
          childLog.warn("Tx validity interval issue — re-signing");
          const freshSig = await resignRelease(order, sig);
          childLog.info({ newExpiry: freshSig.expiryPosix.toString() }, "Re-signed");
          // Restart retry loop with fresh sig
          await this.submitRelease(orderId);
          return;
        }

        if (attempt >= RETRY_DELAYS_MS.length) {
          // All retries exhausted
          childLog.error({ attempts: attempt + 1 }, "All submission retries exhausted");
          await sendAlert(
            `SUBMISSION_FAILED: Order ${orderId} — all ${attempt + 1} submission attempts failed. ` +
              "Manual submission required.",
            { orderId, lastError: errMsg }
          );
          // Keep order in SUBMITTED state so manual retry is possible
          return;
        }

        const delayMs = RETRY_DELAYS_MS[attempt]!;
        childLog.info({ delayMs }, "Waiting before retry");
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    }
  }

  // ── Confirmation monitoring ───────────────────────────────────────────────

  private async monitorConfirmation(orderId: string, txHash: string): Promise<void> {
    const childLog = this.childLog.child({ orderId, txHash });
    const confirmationDepth = config.CONFIRMATION_DEPTH;
    const pollIntervalMs = 20_000; // Poll every 20 seconds
    const maxWaitMs = 30 * 60_000; // 30 minutes max
    const startTime = Date.now();

    childLog.info({ confirmationDepth }, "Starting confirmation monitoring");

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));

      try {
        const lucid = await getLucid();
        // Query transaction confirmation status
        // Lucid-Evolution exposes provider.getTxInfo or we use Blockfrost directly
        const txInfo = await this.fetchTxConfirmationInfo(txHash);

        if (!txInfo) {
          childLog.debug("Transaction not yet confirmed");
          continue;
        }

        if (txInfo.blockHeight !== null && txInfo.confirmations >= 1) {
          await prisma.$transaction([
            prisma.releaseSignature.update({
              where: { orderId },
              data: { confirmedAt: new Date() },
            }),
            prisma.order.update({
              where: { id: orderId },
              data: { status: "CONFIRMED" },
            }),
          ]);
          childLog.info(
            { confirmations: txInfo.confirmations },
            "Transaction CONFIRMED (>= 1 block)"
          );
        }

        if (txInfo.confirmations >= confirmationDepth) {
          await prisma.$transaction([
            prisma.releaseSignature.update({
              where: { orderId },
              data: {
                finalizedAt: new Date(),
                used: true,
                usedAt: new Date(),
              },
            }),
            prisma.order.update({
              where: { id: orderId },
              data: { status: "FINALIZED", completedAt: new Date() },
            }),
          ]);
          childLog.info(
            { confirmations: txInfo.confirmations, depth: confirmationDepth },
            "Transaction FINALIZED — order complete"
          );

          bus.emit("order.finalized", orderId, txHash);
          return;
        }
      } catch (err) {
        childLog.warn({ err }, "Error polling confirmation — will retry");
      }
    }

    // Timeout — alert ops
    childLog.error("Confirmation polling timed out after 30 minutes");
    await sendAlert(
      `CONFIRMATION_TIMEOUT: Order ${orderId} tx ${txHash} not confirmed after 30 minutes. ` +
        "Check Blockfrost / Cardano explorer.",
      { orderId, txHash }
    );
  }

  private async fetchTxConfirmationInfo(
    txHash: string
  ): Promise<{ blockHeight: number | null; confirmations: number } | null> {
    // Use Blockfrost REST API directly for confirmation depth tracking
    const net = config.CARDANO_NETWORK;
    const baseUrl =
      config.BLOCKFROST_BASE_URL ??
      (net === "mainnet"
        ? "https://cardano-mainnet.blockfrost.io/api/v0"
        : net === "preview"
        ? "https://cardano-preview.blockfrost.io/api/v0"
        : "https://cardano-preprod.blockfrost.io/api/v0");

    try {
      const [txResp, latestBlockResp] = await Promise.all([
        axios.get<{ block_height: number | null }>(
          `${baseUrl}/txs/${txHash}`,
          {
            headers: { project_id: config.BLOCKFROST_API_KEY },
            timeout: 10_000,
          }
        ),
        axios.get<{ height: number }>(
          `${baseUrl}/blocks/latest`,
          {
            headers: { project_id: config.BLOCKFROST_API_KEY },
            timeout: 10_000,
          }
        ),
      ]);

      const txBlockHeight = txResp.data.block_height;
      if (txBlockHeight === null) return { blockHeight: null, confirmations: 0 };

      const currentHeight = latestBlockResp.data.height;
      const confirmations = currentHeight - txBlockHeight + 1;

      return { blockHeight: txBlockHeight, confirmations };
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null; // Not yet in chain
      }
      throw err;
    }
  }

  private extractTxHashFromError(errMsg: string): string | null {
    const match = errMsg.match(/[0-9a-f]{64}/i);
    return match ? match[0]! : null;
  }

  /**
   * Handle UTxO contention: if we try to spend a UTxO already consumed, check
   * whether the consuming transaction was our own correct Release.
   */
  async handleUtxoContention(orderId: string, spentTxHash: string): Promise<void> {
    const childLog = this.childLog.child({ orderId, spentTxHash });
    childLog.warn("UTxO contention detected — checking if already released");

    // If the spending tx is already recorded for this order, treat as success
    const sig = await prisma.releaseSignature.findUnique({ where: { orderId } });
    if (sig?.cardanoTxHash === spentTxHash) {
      childLog.info("UTxO was spent by our own transaction — already released");
      return;
    }

    // Otherwise: another transaction consumed the UTxO — critical alert
    childLog.error(
      { ourTxHash: sig?.cardanoTxHash, competingTxHash: spentTxHash },
      "UTxO consumed by unexpected transaction — possible front-running or contract bug"
    );
    await sendAlert(
      `UTXO_CONTENTION: Order ${orderId} — escrow UTxO consumed by unexpected tx ${spentTxHash}. ` +
        "Possible front-running. Immediate investigation required.",
      { orderId, spentTxHash, ourTxHash: sig?.cardanoTxHash }
    );
    await prisma.order.update({ where: { id: orderId }, data: { status: "EXCEPTION" } });
  }
}

export const chainSubmitter = new ChainSubmitter();
