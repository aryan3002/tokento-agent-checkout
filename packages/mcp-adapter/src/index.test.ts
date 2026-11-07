import { describe, expect, it, vi } from 'vitest';
import worker from './index';

describe('mcp adapter worker', () => {
  it('returns method not allowed for non-POST requests', async () => {
    const req = new Request('http://localhost:8787', { method: 'GET' });
    const res = await worker.fetch(req, { API_BASE_URL: 'http://localhost:4000' });
    expect(res.status).toBe(405);
  });

  it('lists available tools', async () => {
    const req = new Request('http://localhost:8787', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });

    const res = await worker.fetch(req, { API_BASE_URL: 'http://localhost:4000' });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      result?: { tools?: Array<{ name: string }> };
    };

    expect(Array.isArray(body.result?.tools)).toBe(true);
    const names = body.result?.tools?.map((tool) => tool.name) || [];
    expect(names).toContain('query_loyalty_tokens');
    expect(names).toContain('validate_token');
    expect(names).toContain('redeem_token');
  });

  it('returns MCP method-not-found for unknown method', async () => {
    const req = new Request('http://localhost:8787', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'unknown_method',
      }),
    });

    const res = await worker.fetch(req, { API_BASE_URL: 'http://localhost:4000' });
    const body = await res.json() as {
      error?: { code?: number };
    };

    expect(res.status).toBe(200);
    expect(body.error?.code).toBe(-32601);
  });
});

describe('identity is taken from the wallet token, never from a tool argument', () => {
  const env = { API_BASE_URL: 'http://localhost:4000' } as never;

  function call(name: string, args: Record<string, unknown>) {
    return new Request('http://worker/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  }

  it('refuses a tool call with no wallet_token', async () => {
    const res = await worker.fetch(call('redeem_token', {
      token_id: 't1', merchant_id: 'm1', transaction_amount: 10, idempotency_key: 'k',
    }), env);
    const body = await res.json() as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/wallet_token/);
  });

  it('forwards the wallet token verbatim and never synthesises a dev session', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tokens: [] }), { headers: { 'Content-Type': 'application/json' } }),
    );

    await worker.fetch(call('query_loyalty_tokens', { wallet_token: 'session-abc' }), env);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const auth = (init.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe('Bearer session-abc');
    expect(auth).not.toContain('dev_session');
    // The customer is resolved from the session, so no customer id travels in the URL.
    expect(url).toContain('/wallet/me/tokens');
    fetchSpy.mockRestore();
  });

  it('does not advertise customer_id as an input on any tool', async () => {
    const res = await worker.fetch(new Request('http://worker/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    }), env);
    const body = await res.json() as { result: { tools: { inputSchema: { properties: Record<string, unknown> } }[] } };
    for (const tool of body.result.tools) {
      expect(Object.keys(tool.inputSchema.properties)).not.toContain('customer_id');
    }
  });
});

describe('checkout tools: any MCP agent can compare stores and start a PayPal checkout', () => {
  const env = { API_BASE_URL: 'http://api.test' } as never;
  const call = (name: string, args: Record<string, unknown>) =>
    new Request('http://worker/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }),
    });
  type ToolResult = { result: { isError?: boolean; content: { text: string }[] } };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function mockFetch(response: Response) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  }

  it('lists the four checkout tools, each needing the shopper wallet token', async () => {
    const res = await worker.fetch(new Request('http://worker/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), env);
    const body = await res.json() as { result: { tools: { name: string; inputSchema: { required: string[] } }[] } };
    const byName = Object.fromEntries(body.result.tools.map((t) => [t.name, t]));
    for (const name of ['search_products', 'compare_offers', 'start_checkout', 'get_order_status']) {
      expect(byName[name]?.inputSchema.required).toContain('wallet_token');
    }
  });

  it('search_products asks the catalog with the shopper session', async () => {
    const spy = mockFetch(json(200, { products: [{ productId: 'p1', name: 'Beans' }] }));
    const res = await worker.fetch(call('search_products', { wallet_token: 'sess-1', query: 'medium roast 2 lb', max_price: 30 }), env);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/catalog/search?q=medium+roast+2+lb&maxPrice=30');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sess-1');
    const body = await res.json() as ToolResult;
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0].text)).toEqual({ products: [{ productId: 'p1', name: 'Beans' }] });
    spy.mockRestore();
  });

  it('compare_offers sends the products, quantity and budget to Tokento, which does all the math', async () => {
    const spy = mockFetch(json(200, { offers: [], recommendedProductId: null, comparison: 'No offers.' }));
    await worker.fetch(call('compare_offers', { wallet_token: 'sess-1', product_ids: ['p1', 'p2'], quantity: 2, max_amount_to_pay: 50 }), env);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/checkout/quote');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ productIds: ['p1', 'p2'], quantity: 2, maxAmountToPay: 50 });
    spy.mockRestore();
  });

  it('start_checkout creates the order with the idempotency key and tells the agent to send the shopper to PayPal', async () => {
    const spy = mockFetch(json(201, {
      id: 'o1', status: 'CREATED', amountToPay: 23, paypal: { approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=X' }, receipt: 'r',
    }));
    const res = await worker.fetch(call('start_checkout', { wallet_token: 'sess-1', product_id: 'p1', reason: 'Best total value', idempotency_key: 'agent-run-42' }), env);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/checkout/orders');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('agent-run-42');
    expect(JSON.parse(String(init.body))).toEqual({ productId: 'p1', quantity: 1, paymentMode: 'auto', agentReason: 'Best total value', agentId: 'mcp-adapter' });
    const out = JSON.parse(((await res.json()) as ToolResult).result.content[0].text);
    expect(out.next_step).toContain('https://www.sandbox.paypal.com/checkoutnow?token=X');
    spy.mockRestore();
  });

  it('refuses a checkout without an idempotency key, before calling Tokento', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await worker.fetch(call('start_checkout', { wallet_token: 'sess-1', product_id: 'p1', reason: 'x' }), env);
    const body = await res.json() as ToolResult;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/idempotency_key/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses malformed product lists before calling Tokento', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const product_ids of [[], 'p1', Array.from({ length: 11 }, (_, i) => `p${i}`), [3]]) {
      const res = await worker.fetch(call('compare_offers', { wallet_token: 'sess-1', product_ids }), env);
      expect(((await res.json()) as ToolResult).result.isError).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("passes Tokento's refusal (e.g. outside the spending limits) back as a tool error", async () => {
    const spy = mockFetch(json(403, { error: { code: 'mandate_violation', message: 'Over the $30.00 per-purchase limit.' } }));
    const res = await worker.fetch(call('start_checkout', { wallet_token: 'sess-1', product_id: 'p1', quantity: 3, reason: 'x', idempotency_key: 'k1' }), env);
    const body = await res.json() as ToolResult;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('mandate_violation');
    expect(body.result.content[0].text).toContain('Over the $30.00 per-purchase limit.');
    spy.mockRestore();
  });

  it('says plainly when Tokento cannot be reached', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const res = await worker.fetch(call('compare_offers', { wallet_token: 'sess-1', product_ids: ['p1', 'p2'] }), env);
    const body = await res.json() as ToolResult;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/could not be reached/);
    spy.mockRestore();
  });

  it('get_order_status reads one order and keeps the id inside the path', async () => {
    const spy = mockFetch(json(200, { id: 'o1', status: 'COMPLETED' }));
    await worker.fetch(call('get_order_status', { wallet_token: 'sess-1', order_id: '../../merchants/me' }), env);
    const [url] = spy.mock.calls[0] as [string];
    expect(url).toBe('http://api.test/api/v1/checkout/orders/..%2F..%2Fmerchants%2Fme');
    spy.mockRestore();
  });
});
