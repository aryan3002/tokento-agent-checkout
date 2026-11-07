// ============================================================
// Tokento — Agent comparisons (why agents picked a store)
// ============================================================
// Every quote that compares two or more stores is saved as one line per store,
// so a store can see how often shopping agents recommend it and how often its
// rewards were the reason. Stores only ever read their own lines.
import { randomUUID } from 'crypto';
import { EventType, type AgentComparisonLine, type AgentComparisonStats, type ComparisonOutcome, type OfferView } from '@tokento/shared';
import prisma from '../db/client';
import { emitEvent } from '../events/emitter';
import { logger } from '../utils/logger';
import { toMoneyNumber } from '../utils/money';
import { comparisonOutcomes } from './comparison-outcomes';

/**
 * Save how each store did in an agent's comparison, then tell each store's live
 * dashboard its own outcome. Never throws: a quote must not fail because of this
 * bookkeeping, and nothing is announced unless the lines were saved.
 */
export async function recordComparison(input: {
  offers: OfferView[];
  recommendedProductId: string | null;
  quantity: number;
  isSandbox: boolean;
}): Promise<void> {
  try {
    const outcomes = comparisonOutcomes(input.offers, input.recommendedProductId);
    if (outcomes.length === 0) return;

    const comparisonId = randomUUID();
    await prisma.agentComparison.createMany({
      data: outcomes.map((o) => ({
        comparisonId,
        merchantId: o.merchantId,
        productId: o.productId,
        outcome: o.outcome,
        quantity: input.quantity,
        subtotal: o.subtotal,
        effectiveCost: o.effectiveCost,
        storesCompared: outcomes.length,
        isSandbox: input.isSandbox,
      })),
    });

    for (const o of outcomes) {
      emitEvent(EventType.AGENT_COMPARED, { merchantId: o.merchantId, comparisonId, outcome: o.outcome });
    }
  } catch (err) {
    logger.warn({ err }, 'Could not record an agent comparison; the quote is unaffected');
  }
}

/** This store's numbers, all time, in one environment (sandbox keys never see live lines). */
export async function comparisonStats(merchantId: string, isSandbox: boolean): Promise<AgentComparisonStats> {
  const groups = await prisma.agentComparison.groupBy({
    by: ['outcome'],
    where: { merchantId, isSandbox },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const count = (outcome: ComparisonOutcome) => groups.find((g) => g.outcome === outcome)?._count._all ?? 0;
  const wonWithRewards = count('won_with_rewards');
  const wonOnPrice = count('won_on_price');
  const notChosen = count('not_chosen');
  const latest = groups.reduce<Date | null>((max, g) => (g._max.createdAt && (!max || g._max.createdAt > max) ? g._max.createdAt : max), null);
  return {
    comparisons: wonWithRewards + wonOnPrice + notChosen,
    recommended: wonWithRewards + wonOnPrice,
    wonWithRewards,
    wonOnPrice,
    notChosen,
    lastComparedAt: latest ? latest.toISOString() : null,
  };
}

/** This store's latest comparison lines, newest first (its own numbers only). */
export async function recentComparisons(merchantId: string, isSandbox: boolean, limit: number): Promise<AgentComparisonLine[]> {
  const rows = await prisma.agentComparison.findMany({
    where: { merchantId, isSandbox },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { product: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    productName: r.product.name,
    quantity: r.quantity,
    subtotal: toMoneyNumber(r.subtotal),
    effectiveCost: toMoneyNumber(r.effectiveCost),
    storesCompared: r.storesCompared,
    outcome: r.outcome as ComparisonOutcome,
  }));
}
