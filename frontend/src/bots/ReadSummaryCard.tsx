import { useEffect, useId, useState } from "react";
import { standingReadSummary, type ReadSummary } from "./trustbotStandingReads";

const areaLabels = { meetings: "Meetings", feed_chats: "Feed and chats" };
const toolLabels = new Map([
  ["tinycloud_find_meetings", "Find meetings"],
  ["tinycloud_read_meeting", "Read a meeting"],
  ["tinycloud_search_transcripts", "Search transcripts"],
  ["tinycloud_list_meeting_actions", "List meeting actions"],
  ["list_feed_cards", "List feed cards"],
  ["read_card", "Read a feed card"],
  ["list_chats", "List chats"],
  ["read_chat", "Read a chat"],
]);
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

export function ReadSummaryCard() {
  const id = useId();
  const [summary, setSummary] = useState<ReadSummary | null>();
  useEffect(() => {
    let latest: Promise<ReadSummary> | undefined;
    const refresh = () => {
      const request = standingReadSummary();
      latest = request;
      void request.then(
        value => { if (latest === request) setSummary(value); },
        () => { if (latest === request) setSummary(null); },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      latest = undefined;
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const days = new Map<string, ReadSummary["days"]>();
  for (const row of summary?.days ?? []) {
    const reads = days.get(row.day) ?? [];
    reads.push(row);
    days.set(row.day, reads);
  }

  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 text-card-foreground">
      <h2 id={id} className="text-headline">Reads while you were away</h2>
      {summary === undefined ? <p role="status" className="text-callout text-muted-foreground">Loading reads…</p> : null}
      {summary === null ? <p role="status" className="text-callout text-muted-foreground">Couldn’t load reads.</p> : null}
      {summary && days.size === 0 ? <p className="text-callout text-muted-foreground">No reads in the last 7 days.</p> : null}
      {[...days].sort(([left], [right]) => right.localeCompare(left)).map(([day, reads]) => (
        <div key={day} className="flex flex-col gap-1">
          <h3 className="text-callout font-medium"><time dateTime={day}>{dateFormat.format(new Date(day))}</time></h3>
          <ul className="divide-y divide-border">
            {reads.map(row => (
              <li key={`${row.area}:${row.tool}`} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1 text-callout">
                <span><span className="text-muted-foreground">{areaLabels[row.area]} · </span>{toolLabels.get(row.tool) ?? "Other read"}</span>
                <span className="whitespace-nowrap tabular-nums text-muted-foreground">{row.ok} allowed · {row.refused} refused</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
