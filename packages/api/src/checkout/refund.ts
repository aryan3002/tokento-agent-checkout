// ============================================================
// Tokento — Refunds
// ============================================================
// A full PayPal refund of an agent purchase. When PayPal confirms it, the
// shopper gets the reward they spent back (as a fresh signed token) and the
// reward the purchase earned is voided if it hasn't been used. The same
// confirmation can arrive from the refund response or a webhook (including
// refunds made in the PayPal dashboard); both paths are idempotent.
import type { Prisma } from '@prisma/client';
import { PayPalApiError } from '@tokento/paypal';
import { CheckoutStatus, EventType, TokenStatus, type CheckoutOrderView } from '@tokento/shared';
import prisma from '../db/client';
import { emitEvent } from '../events/emitter';
import { AppError } from '../middleware/error.middleware';
import { tokenService } from '../services/token.service';
import { logger } from '../utils/logger';
import { toMoneyNumber } from '../utils/money';
import { invalidateWalletCache } from '../utils/wallet-cache';
import type { AfterCommit } from './finalize';
import { withOrderLock } from './order-lock';
import { getPayPal } from './paypal';
import { loadOrderView } from './views';

export interface RefundInfo {
  refundId: string;
  /** PayPal refund status: COMPLETED, PENDING, FAILED, CANCELLED. */
  status: string;
  amount: string;
}

export type RefundSource = 'refund_response' | 'webhook';

const REFUNDABLE: string[] = [CheckoutStatus.COMPLETED, CheckoutStatus.NEEDS_REVIEW];

export async function refundOrder(merchantId: string, checkoutId: string): Promise<CheckoutOrderView> {
  const after = await withOrderLock(checkoutId, async (tx) => {
    const order = await tx.checkoutOrder.findUnique({ where: { id: checkoutId }, include: { merchant: { select: { name: true } } } });
    if (!order || order.merchantId !== merchantId) {
      throw new AppError(404, 'checkout_not_found', 'Checkout order not found.');
    }
    if (order.status === CheckoutStatus.REFUNDED || order.status === CheckoutStatus.REFUND_PENDING) return [];
    if (!REFUNDABLE.includes(order.status) || !order.paypalCaptureId) {
      throw new AppError(409, 'not_refundable', `Order is ${order.status.toLowerCase()} and cannot be refunded.`);
    }

    let refund;
    try {
      refund = await getPayPal().refundCapture(
        order.paypalCaptureId,
        { note: `Refund from ${order.merchant.name}`.slice(0, 255) },
        { requestId: `refund:${order.id}` },
      );
    } catch (err) {
      if (err instanceof PayPalApiError && err.hasIssue('CAPTURE_FULLY_REFUNDED')) {
        throw new AppError(409, 'already_refunded', 'PayPal says this payment was already refunded. The refund webhook will update the order.');
      }
      if (err instanceof PayPalApiError) {
        throw new AppError(502, 'paypal_unavailable', 'PayPal could not refund the payment. Try again.', { paypalError: err.name, debugId: err.debugId });
      }
      throw err;
    }

    return applyRefundLocked(tx, checkoutId, {
      refundId: refund.id,
      status: refund.status,
      amount: refund.amount?.value ?? order.amountToPay.toFixed(2),
    }, 'refund_response');
  });

  for (const run of after) run();
  return loadOrderView(checkoutId);
}

export async function applyRefund(checkoutId: string, refund: RefundInfo, source: RefundSource): Promise<CheckoutOrderView> {
  const after = await withOrderLock(checkoutId, (tx) => applyRefundLocked(tx, checkoutId, refund, source));
  for (const run of after) run();
  return loadOrderView(checkoutId);
}

async function applyRefundLocked(
  tx: Prisma.TransactionClient,
  checkoutId: string,
  refund: RefundInfo,
  source: RefundSource,
): Promise<AfterCommit> {
  const order = await tx.checkoutOrder.findUnique({ where: { id: checkoutId } });
  if (!order) throw new AppError(404, 'checkout_not_found', 'Checkout order not found.');
  if (order.status === CheckoutStatus.REFUNDED) return [];
  const after: AfterCommit = [];
  const announce = (status: string) => () => emitEvent(EventType.CHECKOUT_UPDATED, {
    checkoutId: order.id, merchantId: order.merchantId, customerId: order.customerId, status,
  });

  if (refund.status === 'PENDING') {
    if (order.status !== CheckoutStatus.REFUND_PENDING) {
      await tx.checkoutOrder.update({
        where: { id: order.id },
        data: { status: CheckoutStatus.REFUND_PENDING, paypalRefundId: refund.refundId, note: 'PayPal is processing the refund.' },
      });
      after.push(announce(CheckoutStatus.REFUND_PENDING));
    }
    return after;
  }

  if (refund.status !== 'COMPLETED') {
    await tx.checkoutOrder.update({
      where: { id: order.id },
      data: {
        status: order.status === CheckoutStatus.REFUND_PENDING ? CheckoutStatus.COMPLETED : order.status,
        note: `PayPal could not complete the refund (${refund.status}).`,
      },
    });
    after.push(announce(order.status));
    return after;
  }

  // Give back the reward the shopper spent.
  let reissuedTokenId = order.reissuedTokenId;
  if (order.redemptionId && order.rewardTokenId && !reissuedTokenId) {
    const original = await prisma.token.findUniqueOrThrow({ where: { id: order.rewardTokenId } });
    const reissued = await tokenService.reissue(original, { idempotencyKey: `reissue:${order.id}`, isSandbox: order.isSandbox });
    reissuedTokenId = reissued.id;
  }

  // Cancel the reward this purchase earned, unless it has already been spent.
  let earnedVoided = false;
  if (order.earnedTokenId) {
    const voided = await tx.token.updateMany({
      where: { id: order.earnedTokenId, status: TokenStatus.ACTIVE },
      data: { status: TokenStatus.VOIDED },
    });
    earnedVoided = voided.count === 1;
  }

  await tx.checkoutOrder.update({
    where: { id: order.id },
    data: {
      status: CheckoutStatus.REFUNDED,
      paypalRefundId: refund.refundId,
      refundedAt: new Date(),
      reissuedTokenId,
      note: order.earnedTokenId && !earnedVoided
        ? 'Refunded. The reward this purchase earned was already used, so it stays.'
        : 'Refunded.',
    },
  });

  after.push(() => {
    emitEvent(EventType.CHECKOUT_REFUNDED, {
      checkoutId: order.id,
      merchantId: order.merchantId,
      customerId: order.customerId,
      amountRefunded: toMoneyNumber(order.amountToPay),
      rewardReturned: toMoneyNumber(order.rewardAmount),
      earnedRewardVoided: earnedVoided,
      paypalRefundId: refund.refundId,
      source,
    });
    void invalidateWalletCache(order.customerId);
  });
  logger.info({ checkoutId: order.id, refundId: refund.refundId, source }, 'Checkout refunded');
  return after;
}
