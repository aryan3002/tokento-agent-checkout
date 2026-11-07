"use client";

// The dashboard's sidebar: store, quick find (press F), pages in plain words,
// PayPal connection, theme and collapse. On phones it opens as a drawer.
import { useEffect, useRef, useState } from "react";

export type Page = "overview" | "agent-orders" | "comparisons" | "payouts" | "rewards" | "paypal-events" | "connect" | "webhooks" | "status" | "settings";
export type Theme = "system" | "light" | "dark";
export type Connection = "connecting" | "live" | "down";

const ICONS: Record<string, string> = {
  overview: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  "agent-orders": "M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4",
  comparisons: "M12 3v18M7 21h10M4 7h16M4 7l-3 7a3 3 0 0 0 6 0zM20 7l-3 7a3 3 0 0 0 6 0z",
  payouts: "M3 6h18v13H3zM3 10h18M7 15h4",
  rewards: "M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7C10 3 6 3 6 6s6 1 6 1 6 2 6-1-4-3-6 1z",
  "paypal-events": "M3 12h4l3-8 4 16 3-8h4",
  connect: "M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5",
  webhooks: "M4 12a8 8 0 0 1 16 0M8 12a4 4 0 0 1 8 0M12 12v.01",
  status: "M22 12h-4l-3 9L9 3l-3 9H2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  panel: "M3 4h18v16H3zM9 4v16",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3",
  close: "M18 6 6 18M6 6l12 12",
};

export function Icon({ name, size = 16, className = "" }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`flex-none ${className}`}>
      <path d={ICONS[name]} />
    </svg>
  );
}

interface NavItem { page: Page; label: string; meta?: string | null }

export function Sidebar(props: {
  page: Page;
  onSelect: (page: Page) => void;
  storeName: string;
  ordersCount: number | null;
  /** All-time agent comparisons that included this store. */
  comparisonsCount?: number | null;
  owedLabel: string | null;
  eventsCount: number | null;
  connection: Connection;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const { page, onSelect, collapsed, mobileOpen } = props;
  const [query, setQuery] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const wide = !collapsed || mobileOpen;

  // Press F anywhere (outside a text field) to jump to Find, like the dashboards people already know.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        findRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const main: NavItem[] = [
    { page: "overview", label: "Overview" },
    { page: "agent-orders", label: "Agent orders", meta: props.ordersCount === null ? null : String(props.ordersCount) },
    { page: "comparisons", label: "Agent comparisons", meta: props.comparisonsCount == null ? null : String(props.comparisonsCount) },
    { page: "payouts", label: "Payouts", meta: props.owedLabel },
    { page: "rewards", label: "Rewards" },
    { page: "paypal-events", label: "PayPal activity", meta: props.eventsCount === null ? null : String(props.eventsCount) },
  ];
  const developers: NavItem[] = [
    { page: "connect", label: "Connect an agent" },
    { page: "webhooks", label: "Webhooks" },
    { page: "status", label: "System status" },
  ];
  const q = query.trim().toLowerCase();
  const match = (item: NavItem) => !q || item.label.toLowerCase().includes(q);

  const go = (target: Page) => {
    onSelect(target);
    setQuery("");
    props.onCloseMobile();
  };

  const item = (it: NavItem) => {
    const active = page === it.page;
    return (
      <button
        key={it.page}
        type="button"
        onClick={() => go(it.page)}
        aria-current={active ? "page" : undefined}
        aria-label={wide ? undefined : it.label}
        title={wide ? undefined : it.label}
        className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors ${
          active ? "bg-surface-3 font-medium text-text-primary" : "text-text-muted hover:bg-surface-3 hover:text-text-primary"
        } ${wide ? "" : "justify-center"}`}
      >
        <Icon name={it.page} />
        {wide && <span className="flex-1 truncate text-left">{it.label}</span>}
        {wide && it.meta && <span className="tabular font-mono text-xs text-text-muted">{it.meta}</span>}
      </button>
    );
  };

  const live = props.connection === "live";

  return (
    <>
      {mobileOpen && <button type="button" aria-label="Close menu" onClick={props.onCloseMobile} className="fixed inset-0 z-30 bg-black/40 md:hidden" />}
      <nav
        aria-label="Dashboard"
        className={`${mobileOpen ? "fixed inset-y-0 left-0 z-40 flex w-72 shadow-xl" : "hidden md:flex"} ${
          wide ? "md:w-60" : "md:w-16"
        } shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-surface-2 p-3 transition-[width] duration-150 md:sticky md:top-0 md:h-screen`}
      >
        <div className={`flex items-center gap-2 pb-2 ${wide ? "" : "justify-center"}`}>
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden className="flex-none">
            <rect width="24" height="24" rx="6" fill="var(--text-primary)" />
            <path d="M7 8h10M12 8v9" stroke="var(--surface-0)" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
          {wide && (
            <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1">
              <span aria-hidden className="h-4 w-4 flex-none rounded-full bg-[#c2723a]" />
              <span className="truncate text-sm font-medium">{props.storeName}</span>
              <span className="rounded-full border border-border px-1.5 text-[11px] text-text-muted">Sandbox</span>
            </span>
          )}
          {mobileOpen && (
            <button type="button" onClick={props.onCloseMobile} aria-label="Close menu" className="rounded-md p-1 text-text-muted hover:bg-surface-3 md:hidden">
              <Icon name="close" />
            </button>
          )}
        </div>

        {wide && (
          <div className="relative mb-2">
            <label htmlFor="nav-find" className="sr-only">Find a page</label>
            <span className="pointer-events-none absolute left-2.5 top-2 text-text-muted"><Icon name="search" size={14} /></span>
            <input
              id="nav-find"
              ref={findRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const first = [...main, ...developers, { page: "settings" as Page, label: "Settings" }].find(match);
                if (e.key === "Enter" && first) go(first.page);
                if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); }
              }}
              placeholder="Find…"
              className="w-full rounded-md border border-border bg-surface-1 py-1.5 pl-8 pr-7 text-sm text-text-primary placeholder:text-text-muted focus:border-border-hover focus:outline-none"
            />
            <kbd className="pointer-events-none absolute right-2 top-1.5 rounded border border-border px-1.5 font-mono text-[11px] text-text-muted">F</kbd>
          </div>
        )}

        {main.filter(match).map(item)}
        {developers.some(match) && (
          <>
            {wide ? <p className="px-2 pb-1 pt-4 text-xs font-medium text-text-muted">Developers</p> : <div className="my-2 h-px bg-border" />}
            {developers.filter(match).map(item)}
          </>
        )}
        {match({ page: "settings", label: "Settings" }) && item({ page: "settings", label: "Settings" })}

        <div className="mt-auto flex flex-col gap-2 pt-4">
          {wide && (
            <div className="rounded-md border border-border bg-surface-1 p-2.5">
              <p className="flex items-center gap-2 text-[13px] font-medium">
                <span className={`dot ${live ? "dot-success" : props.connection === "down" ? "dot-error" : "dot-warning pulse-dot"}`} />
                {live ? "PayPal connected" : props.connection === "down" ? "Reconnecting…" : "Connecting…"}
              </p>
              <p className="mt-0.5 text-xs text-text-muted">Sandbox · every payment is checked with PayPal</p>
            </div>
          )}
          <div className={`flex items-center gap-1.5 ${wide ? "" : "flex-col"}`}>
            <button
              type="button"
              onClick={props.onToggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="hidden rounded-md border border-border p-1.5 text-text-muted hover:bg-surface-3 hover:text-text-primary md:block"
            >
              <Icon name="panel" size={15} />
            </button>
            <div role="group" aria-label="Theme" className={`flex rounded-full border border-border p-0.5 ${wide ? "ml-auto" : "flex-col"}`}>
              {(["system", "light", "dark"] as Theme[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => props.onTheme(t)}
                  aria-pressed={props.theme === t}
                  aria-label={`${t[0].toUpperCase()}${t.slice(1)} theme`}
                  title={`${t[0].toUpperCase()}${t.slice(1)} theme`}
                  className={`rounded-full p-1 ${props.theme === t ? "bg-surface-3 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                >
                  <Icon name={t === "system" ? "monitor" : t === "light" ? "sun" : "moon"} size={13} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </nav>
    </>
  );
}
