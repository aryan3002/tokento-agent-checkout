// Usage: npx tsx scripts/webhook-relay.ts, then `ngrok http 4099` and register
// <ngrok url>/api/v1/paypal/webhooks with `pnpm --filter @tokento/paypal smoke webhook-register`.
import { createWebhookRelay, WEBHOOK_PATH } from '../src/dev/webhook-relay';

const port = Number(process.env.RELAY_PORT || 4099);
const target = process.env.TOKENTO_API_URL || 'http://localhost:4000';

createWebhookRelay(target).listen(port, '127.0.0.1', () => {
  console.log(`Webhook relay on http://127.0.0.1:${port}: only POST ${WEBHOOK_PATH} goes through to ${target}`);
});
