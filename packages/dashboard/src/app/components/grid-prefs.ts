// Per-browser grid preferences: how a store arranged a grid's columns (order,
// widths, hidden, pinned, sort) through AG Grid's state API, and CSV file names.
// Storage can be missing, full or blocked; none of that may break the page.
import type { GridState } from "ag-grid-community";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

/** The column parts of the grid's state; scroll, focus and filters are not remembered. */
export function columnLayout(state: GridState): GridState {
  const { columnOrder, columnSizing, columnVisibility, columnPinning, sort } = state;
  return Object.fromEntries(
    Object.entries({ columnOrder, columnSizing, columnVisibility, columnPinning, sort }).filter(([, v]) => v !== undefined),
  ) as GridState;
}

export function loadGridLayout(storage: Store, key: string): GridState | undefined {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? columnLayout(parsed as GridState) : undefined;
  } catch {
    return undefined;
  }
}

export function saveGridLayout(storage: Store, key: string, state: GridState): void {
  try {
    storage?.setItem(key, JSON.stringify(columnLayout(state)));
  } catch {
    // Full or blocked storage: the layout just isn't remembered.
  }
}

export function clearGridLayout(storage: Store, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

export function csvFileName(grid: string, now: Date): string {
  return `tokento-${grid}-${now.toISOString().slice(0, 10)}.csv`;
}
