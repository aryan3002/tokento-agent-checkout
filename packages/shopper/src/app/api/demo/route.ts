// Starts (or resumes) the demo shopper's session.
// Locally this is Maya's seeded wallet through a development session. The hosted
// demo gives every visitor a fresh shopper of their own instead.
import { readAgentConfig } from "@/lib/agent/azure";
import { DEMO_CUSTOMER_ID, SHOPPER_PROFILE } from "@/lib/profile";
import { readSession, writeSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function config() {
  return {
    paypalClientId: process.env.PAYPAL_CLIENT_ID || null,
    agentConfigured: readAgentConfig(process.env) !== null,
  };
}

export async function GET() {
  const session = await readSession();
  return Response.json({ session: session ? { customerId: session.customerId, name: SHOPPER_PROFILE.name } : null, ...config() });
}

export async function POST() {
  const existing = await readSession();
  if (existing) {
    return Response.json({ session: { customerId: existing.customerId, name: SHOPPER_PROFILE.name }, ...config() });
  }
  const session = { token: `b2c_dev_session::${DEMO_CUSTOMER_ID}`, customerId: DEMO_CUSTOMER_ID };
  await writeSession(session);
  return Response.json({ session: { customerId: session.customerId, name: SHOPPER_PROFILE.name }, ...config() });
}
