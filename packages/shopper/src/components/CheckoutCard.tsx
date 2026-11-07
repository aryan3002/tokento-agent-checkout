"use client";

// One agent purchase: the math, the PayPal approval, then the receipt.
import { useState } from "react";
import { PayPalOneTimePaymentButton } from "@paypal/react-paypal-js/sdk-v6";
import type { CheckoutOrderView } from "@tokento/shared";
import { usd } from "@/lib/format";

const WAITING = ["CREATED", "APPROVED"];

async function post(path: string): Promise<CheckoutOrderView> {
  const res = await fetch(path, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? "Something went wrong.");
  return data as CheckoutOrderView;
}

export function CheckoutCard({
  order,
  paypalReady,
  onOrder,
  onPaid,
}: {
  order: CheckoutOrderView;
  paypalReady: boolean;
  onOrder: (order: CheckoutOrderView) => void;
  onPaid: (order: CheckoutOrderView) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = WAITING.includes(order.status);
  const paid = order.status === "COMPLETED";

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      onOrder(await post(`/api/orders/${order.id}/cancel`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass animate-slide-up relative overflow-hidden p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="folio">{order.merchant.name} · PayPal checkout</p>
          <p className="mt-1 font-medium">{order.quantity > 1 ? `${order.quantity} × ` : ""}{order.product.name}</p>
        </div>
        {paid && <span className="stamp shrink-0 px-2 py-1 text-xs">Paid</span>}
        {order.status === "REFUNDED" && <span className="stamp shrink-0 px-2 py-1 text-xs">Refunded</span>}
      </div>

      <dl className="tabular mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 font-mono text-sm">
        <dt className="text-text-secondary">Price</dt>
        <dd className="text-right">{usd(order.subtotal)}</dd>
        {order.reward && (
          <>
            <dt className="text-text-secondary">{order.reward.state === "reissued" ? "Reward (returned)" : "Your reward"}</dt>
            <dd className="text-right text-brand-600">−{usd(order.reward.amount)}</dd>
          </>
        )}
        <dt className="font-medium">{paid ? "Paid with PayPal" : order.status === "REFUNDED" ? "Refunded to PayPal" : "PayPal charges"}</dt>
        <dd className="text-right font-medium">{usd(order.amountToPay)}</dd>
        {order.earned && order.earned.state !== "voided" && (
          <>
            <dt className="text-text-secondary">{order.earned.state === "expected" ? "You'll earn" : "You earned"}</dt>
            <dd className="text-right text-success">+{usd(order.earned.amount)} reward</dd>
          </>
        )}
      </dl>

      {order.agentReason && (
        <p className="mt-3 text-sm text-text-secondary">
          <span className="folio mr-2">Why this store</span>
          {order.agentReason}
        </p>
      )}

      {order.outsideMandate && waiting && (
        <p className="mt-3 text-sm text-warning">This is outside your spending limits, so it needs your approval in PayPal.</p>
      )}

      {waiting && (
        <div className="mt-4 space-y-2">
          {paypalReady && order.paypal.orderId ? (
            <PayPalOneTimePaymentButton
              orderId={order.paypal.orderId}
              presentationMode="auto"
              onApprove={async () => {
                setError(null);
                const updated = await post(`/api/orders/${order.id}/capture`);
                onOrder(updated);
                onPaid(updated);
              }}
              onCancel={() => { void cancel(); }}
              onError={() => setError("PayPal couldn't finish the payment. Try again.")}
            />
          ) : null}
          <div className="flex items-center justify-between text-sm">
            {order.paypal.approvalUrl ? (
              <a className="ink-link text-text-secondary" href={order.paypal.approvalUrl}>
                {paypalReady ? "Or open PayPal in this tab" : "Approve in PayPal"}
              </a>
            ) : <span />}
            <button type="button" disabled={busy} onClick={() => void cancel()} className="ink-link text-text-muted disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {paid && order.paypal.captureId && (
        <p className="folio mt-3">PayPal capture {order.paypal.captureId}</p>
      )}
      {!waiting && !paid && order.status !== "REFUNDED" && <p className="mt-3 text-sm text-text-secondary">{order.receipt}</p>}
      {order.status === "REFUNDED" && <p className="mt-3 text-sm text-text-secondary">{order.receipt}</p>}
      {error && <p className="mt-2 text-sm text-error">{error}</p>}
    </div>
  );
}
