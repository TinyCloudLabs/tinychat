import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  "aria-label": string;
  /** `default` is 44px tall everywhere; `compact` is 44px on touch and 36px with a mouse. */
  size?: "default" | "compact";
  className?: string;
}

/**
 * One choice among a few equal options: a radio group (Radix ToggleGroup,
 * type "single"). The selected segment has the selected tint, a solid primary
 * edge, a check and a heavier label, so selection never rests on colour alone.
 * Segments are equal width; the thumb behind them moves with transform only.
 * When the longest label cannot fit its share (large text, a narrow pane), the
 * segments stack one per row instead of cutting labels off.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  "aria-label": ariaLabel,
  size = "default",
  className,
}: SegmentedControlProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stacked = useStackWhenCramped(rootRef, options.length, options.map((option) => option.label).join("\n"));
  const index = options.findIndex((option) => option.value === value);
  const thumbStep = `calc(${index} * (100% + 0.5rem))`;
  return (
    <ToggleGroup.Root
      ref={rootRef}
      type="single"
      value={value}
      // Pressing the selected segment again would clear the value. A segmented
      // control always has one, so that press does nothing.
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      orientation={stacked ? "vertical" : "horizontal"}
      aria-label={ariaLabel}
      data-stacked={stacked ? "" : undefined}
      className={cn(
        "relative grid rounded-md bg-surface-2",
        stacked ? "auto-rows-fr grid-cols-1" : "auto-cols-fr grid-flow-col",
        className,
      )}
    >
      {index >= 0 && (
        <span
          aria-hidden
          data-segmented-thumb=""
          className={cn(
            "pointer-events-none absolute left-1 top-1 rounded-[calc(var(--radius)-6px)] border border-primary bg-selected transition-transform duration-250 ease-smooth motion-reduce:transition-none",
            stacked ? "right-1" : "bottom-1",
          )}
          style={
            stacked
              ? { height: `calc(100% / ${options.length} - 0.5rem)`, transform: `translateY(${thumbStep})` }
              : { width: `calc(100% / ${options.length} - 0.5rem)`, transform: `translateX(${thumbStep})` }
          }
        />
      )}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <ToggleGroup.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            data-segment=""
            className={cn(
              "tap-transparent relative flex min-w-0 items-center justify-center gap-1.5 rounded-md px-3 text-callout font-medium text-muted-foreground transition-[color,opacity] duration-150",
              size === "compact" ? "min-h-11 fine:min-h-9" : "min-h-11",
              "hover:text-foreground active:opacity-60 disabled:cursor-not-allowed disabled:opacity-50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              selected && "font-semibold text-foreground",
            )}
          >
            {selected && <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />}
            <span data-segment-label="" className={stacked ? "min-w-0 py-2 [overflow-wrap:anywhere]" : "truncate"}>
              {option.label}
            </span>
          </ToggleGroup.Item>
        );
      })}
    </ToggleGroup.Root>
  );
}

/**
 * Whether the widest label, unwrapped and at the selected weight, plus the
 * segment's padding and check, is wider than an equal share of the control.
 * Measured with canvas text metrics, so the answer does not depend on the
 * layout it chooses; re-measured when the control resizes or the text size
 * changes (which changes its height).
 */
function useStackWhenCramped(root: RefObject<HTMLElement | null>, count: number, labels: string): boolean {
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    const context = element && typeof ResizeObserver === "function" ? document.createElement("canvas").getContext("2d") : null;
    if (!element || !context) return;
    const measure = () => {
      const segment = element.querySelector<HTMLElement>("[data-segment]");
      if (!segment || element.clientWidth === 0) return;
      const style = getComputedStyle(segment);
      context.font = `600 ${style.fontSize} ${style.fontFamily}`;
      const widest = Math.max(...labels.split("\n").map((label) => context.measureText(label).width));
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      // Padding, then the check (0.875rem) and its gap (0.375rem), and 2px of slack for letter-spacing.
      const reserve = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight) + 1.25 * rem + 2;
      setStacked(widest + reserve > element.clientWidth / count);
    };
    measure();
    // A frame later, so a change of layout never lands inside the observer's own delivery.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    void document.fonts?.ready.then(measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [root, count, labels]);
  return stacked;
}
