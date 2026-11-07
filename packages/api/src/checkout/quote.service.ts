// ============================================================
// Tokento — Quotes (best total value across stores)
// ============================================================
import { Prisma, type EarnRule, type Product, type Token } from '@prisma/client';
import { TokenStatus, type OfferView, type QuoteResponse } from '@tokento/shared';
import prisma from '../db/client';
import { AppError } from '../middleware/error.middleware';
import { mandateService } from '../mandates/mandate.service';
import { toMoneyNumber } from '../utils/money';
import { describeComparison, describeOffer, priceOffer, rankOffers, usd, type OfferPrice } from './pricing';
import { recordComparison } from './agent-comparisons';

export type ProductWithMerchant = Product & { merchant: { id: string; name: string } };

const MAX_PRODUCTS = 10;
const MAX_QUANTITY = 10;

export function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new AppError(400, 'invalid_quantity', `Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
  }
}

/** Active products in this environment; 404 if any id is unknown. */
export async function loadProducts(productIds: string[], isSandbox: boolean): Promise<ProductWithMerchant[]> {
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, isActive: true, isSandbox },
    include: { merchant: { select: { id: true, name: true } } },
  });
  const found = new Set(products.map((p) => p.id));
  const missing = productIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AppError(404, 'product_not_found', 'Product not found.', { productIds: missing });
  }
  return productIds.map((id) => products.find((p) => p.id === id)!);
}

export function activeRules(merchantIds: string[]): Promise<EarnRule[]> {
  return prisma.earnRule.findMany({ where: { merchantId: { in: merchantIds }, isActive: true } });
}

/**
 * The shopper's rewards at these stores that an agent may use now: active,
 * unexpired, agent-presentable, and not held by another open order.
 */
export async function availableRewards(
  customerId: string,
  merchantIds: string[],
  isSandbox: boolean,
  exclude: string[] = [],
): Promise<Token[]> {
  const tokens = await prisma.token.findMany({
    where: {
      customerId,
      merchantId: { in: merchantIds },
      status: TokenStatus.ACTIVE,
      expiryAt: { gt: new Date() },
      agentPresentableFlag: true,
      isSandbox,
      ...(exclude.length > 0 ? { id: { notIn: exclude } } : {}),
    },
  });
  if (tokens.length === 0) return [];
  const held = await prisma.checkoutOrder.findMany({
    where: { rewardTokenId: { in: tokens.map((t) => t.id) } },
    select: { rewardTokenId: true },
  });
  const heldIds = new Set(held.map((h) => h.rewardTokenId));
  return tokens.filter((t) => !heldIds.has(t.id));
}

export function priceProduct(
  product: ProductWithMerchant,
  quantity: number,
  rewards: Token[],
  rules: EarnRule[],
): { subtotal: Prisma.Decimal; price: OfferPrice } {
  const subtotal = product.price.times(quantity);
  const price = priceOffer({
    subtotal,
    rewards: rewards
      .filter((t) => t.merchantId === product.merchantId)
      .filter((t) => !t.categoryRestriction || t.categoryRestriction === product.category)
      .map((t) => ({ id: t.id, denomination: t.denomination, minimumTransactionFloor: t.minimumTransactionFloor, expiryAt: t.expiryAt })),
    earnRules: rules
      .filter((r) => r.merchantId === product.merchantId)
      .map((r) => ({ id: r.id, name: r.name, spendThreshold: r.spendThreshold, tokenDenomination: r.tokenDenomination })),
  });
  return { subtotal, price };
}

export class QuoteService {
  async quote(
    customerId: string,
    input: { productIds: string[]; quantity?: number; maxAmountToPay?: number },
    isSandbox: boolean,
  ): Promise<QuoteResponse> {
    const quantity = input.quantity ?? 1;
    assertQuantity(quantity);
    const productIds = [...new Set(input.productIds)];
    if (productIds.length === 0 || productIds.length > MAX_PRODUCTS) {
      throw new AppError(400, 'invalid_products', `Compare between 1 and ${MAX_PRODUCTS} products.`);
    }

    const products = await loadProducts(productIds, isSandbox);
    const merchantIds = [...new Set(products.map((p) => p.merchantId))];
    const [rewards, rules] = await Promise.all([
      availableRewards(customerId, merchantIds, isSandbox),
      activeRules(merchantIds),
    ]);

    const budget = input.maxAmountToPay !== undefined ? new Prisma.Decimal(input.maxAmountToPay) : null;
    const priced = products.map((product) => {
      const { subtotal, price } = priceProduct(product, quantity, rewards, rules);
      const withinBudget = budget ? price.amountToPay.lessThanOrEqualTo(budget) : null;
      return { product, subtotal, price, withinBudget };
    });

    // Best total value first; offers over the budget go after every offer inside it.
    const order = rankOffers(priced.map((p) => ({ key: p.product.id, price: p.price })));
    const ranked = order
      .map((id) => priced.find((p) => p.product.id === id)!)
      .sort((a, b) => Number(a.withinBudget === false) - Number(b.withinBudget === false));

    const offers: OfferView[] = [];
    for (const p of ranked) {
      const decision = await mandateService.evaluate(customerId, { merchantId: p.product.merchantId, amount: p.price.amountToPay });
      let reason = describeOffer({
        merchantName: p.product.merchant.name,
        subtotal: p.subtotal,
        price: p.price,
        hasRewardsProgram: rules.some((r) => r.merchantId === p.product.merchantId),
      });
      if (p.withinBudget === false && budget) reason += ` That is over the ${usd(budget)} budget.`;

      offers.push({
        productId: p.product.id,
        productName: p.product.name,
        sku: p.product.sku,
        merchantId: p.product.merchantId,
        merchantName: p.product.merchant.name,
        unitPrice: toMoneyNumber(p.product.price),
        quantity,
        subtotal: toMoneyNumber(p.subtotal),
        reward: p.price.reward ? { tokenId: p.price.reward.tokenId, amount: toMoneyNumber(p.price.reward.amount) } : null,
        amountToPay: toMoneyNumber(p.price.amountToPay),
        earn: p.price.earn ? { ruleId: p.price.earn.ruleId, ruleName: p.price.earn.ruleName, amount: toMoneyNumber(p.price.earn.amount) } : null,
        effectiveCost: toMoneyNumber(p.price.effectiveCost),
        withinBudget: p.withinBudget,
        mandate: decision.within ? { within: true } : { within: false, code: decision.code, message: decision.message },
        reason,
      });
    }

    const recommended = offers.find((o) => o.withinBudget !== false) ?? null;
    const comparison = describeComparison(ranked.map((p) => ({
      key: p.product.id,
      merchantName: p.product.merchant.name,
      subtotal: p.subtotal,
      price: p.price,
    })));
    const recommendedProductId = recommended?.productId ?? null;

    // How each store did, for its "why agents pick you" numbers. Never fails the quote.
    await recordComparison({ offers, recommendedProductId, quantity, isSandbox });

    return { offers, recommendedProductId, comparison };
  }
}

export const quoteService = new QuoteService();
