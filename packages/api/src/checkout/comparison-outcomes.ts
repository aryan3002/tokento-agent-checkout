// ============================================================
// Tokento — How each store did in one agent comparison
// ============================================================
// When a shopper's agent compares offers from two or more stores, each store
// either won the recommendation or didn't. A store that won although another
// store had a lower sticker price won because of its rewards (the reward spent
// now, the reward earned back, or both): that is the proof a store owner wants.
import type { ComparisonOutcome, OfferView } from '@tokento/shared';

export interface StoreOutcome {
  merchantId: string;
  /** The store's best offer in this comparison. */
  productId: string;
  subtotal: number;
  effectiveCost: number;
  outcome: ComparisonOutcome;
}

/**
 * One line per store, in the order the quote ranked them (best first).
 * A comparison with a single store isn't a contest, so it gives no lines.
 */
export function comparisonOutcomes(offers: OfferView[], recommendedProductId: string | null): StoreOutcome[] {
  const bestPerStore = new Map<string, OfferView>();
  for (const offer of offers) {
    if (!bestPerStore.has(offer.merchantId)) bestPerStore.set(offer.merchantId, offer);
  }
  if (bestPerStore.size < 2) return [];

  const winner = offers.find((o) => o.productId === recommendedProductId) ?? null;
  const lowerStickerElsewhere = winner !== null && offers.some((o) => o.merchantId !== winner.merchantId && o.subtotal < winner.subtotal);

  return [...bestPerStore.values()].map((best) => {
    const won = winner !== null && best.merchantId === winner.merchantId;
    const offer = won ? winner : best;
    const outcome: ComparisonOutcome = !won ? 'not_chosen' : lowerStickerElsewhere ? 'won_with_rewards' : 'won_on_price';
    return {
      merchantId: offer.merchantId,
      productId: offer.productId,
      subtotal: offer.subtotal,
      effectiveCost: offer.effectiveCost,
      outcome,
    };
  });
}
