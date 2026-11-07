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

/** Hosted demo: each visitor gets a fresh shopper of their own from Tokento. */
async function hostedShopper(): Promise<{ token: string; customerId: string } | null> {
  const base = (process.env.TOKENTO_API_URL || "http://localhost:4000").replace(/\/$/, "");
  const res = await fetch(`${base}/api/v1/demo/shoppers`, { method: "POST" }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json()) as { token: string; customerId: string };
  return { token: body.token, customerId: body.customerId };
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
  const session = process.env.TOKENTO_DEMO_HOSTED === "true" ? await hostedShopper() : { token: `b2c_dev_session::${DEMO_CUSTOMER_ID}`, customerId: DEMO_CUSTOMER_ID };
  if (!session) return Response.json({ error: { code: "demo_unavailable", message: "Couldn't start a demo shopper. Try again." } }, { status: 503 });
  await writeSession(session);
  return Response.json({ session: { customerId: session.customerId, name: SHOPPER_PROFILE.name }, ...config() });
}
