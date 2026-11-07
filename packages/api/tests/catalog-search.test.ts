// Catalog search as an AI agent uses it: free-form queries with plurals, units
// written different ways and the odd extra word must still find the right items.
import { describe, expect, it } from 'vitest';
import { rankBySearch, searchTerms } from '../src/checkout/catalog.service';

describe('searchTerms', () => {
  it('lower-cases, splits on punctuation and units, and singularises', () => {
    expect(searchTerms('Medium-roast whole BEANS, 2lb!')).toEqual(['medium', 'roast', 'whole', 'bean', '2', 'lb']);
  });

  it('drops filler words an agent adds', () => {
    expect(searchTerms('reorder my usual coffee beans please')).toEqual(['coffee', 'bean']);
  });

  it('reads pounds and ounces the way the catalog writes them', () => {
    expect(searchTerms('2 pounds')).toEqual(['2', 'lb']);
    expect(searchTerms('12 ounces')).toEqual(['12', 'oz']);
    expect(searchTerms('2-lbs bag')).toEqual(['2', 'lb', 'bag']);
  });
});

type Item = { name: string; description: string | null; category: string; merchantName: string; price: number };
const item = (name: string, merchantName: string, price: number, category = 'coffee'): Item => ({ name, description: null, category, merchantName, price });

const CATALOG: Item[] = [
  item('Morning Ridge Blend, medium roast, whole bean, 12 oz', 'Coffee Co.', 14.5),
  item('Night Owl Dark Roast, whole bean, 2 lb', 'Coffee Co.', 30),
  item('Morning Ridge Blend, medium roast, whole bean, 2 lb', 'Coffee Co.', 28),
  item('Harbor House Medium Roast, whole bean, 2 lb', 'Harbor Bean Supply', 25),
  item('Summit Medium Roast, whole bean, 2 lb', 'Ridgeline Roasters', 26.5),
  item('Summit Medium Roast, ground, 2 lb', 'Ridgeline Roasters', 26.5),
  item('Paper filters #4, 100 pack', 'Coffee Co.', 6, 'supplies'),
];
const names = (xs: Item[]) => xs.map((x) => `${x.merchantName}: ${x.name}`);

describe('rankBySearch', () => {
  it('returns only the products that match every word, cheapest first, when there are any', () => {
    expect(names(rankBySearch(searchTerms('medium roast whole beans 2lb'), CATALOG))).toEqual([
      'Harbor Bean Supply: Harbor House Medium Roast, whole bean, 2 lb',
      'Ridgeline Roasters: Summit Medium Roast, whole bean, 2 lb',
      'Coffee Co.: Morning Ridge Blend, medium roast, whole bean, 2 lb',
    ]);
  });

  it('still finds the beans when the query has a word no product uses, closest matches first', () => {
    expect(names(rankBySearch(searchTerms('organic medium roast whole bean 2 lb'), CATALOG))).toEqual([
      'Harbor Bean Supply: Harbor House Medium Roast, whole bean, 2 lb',
      'Ridgeline Roasters: Summit Medium Roast, whole bean, 2 lb',
      'Coffee Co.: Morning Ridge Blend, medium roast, whole bean, 2 lb',
      'Coffee Co.: Night Owl Dark Roast, whole bean, 2 lb',
    ]);
  });

  it('matches the store name, so a named store comes first', () => {
    expect(names(rankBySearch(searchTerms('Harbor medium roast'), CATALOG))[0]).toBe('Harbor Bean Supply: Harbor House Medium Roast, whole bean, 2 lb');
  });

  it('returns nothing for a query that matches no product', () => {
    expect(rankBySearch(searchTerms('laptop stand'), CATALOG)).toEqual([]);
  });

  it('does not drift into unrelated items on a single shared word', () => {
    expect(names(rankBySearch(searchTerms('paper filters'), CATALOG))).toEqual(['Coffee Co.: Paper filters #4, 100 pack']);
  });
});
