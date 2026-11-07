import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { describeComparison, describeOffer, priceOffer, rankOffers } from '../src/checkout/pricing';

const D = (v: string | number) => new Prisma.Decimal(v);

// Demo stores' rules and Maya's rewards (see src/demo/demo-data.ts)
const coffeeRules = [
  { id: 'rule-20', name: 'Spend $20, Get $5 Off', spendThreshold: D(20), tokenDenomination: D(5) },
  { id: 'rule-50', name: 'Spend $50, Get $12 Off', spendThreshold: D(50), tokenDenomination: D(12) },
];
const ridgelineRules = [
  { id: 'rr-25', name: 'Spend $25, Get $2 Off', spendThreshold: D(25), tokenDenomination: D(2) },
  { id: 'rr-40', name: 'Spend $40, Get $3 Off', spendThreshold: D(40), tokenDenomination: D(3) },
];
const coffeeReward = { id: 'tok-coffee-5', denomination: D(5), minimumTransactionFloor: D(10), expiryAt: new Date('2027-02-01') };
const ridgelineReward = { id: 'tok-ridge-3', denomination: D(3), minimumTransactionFloor: D(30), expiryAt: new Date('2027-01-01') };

const coffee = priceOffer({ subtotal: D('28.00'), rewards: [coffeeReward], earnRules: coffeeRules });
const harbor = priceOffer({ subtotal: D('25.00'), rewards: [], earnRules: [] });
const ridgeline = priceOffer({ subtotal: D('26.50'), rewards: [ridgelineReward], earnRules: ridgelineRules });

describe('priceOffer', () => {
  it('Coffee Co.: $28 with the $5 reward pays $23.00 and earns $5.00 back (effective $18.00)', () => {
    expect(coffee.reward).toEqual({ tokenId: 'tok-coffee-5', amount: D(5) });
    expect(coffee.amountToPay.toFixed(2)).toBe('23.00');
    expect(coffee.earn).toEqual({ ruleId: 'rule-20', ruleName: 'Spend $20, Get $5 Off', amount: D(5) });
    expect(coffee.effectiveCost.toFixed(2)).toBe('18.00');
  });

  it('Harbor: $25 with no rewards program pays $25.00 and earns nothing', () => {
    expect(harbor.reward).toBeNull();
    expect(harbor.earn).toBeNull();
    expect(harbor.amountToPay.toFixed(2)).toBe('25.00');
    expect(harbor.effectiveCost.toFixed(2)).toBe('25.00');
  });

  it('Ridgeline: the $3 reward needs a $30 order, so $26.50 is paid and $2.00 earned', () => {
    expect(ridgeline.reward).toBeNull();
    expect(ridgeline.skipped).toEqual([{ tokenId: 'tok-ridge-3', amount: D(3), reason: 'below_floor', floor: D(30) }]);
    expect(ridgeline.amountToPay.toFixed(2)).toBe('26.50');
    expect(ridgeline.earn?.ruleId).toBe('rr-25');
    expect(ridgeline.effectiveCost.toFixed(2)).toBe('24.50');
  });

  it('uses the largest usable reward, and the one expiring first on a tie', () => {
    const price = priceOffer({
      subtotal: D(28),
      rewards: [
        { id: 'five-march', denomination: D(5), minimumTransactionFloor: D(0), expiryAt: new Date('2027-03-01') },
        { id: 'ten-needs-50', denomination: D(10), minimumTransactionFloor: D(50), expiryAt: new Date('2027-01-01') },
        { id: 'five-january', denomination: D(5), minimumTransactionFloor: D(0), expiryAt: new Date('2027-01-15') },
        { id: 'two', denomination: D(2), minimumTransactionFloor: D(0), expiryAt: new Date('2026-12-01') },
      ],
      earnRules: [],
    });
    expect(price.reward?.tokenId).toBe('five-january');
  });

  it('never applies a reward that would cover the whole price, because PayPal cannot charge $0', () => {
    const exact = priceOffer({ subtotal: D(5), rewards: [{ ...coffeeReward, minimumTransactionFloor: D(0) }], earnRules: [] });
    expect(exact.reward).toBeNull();
    expect(exact.amountToPay.toFixed(2)).toBe('5.00');
    expect(exact.skipped[0]).toMatchObject({ tokenId: 'tok-coffee-5', reason: 'covers_total' });
  });

  it('subtracts exactly: $20.10 minus a $5.05 reward is $15.05, not a float approximation', () => {
    const price = priceOffer({
      subtotal: D('20.10'),
      rewards: [{ id: 'odd', denomination: D('5.05'), minimumTransactionFloor: D(0), expiryAt: new Date('2027-01-01') }],
      earnRules: [],
    });
    expect(price.amountToPay.equals(D('15.05'))).toBe(true);
  });

  it('earns when the amount paid lands exactly on the threshold', () => {
    const price = priceOffer({ subtotal: D(25), rewards: [coffeeReward], earnRules: coffeeRules });
    expect(price.amountToPay.toFixed(2)).toBe('20.00');
    expect(price.earn?.ruleId).toBe('rule-20');
  });

  it('earns on the amount paid, not the sticker price', () => {
    const price = priceOffer({ subtotal: D(24), rewards: [coffeeReward], earnRules: coffeeRules });
    expect(price.amountToPay.toFixed(2)).toBe('19.00');
    expect(price.earn).toBeNull();
  });

  it('picks the biggest rule the amount paid qualifies for', () => {
    const price = priceOffer({ subtotal: D(56), rewards: [coffeeReward], earnRules: coffeeRules });
    expect(price.amountToPay.toFixed(2)).toBe('51.00');
    expect(price.earn?.ruleId).toBe('rule-50');
  });
});

describe('rankOffers', () => {
  it('puts the best total value first, not the lowest sticker price', () => {
    expect(rankOffers([
      { key: 'harbor', price: harbor },
      { key: 'ridgeline', price: ridgeline },
      { key: 'coffee', price: coffee },
    ])).toEqual(['coffee', 'ridgeline', 'harbor']);
  });

  it('prefers paying a little more today when the reward earned back makes it cheaper overall', () => {
    const paysMoreEarnsFive = priceOffer({ subtotal: D(27), rewards: [], earnRules: coffeeRules }); // pay 27, earn 5, effective 22
    const paysLessEarnsNothing = priceOffer({ subtotal: D(25), rewards: [], earnRules: [] }); // pay 25, effective 25
    expect(rankOffers([
      { key: 'cheaper-today', price: paysLessEarnsNothing },
      { key: 'better-overall', price: paysMoreEarnsFive },
    ])).toEqual(['better-overall', 'cheaper-today']);
  });

  it('breaks ties on the lower amount to pay, then on key', () => {
    const payMore = priceOffer({ subtotal: D(30), rewards: [], earnRules: [{ id: 'r', name: 'r', spendThreshold: D(1), tokenDenomination: D(5) }] }); // pay 30, effective 25
    const payLess = priceOffer({ subtotal: D(25), rewards: [], earnRules: [] }); // pay 25, effective 25
    expect(rankOffers([{ key: 'a', price: payMore }, { key: 'b', price: payLess }])).toEqual(['b', 'a']);
    expect(rankOffers([{ key: 'z', price: harbor }, { key: 'y', price: harbor }])).toEqual(['y', 'z']);
  });
});

describe('plain-language reasons', () => {
  it('explains the reward used, the PayPal amount and the reward earned', () => {
    const text = describeOffer({ merchantName: 'Coffee Co.', subtotal: D(28), price: coffee, hasRewardsProgram: true });
    expect(text).toContain('$5.00');
    expect(text).toContain('$28.00');
    expect(text).toContain('$23.00');
    expect(text).toContain('Coffee Co.');
  });

  it('says why a reward could not be used', () => {
    const text = describeOffer({ merchantName: 'Ridgeline Roasters', subtotal: D('26.50'), price: ridgeline, hasRewardsProgram: true });
    expect(text).toContain('$30.00');
    expect(text).toContain('$2.00');
  });

  it('says when a store has no rewards program', () => {
    const text = describeOffer({ merchantName: 'Harbor Bean Supply', subtotal: D(25), price: harbor, hasRewardsProgram: false });
    expect(text).toContain('$25.00');
    expect(text.toLowerCase()).toContain('no rewards');
  });

  it('compares the winner with the cheaper sticker price', () => {
    const text = describeComparison([
      { key: 'coffee', merchantName: 'Coffee Co.', subtotal: D(28), price: coffee },
      { key: 'ridgeline', merchantName: 'Ridgeline Roasters', subtotal: D('26.50'), price: ridgeline },
      { key: 'harbor', merchantName: 'Harbor Bean Supply', subtotal: D(25), price: harbor },
    ]);
    expect(text.indexOf('Coffee Co.')).toBe(0);
    expect(text).toContain('$23.00');
    expect(text).toContain('Harbor Bean Supply');
    expect(text).toContain('$25.00');
    expect(text.toLowerCase()).toContain('lowest sticker price');
  });
});
