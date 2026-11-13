// Answering a feed card with one tap: the tap chooses, the answer waits a few
// seconds with Undo, then it is sent. Plain cards (HomeFeedEntries.tsx) and typed
// asks (SitrepCard.tsx) share the wait, its words and the option buttons; comments
// (CardConversation.tsx) and replies (CardReply.tsx) wait the same way.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ComposerField } from "./ComposerField";
import { StatefulSendButton, type SendState } from "./StatefulSendButton";

/** Seconds an answer waits, after the tap or Send, before it is sent. Undo works until then and not after. */
export const ANSWER_UNDO_SECONDS = 5;
export const ANSWER_UNDO_HINT = `Your answer is sent ${ANSWER_UNDO_SECONDS} seconds after you tap an option or press Send. You can undo it until then, not after.`;

/** What a send control reads while its answer waits (`seconds` left) or is being sent (null), naming who gets it (`to`). */
export const sendingLabel = (seconds: number | null, verb = "Sending", to?: string) => seconds === null ? "Sending…" : `${verb}${to ? ` to ${to}` : ""} in ${seconds}s`;

/** The line a card keeps once its answer is sent: what was chosen, or else what was written. */
export const answerSummary = (label?: string, text?: string) => label ? `You chose ${label}` : `You answered “${text}”`;

/**
 * The undo window. `start` counts ANSWER_UNDO_SECONDS down and then calls `send`;
 * `undo` stops the count, so nothing is saved; `flush` sends now whatever waits.
 * A card that goes away while it counts sends at once, and so does a page that is
 * closed or hidden: an answer is never dropped silently. `status` is the line a
 * screen reader hears.
 */
export function useUndoWindow(send: () => void) {
  const [seconds, setSeconds] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const latest = useRef(send);
  latest.current = send;
  function stop() {
    clearInterval(timer.current);
    timer.current = undefined;
    setSeconds(null);
  }
  function flush() {
    if (!timer.current) return;
    stop(); setStatus("Sending…");
    latest.current();
  }
  // A closed or hidden page may never run the rest of the count (mobile browsers freeze or discard it), so the
  // answer goes now, as it does on unmount. `pagehide` covers closing and navigating away; `visibilitychange` to
  // hidden covers switching apps, which on a phone is often the last event a page gets.
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => () => {
    if (!timer.current) return;
    clearInterval(timer.current);
    latest.current();
  }, []);
  return {
    seconds, status,
    start() {
      if (timer.current) return;
      let left = ANSWER_UNDO_SECONDS;
      setSeconds(left); setStatus(`Sending in ${left} seconds. Undo is available until then.`);
      timer.current = setInterval(() => {
        left -= 1;
        if (left > 0) { setSeconds(left); return; }
        stop(); setStatus("Sending…");
        latest.current();
      }, 1_000);
    },
    undo() {
      if (!timer.current) return;
      stop(); setStatus("Undone. Nothing was sent.");
    },
    flush,
  };
}

/** Undo in a status line under something that waits: small text, with a hit area of 44px on touch (40px with a mouse). */
export function UndoButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="relative rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 after:absolute after:-inset-x-2 after:-inset-y-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:after:-inset-y-3">Undo</button>;
}

export interface AnswerOption { id: string; label: string; detail?: string; cost?: string }

/** The last entry of every option list (feed lab, Sam's order of 11-12): it opens a box to write your own answer. */
export const OWN_OPTION: AnswerOption = { id: "lab-your-own-option", label: "Your own answer" };

/**
 * A question's options as choices: filled rows, each with a round marker, its label and detail, and "Suggested" on
 * the one its agent recommends. The chosen one stays pressed; while its answer waits or is sent (`seconds`,
 * `sending`) it reads as the wait, with Undo and a line that runs out, and the others dim.
 */
export function AnswerOptions({ options: given, suggested, chosen, seconds, sending, own, onChoose, onUndo }: {
  options: readonly AnswerOption[];
  /** The option the agent recommends. */
  suggested?: string;
  chosen?: string;
  /** "Your own answer" as the last entry; `open` shows `box` (the text and Send) under it. */
  own?: { open: boolean; box: ReactNode };
  seconds: number | null;
  sending: boolean;
  onChoose: (option: AnswerOption) => void;
  onUndo: () => void;
}) {
  const waiting = seconds !== null || sending;
  const options = own ? [...given, OWN_OPTION] : given;
  return <fieldset className="space-y-2 text-sm"><legend className="mb-2 text-xs font-medium text-muted-foreground">Choose an option</legend>
    {options.map((option) => {
      const pressed = chosen === option.id || (option === OWN_OPTION && !!own?.open);
      return <div key={option.id} className={`relative rounded-xl border ${pressed ? "border-primary bg-selected" : "border-transparent bg-surface-2"} ${waiting && !pressed ? "opacity-50" : ""}`}>
        <button type="button" aria-pressed={pressed} disabled={waiting && !pressed} onClick={() => onChoose(option)} className="flex min-h-12 w-full items-start gap-3 rounded-xl px-3 py-3 text-left active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span aria-hidden className={`mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center rounded-full border-2 ${pressed ? "border-primary" : "border-muted-foreground"} ${pressed && waiting ? "opacity-0" : ""}`}>{pressed && <span className="size-2 rounded-full bg-primary" />}</span>
          <span className={`min-w-0 flex-1 ${pressed && waiting ? "opacity-0" : ""}`}>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 break-words font-medium">{option.label}</span>{suggested === option.id && <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">Suggested</span>}</span>
            {option.detail && <span className="mt-0.5 block break-words text-muted-foreground">{option.detail}</span>}
            {option.cost && <span className="mt-1 block text-xs">Cost: {option.cost}</span>}
          </span>
        </button>
        {/* The wait lies over the option, which keeps its size: nothing moves while Undo is on offer. */}
        {/* The wait lies over the option, which keeps its size: nothing moves while Undo is on offer. The label never
            shortens; the countdown does (design round 6). A screen reader hears the full status from the hold. */}
        {pressed && waiting && <div className="pointer-events-none absolute inset-0 flex items-center gap-2 overflow-hidden rounded-xl px-3">
          <span aria-hidden className="shrink-0 font-medium">{option.label}</span>
          <span aria-hidden className="tnum min-w-0 flex-1 truncate text-right text-xs">{seconds === null ? "Sending…" : `Sending · ${seconds}s`}</span>
          {seconds !== null && <button type="button" onClick={onUndo} className="pointer-events-auto min-h-10 shrink-0 rounded-lg border border-border bg-background px-3 font-medium">Undo</button>}
          {seconds !== null && <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-primary motion-safe:animate-out motion-safe:slide-out-to-left motion-safe:ease-linear motion-safe:fill-mode-forwards motion-reduce:hidden" style={{ animationDuration: `${ANSWER_UNDO_SECONDS}s` }} />}
        </div>}
      </div>;
    }).flatMap((row, index) => options[index] === OWN_OPTION && own?.open ? [row, <div key="own-box">{own.box}</div>] : [row])}
  </fieldset>;
}

/** What "Your own answer" opens: one field with Send inside it. Send waits out the same undo window as a tap. */
// Send only starts the undo window; the real save runs later in the caller, so
// the caller passes `state` for that save (sending/sent/error) and `onRetry` to
// re-run it after a failure. Without `state` the button just stays on Send.
export function OwnAnswerBox({ text, disabled, onText, onSend, state = "idle", onRetry }: {
  text: string; disabled: boolean; onText: (text: string) => void; onSend: () => void;
  state?: SendState; onRetry?: () => void;
}) {
  // While the answer waits out its undo window, the option row above is the only status, so Send steps aside; it
  // comes back to show the save itself (sending, or "Couldn't send · Retry").
  const holding = disabled && state === "idle";
  return <ComposerField autoFocus label={OWN_OPTION.label} value={text} onValue={onText} disabled={disabled}
    send={!holding && <StatefulSendButton compact state={state} disabled={disabled || !text.trim()} onSend={state === "error" ? (onRetry ?? onSend) : onSend} />} />;
}
