import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

type Theme = "light" | "dark";

const STORAGE_KEY = "xyz.tinycloud.tinychat:theme";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** The page background per theme (index.css --background), for the browser/PWA chrome. */
const THEME_COLOR: Record<Theme, string> = { light: "#ffffff", dark: "#09090b" };

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  // index.html ships one theme-color per system scheme; a chosen theme wins over both.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", THEME_COLOR[theme]);
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <Button
      variant="outline"
      size="icon"
      className="size-8"
      aria-label="Toggle theme"
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
    >
      {theme === "dark" ? (
        <SunIcon className="size-4" />
      ) : (
        <MoonIcon className="size-4" />
      )}
    </Button>
  );
}
