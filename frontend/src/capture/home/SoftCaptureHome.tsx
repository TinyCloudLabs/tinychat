// Capture's home in the Soft skin (TC-871), as a pure function of its props
// and the SoftHomeProvider above it: what is in progress (the "on this phone"
// card, app only, and the other In progress rows as they are), one quiet card
// when the last unfinished-recordings check failed, then Recent with See all.
// Rows with a capture issue show it; the recorder clears an issue itself.
import { MicIcon } from "lucide-react";
import { Link } from "react-router-dom";

import { Skeleton } from "@/components/ui/skeleton";
import { PATHS } from "@/shell/routes";
import {
  InProgressRowsView,
  inProgressShown,
  type InProgressRowsViewProps,
} from "../InProgressRows";
import type { LibraryStatus } from "../library/LibraryListView";
import { LibraryRow, type LibraryItem } from "../library/LibraryRow";
import { cardNote, recentEntries } from "./captureIssues";
import { HOME_COPY } from "./homeCopy";
import { SoftIssueRow } from "./SoftIssueRow";
import { useSoftHome } from "./softHome";

/** How many captures Recent shows. */
const RECENT_COUNT = 5;

export interface SoftCaptureHomeProps {
  inProgress: InProgressRowsViewProps;
  recent: { status: LibraryStatus; items: readonly LibraryItem[] };
  /** The recorder's `recoveryScanFailure`: the start-up check for unfinished recordings failed. */
  scanFailure: string | null;
  onRetryRecent: () => void;
  now: Date;
}

function OnThisPhoneCard(props: {
  count: number;
  saving: boolean;
  note: string;
  onSaveNow: () => void;
}) {
  return (
    <div className="soft-card" data-testid="voice-note-pending">
      <MicIcon className="soft-ico soft-card-icon" aria-hidden="true" />
      <div className="soft-card-text">
        <b>
          {props.count === 1
            ? HOME_COPY.onPhoneOne
            : HOME_COPY.onPhoneMany(props.count)}
        </b>
        <span data-testid="voice-note-pending-note">{props.note}</span>
      </div>
      <span className="soft-pill-hit" data-hit-area="">
        <button
          type="button"
          className="soft-pill"
          onClick={props.onSaveNow}
          disabled={props.saving}
          data-testid="voice-note-retry"
        >
          {HOME_COPY.saveNow}
        </button>
      </span>
    </div>
  );
}

function InProgress(props: { inProgress: InProgressRowsViewProps }) {
  const soft = useSoftHome();
  const { voice } = props.inProgress;
  const count = voice?.listing.state === "ok" ? voice.listing.count : 0;
  const card = voice !== undefined && count > 0;
  // The card replaces the plain pending row; everything else still shows as it does.
  const rest: InProgressRowsViewProps = card
    ? {
        ...props.inProgress,
        voice: { ...voice, listing: { state: "unknown" } },
      }
    : props.inProgress;
  const restShown = inProgressShown(rest);
  if (!card && !restShown) return null;
  return (
    <section
      aria-labelledby="soft-in-progress-title"
      className="soft-in-progress"
      data-with-card={card ? "true" : undefined}
      data-testid="soft-in-progress"
    >
      {card && (
        <>
          <h2 id="soft-in-progress-title" className="soft-sect">
            {HOME_COPY.inProgress}
          </h2>
          <OnThisPhoneCard
            count={count}
            saving={voice.saving}
            note={voice.lastError ?? (voice.saving ? HOME_COPY.savingToSpace : cardNote(soft?.issues ?? {}, null))}
            onSaveNow={voice.onSaveNow}
          />
        </>
      )}
      {restShown && (
        <div className="soft-legacy" data-with-card={card ? "true" : undefined}>
          <InProgressRowsView {...rest} />
        </div>
      )}
    </section>
  );
}

function Recent(props: SoftCaptureHomeProps) {
  const soft = useSoftHome();
  const { status, items } = props.recent;
  const entries = recentEntries(items, soft?.issues ?? {}, RECENT_COUNT);
  return (
    <section
      aria-labelledby="recent-title"
      className="soft-recent"
      data-return-focus=""
      data-testid="capture-recent"
    >
      <div className="soft-sect-row">
        <h2
          id="recent-title"
          className="soft-sect"
          tabIndex={-1}
          data-return-focus-target=""
        >
          {HOME_COPY.recent}
        </h2>
        <Link to={PATHS.library} className="soft-link">
          {HOME_COPY.seeAll}
        </Link>
      </div>
      {status === "loading" && entries.length === 0 ? (
        <div role="status">
          <span className="sr-only">{HOME_COPY.loadingRecent}</span>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} shape="row" />
          ))}
        </div>
      ) : status === "failed" && entries.length === 0 ? (
        <div className="soft-failed">
          <p>{HOME_COPY.recentFailed}</p>
          <button
            type="button"
            className="soft-link"
            onClick={props.onRetryRecent}
          >
            {HOME_COPY.retryRecent}
          </button>
        </div>
      ) : entries.length === 0 ? (
        <p className="soft-empty" data-testid="capture-recent-empty">
          {HOME_COPY.recentEmpty}
        </p>
      ) : (
        <ul className="soft-list">
          {entries.map((entry) =>
            entry.type === "item" ? (
              <LibraryRow
                key={entry.item.id}
                item={entry.item}
                now={props.now}
                grouped={false}
                testId="recent-item"
              />
            ) : (
              <SoftIssueRow
                key={`issue-${entry.id}`}
                id={entry.id}
                issue={entry.issue}
                testId="recent-item"
              />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

export function SoftCaptureHome(props: SoftCaptureHomeProps) {
  const soft = useSoftHome();
  return (
    <>
      <InProgress inProgress={props.inProgress} />
      {soft?.quarantineFailed && (
        <p role="alert" className="soft-quiet" data-testid="quarantine-failure">
          {HOME_COPY.quarantineFailure}
        </p>
      )}
      {props.scanFailure !== null && (
        <p className="soft-quiet" data-testid="recovery-scan-failure">
          {HOME_COPY.scanFailure}
        </p>
      )}
      <Recent {...props} />
    </>
  );
}
