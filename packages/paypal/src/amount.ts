// ============================================================
// Amount formatting for PayPal
// ============================================================

const MONEY = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/**
 * Format a non-negative amount with exactly two decimals, as PayPal expects.
 *
 * Accepts numbers, strings and Decimal-like values (anything whose toString()
 * gives the exact amount). It never rounds: a value with more than two decimals
 * — including float drift like 0.1 + 0.2 — is rejected, so a money bug fails
 * loudly instead of charging a rounded amount.
 */
export function toPayPalAmount(value: number | string | { toString(): string }): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`Not a finite amount: ${value}`);
  }
  const text = String(value).trim();
  const match = MONEY.exec(text);
  if (!match) {
    throw new RangeError(`Not a valid PayPal amount (non-negative, at most 2 decimals): "${text}"`);
  }
  const [, whole, fraction = ''] = match;
  const cents = fraction.slice(1).padEnd(2, '0');
  return `${whole}.${cents}`;
}
