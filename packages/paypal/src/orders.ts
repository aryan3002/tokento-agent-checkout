// ============================================================
// Orders v2: create, get, capture
// ============================================================
import type { PayPalHttp } from './http';
import type { CreateOrderInput, PayPalCapture, PayPalLink, PayPalOrder, RequestOptions } from './types';

export function buildCreateOrderBody(input: CreateOrderInput): Record<string, unknown> {
  const money = (value: string) => ({ currency_code: input.currency, value });

  const amount: Record<string, unknown> = money(input.amount);
  if (input.breakdown) {
    amount.breakdown = {
      item_total: money(input.breakdown.itemTotal),
      ...(input.breakdown.discount ? { discount: money(input.breakdown.discount) } : {}),
    };
  }

  const purchaseUnit: Record<string, unknown> = {
    custom_id: input.customId,
    description: input.description,
    amount,
  };
  if (input.invoiceId) purchaseUnit.invoice_id = input.invoiceId;
  if (input.items?.length) {
    purchaseUnit.items = input.items.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      unit_amount: money(item.unitAmount),
      ...(item.sku ? { sku: item.sku } : {}),
      category: 'PHYSICAL_GOODS',
    }));
  }

  const paypal = input.payment.kind === 'vault'
    ? { vault_id: input.payment.vaultId }
    : {
        experience_context: {
          return_url: input.payment.returnUrl,
          cancel_url: input.payment.cancelUrl,
          ...(input.payment.brandName ? { brand_name: input.payment.brandName } : {}),
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          landing_page: 'LOGIN',
          locale: 'en-US',
        },
      };

  return {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit],
    payment_source: { paypal },
  };
}

export function orderMethods(http: PayPalHttp) {
  return {
    createOrder(input: CreateOrderInput, opts: RequestOptions): Promise<PayPalOrder> {
      return http.request({ method: 'POST', path: '/v2/checkout/orders', body: buildCreateOrderBody(input), requestId: opts.requestId });
    },
    getOrder(orderId: string): Promise<PayPalOrder> {
      return http.request({ method: 'GET', path: `/v2/checkout/orders/${encodeURIComponent(orderId)}` });
    },
    captureOrder(orderId: string, opts: RequestOptions): Promise<PayPalOrder> {
      return http.request({
        method: 'POST',
        path: `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        body: {},
        requestId: opts.requestId,
      });
    },
  };
}

/** The link the buyer opens to approve: `payer-action` for orders, `approve` for setup tokens. */
export function approvalUrlOf(resource: { links?: PayPalLink[] }): string | null {
  const link = resource.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return link?.href ?? null;
}

/** The capture on a completed order, or null if there is none yet. */
export function captureOf(order: PayPalOrder): PayPalCapture | null {
  return order.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
}
