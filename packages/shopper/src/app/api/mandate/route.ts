// The shopper's spending limits, with the stores she can allow.
import { withShopper } from "@/lib/shopper-route";

export const dynamic = "force-dynamic";

export async function GET() {
  return withShopper(async (api) => {
    const [{ mandate }, { stores }] = await Promise.all([api.activeMandate(), api.stores()]);
    return { mandate, stores: stores.map((s) => ({ id: s.merchantId, name: s.name })) };
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  return withShopper((api) => api.createMandate(body));
}
