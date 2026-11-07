// Local testing only: the one thing a tunnel (ngrok) should expose. It passes
// PayPal's webhook POST through to the API and refuses everything else, because
// the local API accepts development sessions that would let anyone on the
// internet act as any shopper or store.
import http from 'node:http';

export const WEBHOOK_PATH = '/api/v1/paypal/webhooks';
const MAX_BODY_BYTES = 1_000_000;

/** PayPal's signature headers plus the content type; nothing else is passed on. */
function forwardedHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' && (name.startsWith('paypal-') || name === 'content-type')) out[name] = value;
  }
  return out;
}

export function createWebhookRelay(target: string): http.Server {
  return http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || path !== WEBHOOK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      try {
        const upstream = await fetch(new URL(WEBHOOK_PATH, target), {
          method: 'POST',
          headers: forwardedHeaders(req.headers),
          body: Buffer.concat(chunks),
        });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        res.end(await upstream.text());
      } catch {
        res.writeHead(502, { 'content-type': 'text/plain' }).end('API unreachable');
      }
    });
  });
}
