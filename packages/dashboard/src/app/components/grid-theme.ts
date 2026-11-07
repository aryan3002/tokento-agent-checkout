// AG Grid setup shared by the dashboard's grids: modules and the ledger theme.
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

// The dashboard's ledger palette: paper, ink, one terracotta accent.
export const ledgerTheme = themeQuartz.withParams({
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
