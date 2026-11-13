// Answering a feed card with one tap: the tap chooses, the answer waits UNDO_SECONDS with Undo in its row, then it
// is sent. Plain cards (HomeFeedEntries.tsx) and typed asks (SitrepCard.tsx) share these rows and their words. The
// wait itself is the caller's `usePendingSend` (cardKit.tsx): the caller calls `start(label, run)` from `onChoose`
// and passes the countdown down as `pending`, so the view-change registry, pagehide and the stale-card guard apply.
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { ComposerField } from "./ComposerField";
import { StatefulSendButton, type SendState } from "./StatefulSendButton";
import { displayOptions, UNDO_SECONDS } from "./cardKit";

/** What a send control reads while its answer waits (`seconds` left) or is being sent (null), naming who gets it (`to`). */
export const sendingLabel = (seconds: number | null, verb = "Sending", to?: string) => seconds === null ? "Sending…" : `${verb}${to ? ` to ${to}` : ""} in ${seconds}s`;

/** The line a card keeps once its answer is sent: what was chosen, or else what was written. */
export const answerSummary = (label?: string, text?: string) => label ? `You chose ${label}` : `You answered “${text}”`;

export interface AnswerOption { id: string; label: string; detail?: string; cost?: string }

/** The last entry of every option list: it opens a box to write your own answer. Its id is the `choiceId` of a written answer's countdown. */
export const OWN_OPTION: AnswerOption = { id: "own-answer", label: "Your own answer" };

/**
 * A question's options as choices: filled rows, each with a round marker, its label and detail, and "Suggested" on
 * the one its agent recommends (`suggested`, or else an option whose label ends in "(Recommended)"; the marker comes
 * off the label, as in `displayOptions`). The chosen one stays pressed; while its answer waits (`pending`) or is
 * being saved (`saving`) it reads as the wait, with Undo and a line that runs out, and the others dim.
 */
export function AnswerOptions({ options: given, suggested: recommended, pending, saving, chosen, disabled = false, own, onChoose, onUndo }: {
  options: readonly AnswerOption[];
  /** The option the agent recommends. */
  suggested?: string;
  /** The countdown from `usePendingSend`: which option waits, and its seconds left. */
  pending?: { choiceId: string; seconds: number } | null;
  /** The option whose save is running, after its countdown ended. */
  saving?: string;
  /** An option that stays pressed with no wait, such as one whose save failed and can be retried. */
  chosen?: string;
  /** Every row off: a stale or closed card. */
  disabled?: boolean;
  /** "Your own answer" as the last entry: tapping it calls `onOpen(!open)`; `open` shows `box` (the text and Send) under it. */
  own?: { open: boolean; onOpen: (open: boolean) => void; box: ReactNode };
  /** A tap on an option, with its label as the owner sees it (for `usePendingSend.start`). Never called for the own row. */
  onChoose: (choiceId: string, label: string) => void;
  onUndo: () => void;
}) {
  const { options: shown, suggested } = displayOptions(given, recommended);
  const options = own ? [...shown, OWN_OPTION] : shown;
  const waitingId = pending?.choiceId ?? saving;
  // What a screen reader hears: the wait when it starts, and "Undone" after Undo here, until the next wait.
  const [undone, setUndone] = useState(false);
  if (pending && undone) setUndone(false);
  const waiting = waitingId !== undefined;
  const waitingLabel = options.find((option) => option.id === waitingId)?.label;
  function undo() { setUndone(true); onUndo(); }
  function choose(option: AnswerOption) {
    // A tap during the wait would flush the waiting answer and start another: nothing changes until it is sent or undone.
    if (waiting || disabled) return;
    if (option === OWN_OPTION) own?.onOpen(!own.open);
    else onChoose(option.id, option.label);
  }
  function escape(event: KeyboardEvent) {
    if (event.key !== "Escape" || !pending) return;
    event.preventDefault(); undo();
  }
  const status = pending && waitingLabel ? `Sending ${waitingLabel} in ${UNDO_SECONDS} seconds. Undo is available until then.` : saving ? "Sending…" : undone ? "Undone. Nothing was sent." : "";
  return <fieldset className="space-y-2 text-sm" onKeyDown={escape}><legend className="mb-2 text-xs font-medium text-muted-foreground">Choose an option</legend>
    {options.map((option) => {
      const held = waitingId === option.id;
      const pressed = held || (!waiting && chosen === option.id) || (option === OWN_OPTION && !!own?.open);
      const off = disabled || (waiting && !held);
      return <div key={option.id} className={`relative rounded-xl border ${pressed ? "border-primary bg-selected" : "border-transparent bg-surface-2"} ${off ? "opacity-50" : ""}`}>
        <button type="button" aria-pressed={pressed} disabled={off} onClick={() => choose(option)} className="flex min-h-12 w-full items-start gap-3 rounded-xl px-3 py-3 text-left active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:active:bg-transparent">
          <span aria-hidden className={`mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center rounded-full border-2 ${pressed ? "border-primary" : "border-muted-foreground"} ${held ? "opacity-0" : ""}`}>{pressed && <span className="size-2 rounded-full bg-primary" />}</span>
          <span className={`min-w-0 flex-1 ${held ? "opacity-0" : ""}`}>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 break-words font-medium">{option.label}</span>{suggested === option.id && <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">Suggested</span>}</span>
            {option.detail && <span className="mt-0.5 block break-words text-muted-foreground">{option.detail}</span>}
            {option.cost && <span className="mt-1 block text-xs">Cost: {option.cost}</span>}
          </span>
        </button>
        {/* The wait lies over the option, which keeps its size: nothing moves while Undo is on offer. The label never
            shortens; the countdown does. A screen reader hears the full status line below instead. */}
        {held && <div className="pointer-events-none absolute inset-0 flex items-center gap-2 overflow-hidden rounded-xl px-3">
          <span aria-hidden className="shrink-0 font-medium">{option.label}</span>
          <span aria-hidden className="min-w-0 flex-1 truncate text-right text-xs tabular-nums">{pending ? `Sending · ${pending.seconds}s` : "Sending…"}</span>
          {/* Focus moves to Undo when the wait starts, so Enter or Escape undoes from the keyboard. */}
          {pending && <button type="button" autoFocus onClick={undo} className="pointer-events-auto min-h-10 shrink-0 rounded-lg border border-border bg-background px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Undo</button>}
          {pending && <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-primary motion-safe:animate-out motion-safe:slide-out-to-left motion-safe:ease-linear motion-safe:fill-mode-forwards motion-reduce:hidden" style={{ animationDuration: `${UNDO_SECONDS}s` }} />}
        </div>}
      </div>;
    }).flatMap((row, index) => options[index] === OWN_OPTION && own?.open ? [row, <div key="own-box">{own.box}</div>] : [row])}
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</p>
  </fieldset>;
}

/**
 * What "Your own answer" opens: one field with Cancel and Send inside it (Sam, 23:35Z). Send starts the same countdown
 * as a tap (the caller calls `start` with `OWN_OPTION.id` as the pending choice); the real save runs later in the
 * caller, so the caller passes `state` for that save (sending/error) and `onRetry` to re-run it after a failure.
 * `onCancel` clears the words and closes the box; it steps aside while the answer counts down or saves (Undo is how
 * to take that back).
 */
export function OwnAnswerBox({ text, disabled, onText, onSend, onCancel, state = "idle", onRetry }: {
  text: string; disabled: boolean; onText: (text: string) => void; onSend: () => void; onCancel?: () => void;
  state?: SendState; onRetry?: () => void;
}) {
  // While the answer waits out its countdown, the option row above is the only status, so Send steps aside; it
  // comes back to show the save itself (sending, or "Couldn't send · Retry").
  const holding = disabled && state === "idle";
  return <ComposerField autoFocus label={OWN_OPTION.label} value={text} onValue={onText} disabled={disabled} onCancel={disabled ? undefined : onCancel}
    send={!holding && <StatefulSendButton compact state={state} disabled={disabled || !text.trim()} onSend={state === "error" ? (onRetry ?? onSend) : onSend} />} />;
}
