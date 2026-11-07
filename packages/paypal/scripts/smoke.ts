// ============================================================
// PayPal sandbox smoke test
// ============================================================
// Exercises each PayPal capability Tokento relies on, one step at a time, so a
// human can approve in the browser between steps. Reads PAYPAL_CLIENT_ID /
// PAYPAL_CLIENT_SECRET from the monorepo root .env. Never prints secrets.
//
//   pnpm --filter @tokento/paypal smoke <command> [args]
//
//   token                       check the credentials
//   order [amount]              create an order, print the approval link
//   get <orderId>               show an order
//   capture <orderId>           capture an approved order
//   refund <captureId>          refund a capture in full
//   payout <email> [amount]     send a Payouts batch to one email
//   payout-status <batchId>     show a Payouts batch
//   vault-setup                 start "save PayPal", print the approval link
//   vault-token <setupTokenId>  exchange an approved setup token for a vault id
//   vault-charge <vaultId> [amount]  charge a vault id with no approval
//   webhooks                    list registered webhooks
//   webhook-register <url>      register a webhook for Tokento's events
//   webhook-delete <id>         delete a webhook

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { approvalUrlOf, captureOf, createPayPalClient, PayPalApiError, toPayPalAmount } from '../src';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const TOKENTO_WEBHOOK_EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'VAULT.PAYMENT-TOKEN.CREATED',
];

const RETURN_BASE = process.env.SHOPPER_APP_URL || 'http://localhost:3200';

function client() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in the root .env');
  }
  if ((process.env.PAYPAL_ENV || 'sandbox') !== 'sandbox') {
    throw new Error('The smoke test only runs against the sandbox.');
  }
  return createPayPalClient({ clientId, clientSecret, env: 'sandbox' });
}

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing <${name}>`);
  return value;
}

const USAGE = 'Commands: token | order [amount] | get <orderId> | capture <orderId> | refund <captureId> | payout <email> [amount] | payout-status <batchId> | vault-setup | vault-token <setupTokenId> | vault-charge <vaultId> [amount] | webhooks | webhook-register <url> | webhook-delete <id>';
const COMMANDS = USAGE.replace('Commands: ', '').split(' | ').map((c) => c.split(' ')[0]);

async function main(): Promise<void> {
  const [command, arg1, arg2] = process.argv.slice(2);
  if (!command || !COMMANDS.includes(command)) {
    console.log(USAGE);
    return;
  }
  const paypal = client();

  switch (command) {
    case 'token': {
      const hooks = await paypal.listWebhooks();
      console.log(`credentials ok (sandbox), ${hooks.length} webhook(s) registered`);
      return;
    }
    case 'order': {
      const id = randomUUID();
      const amount = toPayPalAmount(arg1 ?? '1.00');
      const order = await paypal.createOrder({
        customId: id,
        invoiceId: `smoke-${id}`,
        description: 'Tokento smoke test',
        amount,
        currency: 'USD',
        payment: { kind: 'approval', returnUrl: `${RETURN_BASE}/smoke/return`, cancelUrl: `${RETURN_BASE}/smoke/cancel`, brandName: 'Tokento smoke test' },
      }, { requestId: `smoke-order-${id}` });
      console.log(`order ${order.id} status ${order.status} amount ${amount}`);
      console.log(`approve: ${approvalUrlOf(order)}`);
      return;
    }
    case 'get': {
      const order = await paypal.getOrder(need(arg1, 'orderId'));
      const cap = captureOf(order);
      console.log(`order ${order.id} status ${order.status}${cap ? ` capture ${cap.id} ${cap.status} ${cap.amount.value}` : ''}`);
      return;
    }
    case 'capture': {
      const orderId = need(arg1, 'orderId');
      const order = await paypal.captureOrder(orderId, { requestId: `smoke-capture-${orderId}` });
      const cap = captureOf(order);
      console.log(`order ${order.id} status ${order.status}`);
      console.log(`capture ${cap?.id} status ${cap?.status} amount ${cap?.amount.value} ${cap?.amount.currency_code} custom_id ${cap?.custom_id}`);
      console.log(`payer ${order.payment_source?.paypal?.email_address ?? 'unknown'}`);
      return;
    }
    case 'refund': {
      const captureId = need(arg1, 'captureId');
      const refund = await paypal.refundCapture(captureId, { note: 'Tokento smoke test refund' }, { requestId: `smoke-refund-${captureId}` });
      console.log(`refund ${refund.id} status ${refund.status} amount ${refund.amount?.value ?? 'full'}`);
      return;
    }
    case 'payout': {
      const email = need(arg1, 'email');
      const batchId = `smoke-${randomUUID()}`;
      const batch = await paypal.createPayoutBatch({
        senderBatchId: batchId,
        emailSubject: 'Tokento smoke test payout',
        items: [{ receiverEmail: email, amount: toPayPalAmount(arg2 ?? '1.00'), currency: 'USD', senderItemId: `${batchId}-1`, note: 'Smoke test' }],
      });
      console.log(`payout batch ${batch.batch_header.payout_batch_id} status ${batch.batch_header.batch_status} (sender id ${batchId})`);
      return;
    }
    case 'payout-status': {
      const batch = await paypal.getPayoutBatch(need(arg1, 'batchId'));
      console.log(`payout batch ${batch.batch_header.payout_batch_id} status ${batch.batch_header.batch_status}`);
      for (const item of batch.items ?? []) {
        console.log(`  item ${item.payout_item_id} ${item.transaction_status} ${item.payout_item.amount.value} to ${item.payout_item.receiver}${item.errors ? ` error ${item.errors.name}` : ''}`);
      }
      return;
    }
    case 'vault-setup': {
      const id = randomUUID();
      const setup = await paypal.createSetupToken({
        returnUrl: `${RETURN_BASE}/smoke/vault-return`,
        cancelUrl: `${RETURN_BASE}/smoke/vault-cancel`,
        description: 'Purchases by your Tokento agent within your limits',
        brandName: 'Tokento',
      }, { requestId: `smoke-setup-${id}` });
      console.log(`setup token ${setup.id} status ${setup.status} customer ${setup.customer?.id ?? '-'}`);
      console.log(`approve: ${approvalUrlOf(setup)}`);
      return;
    }
    case 'vault-token': {
      const setupTokenId = need(arg1, 'setupTokenId');
      const token = await paypal.createPaymentToken(setupTokenId, { requestId: `smoke-token-${setupTokenId}` });
      console.log(`vault id ${token.id} customer ${token.customer?.id ?? '-'} payer ${token.payment_source?.paypal?.email_address ?? '-'}`);
      return;
    }
    case 'vault-charge': {
      const vaultId = need(arg1, 'vaultId');
      const id = randomUUID();
      let order = await paypal.createOrder({
        customId: id,
        invoiceId: `smoke-${id}`,
        description: 'Tokento smoke test (saved PayPal)',
        amount: toPayPalAmount(arg2 ?? '1.00'),
        currency: 'USD',
        payment: { kind: 'vault', vaultId },
      }, { requestId: `smoke-vault-order-${id}` });
      console.log(`order ${order.id} status after create: ${order.status}`);
      if (order.status !== 'COMPLETED') {
        order = await paypal.captureOrder(order.id, { requestId: `smoke-vault-capture-${id}` });
        console.log(`order ${order.id} status after capture: ${order.status}`);
      }
      const cap = captureOf(order);
      console.log(`capture ${cap?.id} status ${cap?.status} amount ${cap?.amount.value}`);
      return;
    }
    case 'webhooks': {
      for (const hook of await paypal.listWebhooks()) {
        console.log(`${hook.id} ${hook.url} (${hook.event_types?.length ?? 0} events)`);
      }
      return;
    }
    case 'webhook-register': {
      const hook = await paypal.createWebhook(need(arg1, 'url'), TOKENTO_WEBHOOK_EVENTS);
      console.log(`webhook ${hook.id} -> ${hook.url}`);
      console.log('Set PAYPAL_WEBHOOK_ID to this id in the root .env');
      return;
    }
    case 'webhook-delete': {
      await paypal.deleteWebhook(need(arg1, 'id'));
      console.log('deleted');
      return;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((err: unknown) => {
  if (err instanceof PayPalApiError) {
    console.error(`PayPal error ${err.status} ${err.name}: ${err.message}${err.issues.length ? ` [${err.issues.join(', ')}]` : ''}${err.debugId ? ` (debug_id ${err.debugId})` : ''}`);
  } else {
    console.error((err as Error).message);
  }
  process.exitCode = 1;
});
