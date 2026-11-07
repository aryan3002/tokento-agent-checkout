// Display helpers for the Payouts tab. Amounts come from Tokento's API.
import type { SettlementBatchStatus, SettlementPreview } from "@tokento/shared";

export type Tone = "success" | "warning" | "error";

export function payoutStatus(status: SettlementBatchStatus): { label: string; tone: Tone } {
  switch (status) {
    case "SUCCESS":
      return { label: "Paid out", tone: "success" };
    case "DENIED":
      return { label: "Denied by PayPal", tone: "error" };
    case "FAILED":
      return { label: "Failed", tone: "error" };
    default:
      return { label: "Sending", tone: "warning" };
  }
}

const usd = (v: number) => `$${v.toFixed(2)}`;

/** One line that explains what "Settle now" would pay. */
export function previewBreakdown(p: SettlementPreview): string {
  if (p.orders === 0) return "No paid orders waiting.";
  const parts = [`${p.orders} paid order${p.orders === 1 ? "" : "s"}: ${usd(p.gross)}`];
  if (p.fees > 0) parts.push(`${usd(p.fees)} Tokento fees`);
  if (p.refundAdjustments > 0) parts.push(`${usd(p.refundAdjustments)} refunds already paid out`);
  return parts.join(" − ");
}
