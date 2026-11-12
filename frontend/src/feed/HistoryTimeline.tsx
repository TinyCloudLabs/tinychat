import { answerHandling } from "./AnswerSteps";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { ShortTime, shortTime } from "./ShortTime";
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

// One dot per step. Done is solid, the current step is solid with a soft ring so it reads as "where things stand",
// a step still to come is an empty circle, and a failure is red. All of them use theme colours, so dark mode follows.
const dotClass: Record<HistoryTone, string> = {
  done: "bg-foreground",
  current: "bg-foreground ring-4 ring-foreground/15",
  upcoming: "border-[1.5px] border-muted-foreground",
  failed: "bg-destructive ring-4 ring-destructive/15",
};

/**
 * A card's history as a vertical rail with a dot per step, oldest first. The list is a real `<ol>` so a screen reader
 * hears how many steps there are; the rail and dots are decoration and hidden from it.
 */
export function HistoryTimeline({ items, className }: { items: HistoryItem[]; className?: string }) {
  return <ol className={cn("text-sm", className)}>
    {items.map((item, index) => {
      const tone = item.tone ?? "done";
      return <li key={item.key} data-tone={tone} aria-current={tone === "current" ? "step" : undefined} className="relative pb-4 pl-7 last:pb-0">
        {/* The rail runs from under this dot to just above the next one, leaving a small gap around each dot so an
            empty dot stays empty on any background. */}
        {index < items.length - 1 && <span aria-hidden className="absolute bottom-0 left-1.5 top-5 w-px -translate-x-1/2 bg-border" />}
        <span aria-hidden className={cn("absolute left-1.5 top-1 size-3 -translate-x-1/2 rounded-full", dotClass[tone])} />
        <div className="flex items-baseline gap-3">
          <p className={cn("min-w-0 break-words font-medium", tone === "upcoming" && "font-normal text-muted-foreground", tone === "failed" && "text-destructive")}>
            {item.title}{tone === "upcoming" && <span className="sr-only">, not yet</span>}
          </p>
          <ShortTime at={item.at} className="ml-auto shrink-0 text-xs text-muted-foreground" />
        </div>
        {item.detail && <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{item.detail}</p>}
      </li>;
    })}
  </ol>;
}

/**
 * The history of a plain card, oldest first: when it was posted and seen, each answer, follow-up and comment you
 * saved, when the agent received each one and how it turned out, and each time you snoozed it. The latest step is
 * marked current, unless it failed.
 */
export function historyFromEntry(entry: HomeFeedEntry): HistoryItem[] {
  const agent = entry.source.label || "Agent";
  const items: HistoryItem[] = [{ key: "posted", at: entry.state.card.createdAt, title: "Posted" }];
  if (entry.view.seenAt) items.push({ key: "seen", at: entry.view.seenAt, title: "Seen" });

  const responses = entry.responses ?? (entry.state.response ? [entry.state.response] : []);
  for (const response of responses) {
    const choice = response.choiceId ? entry.state.card.choices?.find((option) => option.id === response.choiceId)?.label ?? response.choiceId : undefined;
    const said = [choice, response.text].filter(Boolean).join("\n");
    const title = response.kind === "message" ? "You commented" : response.kind === "followup" ? "Follow-up" : "You answered";
    items.push({ key: `response-${response.responseId}`, at: response.createdAt, title, ...(said ? { detail: said } : {}) });

    const { acknowledgement, outcome } = answerHandling(entry, response.responseId);
    if (acknowledgement) items.push({ key: `received-${response.responseId}`, at: acknowledgement.createdAt, title: `${agent} received it` });
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
