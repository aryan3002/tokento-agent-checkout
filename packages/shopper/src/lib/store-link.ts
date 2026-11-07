// A paid order, as the store sees it: a link into the store dashboard that opens
// on this exact order. Only once money has moved; never a broken link.
const STORE_SEES = new Set(["COMPLETED", "REFUND_PENDING", "REFUNDED"]);

export const DASHBOARD_URL = process.env.NEXT_PUBLIC_DASHBOARD_URL || "http://localhost:3100";

export function storeViewUrl(dashboardUrl: string, order: { id: string; status: string }): string | null {
  if (!STORE_SEES.has(order.status)) return null;
  let base: URL;
  try {
    base = new URL(dashboardUrl);
  } catch {
    return null;
  }
  const url = new URL("/", base);
  url.searchParams.set("order", order.id);
  return url.toString();
}
