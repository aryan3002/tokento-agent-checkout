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

// Words an agent adds that never describe a product.
const FILLER = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'with', 'my', 'me', 'i', 'her', 'his', 'our', 'your', 'some', 'any',
  'usual', 'please', 'to', 'in', 'on', 'at', 'buy', 'get', 'order', 'reorder', 'want', 'need', 'like', 'this', 'that',
  'again', 'same', 'another', 'more',
]);
const UNITS: Record<string, string> = { pound: 'lb', pounds: 'lb', lbs: 'lb', ounce: 'oz', ounces: 'oz' };

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((w) => UNITS[w] ?? w)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** The words of a search that describe a product: normalised, singular, no filler, at most 10. */
export function searchTerms(query: string): string[] {
  return [...new Set(tokens(query).filter((w) => !FILLER.has(w)))].slice(0, 10);
}

type Searchable = { name: string; description: string | null; category: string; merchantName: string; price: number };

/**
 * The products that match every word, cheapest first. When none does, the closest
 * matches (at least 60% of the words), best first: an agent's free-form query
 * ("organic medium roast beans 2lb") still finds the right items when one of its
 * words isn't in any product.
 */
export function rankBySearch<T extends Searchable>(terms: string[], items: T[]): T[] {
  const byPrice = (a: T, b: T) => a.price - b.price || a.name.localeCompare(b.name);
  if (terms.length === 0) return [...items].sort(byPrice);
  const scored = items.map((item) => {
    const words = new Set(tokens(`${item.name} ${item.description ?? ''} ${item.category} ${item.merchantName}`));
    return { item, matched: terms.filter((t) => words.has(t)).length };
  });
  const needed = scored.some((r) => r.matched === terms.length) ? terms.length : Math.max(1, Math.ceil(terms.length * 0.6));
  return scored
    .filter((r) => r.matched >= needed)
    .sort((a, b) => b.matched - a.matched || byPrice(a.item, b.item))
    .map((r) => r.item);
}

// The demo catalog stands in for each store's product feed and is small, so it is
// ranked in memory; a real feed would use Postgres full-text search with the same words.
const MAX_CANDIDATES = 1000;

export async function searchProducts(
  params: { q?: string; category?: string; maxPrice?: number; limit: number },
  isSandbox: boolean,
): Promise<CatalogItem[]> {
  const where: Prisma.ProductWhereInput = {
    isActive: true,
    isSandbox,
    ...(params.category ? { category: { equals: params.category, mode: 'insensitive' } } : {}),
    ...(params.maxPrice !== undefined ? { price: { lte: params.maxPrice } } : {}),
  };
  const products = await prisma.product.findMany({
    where,
    include: { merchant: { select: { id: true, name: true } } },
    orderBy: [{ price: 'asc' }, { name: 'asc' }],
    take: MAX_CANDIDATES,
  });
  const items: CatalogItem[] = products.map((p) => ({
    productId: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    category: p.category,
    price: toMoneyNumber(p.price),
    merchantId: p.merchant.id,
    merchantName: p.merchant.name,
  }));
  return rankBySearch(searchTerms(params.q ?? ''), items).slice(0, params.limit);
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
