// The Feed's top row: one island over the stream, in the black "dynamic island" look the owner picked. It is the
// stream's map: Needs you, Updates and History, each a tap that scrolls to that section; scrolling moves the
// highlight. The columns are weighted 42 / 34 / 24 %, because "Needs you 3" is the longest label, so the row fits beside
// the Filter icon at 390 px; the indicator follows the weights with the app's ease.
import { cn } from "@/lib/utils";

import type { StreamSection } from "./feedStream";

const OPTIONS: readonly { value: StreamSection; label: string; weight: number }[] = [
  { value: "needs", label: "Needs you", weight: 42 },
  { value: "updates", label: "Updates", weight: 34 },
  { value: "history", label: "History", weight: 24 },
];

export function FeedMap({ value, needs, updates, present, onSelect, className }: {
  value: StreamSection; needs: number; updates: number;
  /** The sections that have rows; a map button for one with none is off. */
  present: Readonly<Record<StreamSection, boolean>>;
  onSelect: (section: StreamSection) => void; className?: string;
}) {
  const index = OPTIONS.findIndex((option) => option.value === value);
  const before = OPTIONS.slice(0, Math.max(0, index)).reduce((sum, option) => sum + option.weight, 0);
  const counts: Record<StreamSection, number> = { needs, updates, history: 0 };
  return <nav aria-label="Feed sections"
    className={cn("relative grid grid-cols-[42fr_34fr_24fr] rounded-full bg-black px-1 py-0 fine:py-1 dark:bg-[#1c1c1e]", className)}>
    {index >= 0 && <span aria-hidden className="pointer-events-none absolute bottom-1 top-1 rounded-full bg-[#2c2c2e] transition-[left,width] duration-[250ms] ease-[cubic-bezier(.2,0,0,1)] motion-reduce:transition-none dark:bg-[#3a3a3c]"
      style={{ left: `calc(0.25rem + (100% - 0.5rem) * ${before / 100})`, width: `calc((100% - 0.5rem) * ${OPTIONS[index]!.weight / 100})` }} />}
    {OPTIONS.map((option) => {
      const checked = option.value === value;
      const count = counts[option.value];
      return <button key={option.value} type="button" disabled={!present[option.value]} aria-current={checked ? "true" : undefined} onClick={() => onSelect(option.value)}
        className={cn("relative z-10 flex min-h-11 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-1 text-[13px] transition-[color,transform] duration-300 fine:min-h-9 active:scale-[0.92] max-[359px]:gap-1 max-[359px]:px-0 max-[359px]:text-[12px]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:opacity-40 disabled:active:scale-100",
          checked ? "font-semibold text-white" : "font-medium text-[#a1a1aa] enabled:hover:text-white dark:text-[#8e8e93]")}>
        {option.label}
        {count > 0 && <span aria-label={`, ${count}`} className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-[11px] font-bold tabular-nums",
          checked ? "bg-white text-[#09090b]" : "bg-[#46464c] text-white")}>{count}</span>}
      </button>;
    })}
  </nav>;
}
