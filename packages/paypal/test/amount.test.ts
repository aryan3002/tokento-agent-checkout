import { describe, expect, it } from 'vitest';
import { toPayPalAmount } from '../src';

describe('toPayPalAmount', () => {
  it.each([
    [23, '23.00'],
    ['0.1', '0.10'],
    ['23.5', '23.50'],
    ['15.05', '15.05'],
    // A Decimal-like value (Prisma.Decimal drops trailing zeros in toString)
    [{ toString: () => '23.1' }, '23.10'],
  ])('formats %s as %s', (input, expected) => {
    expect(toPayPalAmount(input)).toBe(expected);
  });

  it.each([
    ['a negative amount', -1],
    ['three decimal places', '1.234'],
    ['float drift', 0.1 + 0.2],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an empty string', ''],
  ])('rejects %s', (_label, input) => {
    expect(() => toPayPalAmount(input as number | string)).toThrow(RangeError);
  });
});
