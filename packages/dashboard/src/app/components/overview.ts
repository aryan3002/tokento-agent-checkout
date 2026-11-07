// Stat cards on the Overview tab. The merchant tokens endpoint returns Prisma
// Decimals as JSON strings ("5"), so denominations are read as numbers and added
// in whole cents.

export interface OverviewStats {
  tokensIssued: number;
  activeTokens: number;
  redemptions: number;
  totalValue: number;
}

export function overviewStats(
  tokens: ReadonlyArray<{ status: string; denomination: number | string }>,
  redemptions: ReadonlyArray<unknown>,
): OverviewStats {
  const cents = tokens.reduce((sum, t) => sum + Math.round(Number(t.denomination) * 100), 0);
  return {
    tokensIssued: tokens.length,
    activeTokens: tokens.filter((t) => t.status === "ACTIVE").length,
    redemptions: redemptions.length,
    totalValue: cents / 100,
  };
}
