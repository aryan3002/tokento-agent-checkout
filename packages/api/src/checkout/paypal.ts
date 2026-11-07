// ============================================================
// Tokento — PayPal client for the API
// ============================================================
import { createPayPalClient, type PayPalClient } from '@tokento/paypal';
import { AppError } from '../middleware/error.middleware';

let client: PayPalClient | null = null;

/** The configured PayPal client. Sandbox only: this deployment never touches live money. */
export function getPayPal(): PayPalClient {
  if (client) return client;
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AppError(503, 'paypal_not_configured', 'PayPal is not configured on this server.');
  }
  if ((process.env.PAYPAL_ENV || 'sandbox') !== 'sandbox') {
    throw new AppError(503, 'paypal_live_disabled', 'Only the PayPal sandbox is supported.');
  }
  client = createPayPalClient({ clientId, clientSecret, env: 'sandbox' });
  return client;
}

/** Where PayPal sends the shopper back after approving or cancelling. */
export function shopperAppUrl(): string {
  return (process.env.SHOPPER_APP_URL || 'http://localhost:3200').replace(/\/$/, '');
}
