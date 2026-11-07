// Server-side client for the Tokento API, acting with the shopper's session.
import type { CheckoutOrderView, MandateView, QuoteResponse } from "@tokento/shared";

export class TokentoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TokentoApiError";
  }
}

export function apiBase(): string {
  return (process.env.TOKENTO_API_URL || "http://localhost:4000").replace(/\/$/, "");
}

export interface CatalogItem {
  productId: string;
  sku: string;
  name: string;
  description: string | null;
  category: string;
  price: number;
  merchantId: string;
  merchantName: string;
}

export interface WalletToken {
  id: string;
  merchantId: string;
  denomination: number;
  minimumTransactionFloor: number;
  expiryAt: string;
}

export interface Store {
  merchantId: string;
  name: string;
}

export type FetchLike = typeof fetch;

/** A Tokento API client bound to one shopper session. */
export function tokentoClient(sessionToken: string, fetchImpl: FetchLike = fetch) {
  async function call<T>(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const res = await fetchImpl(`${apiBase()}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error ?? {};
      throw new TokentoApiError(res.status, err.code ?? `http_${res.status}`, err.message ?? `Tokento returned HTTP ${res.status}.`, err.details);
    }
    return data as T;
  }

  return {
    searchProducts(params: { q?: string; maxPrice?: number; category?: string }) {
      const qs = new URLSearchParams();
      if (params.q) qs.set("q", params.q);
      if (params.maxPrice !== undefined) qs.set("maxPrice", String(params.maxPrice));
      if (params.category) qs.set("category", params.category);
      return call<{ products: CatalogItem[] }>("GET", `/catalog/search?${qs}`);
    },
    stores() {
      return call<{ stores: Store[] }>("GET", "/catalog/stores");
    },
    /** The Token Query Interface: the same wallet read any agent uses. */
    wallet() {
      return call<{ tokens: WalletToken[]; totalValue: number }>("GET", "/wallet/me/tokens");
    },
    quote(input: { productIds: string[]; quantity?: number; maxAmountToPay?: number }) {
      return call<QuoteResponse>("POST", "/checkout/quote", { body: input });
    },
    createOrder(input: { productId: string; quantity?: number; paymentMode?: "auto" | "approval"; agentReason?: string; agentId?: string }, idempotencyKey: string) {
      return call<CheckoutOrderView>("POST", "/checkout/orders", { body: input, headers: { "Idempotency-Key": idempotencyKey } });
    },
    order(id: string) {
      return call<CheckoutOrderView>("GET", `/checkout/orders/${encodeURIComponent(id)}`);
    },
    orders() {
      return call<{ orders: CheckoutOrderView[] }>("GET", "/checkout/orders");
    },
    capture(id: string) {
      return call<CheckoutOrderView>("POST", `/checkout/orders/${encodeURIComponent(id)}/capture`);
    },
    cancel(id: string) {
      return call<CheckoutOrderView>("POST", `/checkout/orders/${encodeURIComponent(id)}/cancel`);
    },
    activeMandate() {
      return call<{ mandate: MandateView | null }>("GET", "/mandates/active");
    },
    createMandate(input: { perPurchaseMax: number; monthlyCap: number; allowedMerchantIds: string[]; expiresInDays: number }) {
      return call<MandateView>("POST", "/mandates", { body: input });
    },
    revokeMandate(id: string) {
      return call<MandateView>("POST", `/mandates/${encodeURIComponent(id)}/revoke`);
    },
    startVault(id: string) {
      return call<{ approvalUrl: string; mandate: MandateView }>("POST", `/mandates/${encodeURIComponent(id)}/vault/setup`);
    },
    confirmVault(id: string) {
      return call<MandateView>("POST", `/mandates/${encodeURIComponent(id)}/vault/confirm`);
    },
  };
}

export type TokentoClient = ReturnType<typeof tokentoClient>;
