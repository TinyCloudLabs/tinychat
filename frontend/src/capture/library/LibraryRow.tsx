// One Library row (TC-761): the kind's icon, the title, where it came from and
// when, and its length as a tabular clock time. The whole row opens the note.
// A voice note is titled by its own words ("Voice note" when it has none) and its line is "7:16 PM · 0:14",
// so notes recorded minutes apart tell apart. It keeps the smoke script's `voice-note-item` and `data-source-id`.
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import { ListRow } from "@/components/ui/list-row";
import type { MeetingListItem } from "@/lib/connectors/meetingExplorer";
import { notePath } from "@/shell/routes";
import { issueForItem, issueHasSheet, issueIsInformational } from "../home/captureIssues";
import { HOME_COPY } from "../home/homeCopy";
import { SoftRow } from "../home/SoftRow";
import { useSoftHome } from "../home/softHome";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { formatClockDuration, rowWhen } from "./formatters";
import { RecordingTitleEditField, RenameRecordingButton, useRecordingTitleEdit, useUserTitle } from "./rename/RecordingRename";
import { RowBadge } from "./RowBadge";
import { KIND_ICON, libraryKind, librarySourceLabel } from "./libraryKinds";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { AppPlatform } from "@/lib/platform";
import { activityForNote, noteStatus } from "../activity/activitySelector";
import { pipelineTranscriptStatus } from "../pipeline/PipelineTrackSummary";

export type LibraryItem = MeetingListItem & {
  /** A voice note on this device with no row in the space yet. */
  onPhone?: true;
  /** A voice note whose row is in the space while this device still holds its copy. */
  saving?: true;
  /** The recording remains on this device after its space row has synced. */
  hasLocalAudio?: true;
  /** The recording's audio is verified ready on this device (native ledger), so the storage-full copy may claim it. */
  localAudioReady?: true;
  /** A voice note's own words (its first moment, else its transcript), which title its row. */
  snippet?: string | null;
};

const isVoiceNote = (item: LibraryItem): boolean => item.source === VOICE_NOTE_SOURCE;
const isPasted = (item: LibraryItem): boolean => item.metadata?.capture === "pasted";

/** A voice note: its own words, else "Voice note" (never the date: a day's group or the line below has it). */
export function libraryRowTitle(item: LibraryItem): string {
  return isVoiceNote(item) && !isPasted(item) ? (item.snippet ?? HOME_COPY.voiceNoteTitle) : (item.title ?? "Untitled");
}

/** "Fireflies · 2:00 PM"; a voice note's is "7:16 PM · 0:14" (the mic says what it is). */
export function libraryRowMeta(item: LibraryItem, now: Date, grouped: boolean): string {
  const when = rowWhen(item.startedAt, now, grouped);
  const parts = isPasted(item) ? ["Pasted transcript", when] : isVoiceNote(item)
    ? [when, item.durationSecs !== null ? formatClockDuration(item.durationSecs) : null]
    : [librarySourceLabel(item.source), when];
  return parts.filter((part): part is string => !!part).join(" · ");
}

/** A local note names its device; pending work is described by the shared Activity selector. */
export function libraryRowBadge(item: LibraryItem, where: string = HOME_COPY.onThisPhone): string | null {
  if (item.onPhone) return where.charAt(0).toUpperCase() + where.slice(1);
  if (item.metadata?.audio_stored === 0) {
    const platform = item.metadata.audio_device_platform;
    if (item.hasLocalAudio || item.saving) return `Audio stays on this ${platform === "tauri" || platform === "mac" ? "Mac" : platform === "web" ? "browser" : "phone"}`;
    return `Audio is on your ${platform === "ios" ? "iPhone" : platform === "tauri" || platform === "mac" ? "Mac" : platform === "android" ? "phone" : "browser"}`;
  }
  return null;
}

/** The length on the row's right: a voice note's is in its line, unless something replaced the line. */
export function libraryRowAsideDuration(item: LibraryItem, lineReplaced: boolean): number | null {
  return isVoiceNote(item) && !lineReplaced ? null : item.durationSecs;
}

export interface LibraryRowProps { item: LibraryItem; now: Date; grouped: boolean; selected?: boolean; testId?: string; onRecentOpen?: (id: string) => void; pipeline?: NotePipeline; activityView?: NotePipelineView; platform?: AppPlatform }

function LibraryRowContent(props: LibraryRowProps & { activityStatus: string | null }) {
  const { item } = props;
  const Icon = KIND_ICON[libraryKind(item.source)];
  const voiceNote = libraryKind(item.source) === "note";
  const soft = useSoftHome();
  const status = props.activityStatus;
  const badge = status ? null : libraryRowBadge(item);
  const transcriptStatus = props.pipeline ? pipelineTranscriptStatus(props.pipeline) : null;
  const title = useUserTitle(item) ?? libraryRowTitle(item);
  const edit = useRecordingTitleEdit(item, title);
  if (soft) {
    const issue = issueForItem(item, soft.issues);
    const lineReplaced = issue !== undefined && !issueIsInformational(issue);
    return (
      <SoftRow
        icon={Icon}
        title={title}
        meta={libraryRowMeta(item, props.now, props.grouped)}
        badge={lineReplaced || (isVoiceNote(item) && item.metadata?.audio_stored !== 0) ? undefined : (badge ?? undefined)}
        pipeline={status ? undefined : isVoiceNote(item) ? props.pipeline : undefined}
        activityStatus={status}
        durationSecs={libraryRowAsideDuration(item, lineReplaced)}
        issue={issue}
        onDetails={issue && issueIsInformational(issue) ? (opener: HTMLElement) => soft.openIssue(item.sourceId, opener) : undefined}
        {...(issue && issueHasSheet(issue)
          ? { onActivate: (row: HTMLElement) => soft.openIssue(item.sourceId, row) }
          : props.onRecentOpen && isVoiceNote(item)
            ? { onActivate: () => props.onRecentOpen?.(item.id) }
            : { href: notePath(item.id) })}
        selected={props.selected}
        testId={props.testId ?? (voiceNote ? "voice-note-item" : "library-item")}
        sourceId={voiceNote ? item.sourceId : undefined}
        {...(edit ? { editor: edit.editing ? <RecordingTitleEditField edit={edit} /> : undefined, trailing: edit.editing ? undefined : <RenameRecordingButton edit={edit} /> } : {})}
      />
    );
  }
  if (edit?.editing) {
    return <li className="flex items-center gap-2 px-2 py-1" data-testid={props.testId ?? (voiceNote ? "voice-note-item" : "library-item")} data-source-id={voiceNote ? item.sourceId : undefined}><RecordingTitleEditField edit={edit} /></li>;
  }
  return (
    <ListRow
      trailing={edit ? <RenameRecordingButton edit={edit} /> : undefined}
      href={notePath(item.id)}
      leading={<Icon />}
      title={title}
      selected={props.selected}
      meta={
        <>
          {badge && <RowBadge>{badge}</RowBadge>}
          {libraryRowMeta(item, props.now, props.grouped)}
          {!status && transcriptStatus && ` · ${transcriptStatus}`}
        </>
      }
      aside={
        <span className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">
          {status && <span className={status.startsWith("Needs attention") ? "max-w-40 text-right text-amber-700 [overflow-wrap:anywhere] dark:text-amber-300" : "max-w-40 text-right [overflow-wrap:anywhere]"} data-testid="library-note-status">{status}</span>}
          {item.durationSecs !== null && !isVoiceNote(item) && <span className="tnum">{formatClockDuration(item.durationSecs)}</span>}
          <ChevronRightIcon aria-hidden="true" className="size-4" />
        </span>
      }
      data-testid={props.testId ?? (voiceNote ? "voice-note-item" : "library-item")}
      data-source-id={voiceNote ? item.sourceId : undefined}
    />
  );
}

const MemoLibraryRowContent = memo(LibraryRowContent, (before, after) => before.item === after.item &&
  Math.floor(before.now.getTime() / 60_000) === Math.floor(after.now.getTime() / 60_000) &&
  before.grouped === after.grouped && before.selected === after.selected && before.testId === after.testId &&
  before.onRecentOpen === after.onRecentOpen && before.platform === after.platform && before.activityStatus === after.activityStatus &&
  (before.activityStatus !== null || after.activityStatus !== null || before.pipeline === after.pipeline));

export function LibraryRow(props: LibraryRowProps) {
  const activityStatus = props.activityView && props.platform
    ? noteStatus(activityForNote(props.activityView, props.platform), props.activityView.pipeline)
    : null;
  return <MemoLibraryRowContent {...props} activityStatus={activityStatus} />;
}
