// Feed lab (Sam, 11-12): a post card. In the feed it is a preview, like an article card on X: the agent, the
// title, a short blurb and one image. Tapping it opens the whole page: what the agent made, with its pictures and
// films, and the questions about it, answered at the bottom. Hunter's review pages were the inspiration (one
// plain ask per question, the media right above the answers, notes, one Send for the lot); the look and the
// way an answer is sent are the feed's own (Sam: "keep the feed intact with intention").
//
// The page is the card's `payload.page`. The real feed has no such field: it would be a new optional card field,
// with the media stored where the person can read it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ChevronLeftIcon, PlayIcon } from "lucide-react";
import type { FeedResponse, NewFeedResponse } from "@tinycloud/sdk-services/feed";

import { Button } from "@/components/ui/button";
import { sendingLabel, useUndoWindow } from "./AnswerOptions";
import { AgentMark, PlatformName, type Platform } from "./AgentMark";
import type { HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";
import { ShortTime } from "./ShortTime";

export interface LabPageMedia { type: "image" | "video"; src: string; caption?: string; poster?: string }
export interface LabPageOption { label: string; description?: string; recommended?: boolean; image?: string }
export interface LabPageQuestion { id: string; header?: string; question: string; media?: LabPageMedia[]; options?: LabPageOption[]; multi?: boolean; notePrompt?: string }
/** The page behind a post: its image in the feed, and its questions. The card's body is the page's opening words. */
export interface LabPage { image: string; imageAlt: string; questions: LabPageQuestion[] }
interface PageAnswer { choices: string[]; note: string }

/** The card's page, when it has one. */
export function labPageOf(entry: HomeFeedEntry): LabPage | undefined {
  const page = entry.state.card.payload?.page as Partial<LabPage> | undefined;
  return page && typeof page.image === "string" && Array.isArray(page.questions) ? page as LabPage : undefined;
}

/** Answers you have tapped on a page and not sent yet, kept while the lab is open, so leaving the page loses none. */
const drafts = new Map<string, Record<string, PageAnswer>>();

const answered = (answer?: PageAnswer) => !!answer && (answer.choices.length > 0 || !!answer.note.trim());

/** What the agent gets: each answered question, its choices and note, one per line. */
function pageSummary(page: LabPage, answers: Record<string, PageAnswer>): string {
  return page.questions.flatMap((question) => {
    const answer = answers[question.id];
    if (!answered(answer)) return [];
    const parts = [answer!.choices.join(", "), answer!.note.trim()].filter(Boolean);
    return [`${question.header ?? question.question}: ${parts.join(". ")}`];
  }).join("\n");
}

/**
 * A post in the feed, short or full: the feed's header row (mark, agent, platform, time, where it stands), the
 * title, the blurb and the page's image. The whole card opens the page.
 */
export function PostPreview({ entry, page, author, agentKey, platform, status, full, onOpen }: {
  entry: HomeFeedEntry; page: LabPage; author: string; agentKey: string; platform?: Platform; status?: string; full: boolean; onOpen: () => void;
}) {
  const card = entry.state.card;
  const blurb = typeof card.payload?.summary === "string" ? card.payload.summary : card.body;
  const films = page.questions.some((question) => question.media?.some((media) => media.type === "video"));
  return <button type="button" onClick={onOpen} aria-haspopup="dialog"
    className={`block w-full min-w-0 rounded-2xl border border-border bg-card text-left text-card-foreground active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${full ? "p-4 shadow-sm sm:p-5" : "p-3"}`}>
    <span className="flex min-w-0 items-start gap-3">
      <AgentMark agentKey={agentKey} name={author} small={!full} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"><span className="font-semibold text-foreground">{author}</span>{platform && <PlatformName platform={platform} />}<ShortTime at={card.createdAt} />
          {status && <span className="ml-auto shrink-0 rounded-full border border-border px-2 py-0.5 font-medium text-foreground">{status}</span>}</span>
        <span className={`mt-1 block break-words font-semibold leading-snug ${full ? "font-display text-xl" : "text-[15px]"}`}>{card.title}</span>
        {blurb && <span className={`mt-0.5 block break-words text-sm text-muted-foreground ${full ? "" : "line-clamp-2"}`}>{blurb}</span>}
      </span>
    </span>
    {/* The one thing a post adds: a look at the page. */}
    <span className={`relative mt-3 block overflow-hidden rounded-xl border border-border bg-muted ${full ? "" : "ml-11"}`}>
      <img src={page.image} alt={page.imageAlt} loading="lazy" className="block aspect-video w-full object-cover" />
      {films && <span aria-hidden className="absolute bottom-2 left-2 flex size-8 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm"><PlayIcon className="size-4" /></span>}
    </span>
    {full && <span className="mt-3 flex items-center justify-between gap-3 text-sm"><span className="text-muted-foreground">{page.questions.length === 1 ? "1 question" : `${page.questions.length} questions`}</span><span className="font-medium underline decoration-border underline-offset-4">Answer</span></span>}
  </button>;
}

function Media({ media }: { media: LabPageMedia }) {
  return <figure className="min-w-0">
    {media.type === "video"
      ? <video src={media.src} poster={media.poster} controls playsInline preload="metadata" className="block aspect-video w-full rounded-xl border border-border bg-black object-contain" />
      : <a href={media.src} target="_blank" rel="noopener noreferrer"><img src={media.src} alt={media.caption ?? ""} loading="lazy" className="block w-full rounded-xl border border-border bg-muted" /></a>}
    {media.caption && <figcaption className="mt-1 text-xs text-muted-foreground">{media.caption}</figcaption>}
  </figure>;
}

/** One question on the page: the ask, its media right above the answers, the options as the feed draws them, a note. */
function PageQuestionView({ question, index, count, answer, disabled, onChange }: {
  question: LabPageQuestion; index: number; count: number; answer: PageAnswer; disabled: boolean; onChange: (answer: PageAnswer) => void;
}) {
  const options = question.options ?? [];
  function toggle(label: string) {
    const on = answer.choices.includes(label);
    onChange({ ...answer, choices: question.multi ? (on ? answer.choices.filter((choice) => choice !== label) : [...answer.choices, label]) : (on ? [] : [label]) });
  }
  return <section aria-label={question.header ?? question.question} className="space-y-3 border-t border-border pt-4">
    <p className="text-xs font-medium text-muted-foreground">{index + 1} of {count}{question.header ? ` · ${question.header}` : ""}</p>
    <p className="whitespace-pre-line break-words font-medium leading-snug">{question.question}</p>
    {!!question.media?.length && <div className={`grid gap-3 ${question.media.length === 2 ? "sm:grid-cols-2" : ""}`}>{question.media.map((media) => <Media key={media.src} media={media} />)}</div>}
    {!!options.length && <fieldset className="space-y-2 text-sm"><legend className="mb-2 text-xs font-medium text-muted-foreground">{question.multi ? "Choose any that fit" : "Choose an option"}</legend>
      {options.map((option) => {
        const pressed = answer.choices.includes(option.label);
        return <button key={option.label} type="button" aria-pressed={pressed} disabled={disabled} onClick={() => toggle(option.label)}
          className={`flex min-h-12 w-full items-start gap-3 rounded-xl border px-3 py-3 text-left active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60 ${pressed ? "border-primary bg-selected" : "border-transparent bg-surface-2"}`}>
          {/* A round marker picks one; a square one picks any number. */}
          <span aria-hidden className={`mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center border-2 ${question.multi ? "rounded" : "rounded-full"} ${pressed ? "border-primary" : "border-muted-foreground"} ${pressed && question.multi ? "bg-primary text-primary-foreground" : ""}`}>
            {pressed && (question.multi ? <CheckIcon className="size-3" strokeWidth={3} /> : <span className="size-2 rounded-full bg-primary" />)}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 break-words font-medium">{option.label}</span>{option.recommended && <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">Suggested</span>}</span>
            {option.description && <span className="mt-0.5 block break-words text-muted-foreground">{option.description}</span>}
            {option.image && <img src={option.image} alt="" loading="lazy" className="mt-2 block w-full rounded-lg border border-border bg-muted" />}
          </span>
        </button>;
      })}
    </fieldset>}
    <textarea rows={2} aria-label={`Note: ${question.header ?? question.question}`} placeholder={question.notePrompt ?? (options.length ? "Add a note (optional)" : "Write your answer")} value={answer.note} disabled={disabled}
      onInput={(event) => onChange({ ...answer, note: event.currentTarget.value })}
      className="block min-h-12 w-full resize-y rounded-lg border border-border bg-background p-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
  </section>;
}

/**
 * The whole page, over the feed: the card as the feed shows it (`card`, with the agent's header and the page's
 * opening words), then each question, then the card's comments (`footer`). One bar at the bottom sends every
 * answer together, after the feed's undo window. Back, or the phone's back, returns to the feed where you were.
 */
export function PostPage({ entry, page, source, author, card, status, footer, onSaved, onClose }: {
  entry: HomeFeedEntry; page: LabPage; source: HomeFeedSource; author: string; card: (children: ReactNode) => ReactNode; status: ReactNode; footer: ReactNode;
  onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void; onClose: () => void;
}) {
  const key = `${entry.source.sourceId}:${entry.state.card.cardId}`;
  const [answers, setAnswers] = useState<Record<string, PageAnswer>>(() => drafts.get(key) ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sent = entry.state.response;
  const pending = useRef<NewFeedResponse | null>(null);
  const hold = useUndoWindow(() => void send());
  const waiting = saving || hold.seconds !== null;
  const count = page.questions.filter((question) => answered(answers[question.id])).length;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // The page is a step in the browser's history, so a phone's back gesture closes it.
  useEffect(() => {
    history.pushState({ feedLabPage: key }, "");
    const back = () => closeRef.current();
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, [key]);
  function change(id: string, answer: PageAnswer) {
    const next = { ...answers, [id]: answer };
    drafts.set(key, next); setAnswers(next); pending.current = null;
  }
  async function send() {
    if (saving || !count) return;
    setSaving(true); setError(null);
    const posted = entry.state.card;
    const response = pending.current ?? {
      responseId: crypto.randomUUID(), cardId: posted.cardId, revision: posted.revision, issuanceId: posted.issuanceId,
      kind: sent ? "followup" as const : "answer" as const, text: pageSummary(page, answers),
      ...(sent ? { supersedesResponseId: sent.responseId } : {}), createdAt: new Date().toISOString(),
    };
    pending.current = response;
    try {
      onSaved(entry, await source.saveResponse(entry, response));
      pending.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your answers weren't sent. Try again."); }
    finally { setSaving(false); }
  }
  return <div role="dialog" aria-modal aria-label={entry.state.card.title} className="fixed inset-0 z-40 overflow-y-auto overscroll-contain bg-background text-foreground">
    <div className="mx-auto w-full max-w-2xl min-w-0 px-3 pb-36 pt-4 sm:px-5">
      <button type="button" onClick={() => history.back()} className="mb-4 inline-flex min-h-10 items-center gap-1 rounded-lg border border-border px-3 text-sm"><ChevronLeftIcon aria-hidden className="size-4" />Home</button>
      {card(<div className="mt-4 space-y-5">
        <img src={page.image} alt={page.imageAlt} className="block aspect-video w-full rounded-xl border border-border bg-muted object-cover" />
        {status}
        {page.questions.map((question, index) => <PageQuestionView key={question.id} question={question} index={index} count={page.questions.length}
          answer={answers[question.id] ?? { choices: [], note: "" }} disabled={waiting} onChange={(answer) => change(question.id, answer)} />)}
        <div className="border-t border-border pt-4">{footer}</div>
      </div>)}
    </div>
    {/* One send for the whole page, at the bottom where the answers are. */}
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:px-5">
      <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground" aria-live="polite">{error ? <span role="alert" className="text-destructive">{error}</span> : waiting ? sendingLabel(hold.seconds, "Sending", author) : `${count} of ${page.questions.length} answered`}</p>
        {hold.seconds !== null
          ? <Button type="button" variant="outline" onClick={hold.undo} className="min-h-11">Undo</Button>
          : <Button type="button" disabled={!count || saving} onClick={hold.start} className="min-h-11">{sent ? "Send again" : "Send answers"}</Button>}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{hold.status}</p>
    </div>
  </div>;
}
