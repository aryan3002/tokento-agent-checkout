"use client";

// System / light / dark, saved per browser. The layout's script applies a saved choice before first paint.
import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "tokento.theme";

const PATHS: Record<Theme, string> = {
  system: "M3 4h18v12H3zM8 20h8M12 16v4",
  light: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  dark: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    void Promise.resolve().then(() => {
      const saved = document.documentElement.dataset.theme;
      if (saved === "light" || saved === "dark") setTheme(saved);
    });
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    if (next === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", next);
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch { /* storage blocked: lasts this visit */ }
  };

  return (
    <div role="group" aria-label="Theme" className="flex rounded-full border border-border p-0.5">
      {(Object.keys(PATHS) as Theme[]).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => apply(t)}
          aria-pressed={theme === t}
          aria-label={`${t[0].toUpperCase()}${t.slice(1)} theme`}
          title={`${t[0].toUpperCase()}${t.slice(1)} theme`}
          className={`rounded-full p-1 ${theme === t ? "bg-surface-3 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={PATHS[t]} />
          </svg>
        </button>
      ))}
    </div>
  );
}
