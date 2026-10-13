import { cn } from "@/lib/utils";

/**
 * A placeholder while something loads (shadcn's Skeleton): a row (icon and two
 * lines), lines of text, or a circle. It pulses, and holds still with reduced
 * motion. Hidden from assistive tech; the caller says "Loading" once.
 */
export function Skeleton({ shape = "text", lines = 1, className }: { shape?: "row" | "text" | "circle"; lines?: number; className?: string }) {
  const bar = "rounded-md bg-surface-2 animate-pulse motion-reduce:animate-none";
  if (shape === "circle") return <span aria-hidden="true" className={cn("block size-9 rounded-full", bar, className)} />;
  if (shape === "row") {
    return (
      <span aria-hidden="true" data-skeleton="row" className={cn("flex min-h-14 items-center gap-3 px-2 fine:min-h-11", className)}>
        <span className={cn("size-9 shrink-0", bar)} />
        <span className="flex flex-1 flex-col gap-2">
          <span className={cn("h-3.5 w-3/5", bar)} />
          <span className={cn("h-3 w-2/5", bar)} />
        </span>
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className={cn("h-3.5", bar, i === lines - 1 && lines > 1 ? "w-2/3" : "w-full")} />
      ))}
    </span>
  );
}
