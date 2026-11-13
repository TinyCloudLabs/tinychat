// Sam, 11-12: the feed's view as one three-position slider, Information | All | Needs action, in the
// look Sam picked: uiverse.io "kind-lizard-11" by _7948 (MIT), a black "dynamic island" pill with a sliding
// indicator. Ported to the app's Tailwind. Unlike the original, the radios are visually hidden rather than
// display:none, so the slider is a real radio group a keyboard and a screen reader can use, and a focused option
// shows a ring. It never stacks.
//
// Sam, 11-13: it sits on the left of one row with Filter and View on the right (HomeFeedEntries). So that all three
// labels fit beside the two buttons at 390 px, the columns are weighted by their labels' length, 35 / 21 / 44 %, and
// the indicator's left edge and width follow the weights.
import type { FeedSelector } from "@tinycloud/sdk-services/feed";

import { cn } from "@/lib/utils";

const OPTIONS: readonly { value: FeedSelector; label: string; weight: number }[] = [
  { value: "information", label: "Information", weight: 35 },
  { value: "both", label: "All", weight: 21 },
  { value: "needs-action", label: "Needs action", weight: 44 },
];

export function FeedViewSlider({ value, onValueChange, className }: { value: FeedSelector; onValueChange: (value: FeedSelector) => void; className?: string }) {
  const index = OPTIONS.findIndex((option) => option.value === value);
  const before = OPTIONS.slice(0, Math.max(0, index)).reduce((sum, option) => sum + option.weight, 0);
  return <div role="radiogroup" aria-label="Feed view"
    className={cn("relative grid grid-cols-[35fr_21fr_44fr] rounded-full bg-black p-1 dark:bg-[#1c1c1e]", className)}>
    {/* The indicator slides under the chosen label: its column's share of the island, inside the island's padding. */}
    {index >= 0 && <span aria-hidden className="pointer-events-none absolute bottom-1 top-1 rounded-full bg-[#2c2c2e] transition-[left,width] duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none dark:bg-[#3a3a3c]"
      style={{ left: `calc(0.25rem + (100% - 0.5rem) * ${before / 100})`, width: `calc((100% - 0.5rem) * ${OPTIONS[index]!.weight / 100})` }} />}
    {OPTIONS.map((option) => {
      const checked = option.value === value;
      return <label key={option.value}
        className={cn("relative z-10 flex min-h-9 min-w-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-full px-1 text-[13px] transition-[color,transform] duration-300 active:scale-[0.92] max-[359px]:px-0 max-[359px]:text-[11px]",
          "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-black",
          checked ? "font-semibold text-white" : "font-medium text-[#a1a1aa] hover:text-white dark:text-[#8e8e93]")}>
        <input type="radio" name="feed-view" value={option.value} checked={checked} onChange={() => onValueChange(option.value)} className="sr-only" />
        {option.label}
      </label>;
    })}
  </div>;
}
