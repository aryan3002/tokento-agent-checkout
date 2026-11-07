"use client";

// Agent comparisons: every time a shopping agent compared this store with others,
// the store's own offer, what it really cost the shopper there after rewards, and
// whether the agent picked it. Only this store's numbers, never another store's.
// New comparisons slide in at the top while an agent is shopping.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GetRowIdParams, GridApi, GridReadyEvent, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import type { AgentComparisonLine, AgentComparisonStats } from "@tokento/shared";
import { comparisonSummary } from "./agent-comparisons";
import { OUTCOME, unseenLines } from "./comparisons";
import { GridToolbar, useGridLayout } from "./GridToolbar";
import { ledgerTheme } from "./grid-theme";
import { usd } from "./overview-data";
import type { StreamEvent } from "./AgentOrdersTab";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Subscribe = (listener: (event: StreamEvent) => void) => () => void;

const LAYOUT_KEY = "tokento.grid.comparisons.v1";
const money = (p: ValueFormatterParams) => (typeof p.value === "number" ? usd(p.value) : "");

function OutcomeCell(p: ICellRendererParams<AgentComparisonLine>) {
  const outcome = p.data ? OUTCOME[p.data.outcome] : null;
  if (!outcome) return null;
  return (
    <span className="flex items-center gap-2">
      <span className={`dot ${outcome.dot}`} />
      {outcome.label}
    </span>
  );
}

export function ComparisonsTab({ request, subscribe, stats }: { request: Request; subscribe: Subscribe; stats: AgentComparisonStats | null }) {
  const [lines, setLines] = useState<AgentComparisonLine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gridApi, setGridApi] = useState<GridApi<AgentComparisonLine> | null>(null);
  const linesRef = useRef<AgentComparisonLine[]>([]);
  const gridApiRef = useRef<GridApi<AgentComparisonLine> | null>(null);
  const layout = useGridLayout(LAYOUT_KEY);

  useEffect(() => {
    let stale = false;
    request<{ comparisons: AgentComparisonLine[] }>("/api/v1/merchants/me/agent-comparisons/recent?limit=500")
      .then((res) => {
        if (stale) return;
        linesRef.current = res.comparisons;
        setLines(res.comparisons);
        gridApiRef.current?.setGridOption("rowData", res.comparisons);
      })
      .catch(() => {
        if (!stale) setLoadError("Couldn't load comparisons. Check that the Tokento API is running.");
      });
    return () => {
      stale = true;
    };
  }, [request]);

  useEffect(
    () =>
      subscribe(({ type }) => {
        if (type !== "agent.compared") return;
        request<{ comparisons: AgentComparisonLine[] }>("/api/v1/merchants/me/agent-comparisons/recent?limit=10")
          .then((res) => {
            const fresh = unseenLines(new Set(linesRef.current.map((l) => l.id)), res.comparisons);
            if (fresh.length === 0) return;
            linesRef.current = [...fresh, ...linesRef.current];
            setLines(linesRef.current);
            const api = gridApiRef.current;
            const result = api?.applyTransaction({ add: fresh, addIndex: 0 });
            if (result?.add.length) api?.flashCells({ rowNodes: result.add });
          })
          .catch(() => {});
      }),
    [subscribe, request],
  );

  const columnDefs = useMemo<ColDef<AgentComparisonLine>[]>(
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
      { field: "productName", headerName: "Your item in the comparison", flex: 1, minWidth: 240, filter: true },
      { field: "quantity", headerName: "Qty", width: 72, type: "rightAligned", cellClass: "tabular" },
      { field: "subtotal", headerName: "Your price", width: 112, type: "rightAligned", cellClass: "tabular", valueFormatter: money },
      {
        field: "effectiveCost",
        headerName: "Real cost to shopper",
        headerTooltip: "What the shopper would really pay at your store: the price, minus the reward they'd spend, minus the reward they'd earn back.",
        width: 164,
        type: "rightAligned",
        cellClass: "tabular font-semibold",
        valueFormatter: money,
      },
      { field: "storesCompared", headerName: "Stores compared", width: 140, type: "rightAligned", cellClass: "tabular" },
      {
        field: "outcome",
        headerName: "Outcome",
        width: 176,
        pinned: "right",
        filter: true,
        cellRenderer: OutcomeCell,
        // Quick search and CSV read the words, not the internal code.
        getQuickFilterText: (p) => OUTCOME[p.data.outcome]?.label ?? p.data.outcome,
        valueFormatter: (p) => (p.value ? OUTCOME[p.value as AgentComparisonLine["outcome"]]?.label ?? String(p.value) : ""),
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true, cellDataType: false, suppressHeaderMenuButton: true }), []);
  const getRowId = useCallback((p: GetRowIdParams<AgentComparisonLine>) => p.data.id, []);
  const onGridReady = useCallback((e: GridReadyEvent<AgentComparisonLine>) => {
    gridApiRef.current = e.api;
    e.api.setGridOption("rowData", linesRef.current);
    setGridApi(e.api);
  }, []);

  const summary = stats ? comparisonSummary(stats) : null;

  return (
    <div className="space-y-6">
      <section aria-label="Comparisons in numbers" className="rounded-xl border border-border bg-surface-1 p-5">
        {summary ? (
          <>
            <p className="tabular text-xl font-semibold tracking-tight">{summary.headline}</p>
            <p className="mt-1 text-sm text-text-muted">{summary.detail}</p>
          </>
        ) : (
          <div className="skeleton h-12" />
        )}
        <p className="mt-3 text-xs text-text-muted">Each row is one time an agent compared your offer with other stores. Only your own numbers are shown; other stores&apos; names and prices stay private.</p>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-surface-1">
        <GridToolbar api={gridApi} grid="agent-comparisons" storageKey={LAYOUT_KEY} placeholder="Search comparisons">
          {loadError ? <span className="text-error">{loadError}</span> : `Newest first${lines ? ` · ${lines.length} shown` : ""}. New comparisons appear as agents shop.`}
        </GridToolbar>
        {layout.ready && (
          <AgGridReact<AgentComparisonLine>
            theme={ledgerTheme}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowId={getRowId}
            onGridReady={onGridReady}
            initialState={layout.initialState}
            onStateUpdated={layout.onStateUpdated}
            loading={lines === null && !loadError}
            domLayout="autoHeight"
            animateRows
            tooltipShowDelay={300}
            overlayNoRowsTemplate="<span>No comparisons yet. When a shopper's agent compares your store with others, each one appears here.</span>"
          />
        )}
      </section>
    </div>
  );
}
