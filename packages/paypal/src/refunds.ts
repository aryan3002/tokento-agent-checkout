// ============================================================
// Payments v2: refund a capture
// ============================================================
import type { PayPalHttp } from './http';
import type { PayPalRefund, RefundInput, RequestOptions } from './types';

export function refundMethods(http: PayPalHttp) {
  return {
    /** Refunds a capture. Omit `amount` for a full refund. */
    refundCapture(captureId: string, input: RefundInput, opts: RequestOptions): Promise<PayPalRefund> {
      const body: Record<string, unknown> = {};
      if (input.amount) body.amount = { currency_code: 'USD', value: input.amount };
      if (input.note) body.note_to_payer = input.note;
      return http.request({
        method: 'POST',
        path: `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
        body,
        requestId: opts.requestId,
      });
    },
  };
}
