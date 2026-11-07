// ============================================================
// Tokento — Demo catalog search
// ============================================================
// Stands in for each store's product feed so an agent can find what to buy.
import type { Prisma } from '@prisma/client';
import prisma from '../db/client';
import { toMoneyNumber } from '../utils/money';

export interface CatalogItem {
  productId: string;
  sku: string;
  name: string;
  description: string | null;
  category: string;
  price: number;
  merchantId: string;
  merchantName: string;
}

export async function searchProducts(
  params: { q?: string; category?: string; maxPrice?: number; limit: number },
  isSandbox: boolean,
): Promise<CatalogItem[]> {
  const words = (params.q ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 8);
  const where: Prisma.ProductWhereInput = {
    isActive: true,
    isSandbox,
    ...(params.category ? { category: { equals: params.category, mode: 'insensitive' } } : {}),
    ...(params.maxPrice !== undefined ? { price: { lte: params.maxPrice } } : {}),
    AND: words.map((word) => ({
      OR: [
        { name: { contains: word, mode: 'insensitive' } },
        { description: { contains: word, mode: 'insensitive' } },
        { category: { contains: word, mode: 'insensitive' } },
        { merchant: { name: { contains: word, mode: 'insensitive' } } },
      ],
    })),
  };
  const products = await prisma.product.findMany({
    where,
    include: { merchant: { select: { id: true, name: true } } },
    orderBy: [{ price: 'asc' }, { name: 'asc' }],
    take: params.limit,
  });
  return products.map((p) => ({
    productId: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    category: p.category,
    price: toMoneyNumber(p.price),
    merchantId: p.merchant.id,
    merchantName: p.merchant.name,
  }));
}

/** Stores with something to sell in this environment, so agents can name a reward's store. */
export async function listStores(isSandbox: boolean): Promise<Array<{ merchantId: string; name: string }>> {
  const merchants = await prisma.merchant.findMany({
    where: { isSandbox, products: { some: { isActive: true, isSandbox } } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return merchants.map((m) => ({ merchantId: m.id, name: m.name }));
}
