// ============================================================
// Tokento — Database Seed Script (demo data)
// ============================================================
// This import MUST come first. crypto.ts captures HMAC_MASTER_KEY at module load,
// and ES imports are hoisted above statements — so calling dotenv.config() in this
// file's body ran too late and the signer silently fell back to the development key,
// producing tokens whose signatures the API rejected.
import '../src/config/env';
import { signToken } from '../src/utils/crypto';

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

import {
  ALL_SCOPES, DEMO, DEMO_EARN_RULES, DEMO_MERCHANTS, DEMO_PRODUCTS, demoPayoutEmails, demoProductId,
} from '../src/demo/demo-data';

const prisma = new PrismaClient();

// Every write is an upsert keyed by a fixed id, so running the seed twice changes nothing.

async function seedToken(params: {
  id: string; merchantId: string; customerId: string; earnRuleId: string;
  denomination: number; minimumTransactionFloor: number; expiryDays: number;
}) {
  const existing = await prisma.token.findUnique({ where: { id: params.id } });
  if (existing) return existing;

  const expiryAt = new Date();
  expiryAt.setDate(expiryAt.getDate() + params.expiryDays);
  const signature = signToken({
    tokenId: params.id,
    merchantId: params.merchantId,
    customerId: params.customerId,
    denomination: params.denomination,
    expiryAt: expiryAt.toISOString(),
    isSandbox: true,
    minimumTransactionFloor: params.minimumTransactionFloor,
    agentPresentableFlag: true,
  });
  return prisma.token.create({
    data: {
      id: params.id,
      merchantId: params.merchantId,
      customerId: params.customerId,
      earnRuleId: params.earnRuleId,
      denomination: params.denomination,
      tokenType: 'loyalty',
      status: 'ACTIVE',
      signature,
      idempotencyKey: `seed-${params.id}`,
      agentPresentableFlag: true,
      stackabilityFlag: true,
      minimumTransactionFloor: params.minimumTransactionFloor,
      expiryAt,
      isSandbox: true,
    },
  });
}

async function main() {
  console.log('Seeding Tokento demo data...\n');

  const payoutEmails = demoPayoutEmails();
  for (const [i, base] of DEMO_MERCHANTS.entries()) {
    const m = { ...base, payoutEmail: payoutEmails[i] };
    const merchant = await prisma.merchant.upsert({
      where: { email: m.email },
      update: { name: m.name, ...(m.payoutEmail ? { paypalPayoutEmail: m.payoutEmail } : {}) },
      create: {
        id: m.id, name: m.name, email: m.email, agentOptIn: true,
        settlementType: 'discount', settlementTiming: 'real_time', isSandbox: true,
        paypalPayoutEmail: m.payoutEmail,
      },
    });
    if (merchant.id !== m.id) {
      throw new Error(`${m.email} already exists with id ${merchant.id}. Reset the database (pnpm --filter @tokento/api exec prisma migrate reset) and seed again.`);
    }
    console.log(`Store: ${merchant.name} (${merchant.id}) payouts to ${merchant.paypalPayoutEmail ?? 'not set'}`);
  }

  // Coffee Co.'s API key backs the merchant dashboard. A fixed key keeps the
  // dashboard wired across reseeds; without one a random key is generated.
  const rawKey = process.env.DEV_FIXED_API_KEY || `tk_${crypto.randomBytes(48).toString('base64url')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  await prisma.apiKey.upsert({
    where: { keyHash },
    update: {},
    create: {
      merchantId: DEMO.merchants.coffeeCo, keyPrefix: rawKey.substring(0, 8), keyHash,
      scopes: ALL_SCOPES, rateLimit: 100, isSandbox: true,
    },
  });

  for (const r of DEMO_EARN_RULES) {
    await prisma.earnRule.upsert({
      where: { id: r.id },
      update: { name: r.name, spendThreshold: r.spendThreshold, tokenDenomination: r.tokenDenomination },
      create: { ...r, agentPresentableFlag: true, stackabilityFlag: true },
    });
  }
  console.log(`Earn rules: ${DEMO_EARN_RULES.map((r) => r.name).join(', ')}`);

  for (const [n, merchantId, sku, name, category, price, description] of DEMO_PRODUCTS) {
    await prisma.product.upsert({
      where: { id: demoProductId(n) },
      update: { name, category, price, description },
      create: { id: demoProductId(n), merchantId, sku, name, category, price, description, isSandbox: true },
    });
  }
  console.log(`Products: ${DEMO_PRODUCTS.length}`);

  await prisma.wallet.upsert({ where: { customerId: DEMO.customerId }, update: {}, create: { customerId: DEMO.customerId } });
  await seedToken({
    id: DEMO.tokens.mayaCoffee5, merchantId: DEMO.merchants.coffeeCo, customerId: DEMO.customerId,
    earnRuleId: DEMO.rules.coffeeSpend20, denomination: 5, minimumTransactionFloor: 10, expiryDays: 90,
  });
  await seedToken({
    id: DEMO.tokens.mayaRidgeline3, merchantId: DEMO.merchants.ridgeline, customerId: DEMO.customerId,
    earnRuleId: DEMO.rules.ridgelineSpend40, denomination: 3, minimumTransactionFloor: 30, expiryDays: 60,
  });
  console.log(`Shopper: Maya (${DEMO.customerId}) with a $5 Coffee Co. reward and a $3 Ridgeline reward`);

  console.log('\nSeed complete.');
  console.log(`Dashboard API key (Coffee Co.): ${rawKey.substring(0, 8)}… (DEV_FIXED_API_KEY)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
