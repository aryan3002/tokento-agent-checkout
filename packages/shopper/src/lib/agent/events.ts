// Events the chat route streams to the browser, one JSON object per line.
import type OpenAI from "openai";
import type { CheckoutOrderView, QuoteResponse } from "@tokento/shared";
import type { CatalogItem } from "../tokento";

/** The conversation the model needs next turn, kept by the browser (append-only). */
export type AgentHistory = OpenAI.Responses.ResponseInputItem[];

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
  | { type: "history"; messages: AgentHistory }
  | { type: "done"; stopReason: string };
