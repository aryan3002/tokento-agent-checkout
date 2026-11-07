// ============================================================
// Webhooks: signature verification and registration
// ============================================================
import type { PayPalHttp } from './http';
import type { PayPalWebhook, VerifyWebhookInput } from './types';

const TRANSMISSION_HEADERS = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
} as const;

function headerValue(headers: VerifyWebhookInput['headers'], name: string): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.trim() ? value : null;
}

export function webhookMethods(http: PayPalHttp) {
  return {
    /**
     * Asks PayPal whether this delivery really came from PayPal for our webhook.
     * Anything short of an explicit SUCCESS is false; a missing header or webhook
     * id is false without a network call.
     */
    async verifyWebhookSignature(input: VerifyWebhookInput): Promise<boolean> {
      if (!input.webhookId) return false;
      const fields: Record<string, string> = {};
      for (const [field, header] of Object.entries(TRANSMISSION_HEADERS)) {
        const value = headerValue(input.headers, header);
        if (!value) return false;
        fields[field] = value;
      }
      const res = await http.request<{ verification_status?: string }>({
        method: 'POST',
        path: '/v1/notifications/verify-webhook-signature',
        body: { ...fields, webhook_id: input.webhookId, webhook_event: input.event },
      });
      return res.verification_status === 'SUCCESS';
    },
    createWebhook(url: string, eventTypes: string[]): Promise<PayPalWebhook> {
      return http.request({
        method: 'POST',
        path: '/v1/notifications/webhooks',
        body: { url, event_types: eventTypes.map((name) => ({ name })) },
      });
    },
    async listWebhooks(): Promise<PayPalWebhook[]> {
      const res = await http.request<{ webhooks?: PayPalWebhook[] }>({ method: 'GET', path: '/v1/notifications/webhooks' });
      return res.webhooks ?? [];
    },
    deleteWebhook(webhookId: string): Promise<unknown> {
      return http.request({ method: 'DELETE', path: `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}` });
    },
  };
}
