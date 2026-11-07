// Opening the dashboard from a shopper's paid order (/?order=<id>): which order
// the Overview features, and whether it is the one the shopper came from.
import type { CheckoutOrderView } from "@tokento/shared";
import { latestOrder } from "./overview-data";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The order id in the address, or null when it is missing or not an order id. */
export function orderIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("order");
  return id && UUID.test(id) ? id : null;
}

/**
 * The asked-for order when this store has it (the live copy from the list first,
 * else one loaded on its own because it is older than the list), otherwise the latest.
 */
export function featuredOrder(
  orders: CheckoutOrderView[],
  focusId: string | null,
  fetched: CheckoutOrderView | null,
): { order: CheckoutOrderView | null; focused: boolean } {
  if (focusId) {
    const found = orders.find((o) => o.id === focusId) ?? (fetched?.id === focusId ? fetched : null);
    if (found) return { order: found, focused: true };
  }
  return { order: latestOrder(orders), focused: false };
}
