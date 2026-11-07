import { describe, expect, it } from 'vitest';
import { approvalUrlOf, captureOf, createPayPalClient, PayPalApiError } from '../src';
import {
  CAPTURE_ID,
  ORDER_ID,
  capturedOrderResponse,
  createdOrderResponse,
  fakePayPal,
} from './fake-paypal';

const creds = { clientId: 'client-abc', clientSecret: 'secret-xyz', env: 'sandbox' as const };

function clientWith(handlers: Parameters<typeof fakePayPal>[0], opts?: Parameters<typeof fakePayPal>[1], now?: () => number) {
  const fake = fakePayPal(handlers, opts);
  const client = createPayPalClient({ ...creds, fetch: fake.fetch, now });
  return { fake, client };
}

const approvalInput = {
  customId: 'c0ffee00-0000-4000-8000-000000000001',
  invoiceId: 'c0ffee00-0000-4000-8000-000000000001',
  description: 'Morning Ridge Blend, whole bean, 2 lb',
  amount: '23.00',
  currency: 'USD' as const,
  payment: {
    kind: 'approval' as const,
    returnUrl: 'http://localhost:3200/checkout/return',
    cancelUrl: 'http://localhost:3200/checkout/cancel',
    brandName: 'Coffee Co. via Tokento',
  },
};

describe('OAuth token handling', () => {
  it('reuses one token inside its lifetime and fetches a new one 60 s before it expires', async () => {
    let now = 1_000_000;
    const { fake, client } = clientWith(
      { [`GET /v2/checkout/orders/${ORDER_ID}`]: () => ({ status: 200, body: capturedOrderResponse }) },
      { tokenExpiresIn: 3600 },
      () => now,
    );

    await client.getOrder(ORDER_ID);
    await client.getOrder(ORDER_ID);
    expect(fake.tokenCalls()).toHaveLength(1);

    const tokenCall = fake.tokenCalls()[0];
    expect(tokenCall.method).toBe('POST');
    expect(tokenCall.headers.authorization).toBe(`Basic ${Buffer.from('client-abc:secret-xyz').toString('base64')}`);
    expect(tokenCall.body).toBe('grant_type=client_credentials');
    expect(fake.apiCalls()[0].headers.authorization).toBe('Bearer A21AAtoken1');

    now += (3600 - 60) * 1000 - 1; // still inside the safety margin
    await client.getOrder(ORDER_ID);
    expect(fake.tokenCalls()).toHaveLength(1);

    now += 2; // past expiry minus 60 s
    await client.getOrder(ORDER_ID);
    expect(fake.tokenCalls()).toHaveLength(2);
    expect(fake.apiCalls()[3].headers.authorization).toBe('Bearer A21AAtoken2');
  });

  it('shares one in-flight token request between concurrent calls', async () => {
    const { fake, client } = clientWith({
      [`GET /v2/checkout/orders/${ORDER_ID}`]: () => ({ status: 200, body: capturedOrderResponse }),
    });
    await Promise.all([client.getOrder(ORDER_ID), client.getOrder(ORDER_ID), client.getOrder(ORDER_ID)]);
    expect(fake.tokenCalls()).toHaveLength(1);
  });
});

describe('idempotency', () => {
  it('sends PayPal-Request-Id on create, capture, refund and both vault calls', async () => {
    const { fake, client } = clientWith({
      'POST /v2/checkout/orders': () => ({ status: 201, body: createdOrderResponse }),
      [`POST /v2/checkout/orders/${ORDER_ID}/capture`]: () => ({ status: 201, body: capturedOrderResponse }),
      [`POST /v2/payments/captures/${CAPTURE_ID}/refund`]: () => ({ status: 201, body: { id: '1JU08902781691411', status: 'COMPLETED' } }),
      'POST /v3/vault/setup-tokens': () => ({ status: 201, body: { id: '5C991763VB2781612', status: 'PAYER_ACTION_REQUIRED', links: [] } }),
      'POST /v3/vault/payment-tokens': () => ({ status: 201, body: { id: '8kk8451t', customer: { id: 'customer_4029352050' } } }),
    });

    await client.createOrder(approvalInput, { requestId: 'req-create' });
    await client.captureOrder(ORDER_ID, { requestId: 'req-capture' });
    await client.refundCapture(CAPTURE_ID, {}, { requestId: 'req-refund' });
    await client.createSetupToken(
      { returnUrl: 'http://localhost:3200/mandate/return', cancelUrl: 'http://localhost:3200/mandate/cancel', description: 'Agent purchases' },
      { requestId: 'req-setup' },
    );
    await client.createPaymentToken('5C991763VB2781612', { requestId: 'req-token' });

    expect(fake.apiCalls().map((c) => c.headers['paypal-request-id'])).toEqual([
      'req-create', 'req-capture', 'req-refund', 'req-setup', 'req-token',
    ]);
  });
});

describe('errors', () => {
  it('maps a 422 to PayPalApiError with name, debugId and issue codes', async () => {
    const { client } = clientWith({
      [`POST /v2/checkout/orders/${ORDER_ID}/capture`]: () => ({
        status: 422,
        body: {
          name: 'UNPROCESSABLE_ENTITY',
          details: [{ issue: 'ORDER_ALREADY_CAPTURED', description: 'Order already captured.' }],
          message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
          debug_id: 'f1e2d3c4b5a69',
        },
      }),
    });

    const err = await client.captureOrder(ORDER_ID, { requestId: 'r1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err).toMatchObject({ status: 422, name: 'UNPROCESSABLE_ENTITY', debugId: 'f1e2d3c4b5a69', issues: ['ORDER_ALREADY_CAPTURED'] });
  });

  it('surfaces network failures as PayPalApiError with status 0', async () => {
    const { client } = clientWith({}, { networkError: true });
    await expect(client.getOrder(ORDER_ID)).rejects.toMatchObject({ status: 0, name: 'NETWORK_ERROR' });
  });
});

describe('orders', () => {
  it('approval orders ask for PAY_NOW and NO_SHIPPING and expose the payer-action link', async () => {
    const { fake, client } = clientWith({
      'POST /v2/checkout/orders': () => ({ status: 201, body: createdOrderResponse }),
    });

    const order = await client.createOrder(approvalInput, { requestId: 'r1' });
    const body = fake.apiCalls()[0].body;

    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units[0]).toMatchObject({
      custom_id: approvalInput.customId,
      invoice_id: approvalInput.invoiceId,
      description: 'Morning Ridge Blend, whole bean, 2 lb',
      amount: { currency_code: 'USD', value: '23.00' },
    });
    expect(body.payment_source.paypal.experience_context).toMatchObject({
      user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
      return_url: 'http://localhost:3200/checkout/return',
      cancel_url: 'http://localhost:3200/checkout/cancel',
      brand_name: 'Coffee Co. via Tokento',
    });
    expect(fake.apiCalls()[0].headers.prefer).toBe('return=representation');
    expect(approvalUrlOf(order)).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`);
  });

  it('vault orders charge the saved PayPal account by vault_id, with no approval context', async () => {
    const { fake, client } = clientWith({
      'POST /v2/checkout/orders': () => ({ status: 201, body: capturedOrderResponse }),
    });

    await client.createOrder({ ...approvalInput, payment: { kind: 'vault', vaultId: '8kk8451t' } }, { requestId: 'r1' });
    expect(fake.apiCalls()[0].body.payment_source).toEqual({ paypal: { vault_id: '8kk8451t' } });
  });

  it('shows the reward as a discount in the item breakdown', async () => {
    const { fake, client } = clientWith({
      'POST /v2/checkout/orders': () => ({ status: 201, body: createdOrderResponse }),
    });

    await client.createOrder(
      {
        ...approvalInput,
        breakdown: { itemTotal: '28.00', discount: '5.00' },
        items: [{ name: 'Morning Ridge Blend, whole bean, 2 lb', quantity: 1, unitAmount: '28.00', sku: 'CC-MRB-2LB' }],
      },
      { requestId: 'r1' },
    );
    const unit = fake.apiCalls()[0].body.purchase_units[0];
    expect(unit.amount).toEqual({
      currency_code: 'USD',
      value: '23.00',
      breakdown: {
        item_total: { currency_code: 'USD', value: '28.00' },
        discount: { currency_code: 'USD', value: '5.00' },
      },
    });
    expect(unit.items).toEqual([
      {
        name: 'Morning Ridge Blend, whole bean, 2 lb',
        quantity: '1',
        unit_amount: { currency_code: 'USD', value: '28.00' },
        sku: 'CC-MRB-2LB',
        category: 'PHYSICAL_GOODS',
      },
    ]);
  });

  it('captures with an empty JSON body and captureOf returns the capture', async () => {
    const { fake, client } = clientWith({
      [`POST /v2/checkout/orders/${ORDER_ID}/capture`]: () => ({ status: 201, body: capturedOrderResponse }),
    });

    const order = await client.captureOrder(ORDER_ID, { requestId: 'r1' });
    expect(fake.apiCalls()[0].body).toEqual({});
    expect(captureOf(order)).toMatchObject({ id: CAPTURE_ID, status: 'COMPLETED', amount: { currency_code: 'USD', value: '23.00' } });
    expect(captureOf(createdOrderResponse as never)).toBeNull();
  });
});

describe('refunds', () => {
  it('refunds in full when no amount is given and partially when one is', async () => {
    const { fake, client } = clientWith({
      [`POST /v2/payments/captures/${CAPTURE_ID}/refund`]: () => ({ status: 201, body: { id: '1JU08902781691411', status: 'COMPLETED' } }),
    });

    const full = await client.refundCapture(CAPTURE_ID, { note: 'Order cancelled' }, { requestId: 'r1' });
    await client.refundCapture(CAPTURE_ID, { amount: '5.00' }, { requestId: 'r2' });

    expect(full).toMatchObject({ id: '1JU08902781691411', status: 'COMPLETED' });
    expect(fake.apiCalls()[0].body).toEqual({ note_to_payer: 'Order cancelled' });
    expect(fake.apiCalls()[1].body).toEqual({ amount: { currency_code: 'USD', value: '5.00' } });
  });
});

describe('payouts', () => {
  it('pays stores by email with sender_item_id and uses the batch id for idempotency', async () => {
    const { fake, client } = clientWith({
      'POST /v1/payments/payouts': () => ({
        status: 201,
        body: { batch_header: { payout_batch_id: '5UXD2E8A7EBQJ', batch_status: 'PENDING', sender_batch_header: { sender_batch_id: 'stl-1', email_subject: 'Tokento payout' } }, links: [] },
      }),
    });

    const batch = await client.createPayoutBatch({
      senderBatchId: 'stl-1',
      emailSubject: 'Tokento payout',
      items: [{ receiverEmail: 'coffeeco@business.example.com', amount: '22.54', currency: 'USD', senderItemId: 'stl-1-coffee', note: '1 agent order' }],
    });

    const call = fake.apiCalls()[0];
    expect(call.headers['paypal-request-id']).toBe('stl-1');
    expect(call.body).toEqual({
      sender_batch_header: { sender_batch_id: 'stl-1', email_subject: 'Tokento payout' },
      items: [{
        recipient_type: 'EMAIL',
        receiver: 'coffeeco@business.example.com',
        amount: { value: '22.54', currency: 'USD' },
        sender_item_id: 'stl-1-coffee',
        note: '1 agent order',
      }],
    });
    expect(batch.batch_header.payout_batch_id).toBe('5UXD2E8A7EBQJ');
  });
});

describe('vault', () => {
  it('asks PayPal for a merchant-initiated, single-token setup and exchanges it for a payment token', async () => {
    const { fake, client } = clientWith({
      'POST /v3/vault/setup-tokens': () => ({
        status: 201,
        body: {
          id: '5C991763VB2781612',
          customer: { id: 'customer_4029352050' },
          status: 'PAYER_ACTION_REQUIRED',
          links: [{ href: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=04J07', rel: 'approve', method: 'GET' }],
        },
      }),
      'POST /v3/vault/payment-tokens': () => ({
        status: 201,
        body: { id: '8kk8451t', customer: { id: 'customer_4029352050' }, payment_source: { paypal: { email_address: 'maya.buyer@personal.example.com' } } },
      }),
    });

    const setup = await client.createSetupToken(
      { returnUrl: 'http://localhost:3200/mandate/return', cancelUrl: 'http://localhost:3200/mandate/cancel', description: 'Purchases by your Tokento agent within your limits' },
      { requestId: 'r1' },
    );
    const token = await client.createPaymentToken(setup.id, { requestId: 'r2' });

    expect(fake.apiCalls()[0].body.payment_source.paypal).toMatchObject({
      usage_type: 'MERCHANT',
      customer_type: 'CONSUMER',
      permit_multiple_payment_tokens: false,
      description: 'Purchases by your Tokento agent within your limits',
      experience_context: {
        return_url: 'http://localhost:3200/mandate/return',
        cancel_url: 'http://localhost:3200/mandate/cancel',
        shipping_preference: 'NO_SHIPPING',
      },
    });
    expect(approvalUrlOf(setup)).toBe('https://www.sandbox.paypal.com/agreements/approve?approval_session_id=04J07');
    expect(fake.apiCalls()[1].body).toEqual({ payment_source: { token: { id: '5C991763VB2781612', type: 'SETUP_TOKEN' } } });
    expect(token.id).toBe('8kk8451t');
  });
});
