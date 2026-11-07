// A stand-in for api-m.sandbox.paypal.com. It records every request the client
// makes (method, path, lower-cased headers, parsed JSON body) and answers from
// per-route handlers, so tests assert on the exact payloads we send to PayPal.

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

export type Handler = (call: RecordedCall) => { status: number; body: unknown };

export function fakePayPal(
  handlers: Record<string, Handler> = {},
  opts: { tokenExpiresIn?: number; networkError?: boolean } = {},
) {
  const calls: RecordedCall[] = [];
  let tokensIssued = 0;

  const fetchImpl = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const raw = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : undefined;
    let body: any;
    if (raw !== undefined) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const call: RecordedCall = { method, path: url.pathname, headers, body };
    calls.push(call);

    if (opts.networkError) throw new TypeError('fetch failed');

    if (url.pathname === '/v1/oauth2/token') {
      tokensIssued += 1;
      return json(200, {
        scope: 'https://uri.paypal.com/services/payments/payment https://uri.paypal.com/services/payments/refund',
        access_token: `A21AAtoken${tokensIssued}`,
        token_type: 'Bearer',
        app_id: 'APP-80W284485P519543T',
        expires_in: opts.tokenExpiresIn ?? 32400,
        nonce: '2026-11-07T10:00:00ZnonceValue',
      });
    }

    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) {
      return json(404, { name: 'RESOURCE_NOT_FOUND', message: `No route ${method} ${url.pathname}`, debug_id: 'dbg404' });
    }
    const res = handler(call);
    return json(res.status, res.body);
  };

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    calls,
    apiCalls: () => calls.filter((c) => c.path !== '/v1/oauth2/token'),
    tokenCalls: () => calls.filter((c) => c.path === '/v1/oauth2/token'),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ---- Fixtures shaped like real sandbox responses ----

export const ORDER_ID = '5O190127TN364715T';
export const CAPTURE_ID = '3C679366HH908993F';

export const createdOrderResponse = {
  id: ORDER_ID,
  status: 'PAYER_ACTION_REQUIRED',
  payment_source: { paypal: {} },
  links: [
    { href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${ORDER_ID}`, rel: 'self', method: 'GET' },
    { href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`, rel: 'payer-action', method: 'GET' },
  ],
};

export const capturedOrderResponse = {
  id: ORDER_ID,
  status: 'COMPLETED',
  payment_source: {
    paypal: {
      email_address: 'maya.buyer@personal.example.com',
      account_id: 'QYR5Z8XDVJNXQ',
      account_status: 'VERIFIED',
      name: { given_name: 'Maya', surname: 'Rivera' },
    },
  },
  purchase_units: [
    {
      reference_id: 'default',
      payments: {
        captures: [
          {
            id: CAPTURE_ID,
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '23.00' },
            final_capture: true,
            seller_protection: { status: 'NOT_ELIGIBLE' },
            seller_receivable_breakdown: {
              gross_amount: { currency_code: 'USD', value: '23.00' },
              paypal_fee: { currency_code: 'USD', value: '1.29' },
              net_amount: { currency_code: 'USD', value: '21.71' },
            },
            custom_id: 'c0ffee00-0000-4000-8000-000000000001',
            invoice_id: 'c0ffee00-0000-4000-8000-000000000001',
            links: [],
            create_time: '2026-11-07T18:00:00Z',
            update_time: '2026-11-07T18:00:00Z',
          },
        ],
      },
    },
  ],
  links: [{ href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${ORDER_ID}`, rel: 'self', method: 'GET' }],
};
