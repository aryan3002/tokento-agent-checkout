// ============================================================
// Tokento — Agent checkout
// ============================================================
// create:  price on the server → mandate decision → write the order and hold the
//          reward (unique column) → create the PayPal order → wait for approval.
// cancel:  release the hold before any money moves.
// Capture, refunds and webhooks build on these rows (see finalize.ts, refund.ts).
import { Prisma } from '@prisma/client';
import { approvalUrlOf, captureOf, PayPalApiError, toPayPalAmount, type PayPalOrder } from '@tokento/paypal';
import { CheckoutStatus, EventType, type CheckoutOrderView } from '@tokento/shared';
import prisma from '../db/client';
import { emitEvent } from '../events/emitter';
import { AppError } from '../middleware/error.middleware';
import { mandateService } from '../mandates/mandate.service';
import { validationService } from '../services/validation.service';
import { logger } from '../utils/logger';
import { toMoneyNumber } from '../utils/money';
import { finalizeCapture, finalizeLocked, type FinalizeSource } from './finalize';
import { withOrderLock } from './order-lock';
import { getPayPal, shopperAppUrl } from './paypal';
import { activeRules, assertQuantity, availableRewards, loadProducts, priceProduct, type ProductWithMerchant } from './quote.service';
import type { OfferPrice } from './pricing';
import { loadOrderView, ORDER_INCLUDE, orderView, type OrderWithRelations } from './views';

export interface CreateCheckoutInput {
  productId: string;
  quantity: number;
  useReward: boolean;
  /** 'auto' lets Tokento pick (saved PayPal inside the mandate); 'approval' forces a PayPal approval by the shopper. */
  paymentMode: 'auto' | 'approval';
  agentReason?: string;
}

export interface CreateCheckoutContext {
  isSandbox: boolean;
  idempotencyKey: string;
  agentId?: string;
}

export type CheckoutPrincipal =
  | { kind: 'customer'; customerId: string }
  | { kind: 'merchant'; merchantId: string };

/** Who may trigger a capture: the shopper after approving, or the server (webhook, sweeper). */
export type CapturePrincipal = { kind: 'customer'; customerId: string } | { kind: 'system'; source: FinalizeSource };

const CANCELLABLE: string[] = [CheckoutStatus.PENDING, CheckoutStatus.CREATED, CheckoutStatus.APPROVED];
const CAPTURABLE: string[] = [CheckoutStatus.CREATED, CheckoutStatus.APPROVED];
/** Already past capture: a repeated capture call just returns the order. */
const ALREADY_CAPTURED: string[] = [
  CheckoutStatus.CAPTURE_PENDING, CheckoutStatus.COMPLETED, CheckoutStatus.NEEDS_REVIEW,
  CheckoutStatus.REFUND_PENDING, CheckoutStatus.REFUNDED,
];
const HOLD_ATTEMPTS = 3;

function isUniqueViolation(err: unknown, field: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError
    && err.code === 'P2002'
    && JSON.stringify(err.meta?.target ?? '').includes(field);
}

export class CheckoutService {
  async create(customerId: string, input: CreateCheckoutInput, ctx: CreateCheckoutContext): Promise<CheckoutOrderView> {
    const existing = await this.findByKey(customerId, ctx.idempotencyKey);
    if (existing) return this.view(existing);

    assertQuantity(input.quantity);
    const [product] = await loadProducts([input.productId], ctx.isSandbox);
    const rules = await activeRules([product.merchantId]);
    const excluded: string[] = [];

    for (let attempt = 0; attempt < HOLD_ATTEMPTS; attempt++) {
      const rewards = input.useReward ? await availableRewards(customerId, [product.merchantId], ctx.isSandbox, excluded) : [];
      const { subtotal, price } = priceProduct(product, input.quantity, rewards, rules);

      // Check the reward's signature and terms before promising its value to PayPal.
      if (price.reward) {
        const check = await validationService.validate(price.reward.tokenId, {
          transactionAmount: toMoneyNumber(subtotal),
          merchantId: product.merchantId,
          agentId: ctx.agentId,
        }, ctx.isSandbox);
        if (!check.valid) {
          logger.warn({ tokenId: price.reward.tokenId, reason: check.reasonCode }, 'Reward failed validation at hold time; pricing without it');
          excluded.push(price.reward.tokenId);
          continue;
        }
      }

      const decision = await mandateService.evaluate(customerId, { merchantId: product.merchantId, amount: price.amountToPay });
      // With no limits set, the shopper approves each payment in PayPal herself; only limits she set can be broken.
      const outside = !decision.within && decision.code !== 'no_mandate';
      if (outside && input.paymentMode !== 'approval') {
        throw new AppError(403, 'mandate_violation',
          `${decision.message} Ask the shopper first. If they agree, retry with paymentMode "approval" so they approve this payment in PayPal themselves.`,
          { mandateCode: decision.code });
      }
      // Pay with the saved PayPal only inside the limits, once linking is confirmed, and only when the agent didn't ask for an approval.
      const vaultId = decision.within && input.paymentMode === 'auto' && decision.mandate.vaultStatus === 'ACTIVE'
        ? decision.mandate.paypalPaymentTokenId
        : null;

      let order: OrderWithRelations;
      try {
        order = await prisma.checkoutOrder.create({
          data: {
            customerId,
            merchantId: product.merchantId,
            productId: product.id,
            quantity: input.quantity,
            subtotal,
            rewardTokenId: price.reward?.tokenId ?? null,
            rewardAmount: price.reward?.amount ?? 0,
            amountToPay: price.amountToPay,
            earnRuleId: price.earn?.ruleId ?? null,
            expectedEarn: price.earn?.amount ?? 0,
            status: CheckoutStatus.PENDING,
            paymentMode: vaultId ? 'vault' : 'approval',
            outsideMandate: outside,
            mandateId: decision.mandate?.id ?? null,
            agentId: ctx.agentId ?? null,
            agentReason: input.agentReason?.slice(0, 500) ?? null,
            idempotencyKey: ctx.idempotencyKey,
            isSandbox: ctx.isSandbox,
          },
          include: ORDER_INCLUDE,
        });
      } catch (err) {
        if (price.reward && isUniqueViolation(err, 'rewardTokenId')) {
          // Another order took this reward between our read and our write.
          excluded.push(price.reward.tokenId);
          continue;
        }
        if (isUniqueViolation(err, 'idempotencyKey')) {
          const duplicate = await this.findByKey(customerId, ctx.idempotencyKey);
          if (duplicate) return this.view(duplicate);
        }
        throw err;
      }

      return this.openWithPayPal(order, product, price, subtotal, vaultId);
    }

    throw new AppError(409, 'reward_contention', 'Could not reserve a reward for this order. Try again.');
  }

  private async openWithPayPal(
    order: OrderWithRelations,
    product: ProductWithMerchant,
    price: OfferPrice,
    subtotal: Prisma.Decimal,
    vaultId: string | null = null,
  ): Promise<CheckoutOrderView> {
    const description = order.quantity > 1 ? `${product.name} x ${order.quantity}` : product.name;
    let ppOrder: PayPalOrder;
    let updated: OrderWithRelations;
    try {
      ppOrder = await getPayPal().createOrder({
        customId: order.id,
        invoiceId: order.id,
        description: description.slice(0, 127),
        amount: toPayPalAmount(price.amountToPay),
        currency: 'USD',
        breakdown: {
          itemTotal: toPayPalAmount(subtotal),
          ...(price.reward ? { discount: toPayPalAmount(price.reward.amount) } : {}),
        },
        items: [{ name: product.name.slice(0, 127), quantity: order.quantity, unitAmount: toPayPalAmount(product.price), sku: product.sku }],
        payment: vaultId
          ? { kind: 'vault', vaultId }
          : {
              kind: 'approval',
              returnUrl: `${shopperAppUrl()}/checkout/return?checkout=${order.id}`,
              cancelUrl: `${shopperAppUrl()}/checkout/cancel?checkout=${order.id}`,
              brandName: `${product.merchant.name} via Tokento`.slice(0, 127),
            },
      }, { requestId: order.id });

      updated = await prisma.checkoutOrder.update({
        where: { id: order.id },
        data: { paypalOrderId: ppOrder.id, approvalUrl: approvalUrlOf(ppOrder), status: CheckoutStatus.CREATED },
        include: ORDER_INCLUDE,
      });
    } catch (err) {
      return this.failCreate(order, err);
    }

    emitEvent(EventType.CHECKOUT_CREATED, {
      checkoutId: updated.id,
      merchantId: updated.merchantId,
      customerId: updated.customerId,
      productName: product.name,
      subtotal: toMoneyNumber(updated.subtotal),
      rewardAmount: toMoneyNumber(updated.rewardAmount),
      amountToPay: toMoneyNumber(updated.amountToPay),
      paypalOrderId: ppOrder.id,
      status: updated.status,
    });
    logger.info({ checkoutId: updated.id, paypalOrderId: ppOrder.id, vault: Boolean(vaultId) }, 'Checkout created');
    if (!vaultId) return this.view(updated);

    // The saved PayPal: PayPal captures a vault order at create. Finalize from that capture, or capture now if it didn't.
    const capture = captureOf(ppOrder);
    if (!capture) return this.capture(order.id, { kind: 'customer', customerId: order.customerId });
    return finalizeCapture(order.id, {
      captureId: capture.id,
      status: capture.status,
      amount: capture.amount.value,
      currency: capture.amount.currency_code,
    }, 'capture_response');
  }

  /** PayPal create failed: nothing was charged, so fail the order and release the reward. */
  private async failCreate(order: OrderWithRelations, err: unknown): Promise<never> {
    await prisma.checkoutOrder.update({
      where: { id: order.id },
      data: {
        status: CheckoutStatus.FAILED,
        rewardTokenId: null,
        note: err instanceof PayPalApiError
          ? `PayPal refused to create the order (${err.name}${err.debugId ? `, debug_id ${err.debugId}` : ''}).`
          : err instanceof AppError
            ? `${err.message} Nothing was charged.`
            : 'Could not create the PayPal order. Nothing was charged.',
      },
    });
    if (err instanceof PayPalApiError) {
      throw new AppError(502, 'paypal_unavailable', 'PayPal could not create the order. Nothing was charged; try again.', {
        paypalError: err.name,
        debugId: err.debugId,
      });
    }
    throw err;
  }

  /**
   * Capture an approved order and finalize it, all under the order lock so a
   * cancel can't land between PayPal taking the money and us recording it.
   */
  async capture(checkoutId: string, principal: CapturePrincipal): Promise<CheckoutOrderView> {
    const source: FinalizeSource = principal.kind === 'system' ? principal.source : 'capture_response';
    const after = await withOrderLock(checkoutId, async (tx) => {
      const order = await tx.checkoutOrder.findUnique({ where: { id: checkoutId } });
      if (!order) throw new AppError(404, 'checkout_not_found', 'Checkout order not found.');
      if (principal.kind === 'customer' && order.customerId !== principal.customerId) {
        throw new AppError(403, 'forbidden', 'This order belongs to another shopper.');
      }
      if (ALREADY_CAPTURED.includes(order.status)) return [];
      if (order.status === CheckoutStatus.CAPTURED && order.paypalCaptureId) {
        // A crash after the capture was recorded: finish the remaining steps.
        return finalizeLocked(tx, checkoutId, {
          captureId: order.paypalCaptureId, status: 'COMPLETED', amount: order.amountToPay.toFixed(2), currency: order.currency,
        }, source);
      }
      if (!CAPTURABLE.includes(order.status) || !order.paypalOrderId) {
        throw new AppError(409, 'not_capturable', `Order is ${order.status.toLowerCase()} and cannot be captured.`);
      }

      const paypal = getPayPal();
      let ppOrder: PayPalOrder;
      try {
        ppOrder = await paypal.captureOrder(order.paypalOrderId, { requestId: `capture:${order.id}` });
      } catch (err) {
        if (!(err instanceof PayPalApiError)) throw err;
        if (err.hasIssue('ORDER_ALREADY_CAPTURED')) {
          ppOrder = await paypal.getOrder(order.paypalOrderId);
        } else if (err.hasIssue('ORDER_NOT_APPROVED')) {
          throw new AppError(409, 'not_approved', 'The shopper has not approved this payment in PayPal yet.');
        } else if (err.hasIssue('INSTRUMENT_DECLINED')) {
          throw new AppError(402, 'payment_declined', 'PayPal declined the funding source. Ask the shopper to approve again with another way to pay.', {
            approvalUrl: order.approvalUrl,
          });
        } else {
          throw new AppError(502, 'paypal_unavailable', 'PayPal could not capture the payment. Try again.', {
            paypalError: err.name,
            debugId: err.debugId,
          });
        }
      }

      const capture = captureOf(ppOrder);
      if (!capture) throw new AppError(502, 'paypal_unexpected', 'PayPal did not return a capture for this order.');
      return finalizeLocked(tx, checkoutId, {
        captureId: capture.id,
        status: capture.status,
        amount: capture.amount.value,
        currency: capture.amount.currency_code,
      }, source);
    });

    for (const run of after) run();
    return loadOrderView(checkoutId);
  }

  async cancel(customerId: string, checkoutId: string): Promise<CheckoutOrderView> {
    const outcome = await withOrderLock(checkoutId, async (tx) => {
      const order = await tx.checkoutOrder.findUnique({ where: { id: checkoutId } });
      if (!order) throw new AppError(404, 'checkout_not_found', 'Checkout order not found.');
      if (order.customerId !== customerId) throw new AppError(403, 'forbidden', 'This order belongs to another shopper.');
      if (order.status === CheckoutStatus.CANCELLED) return { cancelledNow: false };
      if (!CANCELLABLE.includes(order.status)) {
        throw new AppError(409, 'not_cancellable', `Order is ${order.status.toLowerCase()} and can no longer be cancelled.`);
      }
      await tx.checkoutOrder.update({
        where: { id: checkoutId },
        data: { status: CheckoutStatus.CANCELLED, rewardTokenId: null, note: 'Cancelled before payment.' },
      });
      return { cancelledNow: true };
    });

    const order = await prisma.checkoutOrder.findUniqueOrThrow({ where: { id: checkoutId }, include: ORDER_INCLUDE });
    if (outcome.cancelledNow) {
      emitEvent(EventType.CHECKOUT_CANCELLED, {
        checkoutId,
        merchantId: order.merchantId,
        customerId: order.customerId,
        status: order.status,
      });
    }
    return this.view(order);
  }

  /**
   * Close an order nobody finished (sweeper). Releases the hold. Returns false
   * if the order had already moved on.
   */
  async expire(checkoutId: string, reason: string): Promise<boolean> {
    const closed = await withOrderLock(checkoutId, async (tx) => {
      const order = await tx.checkoutOrder.findUnique({ where: { id: checkoutId } });
      if (!order || !CANCELLABLE.includes(order.status)) return null;
      const status = order.status === CheckoutStatus.PENDING ? CheckoutStatus.FAILED : CheckoutStatus.CANCELLED;
      await tx.checkoutOrder.update({ where: { id: checkoutId }, data: { status, rewardTokenId: null, note: reason } });
      return { ...order, status };
    });
    if (!closed) return false;
    emitEvent(EventType.CHECKOUT_CANCELLED, {
      checkoutId, merchantId: closed.merchantId, customerId: closed.customerId, status: closed.status, reason,
    });
    return true;
  }

  async get(checkoutId: string, principal: CheckoutPrincipal): Promise<CheckoutOrderView> {
    const order = await prisma.checkoutOrder.findUnique({ where: { id: checkoutId }, include: ORDER_INCLUDE });
    if (!order) throw new AppError(404, 'checkout_not_found', 'Checkout order not found.');
    const allowed = principal.kind === 'customer'
      ? order.customerId === principal.customerId
      : order.merchantId === principal.merchantId;
    if (!allowed) throw new AppError(403, 'forbidden', 'You cannot view this order.');
    return this.view(order);
  }

  /** A store's view of one of its orders. Another store's order is "not found", as with refunds. */
  async getForMerchant(merchantId: string, checkoutId: string): Promise<CheckoutOrderView> {
    const order = await prisma.checkoutOrder.findFirst({ where: { id: checkoutId, merchantId }, include: ORDER_INCLUDE });
    if (!order) throw new AppError(404, 'checkout_not_found', 'Checkout order not found.');
    return this.view(order);
  }

  async listForCustomer(customerId: string, limit = 50): Promise<CheckoutOrderView[]> {
    const orders = await prisma.checkoutOrder.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      include: ORDER_INCLUDE,
    });
    return Promise.all(orders.map((o) => this.view(o)));
  }

  async listForMerchant(merchantId: string, limit = 100): Promise<CheckoutOrderView[]> {
    const orders = await prisma.checkoutOrder.findMany({
      where: { merchantId, status: { not: CheckoutStatus.PENDING } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      include: ORDER_INCLUDE,
    });
    return Promise.all(orders.map((o) => this.view(o)));
  }

  private findByKey(customerId: string, idempotencyKey: string): Promise<OrderWithRelations | null> {
    return prisma.checkoutOrder.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
      include: ORDER_INCLUDE,
    });
  }

  view(order: OrderWithRelations): Promise<CheckoutOrderView> {
    return orderView(order);
  }
}

export const checkoutService = new CheckoutService();
