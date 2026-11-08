import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { errorHandler } from '../src/middleware/error.middleware';

vi.mock('../src/utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

// A broken or oversized request body is the caller's mistake, not a server fault:
// it must get a 4xx with a clear code, never "internal_error" 500.
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/echo', (req, res) => { res.json(req.body); });
  app.use(errorHandler());
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (body: string) =>
  fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('request body errors', () => {
  it('answers malformed JSON with 400 invalid_json', async () => {
    const res = await post('{"productIds":,}');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_json');
    expect(body.error.message).toBe('The request body is not valid JSON.');
  });

  it('answers an oversized body with 413 payload_too_large', async () => {
    const res = await post(JSON.stringify({ note: 'x'.repeat(2048) }));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('payload_too_large');
  });

  it('still accepts valid JSON', async () => {
    const res = await post('{"ok":true}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
