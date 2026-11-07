// ============================================================
// Tokento — Checkout order views
// ============================================================
import type { CheckoutOrder, SettlementBatch } from '@prisma/client';
import { CheckoutStatus, type CheckoutOrderView, type PaymentMode, type SettlementState, TokenStatus } from '@tokento/shared';
import prisma from '../db/client';
import { toMoneyNumber } from '../utils/money';
import { usd } from './pricing';

export type OrderWithRelations = CheckoutOrder & {
  merchant: { id: string; name: string };
  product: { id: string; name: string; sku: string };
  settlement?: Pick<SettlementBatch, 'id' | 'status'> | null;
};

export const ORDER_INCLUDE = {
  merchant: { select: { id: true, name: true } },
  product: { select: { id: true, name: true, sku: true } },
  settlement: { select: { id: true, status: true } },
} as const;

const OPEN: string[] = [CheckoutStatus.PENDING, CheckoutStatus.CREATED, CheckoutStatus.APPROVED, CheckoutStatus.CAPTURE_PENDING, CheckoutStatus.CAPTURED];
const CLOSED_UNPAID: string[] = [CheckoutStatus.CANCELLED, CheckoutStatus.FAILED];

function rewardView(o: CheckoutOrder): CheckoutOrderView['reward'] {
  const amount = toMoneyNumber(o.rewardAmount);
  if (amount === 0) return null;
  if (CLOSED_UNPAID.includes(o.status)) return { tokenId: o.rewardTokenId, amount, state: 'released' };
  if (o.reissuedTokenId) return { tokenId: o.rewardTokenId, amount, state: 'reissued' };
  if (o.redemptionId) return { tokenId: o.rewardTokenId, amount, state: 'redeemed' };
  return { tokenId: o.rewardTokenId, amount, state: 'held' };
}

function earnedView(o: CheckoutOrder, earnedTokenStatus?: string): CheckoutOrderView['earned'] {
  const amount = toMoneyNumber(o.expectedEarn);
  if (CLOSED_UNPAID.includes(o.status) || o.status === CheckoutStatus.NEEDS_REVIEW) return null;
  if (o.earnedTokenId) {
    if (o.status === CheckoutStatus.REFUNDED) {
      return { tokenId: o.earnedTokenId, amount, state: earnedTokenStatus === TokenStatus.VOIDED ? 'voided' : 'kept' };
    }
    return { tokenId: o.earnedTokenId, amount, state: 'issued' };
  }
  return amount > 0 ? { tokenId: null, amount, state: 'expected' } : null;
}

function settlementState(o: OrderWithRelations): SettlementState {
  const status = o.settlement?.status;
  if (!status) return 'unsettled';
  if (status === 'SUCCESS') return 'paid';
  if (status === 'FAILED' || status === 'DENIED') return 'failed';
  return 'processing';
}

export function receiptFor(o: OrderWithRelations, earnedTokenStatus?: string): string {
  const subtotal = usd(o.subtotal);
  const paid = usd(o.amountToPay);
  const reward = toMoneyNumber(o.rewardAmount) > 0 ? usd(o.rewardAmount) : null;
  const earned = toMoneyNumber(o.expectedEarn) > 0 ? usd(o.expectedEarn) : null;
  const math = reward ? `${subtotal} − ${reward} reward = ${paid}` : paid;
  const what = `${o.product.name} at ${o.merchant.name}`;

  switch (o.status) {
    case CheckoutStatus.COMPLETED:
      return `${what}: ${math} paid with PayPal.${o.earnedTokenId && earned ? ` Earned a ${earned} reward.` : ''}`;
    case CheckoutStatus.REFUNDED: {
      const back = reward ? ` Your ${reward} reward is back in your wallet.` : '';
      const earnedNote = o.earnedTokenId && earned
        ? (earnedTokenStatus === TokenStatus.VOIDED ? ` The ${earned} reward it earned was cancelled.` : ` The ${earned} reward it earned was already used, so it stays.`)
        : '';
      return `${what}: refunded ${paid} to PayPal.${back}${earnedNote}`;
    }
    case CheckoutStatus.CANCELLED:
      return `${what}: cancelled. Nothing was charged.`;
    case CheckoutStatus.FAILED:
      return `${what}: PayPal could not take this payment. Nothing was charged.`;
    case CheckoutStatus.NEEDS_REVIEW:
      return `${what}: PayPal captured a different amount than expected, so the order is held for review.`;
    case CheckoutStatus.CAPTURE_PENDING:
      return `${what}: ${math}. PayPal is holding the payment for review.`;
    case CheckoutStatus.REFUND_PENDING:
      return `${what}: refund of ${paid} is pending at PayPal.`;
    default:
      return `${what}: ${math}, waiting for PayPal approval.`;
  }
}

export function toOrderView(o: OrderWithRelations, opts: { earnedTokenStatus?: string } = {}): CheckoutOrderView {
  return {
    id: o.id,
    status: o.status as CheckoutStatus,
    customerId: o.customerId,
    merchant: { id: o.merchant.id, name: o.merchant.name },
    product: { id: o.product.id, name: o.product.name, sku: o.product.sku },
    quantity: o.quantity,
    subtotal: toMoneyNumber(o.subtotal),
    reward: rewardView(o),
    amountToPay: toMoneyNumber(o.amountToPay),
    earned: earnedView(o, opts.earnedTokenStatus),
    paymentMode: o.paymentMode as PaymentMode,
    outsideMandate: o.outsideMandate,
    paypal: {
      orderId: o.paypalOrderId,
      captureId: o.paypalCaptureId,
      refundId: o.paypalRefundId,
      approvalUrl: OPEN.includes(o.status) ? o.approvalUrl : null,
    },
    platformFee: toMoneyNumber(o.platformFee),
    settlement: { batchId: o.settlementId, state: settlementState(o) },
    agentReason: o.agentReason,
    note: o.note,
    receipt: receiptFor(o, opts.earnedTokenStatus),
    createdAt: o.createdAt.toISOString(),
    completedAt: o.completedAt?.toISOString() ?? null,
    refundedAt: o.refundedAt?.toISOString() ?? null,
  };
}

/** View of an order, looking up the earned reward's status when a refund may have voided it. */
export async function orderView(order: OrderWithRelations): Promise<CheckoutOrderView> {
  let earnedTokenStatus: string | undefined;
  if (order.status === CheckoutStatus.REFUNDED && order.earnedTokenId) {
    const token = await prisma.token.findUnique({ where: { id: order.earnedTokenId }, select: { status: true } });
    earnedTokenStatus = token?.status ?? TokenStatus.VOIDED;
  }
  return toOrderView(order, { earnedTokenStatus });
}

export async function loadOrderView(checkoutId: string): Promise<CheckoutOrderView> {
  const order = await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: checkoutId }, include: ORDER_INCLUDE });
  return orderView(order);
}
