// What the chat shows, built from the agent's event stream. Pure functions so
// the UI state can be tested without a browser.
import type Anthropic from "@anthropic-ai/sdk";
import type { CheckoutOrderView, QuoteResponse } from "@tokento/shared";
import type { RewardSummary, UiEvent } from "../agent/events";

export type Entry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "progress"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; state: "running" | "ok" | "error" }
  | { kind: "offers"; id: string; quote: QuoteResponse }
  | { kind: "rewards"; id: string; rewards: RewardSummary[] }
  | { kind: "checkout"; id: string; order: CheckoutOrderView }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" };

export interface Transcript {
  entries: Entry[];
  /** The conversation as Claude needs it next turn (append-only). */
  history: Anthropic.Beta.BetaMessageParam[];
  busy: boolean;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function emptyTranscript(): Transcript {
  return { entries: [], history: [], busy: false };
}

export function startTurn(t: Transcript, text: string): Transcript {
  return { ...t, busy: true, entries: [...t.entries, { kind: "user", id: nextId("u"), text }] };
}

/** Insert or update the checkout card for this order, wherever it is in the chat. */
export function upsertOrder(t: Transcript, order: CheckoutOrderView): Transcript {
  const index = t.entries.findIndex((e) => e.kind === "checkout" && e.order.id === order.id);
  if (index === -1) return { ...t, entries: [...t.entries, { kind: "checkout", id: nextId("c"), order }] };
  const entries = [...t.entries];
  entries[index] = { ...(entries[index] as Extract<Entry, { kind: "checkout" }>), order };
  return { ...t, entries };
}

/** Bring checkout cards already in the chat up to date (after a reload or the PayPal redirect). */
export function syncOrders(t: Transcript, orders: CheckoutOrderView[]): Transcript {
  const latest = new Map(orders.map((o) => [o.id, o]));
  return {
    ...t,
    entries: t.entries.map((e) => {
      const fresh = e.kind === "checkout" ? latest.get(e.order.id) : undefined;
      return fresh ? { ...(e as Extract<Entry, { kind: "checkout" }>), order: fresh } : e;
    }),
  };
}

export function addNotice(t: Transcript, text: string, tone: "info" | "error"): Transcript {
  return { ...t, entries: [...t.entries, { kind: "notice", id: nextId("n"), text, tone }] };
}

export function applyEvent(t: Transcript, e: UiEvent): Transcript {
  switch (e.type) {
    case "text": {
      const last = t.entries.at(-1);
      if (last?.kind === "assistant") {
        return { ...t, entries: [...t.entries.slice(0, -1), { ...last, text: last.text + e.delta }] };
      }
      return { ...t, entries: [...t.entries, { kind: "assistant", id: nextId("a"), text: e.delta }] };
    }
    case "progress":
      return { ...t, entries: [...t.entries, { kind: "progress", id: nextId("p"), text: e.text }] };
    case "tool_start":
      return { ...t, entries: [...t.entries, { kind: "tool", id: e.id, name: e.name, state: "running" }] };
    case "tool_result":
      return {
        ...t,
        entries: t.entries.map((entry) => (entry.kind === "tool" && entry.id === e.id ? { ...entry, state: e.ok ? "ok" : "error" } : entry)),
      };
    case "offers":
      return { ...t, entries: [...t.entries, { kind: "offers", id: nextId("o"), quote: e.quote }] };
    case "rewards":
      return { ...t, entries: [...t.entries, { kind: "rewards", id: nextId("r"), rewards: e.rewards }] };
    case "checkout":
    case "order":
      return upsertOrder(t, e.order);
    case "notice":
      return addNotice(t, e.text, "info");
    case "error":
      return addNotice(t, e.message, "error");
    case "history":
      return { ...t, history: e.messages };
    case "done":
      return { ...t, busy: false };
    default:
      return t;
  }
}
