"use client";

// Overview: what AI shopping agents bought from this store, in words anyone can
// follow. How it works, the latest order as the shopper saw it, four numbers with
// what they mean, why agents pick this store, recent orders, and who did what.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentComparisonStats, CheckoutOrderView, ComparisonOutcome } from "@tokento/shared";
import { comparisonSummary } from "./agent-comparisons";
import { featuredOrder } from "./order-link";
import { maskShopper, orderStats, toOrderRow } from "./agent-orders";
import { activityFeed, orderLifecycle, relativeTime, statusTone, usd, type ActivityItem, type LifecycleStep, type Tone } from "./overview-data";
import type { Page } from "./Sidebar";
import type { StoreActivity } from "./useStoreActivity";

const HOW_KEY = "tokento.howItWorks.hidden";
const DOT: Record<Tone, string> = { success: "dot-success", warning: "dot-warning", error: "dot-error", neutral: "dot-neutral" };

function readHidden(): boolean {
  try { return localStorage.getItem(HOW_KEY) === "1"; } catch { return false; }
}

function itemName(o: CheckoutOrderView) {
  return `${o.quantity > 1 ? `${o.quantity} × ` : ""}${o.product.name}`;
}

function moneyLine(o: CheckoutOrderView): string {
  const parts = [usd(o.subtotal)];
  if (o.reward && o.reward.state !== "released") parts.push(`− ${usd(o.reward.amount)} reward`);
  const line = parts.join(" ");
  const earned = o.earned && (o.earned.state === "issued" || o.earned.state === "kept" || o.earned.state === "expected") ? ` · +${usd(o.earned.amount)} earned` : "";
  return line + earned;
}

export function OverviewPage({
  activity,
  storeName,
  shopperUrl,
  onNavigate,
  focusOrderId,
  onClearFocus,
  request,
}: {
  activity: StoreActivity;
  storeName: string;
  shopperUrl: string;
  onNavigate: (page: Page) => void;
  /** Set when the dashboard was opened from a shopper's paid order (/?order=<id>). */
  focusOrderId: string | null;
  onClearFocus: () => void;
  request: <T>(path: string) => Promise<T>;
}) {
  const { orders, events, payouts, owed, loadError } = activity;
  const [now, setNow] = useState(() => new Date());
  const [hideHow, setHideHow] = useState(false);
  // The asked-for order when it is older than the loaded list, or why it couldn't be shown.
  const [focusLoaded, setFocusLoaded] = useState<CheckoutOrderView | null>(null);
  const [focusProblem, setFocusProblem] = useState<"not_here" | "unreachable" | null>(null);
  const focusInList = Boolean(focusOrderId && orders?.some((o) => o.id === focusOrderId));

  useEffect(() => {
    if (!focusOrderId || orders === null || focusInList) return;
    let stale = false;
    request<CheckoutOrderView>(`/api/v1/merchants/me/orders/${encodeURIComponent(focusOrderId)}`)
      .then((o) => { if (!stale) { setFocusLoaded(o); setFocusProblem(null); } })
      .catch((err: Error) => { if (!stale) setFocusProblem(err.message.startsWith("404") ? "not_here" : "unreachable"); });
    return () => { stale = true; };
    // Only when the asked-for order or whether the list has it changes, not on every live update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusOrderId, orders === null, focusInList, request]);

  useEffect(() => {
    void Promise.resolve().then(() => setHideHow(readHidden()));
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const sorted = useMemo(() => [...(orders ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), [orders]);
  const featured = useMemo(() => featuredOrder(orders ?? [], focusOrderId, focusLoaded), [orders, focusOrderId, focusLoaded]);
  const focusPending = Boolean(focusOrderId && orders !== null && !featured.focused && !focusProblem);
  const stats = useMemo(() => orderStats(orders ?? []), [orders]);
  const feed = useMemo(() => activityFeed(orders ?? [], events ?? [], payouts ?? [], now), [orders, events, payouts, now]);
  const owedNet = owed?.net ?? 0;

  const hideHowItWorks = () => {
    setHideHow(true);
    try { localStorage.setItem(HOW_KEY, "1"); } catch { /* the strip just comes back next visit */ }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1160px] flex-col gap-7">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-text-muted">Everything AI shopping agents bought from {storeName}, paid with PayPal.</p>
        </div>
        <a href={shopperUrl} target="_blank" rel="noreferrer" className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm font-medium hover:bg-surface-3">
          Try it as a shopper ↗
        </a>
        <button
          type="button"
          onClick={() => onNavigate("payouts")}
          className="rounded-md border border-text-primary bg-text-primary px-3.5 py-1.5 text-sm font-medium text-surface-0 hover:opacity-90"
        >
          {owedNet > 0 ? `Get paid ${usd(owedNet)} →` : "Payouts →"}
        </button>
      </div>

      {!hideHow && (
        <section aria-labelledby="how" className="rounded-xl border border-border bg-surface-2 p-4">
          <div className="flex items-center gap-3">
            <h2 id="how" className="text-sm font-semibold">How it works</h2>
            <button type="button" onClick={hideHowItWorks} className="ml-auto text-xs text-text-muted hover:text-text-primary">Hide</button>
          </div>
          <ol className="mt-3 grid gap-3 md:grid-cols-3">
            {[
              ["1", "An AI agent shops for someone", "It compares stores for the shopper. Your rewards can make you the better deal, even when you are not the cheapest."],
              ["2", "The shopper pays with PayPal", "Tokento checks the payment with PayPal, uses the shopper's reward and gives them a new one."],
              ["3", "You get paid", "Click Settle and PayPal Payouts sends you what shoppers paid, minus Tokento's 2% fee."],
            ].map(([n, title, text]) => (
              <li key={n} className="flex gap-3 rounded-lg border border-border bg-surface-1 p-3">
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-text-primary font-mono text-xs font-medium text-surface-0">{n}</span>
                <span>
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-text-muted">{text}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {loadError && <p className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{loadError}</p>}

      {focusOrderId && focusProblem && (
        <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm">
          <span>
            {focusProblem === "not_here"
              ? `That order isn't one of ${storeName}'s. If the agent bought it from another store, it shows on that store's dashboard.`
              : "Couldn't load that order right now, so this shows the latest one."}
          </span>
          <button type="button" onClick={onClearFocus} className="ml-auto text-text-muted hover:text-text-primary">Dismiss</button>
        </p>
      )}

      {orders === null || focusPending ? (
        <div className="skeleton h-56" />
      ) : featured.order ? (
        <LatestOrder
          order={featured.order}
          focused={featured.focused}
          now={now}
          onViewAll={() => onNavigate("agent-orders")}
          onShowLatest={onClearFocus}
        />
      ) : (
        <section className="glass flex flex-col items-start gap-3 p-6">
          <h2 className="text-base font-semibold">No agent orders yet</h2>
          <p className="max-w-xl text-sm text-text-muted">
            Open the shopper and ask its agent to buy something, for example <span className="font-medium text-text-primary">“Reorder my coffee beans, under $30.”</span> The order shows up here as soon as it starts.
          </p>
          <a href={shopperUrl} target="_blank" rel="noreferrer" className="rounded-md bg-text-primary px-3.5 py-1.5 text-sm font-medium text-surface-0">Open the shopper ↗</a>
        </section>
      )}

      <section aria-label="Today in numbers" className="grid overflow-hidden rounded-xl border border-border bg-surface-1 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sales from AI agents" value={usd(stats.agentSales)} hint={`${stats.paidOrders} paid order${stats.paidOrders === 1 ? "" : "s"}, before rewards`} />
        <Stat label="Collected by PayPal" value={usd(stats.paidWithPayPal)} hint="What shoppers actually paid" />
        <Stat
          label="Rewards used / earned"
          value={<><span className="text-warning">−{usd(stats.rewardsSpent)}</span> <span className="text-text-muted">/</span> <span className="text-success">+{usd(stats.rewardsEarned)}</span></>}
          hint="Discounts you gave / new rewards that bring shoppers back"
        />
        <Stat label="Owed to you" value={usd(owedNet)} hint={owed && owed.fees > 0 ? `After ${usd(owed.fees)} Tokento fees · sent by PayPal Payouts` : "Sent to you by PayPal Payouts"} />
      </section>

      {!activity.comparisonsFailed && (
        <WhyAgentsPickYou stats={activity.comparisons} fresh={activity.comparisonsFresh} now={now} onSeeAll={() => onNavigate("comparisons")} />
      )}

      <div className="flex flex-wrap items-start gap-6">
        <section aria-labelledby="recent" className="min-w-0 flex-[999_1_560px]">
          <div className="mb-3 flex items-center">
            <h2 id="recent" className="text-base font-semibold">Recent agent orders</h2>
            <button type="button" onClick={() => onNavigate("agent-orders")} className="ml-auto text-sm text-brand-500 hover:underline">View all →</button>
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-surface-1">
            {orders === null ? (
              <div className="skeleton m-4 h-40" />
            ) : sorted.length === 0 ? (
              <p className="p-5 text-sm text-text-muted">Orders appear here live while agents shop.</p>
            ) : (
              <ul className="divide-y divide-border">
                {sorted.slice(0, 6).map((o) => <OrderRow key={o.id} order={o} now={now} />)}
              </ul>
            )}
          </div>
        </section>

        <aside aria-labelledby="activity" className="min-w-0 flex-[1_1_300px]">
          <div className="mb-3 flex items-center">
            <h2 id="activity" className="text-base font-semibold">Activity</h2>
            <button type="button" onClick={() => onNavigate("paypal-events")} className="ml-auto text-sm text-brand-500 hover:underline">PayPal activity →</button>
          </div>
          <ol className="overflow-hidden rounded-xl border border-border bg-surface-1">
            {feed.length === 0 ? (
              <li className="p-4 text-sm text-text-muted">Nothing yet today.</li>
            ) : (
              feed.map((a) => <ActivityRow key={a.id} item={a} />)
            )}
          </ol>
        </aside>
      </div>
    </div>
  );
}

const BAR: Record<ComparisonOutcome, string> = {
  won_with_rewards: "bg-success",
  won_on_price: "bg-brand-500",
  not_chosen: "bg-text-muted/60",
};

function WhyAgentsPickYou({ stats, fresh, now, onSeeAll }: { stats: AgentComparisonStats | null; fresh: boolean; now: Date; onSeeAll: () => void }) {
  if (!stats) return <div className="skeleton h-32" />;
  const summary = comparisonSummary(stats);
  const barLabel = summary.segments.map((seg) => `${seg.label}: ${seg.count}`).join(", ");
  return (
    <section aria-labelledby="why-agents" className="rounded-xl border border-border bg-surface-1 p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="why-agents" className="text-base font-semibold">Why agents pick you</h2>
        {stats.lastComparedAt && (
          <span className="text-xs text-text-muted">Last comparison {relativeTime(stats.lastComparedAt, now)}</span>
        )}
        {stats.comparisons > 0 && (
          <button type="button" onClick={onSeeAll} className="ml-auto text-sm text-brand-500 hover:underline">See every comparison →</button>
        )}
      </div>
      {/* Remounts on each new comparison so the wash replays while the agent shops. */}
      <div key={stats.comparisons} className={`-mx-2 mt-2 rounded-lg px-2 py-1 ${fresh ? "ink-wash" : ""}`} aria-live="polite">
        <p className="tabular text-xl font-semibold tracking-tight">{summary.headline}</p>
        <p className="mt-1 text-sm text-text-muted">{summary.detail}</p>
      </div>
      {!summary.empty && (
        <>
          <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={barLabel}>
            {summary.segments.filter((seg) => seg.count > 0).map((seg) => (
              <span key={seg.key} className={`${BAR[seg.key]} h-full`} style={{ width: `${seg.percent}%` }} />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
            {summary.segments.map((seg) => (
              <li key={seg.key} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 flex-none rounded-full ${BAR[seg.key]}`} aria-hidden />
                <span className="text-text-secondary">{seg.label}</span>
                <span className="tabular font-mono">{seg.count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-3 text-xs text-text-muted">Counts only. Other stores&apos; names and prices stay private.</p>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className="border-b border-border p-4 sm:border-r lg:border-b-0 [&:last-child]:border-r-0">
      <p className="text-[13px] text-text-muted">{label}</p>
      <p className="tabular mt-1 font-mono text-2xl font-medium tracking-tight">{value}</p>
      <p className="mt-1.5 text-xs leading-snug text-text-muted">{hint}</p>
    </div>
  );
}

function LatestOrder({
  order,
  focused,
  now,
  onViewAll,
  onShowLatest,
}: {
  order: CheckoutOrderView;
  /** Opened from the shopper's paid order: outlined, labelled, scrolled into view. */
  focused: boolean;
  now: Date;
  onViewAll: () => void;
  onShowLatest: () => void;
}) {
  const row = toOrderRow(order);
  const tone = statusTone(order.status);
  const steps = orderLifecycle(order);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused, order.id]);
  return (
    <section
      ref={ref}
      aria-labelledby="latest"
      className={`glass overflow-hidden ${focused ? "ring-2 ring-brand-500 ring-offset-2 ring-offset-surface-0" : ""}`}
    >
      {focused && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-brand-500/10 px-5 py-2 text-[13px]">
          <span className="font-medium">Opened from the shopper</span>
          <span className="text-text-muted">This is the order they just paid for, as your store sees it.</span>
          <button type="button" onClick={onShowLatest} className="ml-auto text-brand-500 hover:underline">Show latest order</button>
        </div>
      )}
      <div className="flex flex-wrap">
        <div className="min-w-0 flex-[1_1_320px] border-b border-border bg-surface-2 p-5 md:border-b-0 md:border-r">
          <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-sm">
            <p className="text-xs text-text-muted">What the shopper saw</p>
            <p className="mt-1.5 font-medium">{itemName(order)}</p>
            <dl className="tabular mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-text-muted">Price</dt><dd className="font-mono">{usd(order.subtotal)}</dd>
              {order.reward && (<><dt className="text-text-muted">{order.merchant.name} reward</dt><dd className="font-mono text-warning">−{usd(order.reward.amount)}</dd></>)}
              <dt className="border-t border-border pt-1.5 font-medium">Paid with PayPal</dt><dd className="border-t border-border pt-1.5 font-mono font-medium">{usd(order.amountToPay)}</dd>
              {order.earned && order.earned.state !== "voided" && (<><dt className="text-text-muted">Reward earned</dt><dd className="font-mono text-success">+{usd(order.earned.amount)}</dd></>)}
            </dl>
            {order.agentReason && <p className="mt-3 text-[13px] leading-snug text-text-muted">“{order.agentReason}”</p>}
          </div>
        </div>
        <div className="flex min-w-0 flex-[1.4_1_380px] flex-col gap-4 p-5">
          <div className="flex items-center gap-2">
            <h2 id="latest" className="text-base font-semibold">{focused ? "Agent order" : "Latest agent order"}</h2>
            <button type="button" onClick={onViewAll} className="ml-auto rounded-md border border-border bg-surface-1 px-2.5 py-1 text-[13px] font-medium hover:bg-surface-3">All orders</button>
          </div>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
            <Field label="Status"><span className="flex items-center gap-2"><span className={`dot ${DOT[tone]} ${tone === "warning" ? "pulse-dot" : ""}`} />{row.statusLabel}</span></Field>
            <Field label="When">{relativeTime(order.createdAt, now)}</Field>
            <Field label="Shopper"><span className="font-mono text-[13px]">{maskShopper(order.customerId)}</span></Field>
            <Field label="How they paid">{order.paymentMode === "vault" ? "Saved PayPal, no approval needed" : "Approved in PayPal"}</Field>
            <Field label="PayPal order"><span className="font-mono text-[13px] break-all">{order.paypal.orderId ?? "—"}</span></Field>
            <Field label="Payout">{row.settlementLabel === "—" ? "Not yet" : row.settlementLabel}</Field>
          </dl>
          <div>
            <p className="mb-2 text-[13px] text-text-muted">Step by step</p>
            <ol className="flex flex-wrap gap-1.5">
              {steps.map((s) => <StepPill key={s.label} step={s} />)}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

function StepPill({ step }: { step: LifecycleStep }) {
  const dot = step.state === "done" ? "dot-success" : step.state === "current" ? "dot-warning pulse-dot" : "dot-neutral";
  const text = step.state === "todo" || step.state === "off" ? "text-text-muted" : "text-text-primary";
  return (
    <li className={`flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-[12.5px] ${text}`}>
      <span className={`dot ${dot}`} />
      {step.label}
      <span className="sr-only">{step.state === "done" ? "(done)" : step.state === "current" ? "(happening now)" : step.state === "off" ? "(stopped)" : "(not yet)"}</span>
    </li>
  );
}

function OrderRow({ order, now }: { order: CheckoutOrderView; now: Date }) {
  const row = toOrderRow(order);
  const tone = statusTone(order.status);
  return (
    <li className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_auto] items-center gap-4 px-4 py-3 sm:grid-cols-[150px_minmax(0,1.6fr)_90px_minmax(0,1fr)]">
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm"><span className={`dot ${DOT[tone]} ${tone === "warning" ? "pulse-dot" : ""}`} />{row.statusLabel}</span>
        <span className="block text-xs text-text-muted">{order.paymentMode === "vault" ? "Saved PayPal" : "PayPal approval"}</span>
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm">{itemName(order)}</span>
        <span className="block truncate text-xs text-text-muted">{moneyLine(order)}</span>
      </span>
      {order.status === "CANCELLED" || order.status === "FAILED" ? (
        <span className="text-right text-xs text-text-muted">Not charged</span>
      ) : (
        <span className="tabular text-right font-mono text-sm font-medium">{usd(order.amountToPay)}</span>
      )}
      <span className="hidden text-right text-[13px] text-text-muted sm:block">
        {relativeTime(order.createdAt, now)} · <span className="font-mono text-text-primary">{maskShopper(order.customerId)}</span>
      </span>
    </li>
  );
}

const ACTOR: Record<ActivityItem["actor"], { initials: string; label: string; className: string }> = {
  agent: { initials: "AI", label: "Shopping agent", className: "bg-brand-100 text-brand-700" },
  paypal: { initials: "PP", label: "PayPal", className: "bg-surface-4 text-text-primary" },
  you: { initials: "You", label: "You", className: "bg-success/15 text-success" },
};

function ActivityRow({ item }: { item: ActivityItem }) {
  const actor = ACTOR[item.actor];
  return (
    <li className="flex gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <span aria-label={actor.label} role="img" className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-[10px] font-semibold ${actor.className}`}>{actor.initials}</span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-snug">{item.text}</span>
        <span className="block text-xs text-text-muted">{item.ago}</span>
      </span>
    </li>
  );
}
