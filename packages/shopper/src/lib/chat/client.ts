// Browser-side plumbing for the chat page: the saved conversation, one streamed
// agent turn, and the round trip through PayPal's return and cancel pages.
// No React here, so all of it runs under plain unit tests.
import type { CheckoutOrderView } from "@tokento/shared";
import type { AgentHistory, UiEvent } from "../agent/events";
import { readNdjson } from "./ndjson";
import { emptyTranscript, type Transcript } from "./transcript";

/** What the chat sends for the shopper after they approve in PayPal, so the agent checks the order. */
export const APPROVED_MESSAGE = "I approved the payment in PayPal.";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURN_FAILED: UiEvent = { type: "done", stopReason: "error" };

export function transcriptKey(customerId: string): string {
  return `tokento.shopper.chat.v2.${customerId}`;
}

/** The shopper's saved chat. Storage can be blocked or hold junk; then the chat starts empty. */
export function loadTranscript(store: KeyValueStore | null | undefined, customerId: string): Transcript {
  try {
    const raw = store?.getItem(transcriptKey(customerId));
    if (!raw) return emptyTranscript();
    const saved = JSON.parse(raw) as Partial<Transcript>;
    if (!Array.isArray(saved.entries) || !Array.isArray(saved.history)) return emptyTranscript();
    return { entries: saved.entries, history: saved.history, busy: false };
  } catch {
    return emptyTranscript();
  }
}

export function saveTranscript(store: KeyValueStore | null | undefined, customerId: string, t: Transcript): void {
  try {
    store?.setItem(transcriptKey(customerId), JSON.stringify({ entries: t.entries, history: t.history }));
  } catch {
    // Private mode or a full quota: the chat still works, it just won't survive a reload.
  }
}

/** One agent turn. Every way it can fail still ends with a `done`, so the input never stays locked. */
export async function* streamTurn(
  fetchImpl: Fetch,
  message: string,
  history: AgentHistory,
): AsyncGenerator<UiEvent> {
  let res: Response;
  try {
    res = await fetchImpl("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
  } catch {
    yield { type: "error", message: "Couldn't reach the shopping agent. Check your connection and try again." };
    yield TURN_FAILED;
    return;
  }

  if (!res.ok || !res.body) {
    yield { type: "error", message: await failureMessage(res) };
    yield TURN_FAILED;
    return;
  }

  let finished = false;
  try {
    for await (const event of readNdjson(res.body)) {
      const e = event as UiEvent;
      if (e.type === "done") finished = true;
      yield e;
    }
  } catch {
    // The connection dropped mid-reply; handled below.
  }
  if (!finished) {
    yield { type: "error", message: "The reply was cut off. Please try again." };
    yield TURN_FAILED;
  }
}

async function failureMessage(res: Response): Promise<string> {
  if (res.status === 401) return "Your shopping session ended. Reload the page to start a new one.";
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return data?.error?.message ?? "The shopping agent couldn't answer. Please try again.";
}

export type RedirectOutcome = { kind: "paid" | "cancelled"; orderId: string };

/** `/?paid=<id>` or `/?cancelled=<id>`, set by the PayPal return and cancel pages. */
export function redirectOutcome(search: string): RedirectOutcome | null {
  const params = new URLSearchParams(search);
  for (const kind of ["paid", "cancelled"] as const) {
    const id = params.get(kind);
    if (id && UUID.test(id)) return { kind, orderId: id };
  }
  return null;
}

/**
 * PayPal sends the shopper to /checkout/return or /checkout/cancel with `?checkout=<our order id>`.
 * Capture or cancel, then go back to the chat, which re-reads the order and shows its real status.
 */
export async function finishRedirect(page: "return" | "cancel", search: string, fetchImpl: Fetch): Promise<string> {
  const id = new URLSearchParams(search).get("checkout");
  if (!id || !UUID.test(id)) return "/";
  try {
    await fetchImpl(`/api/orders/${id}/${page === "return" ? "capture" : "cancel"}`, { method: "POST" });
  } catch {
    // The chat shows the order's real status either way.
  }
  return page === "return" ? `/?paid=${id}` : `/?cancelled=${id}`;
}

export type AfterPayPal = { autoSend?: string; notice?: { text: string; tone: "info" | "error" } };

/** What the chat does once the shopper is back from PayPal, based on the order's real status. */
export function afterPayPal(kind: RedirectOutcome["kind"], order: CheckoutOrderView | undefined): AfterPayPal {
  if (!order) return {};
  if (kind === "paid") {
    if (order.status === "CREATED" || order.status === "APPROVED") {
      return { notice: { tone: "error", text: "You approved in PayPal, but the payment didn't go through yet. Try the PayPal button again." } };
    }
    return { autoSend: APPROVED_MESSAGE };
  }
  if (order.status !== "CANCELLED") return {};
  return {
    notice: {
      tone: "info",
      text: order.reward
        ? "You cancelled in PayPal. Nothing was charged, and your reward is back in your wallet."
        : "You cancelled in PayPal. Nothing was charged.",
    },
  };
}
