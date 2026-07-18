export type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_WALLET"
  | "INVALID_AMOUNT"
  | "INVALID_SIGNATURE"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "OFFER_NOT_FOUND"
  | "ORDER_NOT_FOUND"
  | "OFFER_INSUFFICIENT"
  | "OFFER_EXPIRED"
  | "ORDER_EXPIRED"
  | "WRONG_STATUS"
  | "HAS_PENDING_ORDERS"
  | "ALREADY_PROCESSED"
  | "RECEIPT_NOT_AVAILABLE"
  | "IDEMPOTENCY_IN_FLIGHT"
  | "IDEMPOTENCY_KEY_MISMATCH"
  | "RATE_LIMITED"
  | "LOCK_UNAVAILABLE";

export class ServiceError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly statusCode: number,
    message?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "ServiceError";
  }
}

export function toHttpError(
  err: ServiceError,
  requestId: string,
): {
  error: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
  timestamp: string;
} {
  return {
    error:     err.code,
    message:   err.message,
    details:   err.details,
    requestId,
    timestamp: new Date().toISOString(),
  };
}
