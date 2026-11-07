"use client";

// The shopper's screen: the chat with the agent, and the wallet beside it.
// The agent itself runs on the server (/api/chat). This file renders its event
// stream, keeps the chat across reloads, and handles the PayPal round trip.
import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { PayPalProvider } from "@paypal/react-paypal-js/sdk-v6";
import type { CheckoutOrderView } from "@tokento/shared";
import type { RewardSummary, UiEvent } from "@/lib/agent/events";
import { afterPayPal, loadTranscript, redirectOutcome, saveTranscript, streamTurn, type AfterPayPal } from "@/lib/chat/client";
import { addNotice, applyEvent, emptyTranscript, startTurn, syncOrders, upsertOrder, type Entry, type Transcript } from "@/lib/chat/transcript";
import { TOOL_LABELS, usd } from "@/lib/format";
import { CheckoutCard } from "./CheckoutCard";
import { MandatePanel, type MandateData } from "./MandatePanel";
import { OfferTable } from "./OfferTable";
import { WalletPanel } from "./WalletPanel";

const SUGGESTIONS = ["Reorder my coffee beans, under $30", "What rewards do I have?", "Find me a travel mug"];

interface DemoStart {
  session: { customerId: string; name: string } | null;
  paypalClientId: string | null;
  agentConfigured: boolean;
}

type Action =
  | { type: "load"; transcript: Transcript }
  | { type: "start"; text: string }
  | { type: "event"; event: UiEvent }
  | { type: "order"; order: CheckoutOrderView }
  | { type: "sync"; orders: CheckoutOrderView[] }
  | { type: "notice"; text: string; tone: "info" | "error" };

function reducer(t: Transcript, a: Action): Transcript {
  switch (a.type) {
    case "load":
      return a.transcript;
    case "start":
      return startTurn(t, a.text);
    case "event":
      return applyEvent(t, a.event);
    case "order":
      return upsertOrder(t, a.order);
    case "sync":
      return syncOrders(t, a.orders);
    case "notice":
      return addNotice(t, a.text, a.tone);
  }
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function ShopperApp() {
  const [demo, setDemo] = useState<DemoStart | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [transcript, dispatch] = useReducer(reducer, undefined, emptyTranscript);
  const [rewards, setRewards] = useState<RewardSummary[] | null>(null);
  const [totalValue, setTotalValue] = useState<number | null>(null);
  const [orders, setOrders] = useState<CheckoutOrderView[] | null>(null);
  const [limits, setLimits] = useState<MandateData | null>(null);
  const [draft, setDraft] = useState("");

  // The conversation Claude needs next turn. A ref, so a queued message reads the latest one.
  const historyRef = useRef<Transcript["history"]>([]);
  const queueRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  // Whether this server has a model to talk to; set once the demo session starts.
  const agentReadyRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);

  const refreshSidebar = useCallback(async () => {
    const [wallet, list, mandate] = await Promise.all([
      getJson<{ rewards: RewardSummary[]; totalValue: number }>("/api/wallet"),
      getJson<{ orders: CheckoutOrderView[] }>("/api/orders"),
      getJson<MandateData>("/api/mandate"),
    ]);
    if (mandate) setLimits(mandate);
    if (wallet) {
      setRewards(wallet.rewards);
      setTotalValue(wallet.totalValue);
    }
    if (list) setOrders(list.orders);
    return list?.orders ?? null;
  }, []);

  // Messages queue up, so an automatic one (after a PayPal approval) never cuts into a reply.
  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message) return;
      queueRef.current.push(message);
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        for (let next = queueRef.current.shift(); next; next = queueRef.current.shift()) {
          dispatch({ type: "start", text: next });
          for await (const event of streamTurn((url, init) => fetch(url, init), next, historyRef.current)) {
            if (event.type === "history") historyRef.current = event.messages;
            dispatch({ type: "event", event });
          }
          const latest = await refreshSidebar();
          if (latest) dispatch({ type: "sync", orders: latest });
        }
      } finally {
        busyRef.current = false;
      }
    },
    [refreshSidebar],
  );

  const follow = useCallback(
    (result: AfterPayPal) => {
      if (result.notice) dispatch({ type: "notice", ...result.notice });
      // With chat off, the refreshed wallet and order list show the outcome instead.
      if (result.autoSend && agentReadyRef.current) void send(result.autoSend);
    },
    [send],
  );

  // Start (or resume) the demo session, restore the saved chat, then finish a PayPal redirect if there was one.
  useEffect(() => {
    let stale = false;
    (async () => {
      const res = await fetch("/api/demo", { method: "POST" });
      const data = (await res.json()) as DemoStart;
      if (stale) return;
      if (!res.ok || !data.session) throw new Error("no session");
      const saved = loadTranscript(browserStorage(), data.session.customerId);
      historyRef.current = saved.history;
      agentReadyRef.current = data.agentConfigured;
      dispatch({ type: "load", transcript: saved });
      setDemo(data);

      const latest = await refreshSidebar();
      if (stale) return;
      if (latest) dispatch({ type: "sync", orders: latest });
      const outcome = redirectOutcome(window.location.search);
      if (outcome) {
        window.history.replaceState(null, "", window.location.pathname);
        follow(afterPayPal(outcome.kind, latest?.find((o) => o.id === outcome.orderId)));
      }
    })().catch(() => {
      if (!stale) setStartError("Couldn't start the demo session. Check that the Tokento API is running, then try again.");
    });
    return () => {
      stale = true;
    };
  }, [attempt, refreshSidebar, follow]);

  const customerId = demo?.session?.customerId;
  useEffect(() => {
    if (customerId) saveTranscript(browserStorage(), customerId, transcript);
  }, [customerId, transcript]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [transcript.entries]);

  const onOrder = useCallback(
    (order: CheckoutOrderView) => {
      dispatch({ type: "order", order });
      void refreshSidebar();
    },
    [refreshSidebar],
  );
  const onPaid = useCallback((order: CheckoutOrderView) => follow(afterPayPal("paid", order)), [follow]);

  const canChat = Boolean(demo?.session && demo.agentConfigured);
  const canSend = canChat && !transcript.busy && draft.trim().length > 0;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    const text = draft;
    setDraft("");
    void send(text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  if (startError) {
    return (
      <main className="mx-auto max-w-md px-4 py-24">
        <div className="glass p-6">
          <p className="folio">Tokento Shopper</p>
          <p className="mt-2 text-text-secondary">{startError}</p>
          <button
            type="button"
            className="mt-4 rounded-sm border border-border px-3 py-1.5 text-sm hover:border-border-hover"
            onClick={() => {
              setStartError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  const name = demo?.session?.name ?? null;
  const last = transcript.entries.at(-1);
  const page = (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-end justify-between gap-4 px-4 py-5">
          <div>
            <p className="folio">Agent checkout · PayPal sandbox</p>
            <h1 className="mt-1 text-3xl">Tokento Shopper</h1>
          </div>
          <p className="pb-1 text-right text-sm text-text-secondary">
            {name ? (
              <>
                Shopping for <span className="font-medium text-text-primary">{name}</span>
              </>
            ) : (
              "Starting your session…"
            )}
          </p>
        </div>
      </header>

      {demo && !demo.agentConfigured && (
        <div className="border-b border-border bg-surface-2">
          <p className="mx-auto max-w-6xl px-4 py-2 text-sm text-text-secondary">
            Chat is off on this server: no Azure OpenAI deployment is configured. The wallet and orders still load.
          </p>
        </div>
      )}

      <main className="mx-auto grid max-w-6xl gap-8 px-4 pt-6 md:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex min-h-[calc(100vh-8rem)] flex-col" aria-label="Chat with the shopping agent">
          <div role="log" aria-live="polite" className="flex-1 space-y-4">
            {transcript.entries.length === 0 && (
              <div className="animate-slide-up max-w-xl pt-6">
                <p className="display text-2xl leading-snug">What can I buy for you{name ? `, ${name}` : ""}?</p>
                <p className="mt-2 text-text-secondary">
                  I compare stores using your rewards, pay the rest with PayPal once you approve, and the purchase earns your next reward.
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={!canChat || transcript.busy}
                      onClick={() => void send(s)}
                      className="rounded-sm border border-border bg-surface-1 px-3 py-1.5 text-sm transition-colors hover:border-border-hover disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {groupEntries(transcript.entries).map((item) =>
              Array.isArray(item) ? (
                <ToolChips key={item[0].id} tools={item} />
              ) : (
                <EntryView key={item.id} entry={item} paypalReady={Boolean(demo?.paypalClientId)} onOrder={onOrder} onPaid={onPaid} />
              ),
            )}

            {transcript.busy && last?.kind !== "assistant" && (
              <p className="flex items-center gap-2 text-sm text-text-muted">
                <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden />
                Working on it
              </p>
            )}
            <div ref={endRef} />
          </div>

          <form onSubmit={submit} className="sticky bottom-0 mt-6 bg-surface-0 pb-5 pt-2">
            <div className="flex items-end gap-2 border border-border bg-surface-1 p-2 focus-within:border-border-hover">
              <label htmlFor="chat-input" className="sr-only">
                Message the shopping agent
              </label>
              <textarea
                id="chat-input"
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={!canChat}
                placeholder={canChat ? "Ask for something, like “reorder my coffee beans”" : "Chat is unavailable"}
                className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] outline-none placeholder:text-text-muted disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!canSend}
                className="h-10 shrink-0 rounded-sm bg-text-primary px-4 text-sm font-medium text-surface-1 transition-opacity disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </form>
        </section>

        <div className="space-y-6 md:sticky md:top-6 md:self-start">
          <MandatePanel data={limits} onChanged={() => void refreshSidebar()} />
          <WalletPanel name={name ?? "Your"} rewards={rewards} totalValue={totalValue} orders={orders} />
        </div>
      </main>
    </div>
  );

  // PayPal's SDK loads only when this server has a PayPal client id; otherwise cards link to PayPal instead.
  return demo?.paypalClientId ? (
    <PayPalProvider clientId={demo.paypalClientId} environment="sandbox" components={["paypal-payments"]} pageType="checkout">
      {page}
    </PayPalProvider>
  ) : (
    page
  );
}

type ToolEntry = Extract<Entry, { kind: "tool" }>;

/** Consecutive tool calls render as one row of chips. */
function groupEntries(entries: Entry[]): (Entry | ToolEntry[])[] {
  const out: (Entry | ToolEntry[])[] = [];
  for (const e of entries) {
    const prev = out.at(-1);
    if (e.kind === "tool" && Array.isArray(prev)) prev.push(e);
    else out.push(e.kind === "tool" ? [e] : e);
  }
  return out;
}

function ToolChips({ tools }: { tools: ToolEntry[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {tools.map((t) => (
        <span
          key={t.id}
          className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[11px] ${
            t.state === "error" ? "border-error/40 text-error" : "border-border text-text-secondary"
          }`}
        >
          {t.state === "running" ? (
            <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden />
          ) : (
            <span aria-hidden>{t.state === "ok" ? "✓" : "✕"}</span>
          )}
          {TOOL_LABELS[t.name] ?? t.name}
          {t.state === "error" && <span className="sr-only"> (failed)</span>}
        </span>
      ))}
    </div>
  );
}

function EntryView({
  entry,
  paypalReady,
  onOrder,
  onPaid,
}: {
  entry: Entry;
  paypalReady: boolean;
  onOrder: (order: CheckoutOrderView) => void;
  onPaid: (order: CheckoutOrderView) => void;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <p className="max-w-[85%] whitespace-pre-wrap rounded-sm border border-border bg-surface-2 px-3 py-2 text-[15px]">{entry.text}</p>
        </div>
      );
    case "assistant":
      return <p className="max-w-[92%] whitespace-pre-wrap text-[15px] leading-relaxed">{entry.text}</p>;
    case "progress":
      return <p className="text-sm italic text-text-muted">{entry.text}</p>;
    case "offers":
      return <OfferTable quote={entry.quote} />;
    case "rewards":
      return <RewardsCard rewards={entry.rewards} />;
    case "checkout":
      return <CheckoutCard order={entry.order} paypalReady={paypalReady} onOrder={onOrder} onPaid={onPaid} />;
    case "notice":
      return <p className={`text-sm ${entry.tone === "error" ? "text-error" : "text-text-secondary"}`}>{entry.text}</p>;
    default:
      return null;
  }
}

function RewardsCard({ rewards }: { rewards: RewardSummary[] }) {
  return (
    <div className="glass animate-slide-up max-w-md p-4">
      <p className="folio">Your rewards</p>
      {rewards.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">No rewards right now.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rewards.map((r) => (
            <li key={r.rewardId} className="flex items-baseline justify-between gap-4 text-sm">
              <span>
                {r.store}
                <span className="text-text-muted">
                  {r.minimumOrder > 0 ? ` · orders ${usd(r.minimumOrder)}+` : ""} · expires {r.expiresOn}
                </span>
              </span>
              <span className="tabular font-mono text-brand-600">{usd(r.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
