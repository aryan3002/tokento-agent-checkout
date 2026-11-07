// ============================================================
// Tokento — Spending mandates
// ============================================================
// What a shopper lets an agent spend without asking: a per-purchase maximum,
// a monthly cap, the stores allowed, and an expiry. Checkout and the quote ask
// evaluate(); only the shopper's own session can set or revoke limits.
import type { Mandate, Prisma } from '@prisma/client';
import { CheckoutStatus, type MandateView, type MandateViolationCode } from '@tokento/shared';
import prisma from '../db/client';
import { AppError } from '../middleware/error.middleware';
import { toMoney, toMoneyNumber } from '../utils/money';

export type MandateDecision =
  | { within: true; mandate: Mandate }
  | { within: false; code: MandateViolationCode; message: string; mandate: Mandate | null };

/** Orders that hold or took money count toward the monthly cap. */
const COUNTED_STATUSES = [
  CheckoutStatus.PENDING,
  CheckoutStatus.CREATED,
  CheckoutStatus.APPROVED,
  CheckoutStatus.CAPTURE_PENDING,
  CheckoutStatus.CAPTURED,
  CheckoutStatus.COMPLETED,
  CheckoutStatus.NEEDS_REVIEW,
  CheckoutStatus.REFUND_PENDING,
];

const usd = (v: Prisma.Decimal) => `$${v.toFixed(2)}`;
const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export class MandateService {
  active(customerId: string): Promise<Mandate | null> {
    return prisma.mandate.findFirst({ where: { customerId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
  }

  async spentThisMonth(customerId: string, now: Date = new Date()): Promise<Prisma.Decimal> {
    const sum = await prisma.checkoutOrder.aggregate({
      where: { customerId, status: { in: COUNTED_STATUSES }, createdAt: { gte: monthStart(now), lte: now } },
      _sum: { amountToPay: true },
    });
    return toMoney(sum._sum.amountToPay ?? 0);
  }

  async evaluate(customerId: string, purchase: { merchantId: string; amount: Prisma.Decimal }, now: Date = new Date()): Promise<MandateDecision> {
    const mandate = await this.active(customerId);
    if (!mandate) {
      return { within: false, code: 'no_mandate', message: 'No spending limits are set, so each payment needs the shopper to approve it in PayPal.', mandate: null };
    }
    if (mandate.expiresAt <= now) {
      return { within: false, code: 'expired', message: `The spending limits expired on ${mandate.expiresAt.toISOString().slice(0, 10)}.`, mandate };
    }
    if (!mandate.allowedMerchantIds.includes(purchase.merchantId)) {
      return { within: false, code: 'store_not_allowed', message: 'This store is not on the list of stores allowed in the spending limits.', mandate };
    }
    if (purchase.amount.greaterThan(mandate.perPurchaseMax)) {
      return { within: false, code: 'over_per_purchase_max', message: `${usd(purchase.amount)} is over the ${usd(mandate.perPurchaseMax)} per-purchase limit.`, mandate };
    }
    const spent = await this.spentThisMonth(customerId, now);
    if (spent.plus(purchase.amount).greaterThan(mandate.monthlyCap)) {
      return {
        within: false,
        code: 'over_monthly_cap',
        message: `${usd(purchase.amount)} would pass the ${usd(mandate.monthlyCap)} monthly limit: ${usd(spent)} is already spent or waiting this month.`,
        mandate,
      };
    }
    return { within: true, mandate };
  }

  /** New limits replace any active ones. */
  async create(customerId: string, input: { perPurchaseMax: number; monthlyCap: number; allowedMerchantIds: string[]; expiresInDays: number }, isSandbox: boolean): Promise<MandateView> {
    const stores = await prisma.merchant.count({ where: { id: { in: input.allowedMerchantIds } } });
    if (stores !== new Set(input.allowedMerchantIds).size) throw new AppError(400, 'unknown_store', 'One of the allowed stores does not exist.');
    const mandate = await prisma.$transaction(async (tx) => {
      await tx.mandate.updateMany({ where: { customerId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
      return tx.mandate.create({
        data: {
          customerId,
          perPurchaseMax: toMoney(input.perPurchaseMax),
          monthlyCap: toMoney(input.monthlyCap),
          allowedMerchantIds: [...new Set(input.allowedMerchantIds)],
          expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
          isSandbox,
        },
      });
    });
    return this.view(mandate);
  }

  async revoke(customerId: string, mandateId: string): Promise<MandateView> {
    const mandate = await prisma.mandate.findFirst({ where: { id: mandateId, customerId } });
    if (!mandate) throw new AppError(404, 'mandate_not_found', 'Spending limits not found.');
    const revoked = mandate.status === 'REVOKED'
      ? mandate
      : await prisma.mandate.update({ where: { id: mandate.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
    return this.view(revoked);
  }

  async view(mandate: Mandate, now: Date = new Date()): Promise<MandateView> {
    const [stores, spent] = await Promise.all([
      prisma.merchant.findMany({ where: { id: { in: mandate.allowedMerchantIds } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.spentThisMonth(mandate.customerId, now),
    ]);
    const remaining = toMoney(mandate.monthlyCap).minus(spent);
    return {
      id: mandate.id,
      status: mandate.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
      perPurchaseMax: toMoneyNumber(mandate.perPurchaseMax),
      monthlyCap: toMoneyNumber(mandate.monthlyCap),
      allowedStores: stores,
      expiresAt: mandate.expiresAt.toISOString(),
      spentThisMonth: toMoneyNumber(spent),
      remainingThisMonth: toMoneyNumber(remaining.isNegative() ? toMoney(0) : remaining),
      vault: { status: mandate.vaultStatus as MandateView['vault']['status'] },
      createdAt: mandate.createdAt.toISOString(),
      revokedAt: mandate.revokedAt?.toISOString() ?? null,
    };
  }
}

export const mandateService = new MandateService();
