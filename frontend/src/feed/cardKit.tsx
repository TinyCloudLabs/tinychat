// The parts every Home card shares: one anatomy for typed, untyped and sample
// cards (an edge inside a 20px radius, a 28px header, a 17px title), one-tap
// option buttons, the answered panel, the quiet row and the More sheet.
// Colours are the theme's semantic tokens, so the light values are the app
// family's (#09090b ink, #71717a dim, #f4f4f5 muted, #e4e4e7 hairline) and
// dark mode follows.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { snoozePresets } from "@tinyboilerplate/core/feed/sitrep";
import { safeUrl } from "./feedData";
import type { HomeFeedEntry } from "./feedStoreTypes";

import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";

export const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";
const controlEdge = "shadow-[inset_0_0_0_1px_hsl(var(--muted-foreground))]";
export const cardClass = "relative min-w-0 overflow-hidden rounded-[20px] bg-card py-4 pl-[18px] pr-4 text-card-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]";
export const quietClass = `inline-flex min-h-11 items-center gap-1.5 rounded-md text-[13px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50 ${focusRing}`;
export const pillClass = `inline-flex h-11 max-w-full items-center justify-center gap-2 rounded-full px-5 text-[13.5px] font-bold ${controlEdge} hover:bg-muted disabled:opacity-50 ${focusRing}`;
export const primaryPillClass = `inline-flex h-[52px] max-w-full items-center justify-center gap-2 rounded-full bg-foreground px-[30px] text-[15px] font-bold text-background hover:bg-foreground/90 disabled:opacity-50 ${focusRing}`;
export const fieldClass = `mt-2 block w-full rounded-xl bg-background p-3 text-[15px] font-normal ${controlEdge} ${focusRing} disabled:opacity-60`;
export const chipClass = "inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full bg-muted px-2.5 text-[12.5px] font-semibold";
export const fineClass = "text-[13px] tabular-nums text-muted-foreground";

const KIND_WORDS: Record<string, string> = {
  ask: "Question", question: "Question", approval: "Approval", task: "To-do", work: "Status", ship: "Release",
  incident: "Incident", order: "Instruction", claim: "Claim check", hold: "On hold", progress: "Progress",
};
/** The owner's word for a card kind: "Question", not "ask". */
export function kindWord(kind: string): string {
  return KIND_WORDS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short" });
function clockTime(date: Date) { return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; }
function dayStart(at: number) { const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime(); }

/** "12 min ago" under an hour, then "Today, 09:00", "Thu 14:00" within the week, then "6 Nov". */
export function cardTime(at: string, now: number): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const age = now - time;
  if (age >= 0 && age < 3_600_000) return age < 60_000 ? "Just now" : `${Math.floor(age / 60_000)} min ago`;
  const days = Math.round((dayStart(time) - dayStart(now)) / 86_400_000);
  if (days === 0) return `Today, ${clockTime(date)}`;
  if (days === -1) return `Yesterday, ${clockTime(date)}`;
  if (days === 1) return `Tomorrow, ${clockTime(date)}`;
  if (Math.abs(days) < 7) return `${WEEKDAY.format(date)} ${clockTime(date)}`;
  const year = date.getFullYear() === new Date(now).getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTH.format(date)}${year}`;
}

/** A future moment for deadlines and snoozes: "15:00", "Thu 14:00", "6 Nov". */
export function dueTime(at: string | number, now: number): string {
  const time = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const days = Math.round((dayStart(time) - dayStart(now)) / 86_400_000);
  const date = new Date(time);
  if (days === 0) return clockTime(date);
  if (days === 1) return `tomorrow ${clockTime(date)}`;
  return cardTime(new Date(time).toISOString(), now);
}

export interface CardOption { id: string; label: string; detail?: string }

const RECOMMENDED_MARK = /\s*\(recommended\)\s*$/i;
/**
 * Agents sometimes mark their pick inside the label ("Yes, go (Recommended)").
 * For display only, the marker comes off the label and becomes the Suggested
 * tag, unless the card already names its recommendation. Saved payloads keep
 * the option exactly as the agent sent it.
 */
export function displayOptions<T extends CardOption>(options: readonly T[], recommended?: string): { options: T[]; suggested?: string } {
  const marked = options.find((option) => RECOMMENDED_MARK.test(option.label));
  return {
    options: options.map((option) => ({ ...option, label: optionText(option.label) })),
    suggested: recommended ?? marked?.id,
  };
}
/** An option's label as the owner sees it: without a trailing "(Recommended)" marker. */
export function optionText(label: string): string {
  return label.replace(RECOMMENDED_MARK, "") || label;
}

/** True while a card shows its full text (expanded, or "Show more" opened): option details stop clamping too. */
export const CardTextContext = createContext(false);

/** One tap saves: each option is its own button. */
export function OptionButtons({ options: given, suggested: recommended, saving, disabled, onChoose, tag = "Suggested" }: {
  options: readonly CardOption[];
  suggested?: string;
  saving?: string;
  disabled?: boolean;
  onChoose: (id: string) => void;
  tag?: string;
}) {
  const full = useContext(CardTextContext);
  const { options, suggested } = displayOptions(given, recommended);
  return <div role="group" aria-label="Answers" className="mt-3.5 grid gap-2 min-[480px]:grid-cols-2">
    {options.map((option) => <button key={option.id} type="button" disabled={disabled} onClick={() => onChoose(option.id)}
      className={`grid min-h-14 min-w-0 content-center gap-px rounded-xl px-3.5 py-[9px] text-left ${controlEdge} hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent ${saving === option.id ? "bg-muted" : ""} ${focusRing}`}>
      <span className="text-[15px] font-semibold text-foreground">{saving === option.id ? "Saving…" : option.label}{option.id === suggested && saving !== option.id && <> <span className="ml-1 inline-flex h-5 items-center whitespace-nowrap rounded-full bg-muted px-2 align-[1px] text-xs font-semibold">{tag}</span></>}</span>
      {option.detail && <span className={`break-words text-[13px] text-muted-foreground ${full ? "" : "line-clamp-2"}`}>{option.detail}</span>}
    </button>)}
  </div>;
}

const INLINE_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()"'\]]+[^\s<>()"'\].,;:!?])/g;
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_LINK)) {
    const href = match[2] ?? match[3]!;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(safeUrl(href)
      ? <a key={match.index} href={href} target="_blank" rel="noopener noreferrer" className="break-words underline underline-offset-[3px]">{match[1] ?? href}</a>
      : match[1] ?? href);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
const LIST_ITEM = /^\s*[-*•]\s+/;
/**
 * A card body as React text: paragraphs, "- " lists and links ([label](https://…)
 * or a bare https URL). Only safe http(s) links become anchors; nothing is
 * parsed as HTML.
 */
export function CardBody({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(<p key={blocks.length} className="whitespace-pre-wrap">{inline(paragraph.join("\n"))}</p>);
    if (items.length) blocks.push(<ul key={blocks.length} className="list-disc space-y-0.5 pl-5">{items.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>);
    paragraph = []; items = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (LIST_ITEM.test(line)) { if (paragraph.length) flush(); items.push(line.replace(LIST_ITEM, "")); }
    else if (!line.trim()) flush();
    else { if (items.length) flush(); paragraph.push(line); }
  }
  flush();
  return <div className={`space-y-2 break-words ${className ?? ""}`}>{blocks}</div>;
}

/** The answer, where the options were. It takes focus when it replaces them after a tap, so it is announced. */
export function AnsweredPanel({ children, focusOnMount = false }: { children: ReactNode; focusOnMount?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusOnMount) ref.current?.focus(); }, [focusOnMount]);
  // Focus moves here for screen readers only: the panel is not operable (tabIndex -1), so it never shows a ring.
  return <div ref={ref} role="status" aria-label="Your answer" tabIndex={-1} className="mt-3.5 flex items-start gap-2.5 rounded-xl bg-muted px-3 py-2.5 text-sm leading-[1.45] outline-none">
    <CheckIcon aria-hidden className="mt-px size-[18px] shrink-0" />
    <div className="min-w-0 space-y-1 break-words">{children}</div>
  </div>;
}

/** A card-level failure in plain words, under the control that failed. Never exception text. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return <p role="alert" className="mt-2 flex items-start gap-2 text-sm leading-[1.45]"><TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" /><span>{children}</span></p>;
}

function names(list: readonly string[]): string {
  return list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}
/**
 * The card-thread composer's name and helper line: who a new message reaches. `approved` is
 * who actually receives it (the publishing agent, or the owner-approved recipients); `held`
 * recipients aren't connected, keep the message privately, and are never counted as seeing it.
 */
export function audienceCopy({ approved, held = [], fallback }: { approved: readonly string[]; held?: readonly string[]; fallback: string }): { ask: string; helper: string } {
  const heldLine = held.length ? ` ${names(held)} ${held.length === 1 ? "isn't" : "aren't"} connected yet, so ${held.length === 1 ? "it doesn't" : "they don't"} get it.` : "";
  if (!approved.length) return { ask: `Ask ${fallback} something`, helper: `Only you see this for now.${heldLine}` };
  if (approved.length >= 3) return { ask: "Ask the agents on this card something", helper: `Only the ${approved.length} agents on this card see this.${heldLine}` };
  return { ask: `Ask ${names(approved)} something`, helper: `Only ${names(approved)} ${approved.length === 1 ? "sees" : "see"} this.${heldLine}` };
}

/** Seconds an answer waits, undoable, before it is sent. */
export const UNDO_SECONDS = 5;

/**
 * The list's "send now" registry: when the owner leaves the view (switches segment),
 * every answer still counting down is sent at once, because the owner chose it.
 */
export const PendingSendContext = createContext<Set<() => void> | null>(null);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
/**
 * True only when `next` is `previous` plus appended agent replies: the same card from the
 * same agent, a higher revision, every card field and payload key structurally identical
 * (canonical JSON) except `payload.replies`, and those replies a strict append (the first k
 * identical, at least one more). The single exception: the revision that adds a "post"
 * card's first reply may also change `payload.render` from "post" to "thread". Revision,
 * issuance and createdAt are the revision's own identity and time, so they are not compared.
 */
export function isReplyOnlyRevision(previous: HomeFeedEntry, next: HomeFeedEntry): boolean {
  if (previous.source.sourceId !== next.source.sourceId || previous.source.agentDid !== next.source.agentDid) return false;
  const before = previous.state.card; const after = next.state.card;
  if (before.cardId !== after.cardId || after.revision <= before.revision) return false;
  const { revision: _r1, issuanceId: _i1, createdAt: _c1, payload: beforePayload = {}, ...beforeFields } = before;
  const { revision: _r2, issuanceId: _i2, createdAt: _c2, payload: afterPayload = {}, ...afterFields } = after;
  if (canonical(beforeFields) !== canonical(afterFields)) return false;
  const { replies: beforeReplies = [], ...beforeOthers } = beforePayload;
  const { replies: afterReplies, ...afterOthers } = afterPayload;
  if (!Array.isArray(beforeReplies) || !Array.isArray(afterReplies) || afterReplies.length <= beforeReplies.length) return false;
  // The one allowed extra change: a "post" card's first reply turns it into a "thread".
  const firstReply = beforeOthers.render === "post" && afterOthers.render === "thread" && beforeReplies.length === 0;
  const { render: _beforeRender, ...beforeRest } = beforeOthers;
  const { render: _afterRender, ...afterRest } = afterOthers;
  if (firstReply ? canonical(beforeRest) !== canonical(afterRest) : canonical(beforeOthers) !== canonical(afterOthers)) return false;
  return beforeReplies.every((reply, index) => canonical(reply) === canonical(afterReplies[index]));
}

/**
 * An answer that waits UNDO_SECONDS before it is sent. `start` shows it at once;
 * `undo` drops it unsent; at 0 (or when the card unmounts, or the view changes)
 * `send` runs exactly once, unless the card's issuance was replaced meanwhile
 * (`guard.stale` at that moment): then nothing is written and `guard.onRefused` runs.
 */
export function usePendingSend(guard: { stale: boolean; onRefused: (label: string) => void }) {
  const [pending, setPending] = useState<{ label: string; seconds: number } | null>(null);
  const send = useRef<{ label: string; run: () => void } | null>(null);
  const timers = useRef<number[]>([]);
  // Read at commit time, not at tap time: a newer issuance may arrive during the countdown.
  const latest = useRef(guard);
  latest.current = guard;
  const registry = useContext(PendingSendContext);
  const stop = useCallback(() => { for (const timer of timers.current) window.clearTimeout(timer); timers.current = []; }, []);
  const flush = useCallback(() => {
    const armed = send.current;
    if (!armed) return;
    send.current = null; stop(); setPending(null);
    // No write may carry a replaced card's identity.
    if (latest.current.stale) latest.current.onRefused(armed.label);
    else armed.run();
  }, [stop]);
  const undo = useCallback(() => {
    if (!send.current) return;
    send.current = null; stop(); setPending(null);
  }, [stop]);
  const start = useCallback((label: string, run: () => void) => {
    flush();
    send.current = { label, run };
    setPending({ label, seconds: UNDO_SECONDS });
    for (let elapsed = 1; elapsed < UNDO_SECONDS; elapsed++) {
      timers.current.push(window.setTimeout(() => setPending((current) => current && { ...current, seconds: UNDO_SECONDS - elapsed }), elapsed * 1000));
    }
    timers.current.push(window.setTimeout(flush, UNDO_SECONDS * 1000));
  }, [flush]);
  useEffect(() => {
    registry?.add(flush);
    // Unmounting mid-countdown sends: the owner chose this answer.
    return () => { registry?.delete(flush); flush(); };
  }, [registry, flush]);
  return { pending, start, undo };
}

/**
 * The chosen answer during its countdown, with the "Undo · N" pill. Tapping the pill,
 * anywhere else on the card, or Escape inside the card undoes it.
 */
export function PendingAnswer({ label, seconds, children, onUndo }: { label: string; seconds: number; children: ReactNode; onUndo: () => void }) {
  const pill = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    pill.current?.focus();
    const card = pill.current?.closest("article");
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onUndo(); } };
    card?.addEventListener("keydown", onKey);
    return () => card?.removeEventListener("keydown", onKey);
  }, [onUndo]);
  return <>
    {/* Covers the whole card (the article is the positioned box): a tap anywhere undoes. */}
    <span aria-hidden className="absolute inset-0 z-10 cursor-pointer" onClick={(event) => { event.stopPropagation(); onUndo(); }} />
    <div className="mt-3.5 flex items-center gap-3 rounded-xl bg-muted py-1.5 pl-3 pr-1.5 text-sm leading-[1.45]">
      <div className="min-w-0 flex-1 break-words">{children}</div>
      <button ref={pill} type="button" aria-label={`Undo, ${seconds} ${seconds === 1 ? "second" : "seconds"} left`} onClick={(event) => { event.stopPropagation(); onUndo(); }}
        className={`relative z-20 inline-flex h-11 shrink-0 items-center rounded-full bg-foreground px-4 text-[13.5px] font-bold tabular-nums text-background ${focusRing}`}>Undo · {seconds}</button>
    </div>
    <p role="status" className="sr-only">Sending {label} in {UNDO_SECONDS} seconds. Undo available.</p>
  </>;
}

/**
 * The quiet text buttons under a card. Each keeps a 44px target; when they wrap, the column
 * gap equals the visible gap between wrapped lines (44px target - 18px text = 26px).
 */
export function QuietRow({ children }: { children: ReactNode }) {
  return <div className="-mb-3 mt-0.5 flex flex-wrap gap-x-[26px]">{children}</div>;
}

/** "Ask me later" presets: tonight, tomorrow morning, and so on. */
export function SnoozeChoices({ now, disabled, onPick }: { now: number; disabled?: boolean; onPick: (until: string) => void }) {
  return <div role="group" aria-label="Ask me later" className="flex flex-wrap gap-2 pb-2">
    {snoozePresets(now).map((preset) => <button key={preset.id} type="button" className={pillClass} disabled={disabled} onClick={() => onPick(preset.until)}>{preset.label}</button>)}
  </div>;
}

/** The card's "More" sheet: a bottom sheet on phones, a dialog on wider screens. */
export function MoreSheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode }) {
  return <ResponsiveSheet open={open} onOpenChange={onOpenChange} title={<span className="block text-[1.375rem] font-normal leading-[1.2]">{title}</span>}>
    <ResponsiveSheetBody className="space-y-5 pb-6 text-[15px]">{children}</ResponsiveSheetBody>
  </ResponsiveSheet>;
}

/** One titled block inside the More sheet. */
export function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="space-y-2">
    <h3 className="text-[13px] font-semibold">{title}</h3>
    {children}
  </section>;
}

/** Mono reference line, for More → Details only. */
export function Reference({ children, title }: { children: ReactNode; title?: string }) {
  return <div>
    <p className="text-[12.5px] font-semibold text-muted-foreground">Card ID</p>
    <p aria-label="Card reference" className="text-[12.5px] leading-[1.4] text-muted-foreground"><code className="select-all break-all" title={title}>{children}</code></p>
  </div>;
}
