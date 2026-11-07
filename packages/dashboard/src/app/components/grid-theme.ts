// AG Grid setup shared by the dashboard's grids: modules and the theme.
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

// Reads the dashboard's CSS variables, so the grids follow the light/dark switch.
export const ledgerTheme = themeQuartz.withParams({
  browserColorScheme: "inherit",
  backgroundColor: "var(--surface-1)",
  foregroundColor: "var(--text-primary)",
  textColor: "var(--text-primary)",
  subtleTextColor: "var(--text-muted)",
  borderColor: "var(--border)",
  accentColor: "var(--brand-500)",
  headerBackgroundColor: "var(--surface-2)",
  headerTextColor: "var(--text-muted)",
  headerFontWeight: 500,
  oddRowBackgroundColor: "var(--surface-1)",
  rowHoverColor: "var(--surface-3)",
  selectedRowBackgroundColor: "var(--surface-3)",
  pinnedRowBackgroundColor: "var(--surface-2)",
  pinnedRowFontWeight: 600,
  valueChangeValueHighlightBackgroundColor: "color-mix(in oklab, var(--brand-500) 22%, transparent)",
  fontFamily: "var(--font-body), ui-sans-serif, system-ui, sans-serif",
  headerFontFamily: "var(--font-body), ui-sans-serif, system-ui, sans-serif",
  fontSize: 13,
  headerFontSize: 12,
  rowHeight: 52,
  headerHeight: 40,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  borderRadius: 6,
  columnBorder: false,
  headerColumnBorder: false,
});
