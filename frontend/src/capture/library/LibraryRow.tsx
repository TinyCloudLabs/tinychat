// One Library row (TC-761): the kind's icon, the title, where it came from and
// when, and its length as a tabular clock time. The whole row opens the note.
// A voice note is titled by its own words ("Voice note" when it has none) and its line is "7:16 PM · 0:14",
// so notes recorded minutes apart tell apart. It keeps the smoke script's `voice-note-item` and `data-source-id`.
import { ChevronRightIcon } from "lucide-react";

import { ListRow } from "@/components/ui/list-row";
import type { MeetingListItem } from "@/lib/connectors/meetingExplorer";
import { notePath } from "@/shell/routes";
import { issueForItem, issueHasSheet, issueIsInformational } from "../home/captureIssues";
import { HOME_COPY } from "../home/homeCopy";
import { SoftRow } from "../home/SoftRow";
import { useSoftHome } from "../home/softHome";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { formatClockDuration, rowWhen } from "./formatters";
import { RowBadge } from "./RowBadge";
import { KIND_ICON, libraryKind, librarySourceLabel } from "./libraryKinds";
import type { NotePipeline } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { AppPlatform } from "@/lib/platform";
import { activityForNote, noteStatus } from "../activity/activitySelector";

export type LibraryItem = MeetingListItem & {
  /** A voice note on this device with no row in the space yet. */
  onPhone?: true;
  /** A voice note whose row is in the space while this device still holds its copy. */
  saving?: true;
  /** A voice note's own words (its first moment, else its transcript), which title its row. */
  snippet?: string | null;
};

const isVoiceNote = (item: LibraryItem): boolean => item.source === VOICE_NOTE_SOURCE;

/** A voice note: its own words, else "Voice note" (never the date: a day's group or the line below has it). */
export function libraryRowTitle(item: LibraryItem): string {
  return isVoiceNote(item) ? (item.snippet ?? HOME_COPY.voiceNoteTitle) : (item.title ?? "Untitled");
}

/** "Fireflies · 2:00 PM"; a voice note's is "7:16 PM · 0:14" (the mic says what it is). */
export function libraryRowMeta(item: LibraryItem, now: Date, grouped: boolean): string {
  const when = rowWhen(item.startedAt, now, grouped);
  const parts = isVoiceNote(item)
    ? [when, item.durationSecs !== null ? formatClockDuration(item.durationSecs) : null]
    : [librarySourceLabel(item.source), when];
  return parts.filter((part): part is string => !!part).join(" · ");
}

/** What a note not yet settled in the space says beside its line: "On this phone" or "Saving…"; null once it is. */
export function libraryRowBadge(item: LibraryItem, where: string = HOME_COPY.onThisPhone): string | null {
  if (item.onPhone) return where.charAt(0).toUpperCase() + where.slice(1);
  return item.saving ? HOME_COPY.savingBadge : null;
}

/** The length on the row's right: a voice note's is in its line, unless something replaced the line. */
export function libraryRowAsideDuration(item: LibraryItem, lineReplaced: boolean): number | null {
  return isVoiceNote(item) && !lineReplaced ? null : item.durationSecs;
}

export function LibraryRow(props: { item: LibraryItem; now: Date; grouped: boolean; selected?: boolean; testId?: string; onRecentOpen?: (id: string) => void; pipeline?: NotePipeline; activityView?: NotePipelineView; platform?: AppPlatform }) {
  const { item } = props;
  const Icon = KIND_ICON[libraryKind(item.source)];
  const voiceNote = libraryKind(item.source) === "note";
  const soft = useSoftHome();
  const status = props.activityView && props.platform ? noteStatus(activityForNote(props.activityView, props.platform)) : null;
  const badge = status ? null : libraryRowBadge(item);
  if (soft) {
    const issue = issueForItem(item, soft.issues);
    const lineReplaced = issue !== undefined && !issueIsInformational(issue);
    return (
      <SoftRow
        icon={Icon}
        title={libraryRowTitle(item)}
        meta={libraryRowMeta(item, props.now, props.grouped)}
        badge={lineReplaced || isVoiceNote(item) ? undefined : (badge ?? undefined)}
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
      />
    );
  }
  return (
    <ListRow
      href={notePath(item.id)}
      selected={props.selected}
      leading={<Icon />}
      title={libraryRowTitle(item)}
      meta={
        <>
          {badge && <RowBadge>{badge}</RowBadge>}
          {libraryRowMeta(item, props.now, props.grouped)}
        </>
      }
      aside={
        <span className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">
          {status && <span className="max-w-40 text-right [overflow-wrap:anywhere]" data-testid="library-note-status">{status}</span>}
          {item.durationSecs !== null && !isVoiceNote(item) && <span className="tnum">{formatClockDuration(item.durationSecs)}</span>}
          <ChevronRightIcon aria-hidden="true" className="size-4" />
        </span>
      }
      data-testid={props.testId ?? (voiceNote ? "voice-note-item" : "library-item")}
      data-source-id={voiceNote ? item.sourceId : undefined}
    />
  );
}
