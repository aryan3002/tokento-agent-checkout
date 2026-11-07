// ============================================================
// Vault v3: save PayPal once, charge later without a new approval
// ============================================================
import type { PayPalHttp } from './http';
import type { CreateSetupTokenInput, PayPalPaymentToken, PayPalSetupToken, RequestOptions } from './types';

export function vaultMethods(http: PayPalHttp) {
  return {
    /** Starts "save PayPal without a purchase". The buyer approves at the returned `approve` link. */
    createSetupToken(input: CreateSetupTokenInput, opts: RequestOptions): Promise<PayPalSetupToken> {
      return http.request({
        method: 'POST',
        path: '/v3/vault/setup-tokens',
        requestId: opts.requestId,
        body: {
          payment_source: {
            paypal: {
              description: input.description,
              usage_type: 'MERCHANT',
              customer_type: 'CONSUMER',
              permit_multiple_payment_tokens: false,
              experience_context: {
                return_url: input.returnUrl,
                cancel_url: input.cancelUrl,
                ...(input.brandName ? { brand_name: input.brandName } : {}),
                shipping_preference: 'NO_SHIPPING',
                locale: 'en-US',
              },
            },
          },
        },
      });
    },
    /** Exchanges an approved setup token for a reusable payment token (the vault id). */
    createPaymentToken(setupTokenId: string, opts: RequestOptions): Promise<PayPalPaymentToken> {
      return http.request({
        method: 'POST',
        path: '/v3/vault/payment-tokens',
        requestId: opts.requestId,
        body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
      });
    },
    deletePaymentToken(paymentTokenId: string): Promise<unknown> {
      return http.request({ method: 'DELETE', path: `/v3/vault/payment-tokens/${encodeURIComponent(paymentTokenId)}` });
    },
  };
}
