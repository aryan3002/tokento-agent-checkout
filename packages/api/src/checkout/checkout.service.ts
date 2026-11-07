// ============================================================
// Tokento — Agent checkout
// ============================================================
// create:  price on the server → mandate decision → write the order and hold the
//          reward (unique column) → create the PayPal order → wait for approval.
// cancel:  release the hold before any money moves.
// Capture, refunds and webhooks build on these rows (see finalize.ts, refund.ts).
import { Prisma } from '@prisma/client';
import { approvalUrlOf, PayPalApiError, toPayPalAmount } from '@tokento/paypal';
import { CheckoutStatus, EventType, TokenStatus, type CheckoutOrderView } from '@tokento/shared';
import prisma from '../db/client';
import { emitEvent } from '../events/emitter';
import { AppError } from '../middleware/error.middleware';
import { mandateService } from '../mandates/mandate.service';
import { validationService } from '../services/validation.service';
import { logger } from '../utils/logger';
import { toMoneyNumber } from '../utils/money';
import { withOrderLock } from './order-lock';
import { getPayPal, shopperAppUrl } from './paypal';
import { activeRules, assertQuantity, availableRewards, loadProducts, priceProduct, type ProductWithMerchant } from './quote.service';
import type { OfferPrice } from './pricing';
import { ORDER_INCLUDE, toOrderView, type OrderWithRelations } from './views';

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

const CANCELLABLE: string[] = [CheckoutStatus.PENDING, CheckoutStatus.CREATED, CheckoutStatus.APPROVED];
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
      if (!decision.within && input.paymentMode !== 'approval') {
        throw new AppError(403, 'mandate_violation',
          `${decision.message} Ask the shopper first. If they agree, retry with paymentMode "approval" so they approve this payment in PayPal themselves.`,
          { mandateCode: decision.code });
      }

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
            paymentMode: 'approval',
            outsideMandate: !decision.within,
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

      return this.openWithPayPal(order, product, price, subtotal);
    }

    throw new AppError(409, 'reward_contention', 'Could not reserve a reward for this order. Try again.');
  }

  private async openWithPayPal(
    order: OrderWithRelations,
    product: ProductWithMerchant,
    price: OfferPrice,
    subtotal: Prisma.Decimal,
  ): Promise<CheckoutOrderView> {
    const description = order.quantity > 1 ? `${product.name} x ${order.quantity}` : product.name;
    try {
      const paypal = getPayPal();
      const ppOrder = await paypal.createOrder({
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
        payment: {
          kind: 'approval',
          returnUrl: `${shopperAppUrl()}/checkout/return?checkout=${order.id}`,
          cancelUrl: `${shopperAppUrl()}/checkout/cancel?checkout=${order.id}`,
          brandName: `${product.merchant.name} via Tokento`.slice(0, 127),
        },
      }, { requestId: order.id });

      const updated = await prisma.checkoutOrder.update({
        where: { id: order.id },
        data: { paypalOrderId: ppOrder.id, approvalUrl: approvalUrlOf(ppOrder), status: CheckoutStatus.CREATED },
        include: ORDER_INCLUDE,
      });

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
      logger.info({ checkoutId: updated.id, paypalOrderId: ppOrder.id }, 'Checkout created');
      return this.view(updated);
    } catch (err) {
      await prisma.checkoutOrder.update({
        where: { id: order.id },
        data: {
          status: CheckoutStatus.FAILED,
          rewardTokenId: null,
          note: err instanceof PayPalApiError
            ? `PayPal refused to create the order (${err.name}${err.debugId ? `, debug_id ${err.debugId}` : ''}).`
            : 'Could not reach PayPal to create the order.',
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

  async get(checkoutId: string, principal: CheckoutPrincipal): Promise<CheckoutOrderView> {
    const order = await prisma.checkoutOrder.findUnique({ where: { id: checkoutId }, include: ORDER_INCLUDE });
    if (!order) throw new AppError(404, 'checkout_not_found', 'Checkout order not found.');
    const allowed = principal.kind === 'customer'
      ? order.customerId === principal.customerId
      : order.merchantId === principal.merchantId;
    if (!allowed) throw new AppError(403, 'forbidden', 'You cannot view this order.');
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

  async view(order: OrderWithRelations): Promise<CheckoutOrderView> {
    let earnedTokenStatus: string | undefined;
    if (order.status === CheckoutStatus.REFUNDED && order.earnedTokenId) {
      const token = await prisma.token.findUnique({ where: { id: order.earnedTokenId }, select: { status: true } });
      earnedTokenStatus = token?.status ?? TokenStatus.VOIDED;
    }
    return toOrderView(order, { earnedTokenStatus });
  }
}

export const checkoutService = new CheckoutService();
