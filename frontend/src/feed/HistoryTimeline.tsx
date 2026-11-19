import { answerHandling } from "./AnswerSteps";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { shortTime } from "./ShortTime";
import { cn } from "@/lib/utils";

export type HistoryTone = "done" | "current" | "upcoming" | "failed";

export interface HistoryItem {
  key: string;
  /** ISO time the step happened, or is due. */
  at: string;
  title: string;
  detail?: string;
  tone?: HistoryTone;
}

// One dot per step, 10 px. Past steps are grey, the latest is black (the theme's foreground, so dark mode follows),
// a step still to come is an empty circle, and a failure is red.
const dotClass: Record<HistoryTone, string> = {
  done: "bg-muted-foreground/45",
  current: "bg-foreground",
  upcoming: "border-[1.5px] border-muted-foreground",
  failed: "bg-destructive",
};

const UTC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A step's time in UTC, as the mock reads: "16 Nov, 15:15 UTC" (with the year when it is not this one). */
export function utcStamp(at: string, now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const year = date.getUTCFullYear() === new Date(now).getUTCFullYear() ? "" : ` ${date.getUTCFullYear()}`;
  return `${date.getUTCDate()} ${UTC_MONTHS[date.getUTCMonth()]}${year}, ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/**
 * A card's history as a vertical rail with a dot per step, oldest first, each step's time under its title. The list is
 * a real `<ol>` so a screen reader hears how many steps there are; the rail and dots are decoration and hidden from it.
 */
export function HistoryTimeline({ items, className }: { items: HistoryItem[]; className?: string }) {
  return <ol className={cn("text-sm", className)}>
    {items.map((item, index) => {
      const tone = item.tone ?? "done";
      return <li key={item.key} data-tone={tone} aria-current={tone === "current" ? "step" : undefined} className="relative pb-4 pl-6 last:pb-0">
        {/* The rail runs from under this dot to just above the next one, leaving a small gap around each dot so an
            empty dot stays empty on any background. */}
        {index < items.length - 1 && <span aria-hidden className="absolute bottom-0 left-[5px] top-[18px] w-px -translate-x-1/2 bg-border" />}
        <span aria-hidden className={cn("absolute left-[5px] top-[5px] size-2.5 -translate-x-1/2 rounded-full", dotClass[tone])} />
        <p className={cn("min-w-0 break-words font-medium", tone === "upcoming" && "font-normal text-muted-foreground", tone === "failed" && "text-destructive")}>
          {item.title}{tone === "upcoming" && <span className="sr-only">, not yet</span>}
        </p>
        <time dateTime={item.at} title={new Date(item.at).toLocaleString()} className="mt-0.5 block text-xs text-muted-foreground">{utcStamp(item.at)}</time>
        {item.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{item.detail}</p>}
      </li>;
    })}
  </ol>;
}

/**
 * Steps from several sources as one rail: oldest first (a step with no readable time sorts as the oldest), a step
 * two sources both list once, the latest marked current unless it failed and every earlier one past.
 */
export function joinHistory(...groups: readonly (readonly HistoryItem[])[]): HistoryItem[] {
  const seen = new Set<string>();
  const items = groups.flat().filter((item) => { const key = `${item.title}|${item.at}`; if (seen.has(key)) return false; seen.add(key); return true; });
  items.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  return items.map((item, index) => ({ ...item, tone: item.tone === "failed" ? item.tone : index === items.length - 1 ? "current" as const : "done" as const }));
}

/**
 * The history of a plain card, oldest first: when it was posted and seen, each answer, follow-up and comment you
 * saved, when the agent received each one and how it turned out, and each time you snoozed it. The latest step is
 * marked current, unless it failed.
 */
export function historyFromEntry(entry: HomeFeedEntry): HistoryItem[] {
  const items: HistoryItem[] = [{ key: "posted", at: entry.state.card.createdAt, title: "Posted" }];
  // You opened the card (Monica: your action, worded like "You answered").
  if (entry.view.seenAt) items.push({ key: "seen", at: entry.view.seenAt, title: "You opened it" });

  const responses = entry.responses ?? (entry.state.response ? [entry.state.response] : []);
  for (const response of responses) {
    const choice = response.choiceId ? entry.state.card.choices?.find((option) => option.id === response.choiceId)?.label ?? response.choiceId : undefined;
    const said = [choice, response.text].filter(Boolean).join("\n");
    const title = response.kind === "message" ? "You commented" : response.kind === "followup" ? "Follow-up" : "You answered";
    items.push({ key: `response-${response.responseId}`, at: response.createdAt, title, ...(said ? { detail: said } : {}) });

    const { acknowledgement, outcome } = answerHandling(entry, response.responseId);
    if (acknowledgement) items.push({ key: `received-${response.responseId}`, at: acknowledgement.createdAt, title: "Received" });
    if (outcome) {
      const message = outcome.detail?.message;
      items.push({
        key: `outcome-${response.responseId}`,
        at: outcome.createdAt,
        title: outcome.phase === "failed" ? "Failed" : "Done",
        ...(typeof message === "string" && message ? { detail: message } : {}),
        ...(outcome.phase === "failed" ? { tone: "failed" as const } : {}),
      });
    }
  }

  for (const event of entry.viewEvents ?? []) {
    if (event.kind !== "snoozed") continue;
    items.push({ key: `snoozed-${event.sequence}`, at: event.createdAt, title: event.snoozedUntil ? `Snoozed until ${shortTime(event.snoozedUntil)}` : "Snoozed" });
  }

  // Sorting is stable, so steps saved at the same moment keep the order above (an answer before its receipt).
  // A time that does not parse sorts as the oldest rather than scrambling the rest.
  items.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const last = items[items.length - 1];
  if (last && !last.tone) last.tone = "current";
  return items;
}
