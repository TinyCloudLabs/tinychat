// Feed lab (Sam, 11-12): the feed's view as one three-position slider, Information | All | Needs action. Unlike
// the app's SegmentedControl it never stacks: the three labels are short enough to share a phone's width, so a
// feed filter keeps one row. A radio group (Radix ToggleGroup, type "single"); the selected one sits on a raised
// thumb with a heavier label, so selection never rests on colour alone.
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import type { FeedSelector } from "@tinycloud/sdk-services/feed";

import { cn } from "@/lib/utils";

const OPTIONS: readonly { value: FeedSelector; label: string }[] = [
  { value: "information", label: "Information" },
  { value: "both", label: "All" },
  { value: "needs-action", label: "Needs action" },
];

export function FeedViewSlider({ value, onValueChange, className }: { value: FeedSelector; onValueChange: (value: FeedSelector) => void; className?: string }) {
  const index = OPTIONS.findIndex((option) => option.value === value);
  return <ToggleGroup.Root type="single" value={value} aria-label="Feed view"
    // Pressing the selected one again would clear it; the feed always has a view.
    onValueChange={(next) => { if (next) onValueChange(next as FeedSelector); }}
    className={cn("relative grid grid-cols-3 rounded-full bg-surface-2 p-1", className)}>
    {index >= 0 && <span aria-hidden className="pointer-events-none absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] rounded-full bg-background shadow-sm transition-transform duration-250 ease-smooth motion-reduce:transition-none"
      style={{ transform: `translateX(${index * 100}%)` }} />}
    {OPTIONS.map((option) => <ToggleGroup.Item key={option.value} value={option.value}
      className={cn("tap-transparent relative flex min-h-11 min-w-0 items-center justify-center whitespace-nowrap rounded-full px-1 text-[13px] transition-colors fine:min-h-9",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:opacity-60",
        option.value === value ? "font-semibold text-foreground" : "font-medium text-muted-foreground hover:text-foreground")}>
      {option.label}
    </ToggleGroup.Item>)}
  </ToggleGroup.Root>;
}
