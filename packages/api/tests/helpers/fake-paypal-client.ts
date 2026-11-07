// A stateful stand-in for the PayPal sandbox, behind the same interface as
// @tokento/paypal's client. It follows PayPal's documented behaviour for the
// calls Tokento makes: orders need buyer approval before capture, a second
// capture fails with ORDER_ALREADY_CAPTURED, and a repeated PayPal-Request-Id
// returns the first result instead of acting twice.
import { randomUUID } from 'crypto';
import { PayPalApiError } from '@tokento/paypal';
import type { CreateOrderInput, PayPalCapture, PayPalOrder, PayPalRefund } from '@tokento/paypal';

interface FakeOrder {
  id: string;
  status: PayPalOrder['status'];
  input: CreateOrderInput;
  capture?: PayPalCapture;
}

export function createFakePayPal() {
  // Test files run in parallel against one database, and PayPal ids are unique
  // columns there, so every fake instance mints ids under its own prefix.
  const prefix = randomUUID().slice(0, 8).toUpperCase();
  let seq = 0;
  const orders = new Map<string, FakeOrder>();
  const byRequestId = new Map<string, unknown>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const failures = new Map<string, PayPalApiError>();
  let captureStatus: PayPalCapture['status'] = 'COMPLETED';
  let capturedValueOverride: string | null = null;
  let signatureValid = true;

  function record(method: string, args: unknown[]) {
    calls.push({ method, args });
    const failure = failures.get(method);
    if (failure) {
      failures.delete(method);
      throw failure;
    }
  }

  function orderView(o: FakeOrder): PayPalOrder {
    return {
      id: o.id,
      status: o.status,
      links: o.status === 'COMPLETED'
        ? []
        : [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`, rel: 'payer-action', method: 'GET' }],
      purchase_units: [{
        reference_id: 'default',
        custom_id: o.input.customId,
        amount: { currency_code: 'USD', value: o.input.amount },
        payments: o.capture ? { captures: [o.capture] } : undefined,
      }],
      payment_source: { paypal: { email_address: 'maya.buyer@personal.example.com', account_id: 'QYR5Z8XDVJNXQ' } },
    };
  }

  function makeCapture(o: FakeOrder): PayPalCapture {
    seq += 1;
    return {
      id: `CAPTURE-${prefix}-${seq}`,
      status: captureStatus,
      amount: { currency_code: 'USD', value: capturedValueOverride ?? o.input.amount },
      custom_id: o.input.customId,
      invoice_id: o.input.invoiceId,
      final_capture: true,
      supplementary_data: { related_ids: { order_id: o.id } },
    };
  }

  const client = {
    env: 'sandbox' as const,

    async createOrder(input: CreateOrderInput, opts: { requestId: string }): Promise<PayPalOrder> {
      record('createOrder', [input, opts]);
      const prior = byRequestId.get(`create:${opts.requestId}`);
      if (prior) return orderView(prior as FakeOrder);
      seq += 1;
      const order: FakeOrder = { id: `PAYPAL-ORDER-${prefix}-${seq}`, status: 'PAYER_ACTION_REQUIRED', input };
      if (input.payment.kind === 'vault') {
        order.status = 'COMPLETED';
        order.capture = makeCapture(order);
      }
      orders.set(order.id, order);
      byRequestId.set(`create:${opts.requestId}`, order);
      return orderView(order);
    },

    async getOrder(orderId: string): Promise<PayPalOrder> {
      record('getOrder', [orderId]);
      const o = orders.get(orderId);
      if (!o) throw new PayPalApiError({ status: 404, name: 'RESOURCE_NOT_FOUND', message: 'Order not found', issues: ['INVALID_RESOURCE_ID'] });
      return orderView(o);
    },

    async captureOrder(orderId: string, opts: { requestId: string }): Promise<PayPalOrder> {
      record('captureOrder', [orderId, opts]);
      const prior = byRequestId.get(`capture:${opts.requestId}`);
      if (prior) return orderView(prior as FakeOrder);
      const o = orders.get(orderId);
      if (!o) throw new PayPalApiError({ status: 404, name: 'RESOURCE_NOT_FOUND', message: 'Order not found', issues: ['INVALID_RESOURCE_ID'] });
      if (o.status === 'COMPLETED') {
        throw new PayPalApiError({ status: 422, name: 'UNPROCESSABLE_ENTITY', message: 'Order already captured.', issues: ['ORDER_ALREADY_CAPTURED'], debugId: 'dbg-captured' });
      }
      if (o.status !== 'APPROVED') {
        throw new PayPalApiError({ status: 422, name: 'UNPROCESSABLE_ENTITY', message: 'Payer has not yet approved the Order for payment.', issues: ['ORDER_NOT_APPROVED'], debugId: 'dbg-not-approved' });
      }
      o.status = 'COMPLETED';
      o.capture = makeCapture(o);
      byRequestId.set(`capture:${opts.requestId}`, o);
      return orderView(o);
    },

    async refundCapture(captureId: string, input: { amount?: string; note?: string }, opts: { requestId: string }): Promise<PayPalRefund> {
      record('refundCapture', [captureId, input, opts]);
      const prior = byRequestId.get(`refund:${opts.requestId}`);
      if (prior) return prior as PayPalRefund;
      seq += 1;
      const refund: PayPalRefund = { id: `REFUND-${prefix}-${seq}`, status: 'COMPLETED' };
      byRequestId.set(`refund:${opts.requestId}`, refund);
      return refund;
    },

    async createPayoutBatch(input: { senderBatchId: string; items: Array<{ amount: string }> }) {
      record('createPayoutBatch', [input]);
      seq += 1;
      return {
        batch_header: {
          payout_batch_id: `PAYOUT-${prefix}-${seq}`,
          batch_status: 'PENDING' as const,
          sender_batch_header: { sender_batch_id: input.senderBatchId },
        },
      };
    },

    async getPayoutBatch(payoutBatchId: string) {
      record('getPayoutBatch', [payoutBatchId]);
      return { batch_header: { payout_batch_id: payoutBatchId, batch_status: 'SUCCESS' as const, sender_batch_header: { sender_batch_id: 'unknown' } } };
    },

    async createSetupToken(input: unknown, opts: { requestId: string }) {
      record('createSetupToken', [input, opts]);
      seq += 1;
      return { id: `SETUP-${prefix}-${seq}`, status: 'PAYER_ACTION_REQUIRED', links: [{ href: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=S${seq}`, rel: 'approve' }] };
    },

    async createPaymentToken(setupTokenId: string, opts: { requestId: string }) {
      record('createPaymentToken', [setupTokenId, opts]);
      return { id: `VAULT-${setupTokenId}`, customer: { id: 'customer_1' } };
    },

    async verifyWebhookSignature(input: unknown): Promise<boolean> {
      record('verifyWebhookSignature', [input]);
      return signatureValid;
    },
  };

  return {
    client,
    calls,
    callsTo: (method: string) => calls.filter((c) => c.method === method),
    /** The buyer approves the order in PayPal. */
    approve(orderId: string) {
      const o = orders.get(orderId);
      if (!o) throw new Error(`no fake order ${orderId}`);
      o.status = 'APPROVED';
    },
    order: (orderId: string) => orders.get(orderId),
    failNext(method: string, error = new PayPalApiError({ status: 503, name: 'SERVICE_UNAVAILABLE', message: 'Service unavailable', debugId: 'dbg-503' })) {
      failures.set(method, error);
    },
    setCaptureStatus(status: PayPalCapture['status']) { captureStatus = status; },
    setCapturedValue(value: string | null) { capturedValueOverride = value; },
    /** What PayPal's verify-webhook-signature answers. */
    setSignatureValid(valid: boolean) { signatureValid = valid; },
    reset() {
      orders.clear(); byRequestId.clear(); calls.length = 0; failures.clear();
      captureStatus = 'COMPLETED'; capturedValueOverride = null; signatureValid = true;
    },
  };
}

export type FakePayPal = ReturnType<typeof createFakePayPal>;
