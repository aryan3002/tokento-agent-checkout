// A fresh demo shopper per hosted-demo visitor: Maya's two starting rewards and
// her default spending limits, so judges can't see or spend each other's wallets.
import { randomUUID } from 'crypto';
import prisma from '../db/client';
import { signToken } from '../utils/crypto';
import { DEMO, DEMO_STARTING_REWARDS } from './demo-data';
import { demoSecret, signDemoSession } from './demo-session';

const SESSION_DAYS = 7;

export interface DemoTemplate {
  rewards: ReadonlyArray<{ merchantId: string; earnRuleId: string; denomination: number; minimumTransactionFloor: number; expiryDays: number }>;
  storeIds: string[];
}

export const DEFAULT_DEMO_TEMPLATE: DemoTemplate = {
  rewards: DEMO_STARTING_REWARDS,
  storeIds: Object.values(DEMO.merchants),
};

export async function provisionDemoShopper(template: DemoTemplate = DEFAULT_DEMO_TEMPLATE, now: Date = new Date()) {
  // Check the signing secret before writing anything: a misconfigured server must not leave half-made shoppers.
  const secret = demoSecret();
  const customerId = randomUUID();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);

  await prisma.$transaction(async (tx) => {
    await tx.wallet.create({ data: { customerId } });
    for (const r of template.rewards) {
      const id = randomUUID();
      const expiryAt = new Date(now.getTime() + r.expiryDays * 86_400_000);
      await tx.token.create({
        data: {
          id,
          merchantId: r.merchantId,
          customerId,
          earnRuleId: r.earnRuleId,
          denomination: r.denomination,
          tokenType: 'loyalty',
          status: 'ACTIVE',
          signature: signToken({
            tokenId: id, merchantId: r.merchantId, customerId, denomination: r.denomination,
            expiryAt: expiryAt.toISOString(), isSandbox: true, minimumTransactionFloor: r.minimumTransactionFloor, agentPresentableFlag: true,
          }),
          idempotencyKey: `demo-${id}`,
          agentPresentableFlag: true,
          stackabilityFlag: true,
          minimumTransactionFloor: r.minimumTransactionFloor,
          expiryAt,
          isSandbox: true,
        },
      });
    }
    await tx.mandate.create({
      data: { customerId, perPurchaseMax: 30, monthlyCap: 100, allowedMerchantIds: template.storeIds, expiresAt: new Date(now.getTime() + 30 * 86_400_000) },
    });
  });

  return { customerId, token: signDemoSession(customerId, expiresAt, secret), expiresAt: expiresAt.toISOString() };
}
