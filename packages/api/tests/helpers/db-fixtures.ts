// Real-database fixtures for checkout tests. Each test file builds its own
// stores, products, rewards and shoppers with random ids and removes them
// afterwards, so it never depends on (or disturbs) the demo seed.
import '../../src/config/env';
import { createHash, randomBytes, randomUUID } from 'crypto';
import prisma from '../../src/db/client';
import { signToken } from '../../src/utils/crypto';

export interface RuleSpec {
  name: string;
  spendThreshold: number;
  tokenDenomination: number;
  minimumTransactionFloor?: number;
}

export interface ProductSpec {
  key: string;
  name: string;
  price: string;
  category?: string;
}

export interface StoreFixture {
  merchantId: string;
  name: string;
  ruleIds: string[];
  products: Record<string, string>;
}

export class DbFixtures {
  private merchantIds: string[] = [];
  private customerIds: string[] = [];

  async store(name: string, spec: { rules?: RuleSpec[]; products: ProductSpec[]; payoutEmail?: string }): Promise<StoreFixture> {
    const merchantId = randomUUID();
    this.merchantIds.push(merchantId);
    await prisma.merchant.create({
      data: {
        id: merchantId,
        name,
        email: `${merchantId}@stores.test`,
        isSandbox: true,
        paypalPayoutEmail: spec.payoutEmail ?? null,
      },
    });

    const ruleIds: string[] = [];
    for (const rule of spec.rules ?? []) {
      const created = await prisma.earnRule.create({
        data: {
          merchantId,
          name: rule.name,
          spendThreshold: rule.spendThreshold,
          tokenDenomination: rule.tokenDenomination,
          minimumTransactionFloor: rule.minimumTransactionFloor ?? 0,
          expiryDays: 30,
        },
      });
      ruleIds.push(created.id);
    }

    const products: Record<string, string> = {};
    for (const p of spec.products) {
      const created = await prisma.product.create({
        data: {
          merchantId,
          sku: `${p.key}-${merchantId.slice(0, 8)}`,
          name: p.name,
          category: p.category ?? 'coffee',
          price: p.price,
          isSandbox: true,
        },
      });
      products[p.key] = created.id;
    }

    return { merchantId, name, ruleIds, products };
  }

  /** A full-scope sandbox API key for the store; returns the raw key. */
  async apiKey(merchantId: string): Promise<string> {
    const rawKey = `tk_test_${randomBytes(24).toString('base64url')}`;
    await prisma.apiKey.create({
      data: {
        merchantId,
        keyPrefix: rawKey.slice(0, 8),
        keyHash: createHash('sha256').update(rawKey).digest('hex'),
        scopes: ['tokens:read', 'tokens:mint', 'merchants:read', 'merchants:write', 'earn_rules:read', 'earn_rules:write'],
        isSandbox: true,
      },
    });
    return rawKey;
  }

  async shopper(): Promise<string> {
    const customerId = randomUUID();
    this.customerIds.push(customerId);
    await prisma.wallet.create({ data: { customerId } });
    return customerId;
  }

  /** A signed, active reward, exactly as the mint path would create it. */
  async reward(params: {
    customerId: string;
    merchantId: string;
    earnRuleId: string;
    denomination: number;
    floor?: number;
    expiresInDays?: number;
  }): Promise<string> {
    const id = randomUUID();
    const expiryAt = new Date(Date.now() + (params.expiresInDays ?? 30) * 86_400_000);
    const floor = params.floor ?? 0;
    await prisma.token.create({
      data: {
        id,
        merchantId: params.merchantId,
        customerId: params.customerId,
        earnRuleId: params.earnRuleId,
        denomination: params.denomination,
        signature: signToken({
          tokenId: id,
          merchantId: params.merchantId,
          customerId: params.customerId,
          denomination: params.denomination,
          expiryAt: expiryAt.toISOString(),
          isSandbox: true,
          minimumTransactionFloor: floor,
          agentPresentableFlag: true,
        }),
        idempotencyKey: `fixture-${id}`,
        minimumTransactionFloor: floor,
        expiryAt,
        isSandbox: true,
      },
    });
    return id;
  }

  async cleanup(): Promise<void> {
    const merchantId = { in: this.merchantIds };
    const customerId = { in: this.customerIds };
    await prisma.checkoutOrder.deleteMany({ where: { OR: [{ merchantId }, { customerId }] } });
    await prisma.settlementBatch.deleteMany({ where: { merchantId } });
    await prisma.redemption.deleteMany({ where: { OR: [{ merchantId }, { customerId }] } });
    await prisma.token.deleteMany({ where: { OR: [{ merchantId }, { customerId }] } });
    await prisma.mandate.deleteMany({ where: { customerId } });
    await prisma.product.deleteMany({ where: { merchantId } });
    await prisma.earnRule.deleteMany({ where: { merchantId } });
    await prisma.apiKey.deleteMany({ where: { merchantId } });
    await prisma.merchant.deleteMany({ where: { id: merchantId } });
    await prisma.wallet.deleteMany({ where: { customerId } });
  }
}

export { prisma };
