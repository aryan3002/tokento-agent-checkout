// ============================================================
// Authenticated HTTP to PayPal REST
// ============================================================
// One OAuth client-credentials token per client, reused until 60 s before it
// expires. Concurrent callers share a single in-flight token request.

import { PayPalApiError } from './errors';
import type { PayPalClientConfig } from './types';

const BASE_URLS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

const EXPIRY_MARGIN_MS = 60_000;

export interface HttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  /** Becomes the PayPal-Request-Id header. */
  requestId?: string;
}

export interface PayPalHttp {
  request<T>(req: HttpRequest): Promise<T>;
}

export function createHttp(config: PayPalClientConfig): PayPalHttp {
  const baseUrl = BASE_URLS[config.env];
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? 20_000;

  let cached: { token: string; refreshAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new PayPalApiError({
        status: 0,
        name: 'NETWORK_ERROR',
        message: `PayPal unreachable: ${(err as Error).message}`,
      });
    }
  }

  async function fetchToken(): Promise<string> {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const res = await send(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const data = (await readJson(res)) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      throw new PayPalApiError({
        status: res.status,
        name: data.error ?? 'AUTHENTICATION_FAILURE',
        message: data.error_description ?? 'PayPal rejected the client credentials.',
      });
    }
    const lifetimeMs = (data.expires_in ?? 0) * 1000;
    cached = { token: data.access_token, refreshAt: now() + lifetimeMs - EXPIRY_MARGIN_MS };
    return data.access_token;
  }

  async function accessToken(): Promise<string> {
    if (cached && now() < cached.refreshAt) return cached.token;
    if (!inFlight) {
      inFlight = fetchToken().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  return {
    async request<T>(req: HttpRequest): Promise<T> {
      const token = await accessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        Prefer: 'return=representation',
      };
      if (req.body !== undefined) headers['Content-Type'] = 'application/json';
      if (req.requestId) headers['PayPal-Request-Id'] = req.requestId;

      const res = await send(`${baseUrl}${req.path}`, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      });

      const data = await readJson(res);
      if (!res.ok) throw toApiError(res.status, data);
      return data as T;
    },
  };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function toApiError(status: number, data: unknown): PayPalApiError {
  const body = (data ?? {}) as {
    name?: string;
    message?: string;
    debug_id?: string;
    details?: Array<{ issue?: string }>;
    error?: string;
    error_description?: string;
  };
  return new PayPalApiError({
    status,
    name: body.name ?? body.error ?? `HTTP_${status}`,
    message: body.message ?? body.error_description ?? `PayPal returned HTTP ${status}.`,
    debugId: body.debug_id ?? null,
    issues: (body.details ?? []).map((d) => d.issue).filter((i): i is string => Boolean(i)),
  });
}
