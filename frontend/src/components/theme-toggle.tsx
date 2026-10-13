import { MoonIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { setThemeChoice, useResolvedTheme } from "@/lib/theme";

/**
 * The header's one-tap switch: shows the other theme and makes it the choice.
 * Settings → Appearance offers System too. Stores a choice only when clicked,
 * never on mount (lib/theme.ts).
 */
export function ThemeToggle() {
  const theme = useResolvedTheme();
  return (
    <Button
      variant="outline"
      size="icon"
      className="size-8"
      aria-label="Toggle theme"
      onClick={() => setThemeChoice(theme === "dark" ? "light" : "dark")}
    >
      {theme === "dark" ? (
        <SunIcon className="size-4" />
      ) : (
        <MoonIcon className="size-4" />
      )}
    </Button>
  );
}
