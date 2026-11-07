// ============================================================
// PayPal API errors
// ============================================================

/**
 * A failed PayPal call. `status` 0 means the request never got an answer
 * (network failure or timeout), which callers treat as "PayPal unavailable".
 */
export class PayPalApiError extends Error {
  readonly status: number;
  /** PayPal's error name, e.g. UNPROCESSABLE_ENTITY, or NETWORK_ERROR. */
  readonly name: string;
  /** PayPal's debug_id, the value their support asks for. */
  readonly debugId: string | null;
  /** Issue codes from `details[].issue`, e.g. ORDER_ALREADY_CAPTURED. */
  readonly issues: string[];

  constructor(params: { status: number; name: string; message: string; debugId?: string | null; issues?: string[] }) {
    super(params.message);
    this.status = params.status;
    this.name = params.name;
    this.debugId = params.debugId ?? null;
    this.issues = params.issues ?? [];
  }

  /** True when PayPal reported this issue code. */
  hasIssue(issue: string): boolean {
    return this.issues.includes(issue);
  }
}
