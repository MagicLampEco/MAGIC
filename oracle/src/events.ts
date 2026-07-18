/**
 * VeData Oracle — Internal Event Bus
 * Typed EventEmitter for loose coupling between bank monitors and the processor.
 */

import { EventEmitter } from "events";

// ─── Event shapes ─────────────────────────────────────────────────────────────

export interface NormalizedPayment {
  /** 'payos' | 'mbbank' | 'vcb' | 'acb' | 'reconciler' */
  source: string;
  /** Bank's own unique transaction identifier */
  bankTxRef: string;
  /** Post-fee VND amount received */
  amountVND: bigint;
  /** Original description from bank */
  rawDescription: string;
  /** When the bank says the transfer occurred */
  detectedAt: Date;
  /** Full raw webhook/poll payload for audit */
  rawPayload: Record<string, unknown>;
}

// ─── Typed bus ────────────────────────────────────────────────────────────────

interface OracleEvents {
  "payment.confirmed": [payment: NormalizedPayment];
  "order.signed": [orderId: string];
  "order.finalized": [orderId: string, txHash: string];
  "alert.ops": [message: string, metadata?: Record<string, unknown>];
  "shutdown.requested": [];
}

class OracleEventBus extends EventEmitter {
  emit<K extends keyof OracleEvents>(
    event: K,
    ...args: OracleEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof OracleEvents>(
    event: K,
    listener: (...args: OracleEvents[K]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof OracleEvents>(
    event: K,
    listener: (...args: OracleEvents[K]) => void
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof OracleEvents>(
    event: K,
    listener: (...args: OracleEvents[K]) => void
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

export const bus = new OracleEventBus();
bus.setMaxListeners(20);
