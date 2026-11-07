// ============================================================
// Tokento — Per-order lock
// ============================================================
// Capture, cancel, refund, the webhook handler and the sweeper can all touch the
// same order at once. A transaction-scoped Postgres advisory lock on the order id
// serialises them, so for example a cancel can't slip in between PayPal taking
// the money and us recording it.
import type { Prisma } from '@prisma/client';
import prisma from '../db/client';

export async function withOrderLock<T>(
  checkoutId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${checkoutId}))`;
    return fn(tx);
  }, { maxWait: 10_000, timeout: 45_000 });
}
