import { cn } from "@/lib/utils";
import { badgePillLabel } from "../chat/useBackgroundDrain";

/**
 * The count on a navigation item (meetings waiting in Connectors). An
 * aria-hidden absolute pill inside the item's relative box, so it never moves
 * the layout; the item's accessible name (connectorsAriaLabel, navItems.ts)
 * carries the exact number, and the pill clamps at 99+.
 */
export function NavBadge({ count, className }: { count: number | undefined; className?: string }) {
  if (!count || count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-label font-semibold tabular-nums text-primary-foreground",
        className,
      )}
    >
      {badgePillLabel(count)}
    </span>
  );
}
