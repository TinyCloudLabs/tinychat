// Home's top row (Sam, 11-13 11:58Z: "Build it as recommended", briefs/feed-lab/design/toprow): one island with
// Needs you (and its count), All and History, in the black "dynamic island" look Sam picked (uiverse.io
// "kind-lizard-11" by _7948, MIT). The columns are weighted 44 / 22 / 34 %, because "Needs you 3" is the longest
// label, so the row fits beside the Filter icon at 390 px; the indicator follows the weights with the app's ease.
// The radios are visually hidden, not display:none, so it is a real radio group for a keyboard and a screen reader.
// Needs you and All are the saved views (`FeedSelector`); History is the list of what is done.
import type { FeedSelector } from "@tinycloud/sdk-services/feed";

import { cn } from "@/lib/utils";

export type FeedTab = Exclude<FeedSelector, "information"> | "history";

const OPTIONS: readonly { value: FeedTab; label: string; weight: number }[] = [
  { value: "needs-action", label: "Needs you", weight: 44 },
  { value: "both", label: "All", weight: 22 },
  { value: "history", label: "History", weight: 34 },
];

export function FeedTabs({ value, needs, onValueChange, className }: { value: FeedTab; needs: number; onValueChange: (value: FeedTab) => void; className?: string }) {
  const index = OPTIONS.findIndex((option) => option.value === value);
  const before = OPTIONS.slice(0, Math.max(0, index)).reduce((sum, option) => sum + option.weight, 0);
  return <div role="radiogroup" aria-label="Feed view"
    className={cn("relative grid grid-cols-[44fr_22fr_34fr] rounded-full bg-black p-1 dark:bg-[#1c1c1e]", className)}>
    {index >= 0 && <span aria-hidden className="pointer-events-none absolute bottom-1 top-1 rounded-full bg-[#2c2c2e] transition-[left,width] duration-[250ms] ease-[cubic-bezier(.2,0,0,1)] motion-reduce:transition-none dark:bg-[#3a3a3c]"
      style={{ left: `calc(0.25rem + (100% - 0.5rem) * ${before / 100})`, width: `calc((100% - 0.5rem) * ${OPTIONS[index]!.weight / 100})` }} />}
    {OPTIONS.map((option) => {
      const checked = option.value === value;
      return <label key={option.value}
        className={cn("relative z-10 flex min-h-9 min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-1 text-[13px] transition-[color,transform] duration-300 active:scale-[0.92] max-[359px]:gap-1 max-[359px]:px-0 max-[359px]:text-[12px]",
          "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-black",
          checked ? "font-semibold text-white" : "font-medium text-[#a1a1aa] hover:text-white dark:text-[#8e8e93]")}>
        <input type="radio" name="feed-view" value={option.value} checked={checked} onChange={() => onValueChange(option.value)} className="sr-only" />
        {option.label}
        {option.value === "needs-action" && needs > 0 && <span aria-label={`, ${needs}`} className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-[11px] font-bold tabular-nums",
          checked ? "bg-white text-[#09090b]" : "bg-[#46464c] text-white")}>{needs}</span>}
      </label>;
    })}
  </div>;
}
