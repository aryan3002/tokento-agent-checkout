"use client";

// The shopper's spending limits for agent purchases. Only she can set or turn
// them off here; the agent can read them but no tool can change them.
import { useState, type FormEvent } from "react";
import type { MandateView } from "@tokento/shared";
import { usd } from "@/lib/format";

export interface MandateData {
  mandate: MandateView | null;
  stores: { id: string; name: string }[];
}

async function send(path: string, body?: unknown): Promise<MandateView> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? "Could not save the limits.");
  return data as MandateView;
}

export function MandatePanel({ data, onChanged }: { data: MandateData | null; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mandate = data?.mandate ?? null;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await send("/api/mandate", {
        perPurchaseMax: Number(form.get("perPurchaseMax")),
        monthlyCap: Number(form.get("monthlyCap")),
        allowedMerchantIds: form.getAll("store").map(String),
        expiresInDays: Number(form.get("days")),
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function linkPayPal() {
    if (!mandate) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mandate/${mandate.id}/vault/setup`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.approvalUrl) throw new Error(body?.error?.message ?? "Could not open PayPal.");
      window.location.href = body.approvalUrl;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function turnOff() {
    if (!mandate) return;
    setBusy(true);
    setError(null);
    try {
      await send(`/api/mandate/${mandate.id}/revoke`);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass p-4">
      <div className="flex items-baseline justify-between">
        <p className="folio">Spending limits</p>
        {mandate && !editing && (
          <div className="flex gap-3 text-xs">
            <button type="button" className="ink-link text-text-secondary" onClick={() => setEditing(true)}>Change</button>
            <button type="button" className="ink-link text-text-muted disabled:opacity-50" disabled={busy} onClick={() => void turnOff()}>Turn off</button>
          </div>
        )}
      </div>

      {data === null ? (
        <div className="skeleton mt-3 h-12 rounded-sm" />
      ) : editing ? (
        <form onSubmit={save} className="mt-3 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs text-text-muted">Per purchase ($)</span>
              <input name="perPurchaseMax" type="number" min="1" step="0.01" required defaultValue={mandate?.perPurchaseMax ?? 30}
                className="tabular mt-1 w-full rounded-sm border border-border bg-surface-0 px-2 py-1 font-mono" />
            </label>
            <label className="block">
              <span className="text-xs text-text-muted">Per month ($)</span>
              <input name="monthlyCap" type="number" min="1" step="0.01" required defaultValue={mandate?.monthlyCap ?? 100}
                className="tabular mt-1 w-full rounded-sm border border-border bg-surface-0 px-2 py-1 font-mono" />
            </label>
          </div>
          <fieldset>
            <legend className="text-xs text-text-muted">Stores the agent may buy from</legend>
            <div className="mt-1 space-y-1">
              {data.stores.map((s) => (
                <label key={s.id} className="flex items-center gap-2">
                  <input type="checkbox" name="store" value={s.id}
                    defaultChecked={mandate ? mandate.allowedStores.some((a) => a.id === s.id) : true} />
                  {s.name}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="text-xs text-text-muted">For</span>
            <select name="days" defaultValue="30" className="mt-1 w-full rounded-sm border border-border bg-surface-0 px-2 py-1">
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy} className="rounded-sm bg-text-primary px-3 py-1.5 text-xs font-medium text-surface-1 disabled:opacity-50">
              {busy ? "Saving…" : "Save limits"}
            </button>
            <button type="button" className="ink-link text-xs text-text-muted" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : mandate ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="tabular font-mono">
            {usd(mandate.perPurchaseMax)} <span className="font-sans text-text-muted">per purchase</span> · {usd(mandate.monthlyCap)} <span className="font-sans text-text-muted">a month</span>
          </p>
          <div>
            <div className="h-1.5 w-full bg-surface-3">
              <div className="h-1.5 bg-brand-500" style={{ width: `${Math.min(100, (mandate.spentThisMonth / mandate.monthlyCap) * 100)}%` }} />
            </div>
            <p className="tabular mt-1 text-xs text-text-muted">{usd(mandate.spentThisMonth)} used this month · {usd(mandate.remainingThisMonth)} left</p>
          </div>
          <p className="text-xs text-text-muted">
            {mandate.allowedStores.map((s) => s.name).join(", ")} · until {mandate.expiresAt.slice(0, 10)}
          </p>
          {mandate.vault.status === "ACTIVE" ? (
            <p className="text-xs text-text-secondary">
              <span className="text-success">✓ PayPal linked.</span> Inside these limits the agent pays without a new approval; anything outside them, it asks you first.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-text-secondary">
                Inside these limits the agent goes ahead and you approve each payment in PayPal; anything outside them, it asks you first.
              </p>
              <button type="button" disabled={busy} onClick={() => void linkPayPal()}
                className="rounded-sm bg-text-primary px-3 py-1.5 text-xs font-medium text-surface-1 disabled:opacity-50">
                {busy ? "Opening PayPal…" : "Link PayPal once"}
              </button>
              <p className="text-[11px] text-text-muted">Approve once in PayPal; after that the agent pays inside these limits without asking.</p>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-text-secondary">No limits set. You approve every payment in PayPal yourself.</p>
          <button type="button" onClick={() => setEditing(true)} className="rounded-sm border border-border px-3 py-1.5 text-xs hover:border-border-hover">
            Set limits
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </section>
  );
}
