"use client";

// Tokento's comparison: every amount here came from the server's Decimal math.
import type { QuoteResponse } from "@tokento/shared";
import { usd } from "@/lib/format";

export function OfferTable({ quote }: { quote: QuoteResponse }) {
  return (
    <div className="glass animate-slide-up overflow-hidden">
      <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <p className="text-sm font-medium">Compared {quote.offers.length} store{quote.offers.length === 1 ? "" : "s"} with your rewards</p>
        <p className="text-xs text-text-muted">Prices worked out by Tokento</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] text-sm">
          <thead>
            <tr className="bg-surface-2 text-left text-xs text-text-muted">
              <th className="px-4 py-2 font-medium">Store</th>
              <th className="px-2 py-2 text-right font-medium">Price</th>
              <th className="px-2 py-2 text-right font-medium">Your reward</th>
              <th className="px-2 py-2 text-right font-medium">You pay</th>
              <th className="px-2 py-2 text-right font-medium">You earn back</th>
              <th className="px-4 py-2 text-right font-medium" title="What you pay today minus the reward you earn back">Real cost</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {quote.offers.map((o) => {
              const best = o.productId === quote.recommendedProductId;
              return (
                <tr key={o.productId} className={`border-t border-border ${best ? "bg-brand-50" : ""}`}>
                  <td className="px-4 py-2.5 font-sans">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{o.merchantName}</span>
                      {best && <span className="rounded-full bg-brand-500 px-2 py-px text-[11px] font-medium text-surface-0">Best value</span>}
                      {o.withinBudget === false && <span className="rounded-full border border-border px-2 py-px text-[11px] text-text-muted">Over budget</span>}
                      {!o.mandate.within && o.mandate.code !== "no_mandate" && <span className="rounded-full border border-warning/40 px-2 py-px text-[11px] text-warning">Outside your limits</span>}
                    </div>
                    <div className="text-xs text-text-muted">{o.productName}</div>
                  </td>
                  <td className="px-2 py-2 text-right">{usd(o.subtotal)}</td>
                  <td className={`px-2 py-2 text-right ${o.reward ? "text-warning" : "text-text-muted"}`}>{o.reward ? `−${usd(o.reward.amount)}` : "—"}</td>
                  <td className="px-2 py-2 text-right font-medium">{usd(o.amountToPay)}</td>
                  <td className={`px-2 py-2 text-right ${o.earn ? "text-success" : "text-text-muted"}`}>{o.earn ? `+${usd(o.earn.amount)}` : "—"}</td>
                  <td className={`px-4 py-2 text-right ${best ? "font-semibold" : ""}`}>{usd(o.effectiveCost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border bg-surface-2 px-4 py-3 text-sm text-text-secondary">{quote.comparison}</p>
    </div>
  );
}
