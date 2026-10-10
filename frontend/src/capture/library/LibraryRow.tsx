// One Library row (TC-761): the kind's icon, the title, where it came from and
// when, and its length as a tabular clock time. The whole row opens the note.
// Voice notes keep the smoke script's `voice-note-item` and `data-source-id`.
import { ChevronRightIcon } from "lucide-react";

import { ListRow } from "@/components/ui/list-row";
import type { MeetingListItem } from "@/lib/connectors/meetingExplorer";
import { notePath } from "@/shell/routes";
import { issueForItem, issueHasSheet, issueIsInformational } from "../home/captureIssues";
import { SoftRow } from "../home/SoftRow";
import { useSoftHome } from "../home/softHome";
import { formatClockDuration, rowWhen } from "./formatters";
import { KIND_ICON, libraryKind, librarySourceLabel } from "./libraryKinds";

export type LibraryItem = MeetingListItem;

/** "Fireflies · 2:00 PM"; the source is left out when the title already starts with it ("Voice note · …"). */
export function libraryRowMeta(item: LibraryItem, now: Date, grouped: boolean): string {
  const source = librarySourceLabel(item.source);
  const when = rowWhen(item.startedAt, now, grouped);
  const parts = (item.title ?? "").startsWith(source) ? [when] : [source, when];
  return parts.filter((part): part is string => !!part).join(" · ");
}

export function LibraryRow(props: { item: LibraryItem; now: Date; grouped: boolean; selected?: boolean; testId?: string }) {
  const { item } = props;
  const Icon = KIND_ICON[libraryKind(item.source)];
  const voiceNote = libraryKind(item.source) === "note";
  const soft = useSoftHome();
  if (soft) {
    const issue = issueForItem(item, soft.issues);
    return (
      <SoftRow
        icon={Icon}
        title={item.title ?? "Untitled"}
        meta={libraryRowMeta(item, props.now, props.grouped)}
        durationSecs={item.durationSecs}
        issue={issue}
        onDetails={issue && issueIsInformational(issue) ? (opener: HTMLElement) => soft.openIssue(item.sourceId, opener) : undefined}
        {...(issue && issueHasSheet(issue) ? { onActivate: (row: HTMLElement) => soft.openIssue(item.sourceId, row) } : { href: notePath(item.id) })}
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
      title={item.title ?? "Untitled"}
      meta={libraryRowMeta(item, props.now, props.grouped)}
      aside={
        <span className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">
          {item.durationSecs !== null && <span className="tnum">{formatClockDuration(item.durationSecs)}</span>}
          <ChevronRightIcon aria-hidden="true" className="size-4" />
        </span>
      }
      data-testid={props.testId ?? (voiceNote ? "voice-note-item" : "library-item")}
      data-source-id={voiceNote ? item.sourceId : undefined}
    />
  );
}
