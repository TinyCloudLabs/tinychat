// Capture's home on the desktop layout (a rail or the sidebar, medium width
// and up; flag on): the Soft skin as one centred column. A quiet ring and
// Start recording (Back to recording · m:ss while the recorder is docked),
// Upload and Meeting, Connect existing meetings, what is still on this Mac,
// In progress, then Recent with its filters. The phone's home is
// ../SoftCaptureHome; this one shares its CSS and nothing else.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  CheckIcon,
  ChevronRightIcon,
  MicIcon,
  UploadIcon,
  VideoIcon,
  type LucideIcon,
} from "lucide-react";
import { useContext, useState } from "react";
import { Link } from "react-router-dom";

import { Skeleton } from "@/components/ui/skeleton";
import { PlatformContext } from "@/lib/platform";
import { nativeVoiceNotesAvailable } from "@/lib/voiceNotes/nativeVoiceNotes";
import { PATHS, notePath } from "@/shell/routes";
import {
  InProgressRowsView,
  inProgressShown,
  type InProgressRowsViewProps,
} from "../../InProgressRows";
import type { LibraryStatus } from "../../library/LibraryListView";
import {
  formatClockDuration,
  formatSpokenDuration,
  groupByDay,
} from "../../library/formatters";
import type { LibraryItem } from "../../library/LibraryRow";
import { libraryRowMeta } from "../../library/LibraryRow";
import { KIND_ICON, libraryKind } from "../../library/libraryKinds";
import { CaptureSettings } from "../../recorder/final/desktop/CaptureSettings";
import { Toasts } from "../../recorder/final/desktop/Toasts";
import { HaloRing } from "../../recorder/final/halo";
import type { RecorderLayout } from "../../recorder/final/shellCapabilities";
import { nativeAudioInputs } from "../../recorder/final/useAudioInputs";
import { recorderActive, useRecorder } from "../../recorder/RecorderProvider";
import { useRecordedElapsed } from "../../recorder/useRecordedElapsed";
import {
  issueHasSheet,
  type CaptureIssues,
  type HomeIssue,
} from "../captureIssues";
import { HOME_COPY } from "../homeCopy";
import { IssueSheet } from "../IssueSheet";
import { useSoftTheme } from "../softTheme";
import { useIssueController } from "../useIssueController";
import { desktopHomeCapabilities } from "./captureHomeKind";
import { ConnectMeetingsLink } from "./ConnectMeetingsLink";
import { DESKTOP_HOME_COPY as COPY, onThisMac } from "./desktopCopy";
import {
  desktopIssueMeta,
  desktopRecent,
  issueNeedsAttention,
  onMacNote,
  onMacTitle,
  RECENT_FILTERS,
  type DesktopEntry,
  type RecentFilter,
} from "./desktopRecent";
import "../../recorder/final/desktop/desktop.css";
import "./desktopHome.css";

export interface DesktopCaptureHomeProps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  layout: Exclude<RecorderLayout, "phone">;
  inProgress: InProgressRowsViewProps;
  recent: { status: LibraryStatus; items: readonly LibraryItem[] };
  onRetryRecent: () => void;
  onUpload: () => void;
  /** Absent while the notetaker is not available. */
  onMeeting?: () => void;
  now: Date;
}

function IdleHero(props: { theme: "night" | "day" }) {
  const recorder = useRecorder();
  const disabled = !recorder.ready;
  return (
    <div className="dch-hero" data-state="idle">
      <button
        type="button"
        className="dch-ring"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        onClick={recorder.record}
      >
        <HaloRing size={118} ticks={40} theme={props.theme} still />
      </button>
      <button
        type="button"
        className="dch-start"
        onClick={recorder.record}
        disabled={disabled}
        aria-label={COPY.startLabel}
        data-testid="voice-note-record"
      >
        <i className="dch-dot" aria-hidden="true" />
        {COPY.start}
      </button>
    </div>
  );
}

function DockedHero() {
  const recorder = useRecorder();
  const elapsedMs = useRecordedElapsed(recorder.elapsedMs, recorder);
  return (
    <div className="dch-hero" data-state="docked">
      <button
        type="button"
        className="dch-start"
        onClick={recorder.openSheet}
        aria-label={COPY.back}
        data-testid="capture-open-recorder"
      >
        <i className="dch-dot" aria-hidden="true" />
        <span>
          {COPY.back} ·{" "}
          <span className="tnum">
            {formatClockDuration(Math.floor(elapsedMs / 1000))}
          </span>
        </span>
      </button>
    </div>
  );
}

export function Hero(props: { theme: "night" | "day" }) {
  const recorder = useRecorder();
  return recorderActive(recorder) ? (
    <DockedHero />
  ) : (
    <IdleHero theme={props.theme} />
  );
}

function ActionPill(props: {
  icon: LucideIcon;
  label: string;
  ariaLabel: string;
  testId: string;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      className="dch-act"
      onClick={props.onClick}
      aria-label={props.ariaLabel}
      data-testid={props.testId}
    >
      <Icon className="soft-ico" aria-hidden="true" />
      {props.label}
    </button>
  );
}

export function OnThisMacCard(props: {
  count: number;
  saving: boolean;
  note: string;
  onSaveNow: () => void;
}) {
  return (
    <div className="soft-card dch-mac" data-testid="voice-note-pending">
      <MicIcon className="soft-ico soft-card-icon" aria-hidden="true" />
      <div className="soft-card-text">
        <b>{onMacTitle(props.count)}</b>
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
          {COPY.saveNow}
        </button>
      </span>
    </div>
  );
}

function InProgress(props: {
  inProgress: InProgressRowsViewProps;
  macCard: boolean;
  issues: CaptureIssues;
}) {
  const { voice } = props.inProgress;
  const count = voice?.listing.state === "ok" ? voice.listing.count : 0;
  const card = props.macCard && voice !== undefined && count > 0;
  // The voice-note row is the card's (or, on the web, nobody's: it says "on this phone"); the rest show as they are.
  const rest: InProgressRowsViewProps = voice
    ? {
        ...props.inProgress,
        voice: { ...voice, listing: { state: "unknown" } },
      }
    : props.inProgress;
  const restShown = inProgressShown(rest);
  if (!card && !restShown) return null;
  return (
    <section
      aria-labelledby="dch-in-progress-title"
      className="dch-in-progress"
      data-testid="soft-in-progress"
    >
      {card && (
        <>
          <h2 id="dch-in-progress-title" className="soft-sect">
            {COPY.inProgress}
          </h2>
          <OnThisMacCard
            count={count}
            saving={voice.saving}
            note={onMacNote(props.issues, voice.lastError)}
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

function rowLabel(parts: {
  title: string;
  meta: string;
  durationSecs: number | null;
  attention: boolean;
  opensDetails: boolean;
}): string {
  const label = [parts.title, parts.meta];
  if (parts.durationSecs !== null)
    label.push(formatSpokenDuration(parts.durationSecs));
  if (parts.attention) label.push(HOME_COPY.needsAttention);
  if (parts.opensDetails) label.push(HOME_COPY.opensDetails);
  return label.filter(Boolean).join(". ");
}

export function RecentRow(props: {
  entry: DesktopEntry;
  now: Date;
  grouped: boolean;
  onDismiss: (id: string) => void;
  /** A tap on a row whose failure has a sheet: the recording's id, and the row to return focus to. */
  onOpenIssue: (id: string, row: HTMLElement) => void;
}) {
  const { entry } = props;
  let icon: LucideIcon = MicIcon;
  let title: string = COPY.voiceNoteTitle;
  let meta: string;
  let durationSecs: number | null = null;
  let href: string | undefined;
  let attention = false;
  let dismissId: string | undefined;
  let sourceId: string | undefined;
  let issueKind: HomeIssue["kind"] | undefined;
  let sheetId: string | undefined;
  if (entry.type === "item") {
    const { item } = entry;
    icon = KIND_ICON[libraryKind(item.source)];
    title = item.title ?? "Untitled";
    durationSecs = item.durationSecs;
    href = notePath(item.id);
    if (libraryKind(item.source) === "note") sourceId = item.sourceId;
    meta = libraryRowMeta(item, props.now, props.grouped);
    if (entry.partialId !== undefined) {
      meta = COPY.partialAudio;
      dismissId = entry.partialId;
      issueKind = "partial_audio";
    } else if (entry.issue) {
      meta = desktopIssueMeta(entry.issue);
      attention = issueNeedsAttention(entry.issue);
      issueKind = entry.issue.kind;
      if (issueHasSheet(entry.issue)) sheetId = item.sourceId;
    }
  } else if (entry.type === "partial") {
    meta = COPY.partialAudio;
    dismissId = entry.id;
    sourceId = entry.id;
    issueKind = "partial_audio";
  } else {
    meta = desktopIssueMeta(entry.issue);
    attention = issueNeedsAttention(entry.issue);
    sourceId = entry.id;
    issueKind = entry.issue.kind;
    if (issueHasSheet(entry.issue)) sheetId = entry.id;
  }
  const Icon = icon;
  const body = (
    <>
      <span
        className="soft-tile"
        aria-hidden="true"
        data-failed={attention ? "true" : undefined}
      >
        {attention ? (
          <span className="soft-tile-bang">!</span>
        ) : (
          <Icon className="soft-ico" />
        )}
      </span>
      <span className="soft-row-text">
        <b className="soft-row-title">{title}</b>
        <span
          className="soft-row-meta"
          data-failed={attention ? "true" : undefined}
        >
          {issueKind === "finalization_timed_out" && (
            <span className="soft-spinner" aria-hidden="true" />
          )}
          {meta}
        </span>
      </span>
      {(durationSecs !== null || href !== undefined || sheetId !== undefined) && (
        <span className="soft-row-aside" aria-hidden="true">
          {durationSecs !== null && (
            <span className="tnum">{formatClockDuration(durationSecs)}</span>
          )}
          {(href !== undefined || sheetId !== undefined) && (
            <ChevronRightIcon className="soft-chev" />
          )}
        </span>
      )}
    </>
  );
  const label = rowLabel({
    title,
    meta,
    durationSecs,
    attention,
    opensDetails: sheetId !== undefined,
  });
  return (
    <li
      className="soft-row-item dch-row-item"
      data-testid="recent-item"
      data-source-id={sourceId}
      data-issue={issueKind}
    >
      {sheetId !== undefined ? (
        <button
          type="button"
          className="soft-row"
          aria-label={label}
          onClick={(event) => props.onOpenIssue(sheetId, event.currentTarget)}
        >
          {body}
        </button>
      ) : href !== undefined ? (
        <Link to={href} className="soft-row" aria-label={label}>
          {body}
        </Link>
      ) : (
        <div role="group" className="soft-row" aria-label={label}>
          {body}
        </div>
      )}
      {dismissId !== undefined && (
        <button
          type="button"
          className="dch-dismiss"
          aria-label={COPY.dismissLabel(title)}
          onClick={() => props.onDismiss(dismissId)}
          data-testid="capture-issue-dismiss"
        >
          {COPY.dismiss}
        </button>
      )}
    </li>
  );
}

export function FilterChips(props: {
  value: RecentFilter;
  onChange: (value: RecentFilter) => void;
}) {
  return (
    <div role="group" aria-label={COPY.filters} className="dch-chips">
      {RECENT_FILTERS.map((chip) => {
        const on = props.value === chip.value;
        return (
          <button
            key={chip.value}
            type="button"
            className="dch-chip"
            aria-pressed={on}
            onClick={() => props.onChange(chip.value)}
            data-testid={`recent-filter-${chip.value}`}
          >
            {on && <CheckIcon className="dch-chip-check" aria-hidden="true" />}
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

export function RecentView(props: {
  status: LibraryStatus;
  items: readonly LibraryItem[];
  issues: CaptureIssues;
  filter: RecentFilter;
  onFilter: (value: RecentFilter) => void;
  onRetry: () => void;
  onDismiss: (id: string) => void;
  onOpenIssue: (id: string, row: HTMLElement) => void;
  now: Date;
}) {
  const { attention, items } = desktopRecent(
    props.items,
    props.issues,
    props.filter,
  );
  const none = attention.length === 0 && items.length === 0;
  const groups = groupByDay(items, props.now);
  return (
    <section
      aria-labelledby="dch-recent-title"
      className="dch-recent"
      data-return-focus=""
      data-testid="capture-recent"
    >
      <div className="dch-recent-head">
        <h2
          id="dch-recent-title"
          className="dch-recent-title soft-title"
          tabIndex={-1}
          data-return-focus-target=""
        >
          {COPY.recent}
        </h2>
        <FilterChips value={props.filter} onChange={props.onFilter} />
      </div>
      {props.status === "loading" && none ? (
        <div role="status">
          <span className="sr-only">{COPY.loadingRecent}</span>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} shape="row" />
          ))}
        </div>
      ) : props.status === "failed" && none ? (
        <div className="soft-failed">
          <p>{COPY.recentFailed}</p>
          <button type="button" className="soft-link" onClick={props.onRetry}>
            {COPY.retryRecent}
          </button>
        </div>
      ) : none ? (
        <p className="soft-empty" data-testid="capture-recent-empty">
          {props.filter === "all" || props.items.length === 0
            ? COPY.recentEmpty
            : COPY.filterEmpty[props.filter]}
        </p>
      ) : (
        <>
          {attention.length > 0 && (
            <ul className="soft-list">
              {attention.map((entry) => (
                <RecentRow
                  key={`issue-${entry.type === "item" ? entry.item.id : entry.id}`}
                  entry={entry}
                  now={props.now}
                  grouped={false}
                  onDismiss={props.onDismiss}
                  onOpenIssue={props.onOpenIssue}
                />
              ))}
            </ul>
          )}
          {groups.map((group) => (
            <div key={group.label} className="dch-day">
              <h3 className="dch-day-label">{group.label}</h3>
              <ul className="soft-list">
                {group.items.map((entry) => (
                  <RecentRow
                    key={entry.item.id}
                    entry={entry}
                    now={props.now}
                    grouped
                    onDismiss={props.onDismiss}
                    onOpenIssue={props.onOpenIssue}
                  />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

export function DesktopCaptureHome(props: DesktopCaptureHomeProps) {
  const recorder = useRecorder();
  const platform = useContext(PlatformContext);
  const softTheme = useSoftTheme();
  const theme = softTheme === "soft-night" ? "night" : "day";
  const caps = desktopHomeCapabilities(platform, props.layout);
  const [filter, setFilter] = useState<RecentFilter>("all");
  // The same issue state and sheet as the phone home, over the recorder's issues and what native parked.
  const issues = useIssueController(true, recorder.captureIssues);
  return (
    <div
      className={`soft-skin soft-home ${softTheme} dch`}
      data-layout={props.layout}
      data-testid="desktop-capture-home"
    >
      {!recorder.sheetOpen && <Toasts />}
      <div className="dch-scroll" data-scroll-root="">
        <div className="dch-col">
          <header className="dch-head">
            <h1 className="dch-title soft-title" tabIndex={-1}>
              {COPY.heading}
            </h1>
            <div className="dch-head-actions">
              <Link
                to={PATHS.library}
                className="soft-header-link"
                data-testid="capture-library-link"
              >
                {COPY.library}
              </Link>
              {caps.settings !== null && (
                <CaptureSettings
                  variant={caps.settings}
                  inputs={
                    nativeVoiceNotesAvailable() ? nativeAudioInputs : null
                  }
                />
              )}
            </div>
          </header>
          <Hero theme={theme} />
          <div className="dch-actions" data-testid="capture-actions">
            <ActionPill
              icon={UploadIcon}
              label={COPY.upload}
              ariaLabel={COPY.uploadLabel}
              testId="capture-upload"
              onClick={props.onUpload}
            />
            {props.onMeeting && (
              <ActionPill
                icon={VideoIcon}
                label={COPY.meeting}
                ariaLabel={COPY.meetingLabel}
                testId="capture-meeting"
                onClick={props.onMeeting}
              />
            )}
          </div>
          {caps.connectMeetings && (
            <ConnectMeetingsLink
              tcw={props.tcw}
              backendUrl={props.backendUrl}
              sessionStore={props.sessionStore}
            />
          )}
          <InProgress
            inProgress={props.inProgress}
            macCard={caps.onThisMac}
            issues={issues.issues}
          />
          {issues.quarantineFailed && (
            <p
              role="alert"
              className="soft-quiet"
              data-testid="quarantine-failure"
            >
              {HOME_COPY.quarantineFailure}
            </p>
          )}
          {recorder.recoveryScanFailure !== null && (
            <p className="soft-quiet" data-testid="recovery-scan-failure">
              {COPY.scanFailure}
            </p>
          )}
          <RecentView
            status={props.recent.status}
            items={props.recent.items}
            issues={issues.issues}
            filter={filter}
            onFilter={setFilter}
            onRetry={props.onRetryRecent}
            onDismiss={recorder.dismissCaptureIssue}
            onOpenIssue={issues.openIssue}
            now={props.now}
          />
        </div>
      </div>
      <IssueSheet {...issues.sheet} layout="desktop" text={onThisMac} />
    </div>
  );
}
