"use client";

// Above every grid: search the rows (AG Grid quick filter), download what's shown as
// CSV, and put the columns back. Each grid remembers how the store arranged its
// columns in this browser (AG Grid state API: initialState + onStateUpdated).
import { useCallback, useEffect, useState } from "react";
import type { GridApi, GridState, StateUpdatedEvent } from "ag-grid-community";
import { clearGridLayout, csvFileName, loadGridLayout, saveGridLayout } from "./grid-prefs";

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Load the saved layout once on the client; render the grid only when `ready`. */
export function useGridLayout(storageKey: string) {
  const [initialState, setInitialState] = useState<GridState | undefined | null>(null);
  useEffect(() => {
    void Promise.resolve().then(() => setInitialState(loadGridLayout(browserStorage(), storageKey)));
  }, [storageKey]);
  const onStateUpdated = useCallback(
    (e: StateUpdatedEvent) => {
      if (e.sources.every((s) => s === "gridInitializing")) return;
      saveGridLayout(browserStorage(), storageKey, e.state);
    },
    [storageKey],
  );
  return { ready: initialState !== null, initialState: initialState ?? undefined, onStateUpdated };
}

export function GridToolbar<T>({
  api,
  grid,
  storageKey,
  placeholder,
  children,
}: {
  api: GridApi<T> | null;
  /** Used in the CSV file name, e.g. "agent-orders". */
  grid: string;
  storageKey: string;
  placeholder: string;
  /** A short note on the left (what the grid shows, errors). */
  children?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");

  const search = (value: string) => {
    setQuery(value);
    api?.setGridOption("quickFilterText", value);
  };

  const download = () => {
    if (!api) return;
    // Only data columns: action buttons have no field and would export as empty cells.
    const columnKeys = api.getAllDisplayedColumns().filter((c) => Boolean(c.getColDef().field)).map((c) => c.getColId());
    api.exportDataAsCsv({ fileName: csvFileName(grid, new Date()), columnKeys, skipPinnedBottom: true });
  };

  const reset = () => {
    api?.resetColumnState();
    clearGridLayout(browserStorage(), storageKey);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
      <div className="mr-auto min-w-0 text-[13px] text-text-muted">{children}</div>
      <label className="relative">
        <span className="sr-only">Search this table</span>
        <input
          type="search"
          value={query}
          onChange={(e) => search(e.target.value)}
          placeholder={placeholder}
          className="h-8 w-48 rounded-md border border-border bg-surface-0 px-2.5 text-[13px] outline-none placeholder:text-text-muted focus:border-border-hover"
        />
      </label>
      <button type="button" disabled={!api} onClick={download} className="h-8 rounded-md border border-border bg-surface-1 px-2.5 text-[13px] font-medium hover:bg-surface-3 disabled:opacity-50">
        Download CSV
      </button>
      <button type="button" disabled={!api} onClick={reset} className="h-8 rounded-md px-2 text-[13px] text-text-muted hover:text-text-primary disabled:opacity-50" title="Put the columns back as they were">
        Reset columns
      </button>
    </div>
  );
}
