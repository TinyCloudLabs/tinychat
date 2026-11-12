// Feed lab (Sam, 11-12): the feed's view as one three-position slider, Information | All | Needs action, in the
// look Sam picked: uiverse.io "kind-lizard-11" by _7948 (MIT), a black "dynamic island" pill with a sliding
// indicator. Ported to the app's Tailwind. Unlike the original, the radios are visually hidden rather than
// display:none, so the slider is a real radio group a keyboard and a screen reader can use, and a focused option
// shows a ring. It never stacks: the labels share a phone's width.
import type { FeedSelector } from "@tinycloud/sdk-services/feed";

import { cn } from "@/lib/utils";

const OPTIONS: readonly { value: FeedSelector; label: string }[] = [
  { value: "information", label: "Information" },
  { value: "both", label: "All" },
  { value: "needs-action", label: "Needs action" },
];

export function FeedViewSlider({ value, onValueChange, className }: { value: FeedSelector; onValueChange: (value: FeedSelector) => void; className?: string }) {
  const index = OPTIONS.findIndex((option) => option.value === value);
  return <div role="radiogroup" aria-label="Feed view"
    className={cn("relative grid grid-cols-3 gap-1 rounded-full bg-black p-1.5 dark:bg-[#1c1c1e]", className)}>
    {/* The indicator slides under the chosen label: one third of the island, less its padding and gaps. */}
    {index >= 0 && <span aria-hidden className="pointer-events-none absolute bottom-1.5 left-1.5 top-1.5 w-[calc((100%-0.75rem-0.5rem)/3)] rounded-full bg-[#222] transition-transform duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none dark:bg-[#3a3a3c]"
      style={{ transform: `translateX(calc(${index * 100}% + ${index * 0.25}rem))` }} />}
    {OPTIONS.map((option) => {
      const checked = option.value === value;
      return <label key={option.value}
        className={cn("relative z-10 flex min-h-11 cursor-pointer items-center justify-center whitespace-nowrap rounded-full px-2 text-sm transition-[color,transform] duration-300 active:scale-[0.92] fine:min-h-9",
          "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-black",
          checked ? "-translate-y-px font-medium text-white" : "text-[#aaa] hover:text-white dark:text-[#8e8e93]")}>
        <input type="radio" name="feed-view" value={option.value} checked={checked} onChange={() => onValueChange(option.value)} className="sr-only" />
        {option.label}
      </label>;
    })}
  </div>;
}
