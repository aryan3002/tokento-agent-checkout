import { describe, expect, it } from 'vitest';
import { createPayPalClient } from '../src';
import { fakePayPal } from './fake-paypal';

const creds = { clientId: 'client-abc', clientSecret: 'secret-xyz', env: 'sandbox' as const };

// Headers as Express hands them over: lower-cased.
const transmission = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
  'paypal-transmission-id': '103e3700-8b0c-11e6-8695-6b62a8a99ac4',
  'paypal-transmission-sig': 't8hlRk64rpEImZMKqgtp5dlWaT1W8ed/mf8Msos341QInVn3BMQubjAhM/cxiSJtKEP1D0QLZ8LXmuNE3GIDQA==',
  'paypal-transmission-time': '2026-11-07T18:00:01Z',
};

const event = {
  id: 'WH-58D329510W468432D-8HN650336L201105X',
  event_version: '1.0',
  create_time: '2026-11-07T18:00:00.000Z',
  resource_type: 'capture',
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  summary: 'Payment completed for $ 23.0 USD',
  resource: { id: '3C679366HH908993F', status: 'COMPLETED', amount: { currency_code: 'USD', value: '23.00' }, custom_id: 'c0ffee00-0000-4000-8000-000000000001' },
};

function clientAnswering(status: 'SUCCESS' | 'FAILURE') {
  const fake = fakePayPal({
    'POST /v1/notifications/verify-webhook-signature': () => ({ status: 200, body: { verification_status: status } }),
  });
  return { fake, client: createPayPalClient({ ...creds, fetch: fake.fetch }) };
}

describe('verifyWebhookSignature', () => {
  it('sends the five transmission headers, our webhook id and the event, and trusts only SUCCESS', async () => {
    const { fake, client } = clientAnswering('SUCCESS');

    const ok = await client.verifyWebhookSignature({ headers: transmission, event, webhookId: '1JE4291016473214C' });

    expect(ok).toBe(true);
    expect(fake.apiCalls()[0].body).toEqual({
      auth_algo: 'SHA256withRSA',
      cert_url: transmission['paypal-cert-url'],
      transmission_id: transmission['paypal-transmission-id'],
      transmission_sig: transmission['paypal-transmission-sig'],
      transmission_time: transmission['paypal-transmission-time'],
      webhook_id: '1JE4291016473214C',
      webhook_event: event,
    });
  });

  it('returns false when PayPal answers FAILURE', async () => {
    const { client } = clientAnswering('FAILURE');
    await expect(client.verifyWebhookSignature({ headers: transmission, event, webhookId: '1JE4291016473214C' })).resolves.toBe(false);
  });

  it('returns false without asking PayPal when a transmission header is missing', async () => {
    const { fake, client } = clientAnswering('SUCCESS');
    const { ['paypal-transmission-sig']: _dropped, ...partial } = transmission;

    await expect(client.verifyWebhookSignature({ headers: partial, event, webhookId: '1JE4291016473214C' })).resolves.toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('returns false when no webhook id is configured', async () => {
    const { fake, client } = clientAnswering('SUCCESS');
    await expect(client.verifyWebhookSignature({ headers: transmission, event, webhookId: '' })).resolves.toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('webhook registration', () => {
  it('registers a URL for the given event types', async () => {
    const fake = fakePayPal({
      'POST /v1/notifications/webhooks': () => ({ status: 201, body: { id: '0EH40505U7160970P', url: 'https://abc.ngrok.app/api/v1/paypal/webhooks', event_types: [] } }),
    });
    const client = createPayPalClient({ ...creds, fetch: fake.fetch });

    const hook = await client.createWebhook('https://abc.ngrok.app/api/v1/paypal/webhooks', ['PAYMENT.CAPTURE.COMPLETED', 'CHECKOUT.ORDER.APPROVED']);

    expect(hook.id).toBe('0EH40505U7160970P');
    expect(fake.apiCalls()[0].body).toEqual({
      url: 'https://abc.ngrok.app/api/v1/paypal/webhooks',
      event_types: [{ name: 'PAYMENT.CAPTURE.COMPLETED' }, { name: 'CHECKOUT.ORDER.APPROVED' }],
    });
  });
});
