// TC-3195: the Library under "Shared with me": recordings other people shared with this account, under the day each
// was added (the account's own record; the link's recorded date is unchecked), newest first. A share the owner stopped,
// or whose access ended, is still listed, muted, until it is removed from the Library.
import { ChevronRightIcon } from "lucide-react";

import { Empty } from "@/components/ui/empty";
import { ListRow } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { quotedTitle, type SharedSource } from "@/lib/nativeShares/display";
import { receivedShareEnded, sharedNoteId, type ReceivedRecordingShare } from "@/lib/nativeShares/receivedShares";
import type { RecordStoreSnapshot } from "@/lib/nativeShares/spaceRecords";
import { cn } from "@/lib/utils";
import { notePath } from "@/shell/routes";
import { SoftRow } from "../home/SoftRow";
import { useSoftHome } from "../home/softHome";
import { formatClockDuration, groupByDay } from "../library/formatters";
import { KIND_ICON, emptyFilterText, type LibraryKind } from "../library/libraryKinds";
import { SHARED_ROW_CUE, sharedRowMeta } from "./shareCopy";

const KIND_OF: Readonly<Record<SharedSource, LibraryKind>> = { meeting: "meeting", "voice-note": "note", upload: "upload" };

function SharedRow(props: { record: ReceivedRecordingShare; now: Date; selected: boolean }) {
  const { record } = props;
  const Icon = KIND_ICON[KIND_OF[record.display.source]];
  const meta = sharedRowMeta(record, props.now);
  const over = record.revokedAt !== undefined || receivedShareEnded(record, props.now);
  const duration = over ? null : record.display.durationSeconds;
  const soft = useSoftHome();
  if (soft) {
    return <SoftRow icon={Icon} title={quotedTitle(record.display.title)} meta={meta} subMeta={SHARED_ROW_CUE} durationSecs={duration} href={notePath(sharedNoteId(record.id))} selected={props.selected} testId="shared-item" />;
  }
  return (
    <ListRow
      href={notePath(sharedNoteId(record.id))}
      leading={<Icon />}
      title={<span className={cn(over && "text-muted-foreground")}>{quotedTitle(record.display.title)}</span>}
      selected={props.selected}
      meta={meta}
      metaLines={2}
      subMeta={SHARED_ROW_CUE}
      aside={
        <span className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">
          {duration !== null && <span className="tnum">{formatClockDuration(duration)}</span>}
          <ChevronRightIcon aria-hidden="true" className="size-4" />
        </span>
      }
      data-testid="shared-item"
    />
  );
}

export function SharedLibraryRows(props: { shared: RecordStoreSnapshot<ReceivedRecordingShare>; now: Date; selectedId?: string | null }) {
  const { shared, now } = props;
  if (shared.state === "loading" || shared.state === "idle") {
    return (
      <div role="status">
        <span className="sr-only">Loading your Library…</span>
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} shape="row" />
        ))}
      </div>
    );
  }
  if (shared.records.length === 0) {
    return <Empty data-testid="library-empty" title={shared.state === "failed" ? "Couldn’t load your Library." : emptyFilterText("shared")} />;
  }
  const rows = [...shared.records]
    .sort((a, b) => b.claimedAt.localeCompare(a.claimedAt))
    .map((record) => ({ record, startedAt: record.claimedAt }));
  return (
    <>
      {groupByDay(rows, now).map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="sticky top-13 z-[5] bg-background py-1.5 text-meta font-semibold text-muted-foreground">{group.label}</h3>
          <ul className="flex flex-col">
            {group.items.map(({ record }) => (
              <SharedRow key={record.id} record={record} now={now} selected={props.selectedId === sharedNoteId(record.id)} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
