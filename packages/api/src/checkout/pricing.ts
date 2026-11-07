// ============================================================
// Tokento — Offer pricing (pure, Decimal)
// ============================================================
// The only place reward math happens. The quote, the checkout and the agent's
// explanation all come from these functions, so the numbers the shopper reads
// are the numbers PayPal charges. The model never computes money.
//
// Rules:
//   reward       largest usable reward: its floor ≤ subtotal and it is smaller than
//                the subtotal (PayPal cannot charge $0). Ties go to the reward that
//                expires first.
//   amountToPay  subtotal − reward
//   earn         biggest earn rule whose threshold ≤ amountToPay (earned on what
//                the shopper actually pays)
//   effective    amountToPay − earn (today's cost net of the reward earned back)

import { Prisma } from '@prisma/client';

type Decimal = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);

export interface RewardCandidate {
  id: string;
  denomination: Decimal;
  minimumTransactionFloor: Decimal;
  expiryAt: Date;
}

export interface EarnRuleCandidate {
  id: string;
  name: string;
  spendThreshold: Decimal;
  tokenDenomination: Decimal;
}

export interface SkippedReward {
  tokenId: string;
  amount: Decimal;
  /** below_floor: the order is under the reward's minimum. covers_total: it would make the order free. */
  reason: 'below_floor' | 'covers_total';
  floor?: Decimal;
}

export interface OfferPrice {
  reward: { tokenId: string; amount: Decimal } | null;
  skipped: SkippedReward[];
  amountToPay: Decimal;
  earn: { ruleId: string; ruleName: string; amount: Decimal } | null;
  effectiveCost: Decimal;
}

export function priceOffer(input: {
  subtotal: Decimal;
  rewards: RewardCandidate[];
  earnRules: EarnRuleCandidate[];
}): OfferPrice {
  const { subtotal } = input;
  const skipped: SkippedReward[] = [];
  const usable: RewardCandidate[] = [];

  for (const r of input.rewards) {
    if (subtotal.lessThan(r.minimumTransactionFloor)) {
      skipped.push({ tokenId: r.id, amount: r.denomination, reason: 'below_floor', floor: r.minimumTransactionFloor });
    } else if (r.denomination.greaterThanOrEqualTo(subtotal)) {
      skipped.push({ tokenId: r.id, amount: r.denomination, reason: 'covers_total' });
    } else {
      usable.push(r);
    }
  }

  usable.sort((a, b) => b.denomination.comparedTo(a.denomination) || a.expiryAt.getTime() - b.expiryAt.getTime());
  const chosen = usable[0] ?? null;

  const amountToPay = chosen ? subtotal.minus(chosen.denomination) : subtotal;

  const qualifying = input.earnRules
    .filter((rule) => rule.spendThreshold.lessThanOrEqualTo(amountToPay))
    .sort((a, b) => b.tokenDenomination.comparedTo(a.tokenDenomination));
  const rule = qualifying[0] ?? null;

  const earnAmount = rule ? rule.tokenDenomination : ZERO;

  return {
    reward: chosen ? { tokenId: chosen.id, amount: chosen.denomination } : null,
    skipped,
    amountToPay,
    earn: rule ? { ruleId: rule.id, ruleName: rule.name, amount: rule.tokenDenomination } : null,
    effectiveCost: amountToPay.minus(earnAmount),
  };
}

/** Keys best-first: lowest effective cost, then lowest amount to pay, then key. */
export function rankOffers(offers: Array<{ key: string; price: OfferPrice }>): string[] {
  return [...offers]
    .sort((a, b) =>
      a.price.effectiveCost.comparedTo(b.price.effectiveCost)
      || a.price.amountToPay.comparedTo(b.price.amountToPay)
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((o) => o.key);
}

export function usd(value: Decimal | number): string {
  const d = typeof value === 'number' ? new Prisma.Decimal(value) : value;
  return `$${d.toFixed(2)}`;
}

/** One store's offer in plain words, using only numbers from priceOffer. */
/** A sentence ending in a name like "Coffee Co." keeps its one period. */
const endSentence = (text: string) => (text.endsWith('.') ? text : `${text}.`);

export function describeOffer(input: {
  merchantName: string;
  subtotal: Decimal;
  price: OfferPrice;
  hasRewardsProgram: boolean;
}): string {
  const { merchantName, subtotal, price } = input;
  const parts: string[] = [];

  if (price.reward) {
    parts.push(`Your ${usd(price.reward.amount)} ${merchantName} reward brings ${usd(subtotal)} down to ${usd(price.amountToPay)}, paid with PayPal.`);
  } else {
    parts.push(`${usd(price.amountToPay)} at ${merchantName}, paid with PayPal.`);
    const blocked = price.skipped.find((s) => s.reason === 'below_floor');
    if (blocked?.floor) {
      parts.push(`Your ${usd(blocked.amount)} reward here needs an order of ${usd(blocked.floor)} or more, so it can't be used.`);
    }
  }

  if (price.earn) {
    parts.push(endSentence(`This order earns a new ${usd(price.earn.amount)} reward at ${merchantName}`));
  } else if (!input.hasRewardsProgram) {
    parts.push(`${merchantName} has no rewards program on Tokento.`);
  } else {
    parts.push('This order is too small to earn a reward here.');
  }

  return parts.join(' ');
}

/** Compares offers best-first. The first entry must be the ranked winner. */
export function describeComparison(ranked: Array<{ key: string; merchantName: string; subtotal: Decimal; price: OfferPrice }>): string {
  if (ranked.length === 0) return 'No offers to compare.';
  const [best, ...rest] = ranked;

  let text = `${best.merchantName} is the best total value: ${usd(best.price.amountToPay)} today`;
  if (best.price.reward) text += ` with your ${usd(best.price.reward.amount)} reward`;
  text += best.price.earn ? `, and you earn ${usd(best.price.earn.amount)} back for next time.` : '.';

  const cheapestSticker = rest.reduce<{ name: string; subtotal: Decimal } | null>(
    (min, o) => (o.subtotal.lessThan(min?.subtotal ?? best.subtotal) ? { name: o.merchantName, subtotal: o.subtotal } : min),
    null,
  );
  if (cheapestSticker) {
    text += ` It isn't the lowest sticker price (${cheapestSticker.name} is ${usd(cheapestSticker.subtotal)} vs ${usd(best.subtotal)}), but it costs you less overall.`;
  }

  for (const o of rest) {
    let line = ` ${o.merchantName}: ${usd(o.price.amountToPay)}`;
    if (o.price.reward) line += ` after a ${usd(o.price.reward.amount)} reward`;
    line += o.price.earn ? `, earns ${usd(o.price.earn.amount)}.` : ', no reward earned.';
    text += line;
  }
  return text;
}
