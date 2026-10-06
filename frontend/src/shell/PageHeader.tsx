// A page's header (TC-761): sticky, 52 px, at the top of the page's own
// scroller. The title is large Literata at rest and collapses to the sans
// headline once content scrolls under the header; a hairline appears with it.
// On a phone on its side the title starts compact (there is no room to spare).
//
//   A root page (Capture, Connectors) keeps its large title in the header row,
//   beside its actions, and swaps it for the headline in place.
//   A pushed page (Library, Settings on a phone) has Back in the row and its
//   large title below; the headline fades into the row as the title leaves.
//
// The h1 is always the one in the row (tabIndex -1, so the shell can move focus
// to it after navigation); the large title of a pushed page is its visual twin.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronLeftIcon, SettingsIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { PATHS } from "./routes";

/** The header row's height, which the collapse is measured against. */
const ROW_PX = 52;

/**
 * A large title never outgrows a narrow screen: at most 28 px (20 px on its
 * side), and smaller only when the text is scaled up past what the width holds.
 */
const LARGE_TITLE_FIT = "[font-size:min(1.75rem,9vw)] land:[font-size:min(1.25rem,6vw)]";

export interface PageHeaderProps {
  title: string;
  /** Large Literata title at rest (default). False keeps the compact row only. */
  largeTitle?: boolean;
  /** Shows Back in the row; called when it is tapped. */
  back?: () => void;
  leading?: ReactNode;
  /** Actions at the end of the row (Settings, Library), 44 px targets. */
  trailing?: ReactNode;
  /** The row's width and gutters, to line up with the page's column. */
  className?: string;
}

export function PageHeader({ title, largeTitle = true, back, leading, trailing, className }: PageHeaderProps) {
  const [collapsed, setCollapsed] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pushed = back !== undefined;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // A hidden pane reports a zero box: leave the header as it was.
        if (entry && entry.rootBounds !== null && entry.rootBounds.height > 0) setCollapsed(!entry.isIntersecting);
      },
      { root: sentinel.closest("[data-scroll-root]"), rootMargin: `-${ROW_PX}px 0px 0px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const compact = collapsed || !largeTitle;
  return (
    <>
      <header
        data-collapsed={compact ? "true" : "false"}
        className={cn(
          "sticky top-0 z-10 border-b bg-background transition-colors duration-150",
          compact ? "border-border" : "border-transparent",
        )}
      >
        {/* One row at any normal text size; scaled-up text pushes the actions
            onto a second line rather than squeezing the title. */}
        <div className={cn("flex min-h-13 flex-wrap items-center gap-x-1", className)}>
          {back && (
            <button
              type="button"
              onClick={back}
              className="tap-transparent -ml-2 flex h-11 shrink-0 items-center gap-0.5 rounded-md pl-1 pr-2 text-body text-primary transition-opacity active:opacity-60"
            >
              <ChevronLeftIcon aria-hidden className="size-6" />
              Back
            </button>
          )}
          {leading}
          <h1 tabIndex={-1} className="relative min-w-0 flex-auto outline-none">
            {pushed ? (
              <span
                className={cn(
                  "block truncate text-headline transition-opacity duration-150",
                  "land:font-display land:text-title-2 land:opacity-100",
                  compact ? "opacity-100" : "opacity-0",
                )}
              >
                {title}
              </span>
            ) : (
              <>
                <span
                  className={cn(
                    "block truncate font-display text-title-1 transition-opacity duration-150 land:text-title-2",
                    LARGE_TITLE_FIT,
                    compact && "opacity-0",
                  )}
                >
                  {title}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-0 flex items-center truncate text-headline transition-opacity duration-150",
                    compact ? "opacity-100" : "opacity-0",
                  )}
                >
                  {title}
                </span>
              </>
            )}
          </h1>
          {trailing && <div className="-mr-2 ml-auto flex shrink-0 items-center gap-1">{trailing}</div>}
        </div>
      </header>
      {pushed && largeTitle && (
        <div aria-hidden className={cn("land:hidden", className)}>
          {/* Wraps (a note's title is the user's own words); one word is unchanged. */}
          <p className={cn("line-clamp-3 pb-1 pt-1 font-display text-title-1 [overflow-wrap:anywhere]", LARGE_TITLE_FIT)}>{title}</p>
        </div>
      )}
      {/* Collapses the header once it passes under the row: right after a
          pushed page's large title, or a little way into a root page. */}
      <div
        ref={sentinelRef}
        aria-hidden
        className={pushed ? "h-px" : "pointer-events-none absolute left-0 top-[5.25rem] h-px w-px"}
      />
    </>
  );
}

/** A page's column: centred, with the gutters of each size class. */
export const PAGE_COLUMN = "mx-auto w-full max-w-2xl px-4 medium:px-6 expanded:px-8";

/** Settings from a page header: on a phone held upright, where the navigation has no place for it. */
export function SettingsGear() {
  return (
    <Link
      to={PATHS.settings}
      aria-label="Settings"
      className="tap-transparent flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-2"
    >
      <SettingsIcon aria-hidden className="size-6" />
    </Link>
  );
}
