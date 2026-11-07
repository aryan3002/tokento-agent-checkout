"use client";

// Payouts: what Tokento owes this store for agent sales, a "Settle now" button
// that pays it through PayPal Payouts, and every payout so far in AG Grid.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import type { SettlementPreview, SettlementView } from "@tokento/shared";
import { ledgerTheme } from "./grid-theme";
import { payoutStatus, previewBreakdown } from "./payouts";
import type { StreamEvent } from "./AgentOrdersTab";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Subscribe = (listener: (event: StreamEvent) => void) => () => void;

const usd = (v: number) => `$${v.toFixed(2)}`;
const money = (p: ValueFormatterParams) => (typeof p.value === "number" ? usd(p.value) : "—");
const TONE = { success: "text-success", warning: "text-warning", error: "text-error" } as const;

function apiErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return /"message":"([^"]+)"/.exec(text)?.[1] ?? text;
}

function StatusCell({ data }: ICellRendererParams<SettlementView>) {
  if (!data) return null;
  const s = payoutStatus(data.status);
  return (
    <span title={data.error ?? undefined} className={`font-mono text-[11px] uppercase tracking-wider ${TONE[s.tone]}`}>
      {s.label}
    </span>
  );
}

export function PayoutsTab({ request, subscribe }: { request: Request; subscribe: Subscribe }) {
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [settlements, setSettlements] = useState<SettlementView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [p, list] = await Promise.all([
      request<SettlementPreview>("/api/v1/merchants/me/settlements/preview"),
      request<{ settlements: SettlementView[] }>("/api/v1/merchants/me/settlements"),
    ]);
    setPreview(p);
    setSettlements(list.settlements);
  }, [request]);

  useEffect(() => {
    let stale = false;
    Promise.all([
      request<SettlementPreview>("/api/v1/merchants/me/settlements/preview"),
      request<{ settlements: SettlementView[] }>("/api/v1/merchants/me/settlements"),
    ])
      .then(([p, list]) => {
        if (stale) return;
        setPreview(p);
        setSettlements(list.settlements);
      })
      .catch(() => {
        if (!stale) setError("Couldn't load payouts. Check that the Tokento API is running.");
      });
    return () => {
      stale = true;
    };
  }, [request]);

  useEffect(
    () =>
      subscribe(({ type }) => {
        if (type.startsWith("settlement.") || type === "checkout.completed" || type === "checkout.refunded") void refresh().catch(() => {});
      }),
    [subscribe, refresh],
  );

  async function settleNow() {
    setBusy(true);
    setError(null);
    try {
      await request<SettlementView>("/api/v1/merchants/me/settlements", { method: "POST" });
      await refresh();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const columnDefs = useMemo<ColDef<SettlementView>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Time",
        width: 150,
        sort: "desc",
        cellClass: "tabular font-mono text-xs",
        valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""),
      },
      { field: "status", headerName: "Status", width: 150, cellRenderer: StatusCell },
      { field: "orders", headerName: "Orders", width: 90, type: "rightAligned", cellClass: "tabular" },
      { field: "gross", headerName: "Paid by shoppers", width: 140, type: "rightAligned", cellClass: "tabular", valueFormatter: money },
      { field: "fees", headerName: "Tokento fees", width: 120, type: "rightAligned", cellClass: "tabular text-text-secondary", valueFormatter: (p) => (typeof p.value === "number" ? `−${usd(p.value)}` : "—") },
      {
        field: "refundAdjustments",
        headerName: "Refunds netted",
        width: 130,
        type: "rightAligned",
        cellClass: "tabular text-text-secondary",
        valueFormatter: (p) => (typeof p.value === "number" && p.value > 0 ? `−${usd(p.value)}` : "—"),
      },
      { field: "net", headerName: "Paid to store", width: 120, type: "rightAligned", cellClass: "tabular font-semibold", valueFormatter: money },
      { field: "paypalPayoutBatchId", headerName: "PayPal payout batch", width: 180, cellClass: "font-mono text-[11px]", tooltipField: "paypalPayoutBatchId" },
      { field: "receiverEmail", headerName: "Paid to", flex: 1, minWidth: 220, cellClass: "text-xs text-text-secondary" },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <section className="glass flex flex-wrap items-end justify-between gap-6 p-5">
        <div>
          <p className="folio">Owed for agent sales</p>
          {preview === null ? (
            <div className="skeleton mt-3 h-10 w-48" />
          ) : (
            <>
              <p className="tabular mt-3 text-4xl leading-none" style={{ fontFamily: "var(--font-display), Georgia, serif" }}>
                {usd(Math.max(preview.net, 0))}
              </p>
              <p className="mt-2 text-sm text-text-secondary">{previewBreakdown(preview)}</p>
              <p className="mt-1 text-xs text-text-muted">
                {preview.receiverEmail ? `Paid through PayPal Payouts to ${preview.receiverEmail}` : "Add the store's PayPal email for payouts in Settings."}
              </p>
            </>
          )}
        </div>
        <div className="text-right">
          <button
            type="button"
            disabled={busy || !preview?.payable}
            onClick={() => void settleNow()}
            className="rounded-sm bg-text-primary px-4 py-2 text-sm font-medium text-surface-1 transition-opacity disabled:opacity-40"
          >
            {busy ? "Sending payout…" : "Settle now"}
          </button>
          {error && <p className="mt-2 max-w-xs text-xs text-error">{error}</p>}
        </div>
      </section>

      <section className="glass overflow-hidden">
        <div className="px-5 pt-4 pb-3">
          <p className="folio">Payouts</p>
          <p className="mt-1 text-xs text-text-muted">One PayPal Payouts batch per settlement. Status updates from PayPal&apos;s verified payout webhooks.</p>
        </div>
        <AgGridReact<SettlementView>
          theme={ledgerTheme}
          rowData={settlements ?? undefined}
          loading={settlements === null && !error}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, resizable: true, cellDataType: false, suppressHeaderMenuButton: true, enableCellChangeFlash: true }}
          getRowId={(p) => p.data.id}
          domLayout="autoHeight"
          tooltipShowDelay={300}
          overlayNoRowsTemplate="<span>No payouts yet. Settle now sends the first one.</span>"
        />
      </section>
    </div>
  );
}
