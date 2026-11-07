// Display formatting only. Every amount shown was computed by Tokento.
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `$${value.toFixed(2)}`;
}

export const TOOL_LABELS: Record<string, string> = {
  search_products: "Searching the stores",
  get_rewards: "Checking your rewards",
  compare_offers: "Comparing offers with your rewards",
  start_checkout: "Starting PayPal checkout",
  get_order_status: "Checking the order",
  get_spending_limits: "Checking your spending limits",
  list_my_orders: "Looking at past orders",
};
