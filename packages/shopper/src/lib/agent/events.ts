// Events the chat route streams to the browser, one JSON object per line.
import type Anthropic from "@anthropic-ai/sdk";
import type { CheckoutOrderView, QuoteResponse } from "@tokento/shared";
import type { CatalogItem } from "../tokento";

export interface RewardSummary {
  rewardId: string;
  store: string;
  amount: number;
  minimumOrder: number;
  expiresOn: string;
}

export type UiEvent =
  | { type: "text"; delta: string }
  | { type: "progress"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean }
  | { type: "products"; products: CatalogItem[] }
  | { type: "rewards"; rewards: RewardSummary[] }
  | { type: "offers"; quote: QuoteResponse }
  | { type: "checkout"; order: CheckoutOrderView }
  | { type: "order"; order: CheckoutOrderView }
  | { type: "limits"; mandate: unknown }
  | { type: "notice"; text: string }
  | { type: "error"; message: string }
  | { type: "history"; messages: Anthropic.Beta.BetaMessageParam[] }
  | { type: "done"; stopReason: string };
