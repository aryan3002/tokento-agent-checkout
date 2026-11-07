"use client";

// Tokento's comparison: every amount here came from the server's Decimal math.
import type { QuoteResponse } from "@tokento/shared";
import { usd } from "@/lib/format";

export function OfferTable({ quote }: { quote: QuoteResponse }) {
  return (
    <div className="glass animate-slide-up overflow-hidden">
      <div className="px-4 pt-3">
        <p className="folio">Offers priced with your rewards</p>
      </div>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full min-w-[520px] text-sm">
          <thead>
            <tr className="folio text-left">
              <th className="px-4 py-2 font-normal">Store</th>
              <th className="px-2 py-2 text-right font-normal">Price</th>
              <th className="px-2 py-2 text-right font-normal">Reward</th>
              <th className="px-2 py-2 text-right font-normal">PayPal</th>
              <th className="px-2 py-2 text-right font-normal">Earn back</th>
              <th className="px-4 py-2 text-right font-normal">Net</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {quote.offers.map((o) => {
              const best = o.productId === quote.recommendedProductId;
              return (
                <tr key={o.productId} className={`border-t border-border ${best ? "bg-brand-50" : ""}`}>
                  <td className="px-4 py-2 font-sans">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{o.merchantName}</span>
                      {best && <span className="rounded-sm border border-brand-500 px-1.5 text-[11px] uppercase tracking-wider text-brand-600">Best value</span>}
                      {o.withinBudget === false && <span className="text-[11px] uppercase tracking-wider text-text-muted">Over budget</span>}
                      {!o.mandate.within && o.mandate.code !== "no_mandate" && <span className="text-[11px] uppercase tracking-wider text-warning">Outside limits</span>}
                    </div>
                    <div className="text-xs text-text-muted">{o.productName}</div>
                  </td>
                  <td className="px-2 py-2 text-right">{usd(o.subtotal)}</td>
                  <td className="px-2 py-2 text-right text-brand-600">{o.reward ? `−${usd(o.reward.amount)}` : "—"}</td>
                  <td className="px-2 py-2 text-right font-medium">{usd(o.amountToPay)}</td>
                  <td className="px-2 py-2 text-right text-success">{o.earn ? `+${usd(o.earn.amount)}` : "—"}</td>
                  <td className="px-4 py-2 text-right">{usd(o.effectiveCost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-3 text-sm text-text-secondary">{quote.comparison}</p>
    </div>
  );
}
