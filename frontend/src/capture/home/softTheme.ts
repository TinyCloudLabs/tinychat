import { useResolvedTheme } from "@/lib/theme";

/** The Soft skin's palette class for the app's resolved theme. */
export function useSoftTheme(): "soft-night" | "soft-day" {
  return useResolvedTheme() === "dark" ? "soft-night" : "soft-day";
}
