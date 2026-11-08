import { describe, expect, it } from 'vitest';
import { handleLine } from './claude-desktop.mjs';

const TOOLS = {
  tools: [{
    name: 'compare_offers',
    inputSchema: {
      type: 'object',
      properties: { wallet_token: { type: 'string' }, product_ids: { type: 'array' } },
      required: ['wallet_token', 'product_ids'],
    },
  }],
};

// A fake Worker: records what it was sent and answers like the real one.
function worker(result = {}) {
  const sent = [];
  const post = async (body) => {
    sent.push(body);
    return { jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? TOOLS : result };
  };
  return { sent, post };
}

const line = (msg) => JSON.stringify(msg);

describe('Claude Desktop bridge', () => {
  it('never answers a notification, and never forwards it', async () => {
    const w = worker();
    expect(await handleLine(line({ jsonrpc: '2.0', method: 'notifications/initialized' }), { post: w.post })).toBeNull();
    expect(w.sent).toEqual([]);
  });

  it('answers ping itself', async () => {
    const w = worker();
    expect(await handleLine(line({ jsonrpc: '2.0', id: 7, method: 'ping' }), { post: w.post })).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect(w.sent).toEqual([]);
  });

  it('with a configured wallet token, hides wallet_token from every tool', async () => {
    const w = worker();
    const out = await handleLine(line({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { post: w.post, walletToken: 'demo_session::abc' });
    const schema = out.result.tools[0].inputSchema;
    expect(schema.properties).not.toHaveProperty('wallet_token');
    expect(schema.required).toEqual(['product_ids']);
  });

  it('with a configured wallet token, sends it on every tool call, over anything the model passed', async () => {
    const w = worker({ content: [] });
    await handleLine(
      line({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'compare_offers', arguments: { product_ids: ['p1'], wallet_token: 'made-up' } } }),
      { post: w.post, walletToken: 'demo_session::abc' },
    );
    expect(w.sent[0].params.arguments).toEqual({ product_ids: ['p1'], wallet_token: 'demo_session::abc' });
  });

  it('without a configured wallet token, passes tools and calls through unchanged', async () => {
    const w = worker({ content: [] });
    const list = await handleLine(line({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { post: w.post });
    expect(list.result).toEqual(TOOLS);
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'compare_offers', arguments: { wallet_token: 't', product_ids: ['p1'] } } };
    await handleLine(line(call), { post: w.post });
    expect(w.sent[1]).toEqual(call);
  });

  it('turns an unreachable server into a JSON-RPC error for that request', async () => {
    const post = async () => { throw new Error('connect ECONNREFUSED'); };
    const out = await handleLine(line({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), { post, url: 'http://127.0.0.1:8787' });
    expect(out.id).toBe(3);
    expect(out.error.code).toBe(-32603);
    expect(out.error.message).toContain('http://127.0.0.1:8787');
  });

  it('answers a line that is not JSON with a parse error', async () => {
    const out = await handleLine('{not json', { post: worker().post });
    expect(out).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  });
});
