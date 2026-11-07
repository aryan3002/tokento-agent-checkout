"use client";

// Agent orders: every purchase a shopping agent made at this store through
// PayPal, live. The first load fills the grid; after that each checkout or
// PayPal event re-reads that one order and applies it as an AG Grid
// transaction, so changed cells flash and the pinned totals row follows.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type ValueFormatterParams,
} from "ag-grid-community";
import type { CheckoutOrderView } from "@tokento/shared";
import { orderStats, orderTotals, toOrderRow, upsertById, type AgentOrderRow } from "./agent-orders";
import { ledgerTheme } from "./grid-theme";

export type StreamEvent = { type: string; payload: Record<string, unknown> };
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Subscribe = (listener: (event: StreamEvent) => void) => () => void;

const usd = (value: number) => `$${value.toFixed(2)}`;
const money = (p: ValueFormatterParams) => (typeof p.value === "number" ? usd(p.value) : "—");

function apiErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return /"message":"([^"]+)"/.exec(text)?.[1] ?? text;
}

function statusDot(status: AgentOrderRow["status"]): string {
  if (status === "COMPLETED") return "dot-success";
  if (status === "FAILED" || status === "NEEDS_REVIEW") return "dot-error";
  if (status === "REFUNDED" || status === "CANCELLED") return "dot-neutral";
  return "dot-warning pulse-dot";
}

// A dot plus the words, never colour alone.
function StatusCell({ data, node }: ICellRendererParams<AgentOrderRow>) {
  if (!data || node.rowPinned) return null;
  return (
    <span className="flex h-full items-center gap-2 text-[13px]">
      <span className={`dot ${statusDot(data.status)}`} />
      {data.statusLabel}
    </span>
  );
}

function ProductCell({ data, node }: ICellRendererParams<AgentOrderRow>) {
  if (!data) return null;
  if (node.rowPinned) return <span className="font-medium">{data.product}</span>;
  return (
    <span className="flex h-full min-w-0 flex-col justify-center leading-tight">
      <span className="truncate">{data.quantity > 1 ? `${data.quantity} × ` : ""}{data.product}</span>
      {data.agentReason && <span className="truncate text-xs text-text-muted">Why you: {data.agentReason}</span>}
    </span>
  );
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
      className="rounded-md border border-border bg-surface-1 px-2.5 py-1 text-xs font-medium hover:bg-surface-3 disabled:opacity-50"
    >
      {step === "working" ? "Refunding…" : "Refund"}
    </button>
  );
}

function StatTile({ label, value, hint, tone = "" }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div className="border-b border-border p-4 sm:border-r lg:border-b-0 [&:last-child]:border-r-0">
      <p className="text-[13px] text-text-muted">{label}</p>
      <p className={`tabular mt-1 font-mono text-2xl font-medium tracking-tight ${tone}`}>{value}</p>
      <p className="mt-1.5 text-xs text-text-muted">{hint}</p>
    </div>
  );
}

export function AgentOrdersTab({ request, subscribe }: { request: Request; subscribe: Subscribe }) {
  const [orders, setOrders] = useState<CheckoutOrderView[] | null>(null);
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

  useEffect(() => {
    let stale = false;
    request<{ orders: CheckoutOrderView[] }>("/api/v1/merchants/me/orders")
      .then((res) => {
        if (!stale) replaceOrders(res.orders);
      })
      .catch(() => {
        if (!stale) setLoadError("Couldn't load agent orders. Check that the Tokento API is running.");
      });
    return () => {
      stale = true;
    };
  }, [request, replaceOrders]);

  useEffect(
    () =>
      subscribe(({ type, payload }) => {
        const checkoutId = typeof payload.checkoutId === "string" ? payload.checkoutId : null;
        if (checkoutId && (type.startsWith("checkout.") || type === "paypal.webhook")) {
          request<CheckoutOrderView>(`/api/v1/merchants/me/orders/${encodeURIComponent(checkoutId)}`)
            .then(applyOrder)
            .catch(() => {});
        }
      }),
    [subscribe, request, applyOrder],
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
        headerName: "When",
        width: 156,
        sort: "desc",
        cellClass: "tabular font-mono text-xs",
        valueFormatter: (p) =>
          p.value ? new Date(p.value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "",
      },
      { field: "shopper", headerName: "Shopper", width: 104, cellClass: "font-mono text-xs" },
      {
        field: "product",
        headerName: "What they bought",
        flex: 1,
        minWidth: 260,
        filter: true,
        cellRenderer: ProductCell,
        tooltipValueGetter: (p) => (p.data?.agentReason ? `Why the agent chose you: ${p.data.agentReason}` : undefined),
      },
      { field: "subtotal", headerName: "Price", width: 96, type: "rightAligned", cellClass: "tabular", valueFormatter: money },
      {
        field: "rewardUsed",
        headerName: "Reward used",
        width: 118,
        type: "rightAligned",
        cellClass: (p) => (typeof p.value === "number" ? "tabular text-warning" : "tabular text-text-muted"),
        valueFormatter: (p) => (typeof p.value === "number" ? `−${usd(p.value)}` : "—"),
      },
      { field: "paid", headerName: "Paid via PayPal", width: 128, type: "rightAligned", cellClass: "tabular font-semibold", valueFormatter: money },
      {
        field: "earned",
        headerName: "Reward earned",
        width: 124,
        type: "rightAligned",
        cellClass: (p) => (typeof p.value === "number" ? "tabular text-success" : "tabular text-text-muted"),
        valueFormatter: (p) => (typeof p.value === "number" ? `+${usd(p.value)}` : "—"),
      },
      { field: "paypalOrderId", headerName: "PayPal order", width: 158, cellClass: "font-mono text-[11px]", tooltipField: "paypalOrderId" },
      { field: "paypalCaptureId", headerName: "PayPal capture", width: 158, cellClass: "font-mono text-[11px]", tooltipField: "paypalCaptureId" },
      { field: "statusLabel", headerName: "Status", width: 168, filter: true, pinned: "right", cellRenderer: StatusCell },
      { field: "settlementLabel", headerName: "Payout", width: 112 },
      { colId: "refund", headerName: "", width: 150, sortable: false, pinned: "right", cellRenderer: RefundCell, cellRendererParams: { onRefund: refund } },
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
      <section aria-label="Agent orders in numbers" className="grid overflow-hidden rounded-xl border border-border bg-surface-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Sales from AI agents" value={usd(stats.agentSales)} hint={`${stats.paidOrders} paid order${stats.paidOrders === 1 ? "" : "s"}, before rewards`} />
        <StatTile label="Collected by PayPal" value={usd(stats.paidWithPayPal)} hint="What shoppers actually paid" />
        <StatTile label="Rewards used here" value={`−${usd(stats.rewardsSpent)}`} hint="Discounts your rewards gave shoppers" tone="text-warning" />
        <StatTile label="Rewards earned" value={`+${usd(stats.rewardsEarned)}`} hint="New rewards that bring shoppers back" tone="text-success" />
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-surface-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-[13px] text-text-muted">Newest first. Rows update the moment PayPal confirms a payment. Click a column to sort.</p>
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
    </div>
  );
}
