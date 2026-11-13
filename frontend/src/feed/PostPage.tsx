// Feed lab (Sam, 11-12): a post card. In the feed it is a preview, like an article card on X: the agent, the
// title, a short blurb and one image. Tapping it opens the whole page: what the agent made, with its pictures and
// films, and the questions about it, answered at the bottom. Hunter's review pages were the inspiration (one
// plain ask per question, the media right above the answers, notes, one Send for the lot); the look and the
// way an answer is sent are the feed's own (Sam: "keep the feed intact with intention").
//
// The page is the card's `payload.page`. The real feed has no such field: it would be a new optional card field,
// with the media stored where the person can read it.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CheckIcon, ChevronLeftIcon, PlayIcon } from "lucide-react";
import type { FeedResponse, NewFeedResponse } from "@tinycloud/sdk-services/feed";

import { Button } from "@/components/ui/button";
import { sendingLabel, useUndoWindow } from "./AnswerOptions";
import { AgentMark, PlatformName, type Platform } from "./AgentMark";
import { CompactCard, StatusMark } from "./CompactCard";
import type { HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";
import { morphImageId, morphTitleId, useMorphTransition } from "./PostTile";
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

/** Answers you have tapped on a page, sent or not, kept while the lab is open, so leaving the page loses none. */
const drafts = new Map<string, Record<string, PageAnswer>>();
const draftKey = (entry: HomeFeedEntry) => `${entry.source.sourceId}:${entry.state.card.cardId}`;

const answered = (answer?: PageAnswer) => !!answer && (answer.choices.length > 0 || !!answer.note.trim());

/**
 * Where a post stands, for its card (Sam, 11-12): "Done" once its answers are sent with every question answered,
 * "1 of 2 answered" while only some are, and otherwise what the feed says of any card (`fallback`).
 */
export function postStatus(entry: HomeFeedEntry, page: LabPage, fallback: string): string {
  const answers = drafts.get(draftKey(entry)) ?? {};
  const count = page.questions.filter((question) => answered(answers[question.id])).length;
  if (entry.state.response && count === page.questions.length) return "Done";
  return count > 0 && count < page.questions.length ? `${count} of ${page.questions.length} answered` : fallback;
}

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
 * A post in the feed. Compact: the feed's compact card with a thumbnail of the page. Full: the header row, title,
 * blurb and the page's image, with how many questions it asks. Either way the whole card opens the page.
 */
export function PostPreview({ entry, page, author, agentKey, platform, status, full, onOpen }: {
  entry: HomeFeedEntry; page: LabPage; author: string; agentKey: string; platform?: Platform; status?: string; full: boolean; onOpen: () => void;
}) {
  const card = entry.state.card;
  const blurb = typeof card.payload?.summary === "string" ? card.payload.summary : card.body;
  const films = page.questions.some((question) => question.media?.some((media) => media.type === "video"));
  if (!full) return <CompactCard agentKey={agentKey} author={author} platform={platform} createdAt={card.createdAt} status={status} title={card.title} description={blurb}
    thumb={{ src: page.image, video: films }} onOpen={onOpen} opensPage />;
  return <button type="button" onClick={onOpen} aria-haspopup="dialog"
    className="block w-full min-w-0 rounded-2xl border border-border bg-card p-4 text-left text-card-foreground shadow-sm active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">
    <span className="flex min-w-0 items-start gap-3">
      <AgentMark agentKey={agentKey} name={author} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground"><span className="max-w-[58%] shrink-0 truncate font-semibold text-foreground">{author}</span>{platform && <PlatformName platform={platform} logoOnly />}<ShortTime at={card.createdAt} className="shrink-0 before:mr-1.5 before:content-['·']" />
          <span className="ml-auto flex shrink-0 items-center"><StatusMark status={status} /></span></span>
        <span className="mt-1 block break-words font-display text-xl font-semibold leading-snug">{card.title}</span>
        {blurb && <span className="mt-0.5 block break-words text-sm text-muted-foreground">{blurb}</span>}
      </span>
    </span>
    {/* The one thing a post adds: a look at the page. */}
    <span className="relative mt-3 block overflow-hidden rounded-xl border border-border bg-muted">
      <img src={page.image} alt={page.imageAlt} loading="lazy" className="block aspect-video w-full object-cover" />
      {films && <span aria-hidden className="absolute bottom-2 left-2 flex size-8 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm"><PlayIcon className="size-4" /></span>}
    </span>
    <span className="mt-3 flex items-center justify-between gap-3 text-sm"><span className="text-muted-foreground">{page.questions.length === 1 ? "1 question" : `${page.questions.length} questions`}</span><span className="font-medium underline decoration-border underline-offset-4">Answer</span></span>
  </button>;
}

function Media({ media }: { media: LabPageMedia }) {
  return <figure className="min-w-0">
    {media.type === "video"
      // A video's native controls live in its shadow DOM and show no ring of their own, so the wrapper draws one
      // while focus is anywhere in the video (QA cb784d4, P2); the video's own ring stays for focus on the video itself.
      ? <div className="rounded-xl focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
        <video src={media.src} poster={media.poster} controls playsInline preload="metadata" className="block aspect-video w-full rounded-xl border border-border bg-black object-contain focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background" />
      </div>
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
          </span>
          {/* A picture beside its option, small, so a list of options stays on a screen (design critique #7). */}
          {option.image && <img src={option.image} alt="" loading="lazy" className="size-16 shrink-0 rounded-lg border border-border bg-muted object-cover" />}
        </button>;
      })}
    </fieldset>}
    <textarea rows={2} aria-label={`Note: ${question.header ?? question.question}`} placeholder={question.notePrompt ?? (options.length ? "Add a note (optional)" : "Write your answer")} value={answer.note} disabled={disabled}
      onInput={(event) => onChange({ ...answer, note: event.currentTarget.value })}
      className="block min-h-12 w-full resize-y rounded-lg border border-border bg-background p-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />
  </section>;
}

/** From Tailwind's `sm` up the page is a dialog with round corners; below it, it fills the phone's screen. */
const WIDE = "(min-width: 640px)";
function subscribeWide(change: () => void) {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia(WIDE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}
const isWide = () => typeof matchMedia === "function" && matchMedia(WIDE).matches;

/**
 * The whole page, over the feed: the card as the feed shows it (`card`, with the agent's header and the page's
 * opening words), then each question, then the card's comments (`footer`). One bar at the bottom sends every
 * answer together, after the feed's undo window. Back, or the phone's back, returns to the feed where you were.
 * A phone gets the whole screen; from 640px up it is a dialog over the dimmed feed.
 *
 * Opened from a grid tile (`morphFrom`, the tile's postMorphId), the tile grows into the page: its surface, picture
 * and title become the page's, and shrink back into it on the way out. The picture and title then sit above the
 * card, so `card` is told to leave its own title out. Opened from the list, the page fades in.
 */
export function PostPage({ entry, page, source, author, card, status, footer, morphFrom, onSaved, onClose }: {
  entry: HomeFeedEntry; page: LabPage; source: HomeFeedSource; author: string;
  /** The card around the page. `showTitle` is false when the page already shows the title above the card. */
  card: (children: ReactNode, options: { showTitle: boolean }) => ReactNode;
  status: ReactNode; footer: ReactNode;
  /** The grid tile's postMorphId, when the page opens from one. */
  morphFrom?: string;
  onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void; onClose: () => void;
}) {
  const key = draftKey(entry);
  const [answers, setAnswers] = useState<Record<string, PageAnswer>>(() => drafts.get(key) ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Changed since the last send: only then is there anything to send again.
  const [dirty, setDirty] = useState(false);
  const sent = entry.state.response;
  const pending = useRef<NewFeedResponse | null>(null);
  const hold = useUndoWindow(() => void send());
  const waiting = saving || hold.seconds !== null;
  const count = page.questions.filter((question) => answered(answers[question.id])).length;
  // Open until the history step is undone; then the page plays its way out and only after that calls `onClose`.
  const [open, setOpen] = useState(true);
  // The post that opened the page, read before the page takes focus, so focus can go back to it (design critique #3).
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const homeRef = useRef<HTMLButtonElement>(null);
  const firstNote = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);
  const transition = useMorphTransition();
  const reduce = useReducedMotion();
  const wide = useSyncExternalStore(subscribeWide, isWide, () => false);
  // The page is a step in the browser's history, so a phone's back gesture closes it. Home, Escape and a tap on the
  // dimmed feed all go back that one step; the step's undoing is what closes the page.
  useEffect(() => {
    history.pushState({ feedLabPage: key }, "");
    const back = () => { leaving.current = true; setOpen(false); };
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, [key]);
  // Once only: a second tap on Home while the page is leaving would step the browser back past the feed.
  function leave() {
    if (leaving.current) return;
    leaving.current = true;
    history.back();
  }
  function change(id: string, answer: PageAnswer) {
    const next = { ...answers, [id]: answer };
    drafts.set(key, next); setAnswers(next); setDirty(true); pending.current = null;
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
      pending.current = null; setDirty(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your answers weren't sent. Try again."); }
    finally { setSaving(false); }
  }
  const title = entry.state.card.title;
  const fade = reduce ? { duration: 0 } : { duration: 0.2, ease: [0.2, 0, 0, 1] as const };
  // Grown from a tile: the surface is the tile's. From the list: it rises a little as it fades in.
  const surface = morphFrom ? { layoutId: morphFrom, transition }
    : { initial: { opacity: 0, y: reduce ? 0 : 24 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: reduce ? 0 : 24 }, transition: fade };
  // What only the page has fades in once the tile has mostly grown, and goes first on the way back, so it is never
  // seen squeezed into the tile's size.
  const reveal = morphFrom ? {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: reduce ? { duration: 0 } : { delay: 0.12, duration: 0.25 } },
    exit: { opacity: 0, transition: reduce ? { duration: 0 } : { duration: 0.08 } },
  } : {};
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) leave(); }}>
    <AnimatePresence onExitComplete={() => closeRef.current()}>
      {open && <Dialog.Portal key="page" forceMount>
        <Dialog.Overlay asChild forceMount>
          <motion.div className="fixed inset-0 z-40 bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} />
        </Dialog.Overlay>
        <div className="pointer-events-none fixed inset-0 z-40 flex sm:items-center sm:justify-center sm:p-6">
          <Dialog.Content asChild forceMount aria-describedby={undefined}
            onOpenAutoFocus={(event) => { event.preventDefault(); homeRef.current?.focus({ preventScroll: true }); }}
            onCloseAutoFocus={(event) => { event.preventDefault(); if (opener?.isConnected) opener.focus(); }}>
            {/* Motion keeps corners right while it scales only when the radius is in `style`. */}
            <motion.div {...surface} style={{ borderRadius: wide ? 16 : 0 }}
              className="pointer-events-auto relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-background text-foreground outline-none sm:h-auto sm:max-h-full sm:max-w-2xl sm:border sm:border-border sm:shadow-float">
              {/* "position" only, so the page is never stretched while the surface grows; it scrolls on its own. */}
              <motion.div layout="position" layoutScroll transition={transition} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="mx-auto w-full min-w-0 px-3 pb-6 pt-4 sm:px-5">
                  <motion.div {...reveal}>
                    <Dialog.Close asChild>
                      <button ref={homeRef} type="button" className="mb-4 inline-flex min-h-11 items-center gap-1 rounded-lg border border-border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-10"><ChevronLeftIcon aria-hidden className="size-4" />Home</button>
                    </Dialog.Close>
                  </motion.div>
                  {morphFrom ? <>
                    {/* The tile's picture and title, grown: above the card, in the order the tile had them. */}
                    <motion.div layoutId={morphImageId(morphFrom)} transition={transition} style={{ borderRadius: 12 }}
                      className="relative mb-3 aspect-[4/3] w-full overflow-hidden border border-border bg-muted sm:aspect-video">
                      <img src={page.image} alt={page.imageAlt} className="absolute inset-0 size-full object-cover" />
                    </motion.div>
                    <Dialog.Title asChild>
                      <motion.h2 layoutId={morphTitleId(morphFrom)} layout="position" transition={transition} className="mb-4 break-words font-display text-title-2">{title}</motion.h2>
                    </Dialog.Title>
                  </> : <Dialog.Title className="sr-only">{title}</Dialog.Title>}
                  <motion.div {...reveal}>
                    {card(<div className="mt-4 space-y-5">
                      {/* The page's picture, unless it is already above the card or its first question shows its own media (design critique #7). */}
                      {!morphFrom && !page.questions[0]?.media?.length && <img src={page.image} alt={page.imageAlt} className="block aspect-video w-full rounded-xl border border-border bg-muted object-cover" />}
                      {status}
                      <div ref={firstNote} className="space-y-5">{page.questions.map((question, index) => <PageQuestionView key={question.id} question={question} index={index} count={page.questions.length}
                        answer={answers[question.id] ?? { choices: [], note: "" }} disabled={waiting} onChange={(answer) => change(question.id, answer)} />)}</div>
                      {footer}
                    </div>, { showTitle: !morphFrom })}
                  </motion.div>
                </div>
              </motion.div>
              {/* One send for the whole page, at the bottom where the answers are. */}
              <motion.div {...reveal} className="shrink-0 border-t border-border bg-background px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5 sm:pb-3">
                <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
                  {/* Once sent, where the person is: Sent, then "{agent} received it", then Done (QA, 1f17120: the
                      status at the top of the page was off-screen after sending from the bottom). */}
                  <p className="min-w-0 flex-1 text-sm text-muted-foreground" aria-live="polite">{error ? <span role="alert" className="text-destructive">{error}</span> : waiting ? sendingLabel(hold.seconds, "Sending", author)
                    : sent && !dirty ? <span className="font-medium text-foreground">{entry.state.outcome?.phase === "succeeded" ? "Done" : entry.state.outcome?.phase === "failed" ? "Failed" : entry.state.acknowledgement ? `${author} received it` : "Sent"}</span>
                    : `${count} of ${page.questions.length} answered`}</p>
                  {hold.seconds !== null
                    ? <Button type="button" variant="outline" onClick={hold.undo} className="min-h-11">Undo</Button>
                    // Once sent and unchanged, adding more is the quiet way back in (design critique #7).
                    : sent && !dirty ? <button type="button" onClick={() => firstNote.current?.querySelector("textarea")?.focus()} className="min-h-11 shrink-0 px-1 text-sm font-medium underline decoration-border underline-offset-4">Add to your answer</button>
                    : <Button type="button" disabled={!count || saving} onClick={hold.start} className="min-h-11">{sent ? "Send again" : "Send answers"}</Button>}
                </div>
                <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{hold.status}</p>
              </motion.div>
            </motion.div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>}
    </AnimatePresence>
  </Dialog.Root>;
}
