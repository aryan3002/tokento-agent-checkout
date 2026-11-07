import { describe, expect, it } from "vitest";
import type { AgentComparisonLine } from "@tokento/shared";
import { columnLayout, csvFileName, loadGridLayout, saveGridLayout } from "../src/app/components/grid-prefs";
import { unseenLines } from "../src/app/components/comparisons";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}
const throwing = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("quota"); },
  removeItem: () => { throw new Error("blocked"); },
};

describe("columnLayout", () => {
  it("keeps only how the columns are arranged, not scroll, focus or filters", () => {
    const state = {
      columnOrder: { orderedColIds: ["a", "b"] },
      columnSizing: { columnSizingModel: [{ colId: "a", width: 120 }] },
      columnVisibility: { hiddenColIds: ["b"] },
      columnPinning: { leftColIds: [], rightColIds: ["a"] },
      sort: { sortModel: [{ colId: "a", sort: "desc" as const }] },
      scroll: { top: 300, left: 0 },
      focusedCell: { colId: "a", rowIndex: 3, rowPinned: null },
      filter: { filterModel: {} },
    };
    expect(columnLayout(state)).toEqual({
      columnOrder: { orderedColIds: ["a", "b"] },
      columnSizing: { columnSizingModel: [{ colId: "a", width: 120 }] },
      columnVisibility: { hiddenColIds: ["b"] },
      columnPinning: { leftColIds: [], rightColIds: ["a"] },
      sort: { sortModel: [{ colId: "a", sort: "desc" }] },
    });
  });
});

describe("loadGridLayout / saveGridLayout", () => {
  it("round-trips a layout through the browser's storage", () => {
    const storage = memoryStorage();
    saveGridLayout(storage, "grid.orders", { sort: { sortModel: [{ colId: "when", sort: "asc" }] } });
    expect(loadGridLayout(storage, "grid.orders")).toEqual({ sort: { sortModel: [{ colId: "when", sort: "asc" }] } });
  });

  it("starts from the default layout when nothing usable is saved", () => {
    expect(loadGridLayout(memoryStorage(), "grid.orders")).toBeUndefined();
    expect(loadGridLayout(memoryStorage({ "grid.orders": "{not json" }), "grid.orders")).toBeUndefined();
    expect(loadGridLayout(memoryStorage({ "grid.orders": "[1,2]" }), "grid.orders")).toBeUndefined();
    expect(loadGridLayout(throwing, "grid.orders")).toBeUndefined();
    expect(loadGridLayout(null, "grid.orders")).toBeUndefined();
  });

  it("never breaks the page when storage is full or blocked", () => {
    expect(() => saveGridLayout(throwing, "grid.orders", {})).not.toThrow();
    expect(() => saveGridLayout(null, "grid.orders", {})).not.toThrow();
  });
});

describe("csvFileName", () => {
  it("names the download after the grid and the day", () => {
    expect(csvFileName("agent-orders", new Date("2026-11-07T23:30:00Z"))).toBe("tokento-agent-orders-2026-11-07.csv");
  });
});

describe("unseenLines", () => {
  const line = (id: string, createdAt: string) => ({ id, createdAt }) as AgentComparisonLine;
  it("returns only the comparisons the grid doesn't show yet, newest first", () => {
    const fetched = [line("c3", "2026-11-07T12:00:00Z"), line("c2", "2026-11-07T11:00:00Z"), line("c1", "2026-11-07T10:00:00Z")];
    expect(unseenLines(new Set(["c1"]), fetched).map((l) => l.id)).toEqual(["c3", "c2"]);
    expect(unseenLines(new Set(["c1", "c2", "c3"]), fetched)).toEqual([]);
  });
});
