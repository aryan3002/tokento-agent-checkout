"use client";

// Agent orders: every purchase a shopping agent made at this store through
// PayPal, live. The first load fills the grid; after that each checkout or
// PayPal event re-reads that one order and applies it as an AG Grid
// transaction, so changed cells flash and the pinned totals row follows.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type ValueFormatterParams,
} from "ag-grid-community";
import type { CheckoutOrderView, PayPalEventView } from "@tokento/shared";
import {
  eventFromStream,
  orderStats,
  orderTotals,
  prependEvent,
  toOrderRow,
  upsertById,
  type AgentOrderRow,
  type PayPalWebhookMessage,
} from "./agent-orders";
import { PayPalEventsFeed } from "./PayPalEventsFeed";

ModuleRegistry.registerModules([AllCommunityModule]);

// The dashboard's ledger palette: paper, ink, one terracotta accent.
const ledgerTheme = themeQuartz.withParams({
  browserColorScheme: "light",
  backgroundColor: "#faf7f0",
  foregroundColor: "#0f0f0e",
  borderColor: "#d6cfbf",
  accentColor: "#b85042",
  headerBackgroundColor: "#efe9dc",
  headerTextColor: "#6b6759",
  oddRowBackgroundColor: "#f5f1e8",
  rowHoverColor: "#efe9dc",
  pinnedRowBackgroundColor: "#efe9dc",
  pinnedRowFontWeight: 600,
  valueChangeValueHighlightBackgroundColor: "rgba(184, 80, 66, 0.22)",
  fontFamily: "var(--font-body), ui-sans-serif, system-ui, sans-serif",
  headerFontFamily: "var(--font-mono-ui), ui-monospace, monospace",
  fontSize: 13,
  headerFontSize: 11,
  wrapperBorderRadius: 2,
  borderRadius: 2,
});

export type StreamEvent = { type: string; payload: Record<string, unknown> };
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Subscribe = (listener: (event: StreamEvent) => void) => () => void;

const usd = (value: number) => `$${value.toFixed(2)}`;
const money = (p: ValueFormatterParams) => (typeof p.value === "number" ? usd(p.value) : "—");

function apiErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return /"message":"([^"]+)"/.exec(text)?.[1] ?? text;
}

function statusTone(status: AgentOrderRow["status"]): string {
  if (status === "COMPLETED") return "text-success";
  if (status === "FAILED" || status === "NEEDS_REVIEW") return "text-error";
  if (status === "REFUNDED" || status === "CANCELLED") return "text-text-muted";
  return "text-warning";
}

function StatusCell({ data, node }: ICellRendererParams<AgentOrderRow>) {
  if (!data || node.rowPinned) return null;
  return <span className={`font-mono text-[11px] uppercase tracking-wider ${statusTone(data.status)}`}>{data.statusLabel}</span>;
}

function RefundCell({ data, node, onRefund }: ICellRendererParams<AgentOrderRow> & { onRefund: (id: string) => Promise<void> }) {
  const [step, setStep] = useState<"idle" | "confirm" | "working">("idle");
  if (!data || node.rowPinned || !data.canRefund) return null;
  if (step === "confirm") {
    return (
      <span className="flex gap-3 text-xs">
        <button
          type="button"
          className="font-medium text-error"
          onClick={async () => {
            setStep("working");
            await onRefund(data.id);
            setStep("idle");
          }}
        >
          Confirm refund
        </button>
        <button type="button" className="text-text-muted" onClick={() => setStep("idle")}>
          Keep
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={step === "working"}
      onClick={() => setStep("confirm")}
      className="rounded-sm border border-border px-2 py-0.5 text-xs hover:border-border-hover disabled:opacity-50"
    >
      {step === "working" ? "Refunding…" : "Refund"}
    </button>
  );
}

function StatTile({ folio, value, label }: { folio: string; value: string; label: string }) {
  return (
    <div className="glass p-5">
      <span className="folio">{folio}</span>
      <p className="tabular mt-3 text-3xl leading-none text-text-primary" style={{ fontFamily: "var(--font-display), Georgia, serif" }}>
        {value}
      </p>
      <p className="mt-2 text-xs text-text-muted">{label}</p>
    </div>
  );
}

export function AgentOrdersTab({ request, subscribe }: { request: Request; subscribe: Subscribe }) {
  const [orders, setOrders] = useState<CheckoutOrderView[] | null>(null);
  const [events, setEvents] = useState<PayPalEventView[] | null>(null);
  const [freshEventIds, setFreshEventIds] = useState<Set<string>>(() => new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The grid owns its rows after the first load; this mirror feeds the stats and totals.
  const ordersRef = useRef<CheckoutOrderView[]>([]);
  const gridApiRef = useRef<GridApi<AgentOrderRow> | null>(null);

  const replaceOrders = useCallback((list: CheckoutOrderView[]) => {
    ordersRef.current = list;
    setOrders(list);
    gridApiRef.current?.setGridOption("rowData", list.map(toOrderRow));
  }, []);

  const applyOrder = useCallback((order: CheckoutOrderView) => {
    const next = upsertById(ordersRef.current, order);
    ordersRef.current = next;
    setOrders(next);
    const api = gridApiRef.current;
    if (!api) return;
    const row = toOrderRow(order);
    if (api.getRowNode(row.id)) {
      api.applyTransaction({ update: [row] });
    } else {
      const result = api.applyTransaction({ add: [row], addIndex: 0 });
      if (result?.add.length) api.flashCells({ rowNodes: result.add });
    }
  }, []);

  const markFresh = useCallback((id: string) => {
    setFreshEventIds((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setFreshEventIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 1600);
  }, []);

  useEffect(() => {
    let stale = false;
    request<{ orders: CheckoutOrderView[] }>("/api/v1/merchants/me/orders")
      .then((res) => {
        if (!stale) replaceOrders(res.orders);
      })
      .catch(() => {
        if (!stale) setLoadError("Couldn't load agent orders. Check that the Tokento API is running.");
      });
    request<{ events: PayPalEventView[] }>("/api/v1/merchants/me/paypal-events")
      .then((res) => {
        if (!stale) setEvents(res.events);
      })
      .catch(() => {
        if (!stale) setEvents([]);
      });
    return () => {
      stale = true;
    };
  }, [request, replaceOrders]);

  useEffect(
    () =>
      subscribe(({ type, payload }) => {
        if (type === "paypal.webhook") {
          const event = eventFromStream(payload as unknown as PayPalWebhookMessage, new Date().toISOString());
          setEvents((prev) => prependEvent(prev ?? [], event, 50));
          markFresh(event.id);
        }
        const checkoutId = typeof payload.checkoutId === "string" ? payload.checkoutId : null;
        if (checkoutId && (type.startsWith("checkout.") || type === "paypal.webhook")) {
          request<CheckoutOrderView>(`/api/v1/merchants/me/orders/${encodeURIComponent(checkoutId)}`)
            .then(applyOrder)
            .catch(() => {});
        }
      }),
    [subscribe, request, applyOrder, markFresh],
  );

  const refund = useCallback(
    async (id: string) => {
      setActionError(null);
      try {
        applyOrder(await request<CheckoutOrderView>(`/api/v1/merchants/me/orders/${encodeURIComponent(id)}/refund`, { method: "POST" }));
      } catch (err) {
        setActionError(`Refund failed: ${apiErrorMessage(err)}`);
      }
    },
    [request, applyOrder],
  );

  const columnDefs = useMemo<ColDef<AgentOrderRow>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Time",
        width: 128,
        sort: "desc",
        cellClass: "tabular font-mono text-xs",
        valueFormatter: (p) =>
          p.value ? new Date(p.value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "",
      },
      { field: "shopper", headerName: "Shopper", width: 104, cellClass: "font-mono text-xs" },
      {
        field: "product",
        headerName: "Product",
        flex: 1,
        minWidth: 220,
        filter: true,
        tooltipValueGetter: (p) => (p.data?.agentReason ? `Why this store: ${p.data.agentReason}` : undefined),
      },
      { field: "subtotal", headerName: "Price", width: 96, type: "rightAligned", cellClass: "tabular", valueFormatter: money },
      {
        field: "rewardUsed",
        headerName: "Reward used",
        width: 118,
        type: "rightAligned",
        cellClass: "tabular text-brand-600",
        valueFormatter: (p) => (typeof p.value === "number" ? `−${usd(p.value)}` : "—"),
      },
      { field: "paid", headerName: "PayPal paid", width: 112, type: "rightAligned", cellClass: "tabular font-semibold", valueFormatter: money },
      {
        field: "earned",
        headerName: "Reward earned",
        width: 124,
        type: "rightAligned",
        cellClass: "tabular text-success",
        valueFormatter: (p) => (typeof p.value === "number" ? `+${usd(p.value)}` : "—"),
      },
      { field: "paypalOrderId", headerName: "PayPal order", width: 158, cellClass: "font-mono text-[11px]", tooltipField: "paypalOrderId" },
      { field: "paypalCaptureId", headerName: "PayPal capture", width: 158, cellClass: "font-mono text-[11px]", tooltipField: "paypalCaptureId" },
      { field: "statusLabel", headerName: "Status", width: 150, filter: true, cellRenderer: StatusCell },
      { field: "settlementLabel", headerName: "Settlement", width: 116 },
      { colId: "refund", headerName: "", width: 150, sortable: false, cellRenderer: RefundCell, cellRendererParams: { onRefund: refund } },
    ],
    [refund],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({ sortable: true, resizable: true, enableCellChangeFlash: true, cellDataType: false, suppressHeaderMenuButton: true }),
    [],
  );

  const onGridReady = useCallback((e: GridReadyEvent<AgentOrderRow>) => {
    gridApiRef.current = e.api;
    e.api.setGridOption("rowData", ordersRef.current.map(toOrderRow));
  }, []);

  const getRowId = useCallback((p: GetRowIdParams<AgentOrderRow>) => p.data.id, []);
  const totals = useMemo(() => [orderTotals((orders ?? []).map(toOrderRow))], [orders]);
  const stats = useMemo(() => orderStats(orders ?? []), [orders]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile folio="A1" value={usd(stats.agentSales)} label={`Agent sales · ${stats.paidOrders} paid order${stats.paidOrders === 1 ? "" : "s"}`} />
        <StatTile folio="A2" value={usd(stats.paidWithPayPal)} label="Paid through PayPal" />
        <StatTile folio="A3" value={usd(stats.rewardsSpent)} label="Rewards shoppers spent here" />
        <StatTile folio="A4" value={usd(stats.rewardsEarned)} label="Rewards earned for next time" />
      </div>

      <section className="glass overflow-hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-3">
          <div>
            <p className="folio">Agent orders</p>
            <p className="mt-1 text-xs text-text-muted">Purchases AI shopping agents made here, paid with PayPal. Updates live; hover a product for the agent&apos;s reason.</p>
          </div>
          {loadError && <p className="text-xs text-error">{loadError}</p>}
          {actionError && <p className="text-xs text-error">{actionError}</p>}
        </div>
        <AgGridReact<AgentOrderRow>
          theme={ledgerTheme}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
          onGridReady={onGridReady}
          pinnedBottomRowData={totals}
          loading={orders === null && !loadError}
          domLayout="autoHeight"
          animateRows
          tooltipShowDelay={300}
          overlayNoRowsTemplate="<span>No agent orders yet. They appear here live when a shopping agent buys.</span>"
        />
      </section>

      <PayPalEventsFeed events={events} freshIds={freshEventIds} />
    </div>
  );
}
