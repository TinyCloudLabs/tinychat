import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "@/lib/theme";

const THEME_OPTIONS: readonly SegmentedOption<ThemeChoice>[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Settings → Appearance. System is the default and follows the device as it changes. */
export function AppearanceControl() {
  const choice = useThemeChoice();
  return (
    <div className="flex flex-col gap-2">
      <SegmentedControl
        aria-label="Theme"
        size="compact"
        value={choice}
        onValueChange={setThemeChoice}
        options={THEME_OPTIONS}
        className="w-full sm:max-w-xs"
      />
      <p className="text-xs text-muted-foreground">System follows your device’s light or dark setting.</p>
    </div>
  );
}
