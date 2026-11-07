// The local webhook relay: the only thing ngrok exposes during local testing.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWebhookRelay, WEBHOOK_PATH } from '../src/dev/webhook-relay';

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
let seen: Seen[] = [];
let upstream: http.Server;
let relay: http.Server;
let relayUrl: string;

const listen = (server: http.Server) =>
  new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}');
    });
  });
  const target = await listen(upstream);
  relay = createWebhookRelay(target);
  relayUrl = await listen(relay);
});

afterAll(async () => {
  await new Promise((r) => relay.close(r));
  await new Promise((r) => upstream.close(r));
});

beforeEach(() => {
  seen = [];
});

describe('webhook relay', () => {
  it("forwards PayPal's webhook POST with its signature headers and the exact body", async () => {
    const body = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP-1"}}';
    const res = await fetch(relayUrl + WEBHOOK_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'paypal-transmission-id': 'tx-1',
        'paypal-transmission-sig': 'sig-1',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-transmission-time': '2026-11-07T12:00:00Z',
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: WEBHOOK_PATH, body });
    expect(seen[0].headers).toMatchObject({ 'paypal-transmission-id': 'tx-1', 'paypal-transmission-sig': 'sig-1', 'paypal-auth-algo': 'SHA256withRSA' });
  });

  it('refuses every other path and method without reaching the API', async () => {
    const attempts: Array<[string, string]> = [
      ['GET', '/api/v1/catalog/search?q=coffee'],
      ['POST', '/api/v1/checkout/orders'],
      ['GET', WEBHOOK_PATH],
      ['POST', `${WEBHOOK_PATH}/../checkout/orders`],
      ['GET', '/health'],
    ];
    for (const [method, path] of attempts) {
      const res = await fetch(relayUrl + path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('never passes along login headers or a query string', async () => {
    await fetch(`${relayUrl}${WEBHOOK_PATH}?apiKey=abc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer b2c_dev_session::someone', 'x-api-key': 'tk_live_x', cookie: 'tokento_shopper=1' },
      body: '{}',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(WEBHOOK_PATH);
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers['x-api-key']).toBeUndefined();
    expect(seen[0].headers.cookie).toBeUndefined();
  });
});
