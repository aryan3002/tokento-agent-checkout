import { withShopper } from "@/lib/shopper-route";

export const dynamic = "force-dynamic";

export async function GET() {
  return withShopper((api) => api.orders());
}
