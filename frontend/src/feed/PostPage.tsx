// A post card (Sam, 11-12). In the feed it is a preview, like an article card on X: the agent, the title, a short
// blurb and one image. Tapping it opens the whole page: what the agent made, with its pictures and films, and the
// questions about it, answered at the bottom. Hunter's review pages were the inspiration (one plain ask per
// question, the media right above the answers, notes, one Send for the lot); the look and the way an answer is
// sent are the feed's own (Sam: "keep the feed intact with intention").
//
// The page is the card's `payload.page` (postAnswers.ts). Its answers go as one answer: a summary in words for
// the agent to read, and each question's answer in a private `feed.page` payload for its program.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { CheckIcon, ChevronLeftIcon } from "lucide-react";
import type { FeedResponse, NewFeedResponse } from "@tinycloud/sdk-services/feed";

import { Button } from "@/components/ui/button";
import { NAV_LABEL_HOME } from "@/lib/homeStrings";
import { ANSWER_FAILED_COPY, ANSWER_HELD_COPY, NOT_SENT_COPY, UNDO_SECONDS, usePendingSend } from "./cardKit";
import type { HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";
import {
  answeredCount, clearPostDraft, EMPTY_ANSWER, pageAnswerPayload, pageSummary, postDraft, rememberPageAnswer, sameAnswers, savedPageAnswers, savePostDraft,
  type LabPage, type LabPageMedia, type LabPageQuestion, type PageAnswer, type PageAnswers,
} from "./postAnswers";

function Media({ media }: { media: LabPageMedia }) {
  return <figure className="min-w-0">
    {media.type === "video"
      // A video's native controls live in its shadow DOM and don't match :focus-visible, so its ring shows on any
      // focus (QA, 1f17120); the wrapper's ring shows while focus is on any of those controls (QA, cb784d4).
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
 * answer together, after the feed's undo window, held in the page-close outbox until it lands. Back, or the
 * phone's back, returns to the feed where you were. A phone gets the whole screen; from 640px up it is a dialog
 * over the dimmed feed. Unsent answers stay on the device (postAnswers.ts), so leaving the page loses none.
 * It rises a little as it fades in.
 */
export function PostPage({ entry, answered, page, source, author, card, status, footer, stale = false, onRefused, onSaved, onClose }: {
  entry: HomeFeedEntry;
  /**
   * The revision that holds the card's stored answer, when an earlier revision was answered and only agent
   * replies followed (as for AnswerForm). The answers are shown from it, and a new send names its issuance.
   */
  answered?: HomeFeedEntry;
  page: LabPage; source: HomeFeedSource; author: string;
  /** The card around the page. */
  card: (children: ReactNode) => ReactNode;
  status: ReactNode; footer: ReactNode;
  /** A newer issuance replaced this card: its answers stay, but they can no longer be sent. */
  stale?: boolean;
  /** Answers whose countdown ended after the card was replaced: nothing was written. */
  onRefused: (label: string) => void;
  onSaved: (entry: HomeFeedEntry, response: FeedResponse) => void; onClose: () => void;
}) {
  // Writes go to the answered issuance when there is one, otherwise to the card as it is now.
  const target = answered ?? entry;
  const sent = target.state.response;
  // What the page opens with: the unsent draft, else what was sent. A draft that says what was sent already
  // (its answer went from the outbox at a later launch) is done with.
  const [start] = useState(() => {
    const draft = postDraft(entry, page);
    const stored = savedPageAnswers(target, page);
    if (draft && stored && sameAnswers(draft, stored)) { clearPostDraft(entry); return { answers: stored, dirty: false }; }
    return { answers: draft ?? stored ?? {}, dirty: !!draft };
  });
  const [answers, setAnswers] = useState<PageAnswers>(start.answers);
  // Changed since the last send: only then is there anything to send again.
  const [dirty, setDirty] = useState(start.dirty);
  const [saving, setSaving] = useState(false);
  // The send that failed: whether it is still held is read when the line renders.
  const [failed, setFailed] = useState<{ target: HomeFeedEntry; responseId: string } | null>(null);
  // What a screen reader hears about the wait.
  const [announce, setAnnounce] = useState("");
  const countdown = usePendingSend({ stale, onRefused });
  // A retry of the same answers to the same issuance reuses the response, so it can't be written twice.
  const pending = useRef<{ key: string; response: NewFeedResponse } | null>(null);
  // Read when the countdown commits: a reply-only revision may arrive meanwhile, and an unmount still sends.
  const live = useRef({ target, sent, answers });
  live.current = { target, sent, answers };
  const waiting = saving || !!countdown.pending;
  const count = answeredCount(page, answers);
  // Open until the history step is undone; then the page plays its way out and only after that calls `onClose`.
  const [open, setOpen] = useState(true);
  // The post that opened the page, read before the page takes focus, so focus can go back to it (design critique #3).
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const homeRef = useRef<HTMLButtonElement>(null);
  const firstNote = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);
  const reduce = useReducedMotion();
  const wide = useSyncExternalStore(subscribeWide, isWide, () => false);
  const step = `post:${entry.source.sourceId}:${entry.state.card.cardId}`;
  // The page is a step in the browser's history, so a phone's back gesture closes it. Home, Escape and a tap on the
  // dimmed feed all go back that one step; the step's undoing is what closes the page.
  useEffect(() => {
    history.pushState({ homePost: step }, "");
    const back = () => { leaving.current = true; setOpen(false); };
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, [step]);
  // Once only: a second tap on Home while the page is leaving would step the browser back past the feed.
  function leave() {
    if (leaving.current) return;
    leaving.current = true;
    history.back();
  }
  function change(id: string, answer: PageAnswer) {
    const next = { ...answers, [id]: answer };
    savePostDraft(entry, next); setAnswers(next); setDirty(true);
  }
  async function send() {
    const { target, sent, answers } = live.current;
    if (!answeredCount(page, answers)) return;
    setSaving(true); setFailed(null); setAnnounce("Sending…");
    const posted = target.state.card;
    const text = pageSummary(page, answers);
    const payload = pageAnswerPayload(page, answers);
    const key = JSON.stringify([posted.cardId, posted.revision, posted.issuanceId, sent?.responseId ?? null, payload.data]);
    const response = pending.current?.key === key ? pending.current.response : {
      responseId: crypto.randomUUID(), cardId: posted.cardId, revision: posted.revision, issuanceId: posted.issuanceId,
      kind: sent ? "followup" as const : "answer" as const, text,
      ...(sent ? { supersedesResponseId: sent.responseId } : {}), createdAt: new Date().toISOString(),
    };
    pending.current = { key, response };
    try {
      // Held until confirmed: a page that closes before this write lands sends it at the next launch.
      const result = await source.saveResponse(target, response, payload, { hold: true });
      rememberPageAnswer(result.responseId, payload);
      clearPostDraft(entry);
      pending.current = null; setDirty(false);
      onSaved(target, result);
    } catch {
      setFailed({ target, responseId: response.responseId });
    } finally { setSaving(false); }
  }
  function hold() {
    if (stale || waiting || !count) return;
    countdown.start(NOT_SENT_COPY.yourAnswer, () => void send());
    setAnnounce(`Sending in ${UNDO_SECONDS} seconds. Undo is available until then.`);
  }
  function undo() {
    countdown.undo();
    setAnnounce("Undone. Nothing was sent.");
  }
  const handling = sent && (target.responseHandling?.[sent.responseId] ?? target.state);
  const title = entry.state.card.title;
  const fade = reduce ? { duration: 0 } : { duration: 0.2, ease: [0.2, 0, 0, 1] as const };
  const surface = { initial: { opacity: 0, y: reduce ? 0 : 24 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: reduce ? 0 : 24 }, transition: fade };
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) leave(); }}>
    <AnimatePresence onExitComplete={() => closeRef.current()}>
      {open && <Dialog.Portal key="page" forceMount>
        <Dialog.Overlay asChild forceMount>
          <m.div className="fixed inset-0 z-40 bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} />
        </Dialog.Overlay>
        <div className="pointer-events-none fixed inset-0 z-40 flex sm:items-center sm:justify-center sm:p-6">
          <Dialog.Content asChild forceMount aria-describedby={undefined}
            onOpenAutoFocus={(event) => { event.preventDefault(); homeRef.current?.focus({ preventScroll: true }); }}
            onCloseAutoFocus={(event) => { event.preventDefault(); if (opener?.isConnected) opener.focus(); }}>
            {/* Motion keeps corners right while it moves only when the radius is in `style`. */}
            <m.div {...surface} style={{ borderRadius: wide ? 16 : 0 }}
              className="pointer-events-auto relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-background text-foreground outline-none sm:h-auto sm:max-h-full sm:max-w-2xl sm:border sm:border-border sm:shadow-float">
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="mx-auto w-full min-w-0 px-3 pb-6 pt-4 sm:px-5">
                  <Dialog.Close asChild>
                    <button ref={homeRef} type="button" className="mb-4 inline-flex min-h-11 items-center gap-1 rounded-lg border border-border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-10"><ChevronLeftIcon aria-hidden className="size-4" />{NAV_LABEL_HOME}</button>
                  </Dialog.Close>
                  <Dialog.Title className="sr-only">{title}</Dialog.Title>
                  {card(<div className="mt-4 space-y-5">
                    {/* The page's picture, unless its first question shows its own media (design critique #7). */}
                    {!page.questions[0]?.media?.length && <img src={page.image} alt={page.imageAlt} className="block aspect-video w-full rounded-xl border border-border bg-muted object-cover" />}
                    {status}
                    <div ref={firstNote} className="space-y-5">{page.questions.map((question, index) => <PageQuestionView key={question.id} question={question} index={index} count={page.questions.length}
                      answer={answers[question.id] ?? EMPTY_ANSWER} disabled={waiting} onChange={(answer) => change(question.id, answer)} />)}</div>
                    {footer}
                  </div>)}
                </div>
              </div>
              {/* One send for the whole page, at the bottom where the answers are. */}
              <div className="shrink-0 border-t border-border bg-background px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5 sm:pb-3">
                <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
                  {/* Once sent, where the person is: Sent, then "{agent} received it", then Done (QA, 1f17120: the
                      status at the top of the page was off-screen after sending from the bottom). */}
                  <p className="min-w-0 flex-1 text-sm text-muted-foreground" aria-live="polite">{failed ? <span role="alert" className="text-destructive">{source.holdsAnswer?.(failed.target, failed.responseId) ? ANSWER_HELD_COPY : ANSWER_FAILED_COPY}</span>
                    : countdown.pending ? `Sending to ${author} in ${countdown.pending.seconds}s` : saving ? "Sending…"
                    : handling && !dirty ? <span className="font-medium text-foreground">{handling.outcome?.phase === "succeeded" ? "Done" : handling.outcome?.phase === "failed" ? "Failed" : handling.acknowledgement ? `${author} received it` : "Sent"}</span>
                    : `${count} of ${page.questions.length} answered`}</p>
                  {countdown.pending
                    ? <Button type="button" variant="outline" onClick={undo} className="min-h-11">Undo</Button>
                    // Once sent and unchanged, adding more is the quiet way back in (design critique #7).
                    : sent && !dirty ? <button type="button" onClick={() => firstNote.current?.querySelector("textarea")?.focus()} className="min-h-11 shrink-0 px-1 text-sm font-medium underline decoration-border underline-offset-4">Add to your answer</button>
                    : <Button type="button" disabled={!count || saving || stale} onClick={hold} className="min-h-11">{sent ? "Send again" : "Send answers"}</Button>}
                </div>
                <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</p>
              </div>
            </m.div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>}
    </AnimatePresence>
  </Dialog.Root>;
}
