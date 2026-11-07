// ============================================================
// Payouts v1: pay stores
// ============================================================
import type { PayPalHttp } from './http';
import type { CreatePayoutBatchInput, PayPalPayoutBatch } from './types';

export function payoutMethods(http: PayPalHttp) {
  return {
    createPayoutBatch(input: CreatePayoutBatchInput): Promise<PayPalPayoutBatch> {
      return http.request({
        method: 'POST',
        path: '/v1/payments/payouts',
        requestId: input.senderBatchId,
        body: {
          sender_batch_header: { sender_batch_id: input.senderBatchId, email_subject: input.emailSubject },
          items: input.items.map((item) => ({
            recipient_type: 'EMAIL',
            receiver: item.receiverEmail,
            amount: { value: item.amount, currency: item.currency },
            sender_item_id: item.senderItemId,
            ...(item.note ? { note: item.note } : {}),
          })),
        },
      });
    },
    getPayoutBatch(payoutBatchId: string): Promise<PayPalPayoutBatch> {
      return http.request({ method: 'GET', path: `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}` });
    },
  };
}
