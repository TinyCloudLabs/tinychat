import type * as React from "react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";

/**
 * One row of a list (shadcn's Item pattern): an optional leading icon, a
 * title over a meta line, and an aside (a duration, a chevron) inside one tap
 * target, a Link or a button. `trailing` sits beside that target, never inside
 * it, so interactive controls never nest. A selected row (the note open beside
 * the list) gets the selected tint, an inner edge, a heavier title and
 * `aria-current`. 56 px tall on touch, 44 px with a mouse.
 */
export interface ListRowProps {
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  /** Inside the tap target, after the text: not interactive. */
  aside?: React.ReactNode;
  /** Beside the tap target: buttons and links of its own. */
  trailing?: React.ReactNode;
  href?: string;
  onClick?: () => void;
  selected?: boolean;
  /** How many lines the title may take before it is cut (default 1). */
  titleLines?: 1 | 2;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}

export function ListRow({ leading, title, meta, aside, trailing, href, onClick, selected = false, titleLines = 1, className, ...data }: ListRowProps) {
  const main = cn(
    "tap-transparent flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors fine:min-h-11",
    "hover:bg-surface-2 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    selected && "bg-selected ring-1 ring-inset ring-primary hover:bg-selected",
  );
  const body = (
    <>
      {leading && (
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground [&_svg]:size-5">
          {leading}
        </span>
      )}
      {/* Long text wraps inside its lines and is cut at the last one, never pushed out sideways. */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("text-body [overflow-wrap:anywhere]", titleLines === 1 ? "line-clamp-1" : "line-clamp-2", selected && "font-semibold")}>
          {title}
        </span>
        {meta && <span className="line-clamp-1 text-meta text-muted-foreground [overflow-wrap:anywhere]">{meta}</span>}
      </span>
      {aside}
    </>
  );
  return (
    <li className={cn("flex items-center gap-2", className)} {...data}>
      {href !== undefined ? (
        <Link to={href} onClick={onClick} className={main} aria-current={selected ? "page" : undefined}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onClick} className={main} aria-current={selected ? "true" : undefined}>
          {body}
        </button>
      )}
      {trailing}
    </li>
  );
}
