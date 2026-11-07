// ============================================================
// Tokento — Demo data (fictional stores, rules, products, shopper)
// ============================================================
// Shared by the seed script and the hosted demo's per-visitor shopper setup.
// Every row has a fixed id so seeding is idempotent.

export const DEMO = {
  customerId: '11111111-1111-4111-8111-111111111111', // Maya
  merchants: {
    coffeeCo: '10000000-0000-4000-8000-000000000001',
    ridgeline: '10000000-0000-4000-8000-000000000002',
    harbor: '10000000-0000-4000-8000-000000000003',
  },
  rules: {
    coffeeSpend20: '20000000-0000-4000-8000-000000000001',
    coffeeSpend50: '20000000-0000-4000-8000-000000000002',
    ridgelineSpend25: '20000000-0000-4000-8000-000000000003',
    ridgelineSpend40: '20000000-0000-4000-8000-000000000004',
  },
  tokens: {
    mayaCoffee5: '30000000-0000-4000-8000-000000000001',
    mayaRidgeline3: '30000000-0000-4000-8000-000000000002',
  },
} as const;

export const ALL_SCOPES = [
  'tokens:mint', 'tokens:read', 'tokens:validate', 'tokens:redeem', 'merchants:read', 'merchants:write',
  'earn_rules:read', 'earn_rules:write', 'webhooks:read', 'webhooks:write', 'audit:read',
];

/** Stores in payout-email order: DEMO_STORE_PAYOUT_EMAILS lists Coffee Co., Ridgeline, Harbor. */
export const DEMO_MERCHANTS = [
  { id: DEMO.merchants.coffeeCo, name: 'Coffee Co.', email: 'demo@coffeeco.com' },
  { id: DEMO.merchants.ridgeline, name: 'Ridgeline Roasters', email: 'demo@ridgeline-roasters.test' },
  { id: DEMO.merchants.harbor, name: 'Harbor Bean Supply', email: 'demo@harbor-bean.test' },
] as const;

export function demoPayoutEmails(raw = process.env.DEMO_STORE_PAYOUT_EMAILS || ''): Array<string | null> {
  const emails = raw.split(',').map((e) => e.trim()).filter(Boolean);
  return DEMO_MERCHANTS.map((_m, i) => emails[i] ?? null);
}

export const DEMO_EARN_RULES = [
  { id: DEMO.rules.coffeeSpend20, merchantId: DEMO.merchants.coffeeCo, name: 'Spend $20, Get $5 Off', spendThreshold: 20, tokenDenomination: 5, expiryDays: 90, minimumTransactionFloor: 10 },
  { id: DEMO.rules.coffeeSpend50, merchantId: DEMO.merchants.coffeeCo, name: 'Spend $50, Get $12 Off', spendThreshold: 50, tokenDenomination: 12, expiryDays: 60, minimumTransactionFloor: 20 },
  { id: DEMO.rules.ridgelineSpend25, merchantId: DEMO.merchants.ridgeline, name: 'Spend $25, Get $2 Off', spendThreshold: 25, tokenDenomination: 2, expiryDays: 60, minimumTransactionFloor: 0 },
  { id: DEMO.rules.ridgelineSpend40, merchantId: DEMO.merchants.ridgeline, name: 'Spend $40, Get $3 Off', spendThreshold: 40, tokenDenomination: 3, expiryDays: 60, minimumTransactionFloor: 30 },
];

// [id suffix, merchant, sku, name, category, price, description]
export const DEMO_PRODUCTS: Array<[number, string, string, string, string, number, string]> = [
  [1, DEMO.merchants.coffeeCo, 'CC-MRB-2LB', 'Morning Ridge Blend, medium roast, whole bean, 2 lb', 'coffee', 28.0, 'Balanced medium roast with cocoa and toasted almond notes. Roasted weekly.'],
  [2, DEMO.merchants.coffeeCo, 'CC-MRB-12OZ', 'Morning Ridge Blend, medium roast, whole bean, 12 oz', 'coffee', 14.5, 'Smaller bag of the house medium roast.'],
  [3, DEMO.merchants.coffeeCo, 'CC-NOD-2LB', 'Night Owl Dark Roast, whole bean, 2 lb', 'coffee', 30.0, 'Smoky dark roast with a heavy body.'],
  [4, DEMO.merchants.coffeeCo, 'CC-FILTER-4', 'Paper filters #4, 100 pack', 'supplies', 6.0, 'Unbleached cone filters.'],
  [5, DEMO.merchants.coffeeCo, 'CC-DRIPPER', 'Ceramic pour-over dripper', 'gear', 24.0, 'Single-cup ceramic dripper.'],
  [6, DEMO.merchants.ridgeline, 'RR-SUM-WB-2LB', 'Summit Medium Roast, whole bean, 2 lb', 'coffee', 26.5, 'Medium roast with caramel sweetness. Small-batch.'],
  [7, DEMO.merchants.ridgeline, 'RR-SUM-GR-2LB', 'Summit Medium Roast, ground, 2 lb', 'coffee', 26.5, 'Pre-ground for drip brewers.'],
  [8, DEMO.merchants.ridgeline, 'RR-DECAF-2LB', 'Decaf Valley, medium roast, whole bean, 2 lb', 'coffee', 27.0, 'Swiss-water decaf medium roast.'],
  [9, DEMO.merchants.ridgeline, 'RR-COLD-4PK', 'Cold brew pack, 4 x 32 oz', 'coffee', 22.0, 'Coarse-ground packs for overnight cold brew.'],
  [10, DEMO.merchants.ridgeline, 'RR-GREEN-8OZ', 'Loose leaf green tea, 8 oz', 'tea', 12.0, 'Grassy, light green tea.'],
  [11, DEMO.merchants.harbor, 'HB-HOUSE-2LB', 'Harbor House Medium Roast, whole bean, 2 lb', 'coffee', 25.0, 'Everyday medium roast.'],
  [12, DEMO.merchants.harbor, 'HB-ESP-2LB', 'Harbor House Espresso Roast, whole bean, 2 lb', 'coffee', 27.5, 'Dark espresso roast.'],
  [13, DEMO.merchants.harbor, 'HB-OAT-6PK', 'Oat milk, barista edition, 6 pack', 'dairy-free', 21.0, 'Steams and foams like dairy.'],
  [14, DEMO.merchants.harbor, 'HB-MUG-16', 'Stainless travel mug, 16 oz', 'gear', 18.0, 'Keeps coffee hot for 6 hours.'],
  [15, DEMO.merchants.harbor, 'HB-EARL-50', 'Earl grey tea bags, 50 count', 'tea', 9.0, 'Black tea with bergamot.'],
];

export function demoProductId(n: number): string {
  return `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** The rewards every demo shopper starts with. */
export const DEMO_STARTING_REWARDS = [
  { merchantId: DEMO.merchants.coffeeCo, earnRuleId: DEMO.rules.coffeeSpend20, denomination: 5, minimumTransactionFloor: 10, expiryDays: 90 },
  { merchantId: DEMO.merchants.ridgeline, earnRuleId: DEMO.rules.ridgelineSpend40, denomination: 3, minimumTransactionFloor: 30, expiryDays: 60 },
] as const;
