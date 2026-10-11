// Capture's home in the Soft skin (TC-871), as a pure function of its props
// and the SoftHomeProvider above it: what is in progress (the "on this phone"
// card, app only, and the other In progress rows as they are), one quiet card
// when the last unfinished-recordings check failed, then Recent with See all.
// Rows with a capture issue show it; the recorder clears an issue itself.
import { Link, useNavigate } from "react-router-dom";

import { Skeleton } from "@/components/ui/skeleton";
import { notePath, PATHS } from "@/shell/routes";
import {
  InProgressRowsView,
  inProgressShown,
  type InProgressRowsViewProps,
} from "../InProgressRows";
import type { LibraryStatus } from "../library/LibraryListView";
import { LibraryRow, libraryRowTitle, type LibraryItem } from "../library/LibraryRow";
import { recentEntries } from "./captureIssues";
import { HOME_COPY } from "./homeCopy";
import { SoftIssueRow } from "./SoftIssueRow";
import { useSoftHome } from "./softHome";
import { InProgressVoiceCard, type InProgressNoteRow, type ModelProgress } from "./InProgressVoiceCard";
import type { NotePipeline, PipelineActionKind } from "@/lib/voiceNotes/notePipeline";
import { formatClockDuration, formatSpokenDuration } from "../library/formatters";

/** How many captures Recent shows. */
const RECENT_COUNT = 5;

export interface SoftCaptureHomeProps {
  inProgress: InProgressRowsViewProps;
  recent: { status: LibraryStatus; items: readonly LibraryItem[] };
  /** The recorder's `recoveryScanFailure`: the start-up check for unfinished recordings failed. */
  scanFailure: string | null;
  onRetryRecent: () => void;
  onOpenRecentNote?: (id: string) => void;
  pipelines?: ReadonlyMap<string, NotePipeline>;
  pipelineNotes?: readonly LibraryItem[];
  modelProgress?: ModelProgress | null;
  onPipelineAction: (kind: PipelineActionKind, noteId: string) => void;
  pipelineActionError?: string | null;
  onOpenLibrary: () => void;
  now: Date;
}

function InProgress(props: Pick<SoftCaptureHomeProps, "inProgress" | "pipelineNotes" | "pipelines" | "modelProgress" | "onPipelineAction" | "pipelineActionError" | "onOpenRecentNote" | "onOpenLibrary">) {
  const navigate = useNavigate();
  const { voice } = props.inProgress;
  const count = voice?.listing.state === "ok" ? voice.listing.count : 0;
  const cardRows: InProgressNoteRow[] = (props.pipelineNotes ?? [])
    .filter((item) => item.source === "exo-voice-note")
    .flatMap((item) => {
      const pipeline = props.pipelines?.get(item.sourceId);
      return pipeline && !pipeline.done ? [{
        id: item.id,
        pipelineId: item.sourceId,
        title: libraryRowTitle(item),
        duration: item.durationSecs === null ? null : formatClockDuration(item.durationSecs),
        spokenDuration: item.durationSecs === null ? null : formatSpokenDuration(item.durationSecs),
        pipeline,
      }] : [];
    });
  const card = cardRows.length > 0;
  const pendingNotes = voice?.pendingNotes ?? [];
  const saveNowEligible = voice !== undefined
    && voice.listing.state === "ok"
    && voice.listing.count > 0
    && voice.online === true
    && !voice.saving
    && !pendingNotes.some((note) => note.upload?.state === "uploading" || note.upload?.state === "retrying")
    && !cardRows.some((row) => row.pipeline.steps.some((step) => step.state === "active"))
    && !cardRows.some((row) => row.pipeline.blocker?.action !== undefined)
    && cardRows.some((row) => {
      const space = row.pipeline.steps.find((step) => step.key === "space");
      return row.pipeline.current === "space" && space?.state === "waiting";
    });
  // The card replaces the plain pending row; everything else still shows as it does.
  const rest: InProgressRowsViewProps = voice !== undefined && count > 0
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
          <InProgressVoiceCard
            rows={cardRows}
            model={props.modelProgress}
            onOpen={(id) => props.onOpenRecentNote ? props.onOpenRecentNote(id) : navigate(notePath(id))}
            onAction={props.onPipelineAction}
            {...(saveNowEligible && voice ? { onSaveNow: voice.onSaveNow } : {})}
            actionError={props.pipelineActionError}
            onOpenLibrary={props.onOpenLibrary}
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
                onRecentOpen={props.onOpenRecentNote}
                pipeline={props.pipelines?.get(entry.item.sourceId)}
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
      <InProgress {...props} />
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
