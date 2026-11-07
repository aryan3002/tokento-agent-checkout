import { withShopper } from "@/lib/shopper-route";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withShopper((api) => api.startVault(id));
}
