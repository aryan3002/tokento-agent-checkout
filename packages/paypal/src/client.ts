// ============================================================
// PayPal client
// ============================================================
import { createHttp } from './http';
import { orderMethods } from './orders';
import { payoutMethods } from './payouts';
import { refundMethods } from './refunds';
import { vaultMethods } from './vault';
import { webhookMethods } from './webhooks';
import type { PayPalClientConfig } from './types';

export function createPayPalClient(config: PayPalClientConfig) {
  if (!config.clientId || !config.clientSecret) {
    throw new Error('PayPal client id and secret are required.');
  }
  const http = createHttp(config);
  return {
    env: config.env,
    ...orderMethods(http),
    ...refundMethods(http),
    ...payoutMethods(http),
    ...vaultMethods(http),
    ...webhookMethods(http),
  };
}

export type PayPalClient = ReturnType<typeof createPayPalClient>;
