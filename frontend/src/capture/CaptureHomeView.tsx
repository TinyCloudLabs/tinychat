// Capture's home (TC-761), as a pure function of its props: what is in
// progress, then the last five captures under Recent with See all (the
// Library). Before anything has been captured it says "Think out loud." (or
// "Bring in a conversation." where nothing records) and one short line.
// Beside the Library (wide screens) Recent is left out: the list is there.
import { Link } from "react-router-dom";

import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AppPlatform } from "@/lib/platform";
import { PATHS } from "@/shell/routes";
import { InProgressRowsView, inProgressShown, type InProgressRowsViewProps } from "./InProgressRows";
import type { LibraryStatus } from "./library/LibraryListView";
import { LibraryRow, type LibraryItem } from "./library/LibraryRow";

/** How many captures Recent shows. */
export const RECENT_COUNT = 5;

export function FirstUse(props: { platform: AppPlatform; className?: string }) {
  const records = props.platform !== "web";
  return (
    <div className={props.className} data-testid="capture-first-use">
      <p className="font-display text-display">{records ? "Think out loud." : "Bring in a conversation."}</p>
      <p className="mt-2 max-w-[34ch] text-body text-muted-foreground">Everything you capture is saved to your TinyCloud space.</p>
      <HowItWorksLink section="capture" className="mt-1" />
    </div>
  );
}

export function RecentList(props: { status: LibraryStatus; items: readonly LibraryItem[]; now: Date; onRetry: () => void }) {
  const items = props.items.slice(0, RECENT_COUNT);
  return (
    <section aria-labelledby="recent-title" data-testid="capture-recent">
      <div className="flex items-center justify-between gap-2">
        <h2 id="recent-title" className="text-headline">
          Recent
        </h2>
        <Link
          to={PATHS.library}
          className="tap-transparent -mr-2 flex h-11 items-center rounded-full px-2 text-callout font-medium text-primary transition-colors hover:bg-surface-2 active:bg-surface-2 fine:h-9"
        >
          See all
        </Link>
      </div>
      {props.status === "loading" && items.length === 0 ? (
        <div role="status">
          <span className="sr-only">Loading your recent captures…</span>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} shape="row" />
          ))}
        </div>
      ) : props.status === "failed" && items.length === 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 py-2">
          <p className="text-callout text-muted-foreground">Couldn’t load your recent captures.</p>
          <Button type="button" variant="link" className="px-0" onClick={props.onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <ul className="mt-1 flex flex-col">
          {items.map((item) => (
            <LibraryRow key={item.id} item={item} now={props.now} grouped={false} testId="recent-item" />
          ))}
        </ul>
      )}
    </section>
  );
}

export interface CaptureHomeViewProps {
  platform: AppPlatform;
  inProgress: InProgressRowsViewProps;
  /** The Library's list; null where the Library is on screen beside the home (wide). */
  recent: { status: LibraryStatus; items: readonly LibraryItem[] } | null;
  onRetryRecent: () => void;
  now: Date;
}

export function CaptureHomeView(props: CaptureHomeViewProps) {
  const { recent } = props;
  const busy = inProgressShown(props.inProgress);
  const firstUse = recent !== null && recent.status === "ready" && recent.items.length === 0 && !busy;
  return (
    <>
      <InProgressRowsView {...props.inProgress} />
      {firstUse ? (
        <FirstUse platform={props.platform} className="pt-2" />
      ) : recent !== null && (recent.items.length > 0 || recent.status !== "ready") ? (
        <RecentList status={recent.status} items={recent.items} now={props.now} onRetry={props.onRetryRecent} />
      ) : null}
    </>
  );
}
