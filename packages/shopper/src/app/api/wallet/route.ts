// The shopper's rewards, read through the Token Query Interface, with store names.
import { withShopper } from "@/lib/shopper-route";

export const dynamic = "force-dynamic";

export async function GET() {
  return withShopper(async (api) => {
    const [{ tokens, totalValue }, { stores }] = await Promise.all([api.wallet(), api.stores()]);
    const names = new Map(stores.map((s) => [s.merchantId, s.name]));
    return {
      totalValue,
      rewards: tokens.map((t) => ({
        rewardId: t.id,
        store: names.get(t.merchantId) ?? "Store",
        amount: t.denomination,
        minimumOrder: t.minimumTransactionFloor,
        expiresOn: String(t.expiryAt).slice(0, 10),
      })),
    };
  });
}
