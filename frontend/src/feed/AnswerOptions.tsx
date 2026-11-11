// Answering a feed card with one tap: the tap chooses, the answer waits a few
// seconds with Undo, then it is sent. Plain cards (HomeFeedEntries.tsx) and typed
// asks (SitrepCard.tsx) share the wait, its words and the option buttons.
import { useEffect, useRef, useState } from "react";

/** Seconds an answer waits, after the tap or Send, before it is sent. Undo works until then and not after. */
export const ANSWER_UNDO_SECONDS = 4;
export const ANSWER_UNDO_HINT = `Your answer is sent ${ANSWER_UNDO_SECONDS} seconds after you tap an option or press Send. You can undo it until then, not after.`;

/** What a send control reads while its answer waits (`seconds` left) or is being sent (null). */
export const sendingLabel = (seconds: number | null) => seconds === null ? "Sending…" : `Sending in ${seconds}s`;

/**
 * The undo window. `start` counts ANSWER_UNDO_SECONDS down and then calls `send`;
 * `undo` stops the count, so nothing is saved. A card that goes away while it
 * counts sends at once: an answer is never dropped silently. `status` is the
 * line a screen reader hears.
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
  };
}

export interface AnswerOption { id: string; label: string; detail?: string; cost?: string }

/**
 * A question's options as buttons. The chosen one stays pressed; while its answer
 * waits or is sent (`seconds`, `sending`) it reads as the wait, with Undo and a
 * line that runs out, and the others dim.
 */
export function AnswerOptions({ options, chosen, seconds, sending, onChoose, onUndo }: {
  options: readonly AnswerOption[];
  chosen?: string;
  seconds: number | null;
  sending: boolean;
  onChoose: (option: AnswerOption) => void;
  onUndo: () => void;
}) {
  const waiting = seconds !== null || sending;
  return <fieldset className="space-y-2 text-sm"><legend className="font-medium">Choose an option</legend>
    {options.map((option) => {
      const pressed = chosen === option.id;
      return <div key={option.id} className={`relative rounded-lg border ${pressed ? "border-primary bg-primary/10" : "border-border"} ${waiting && !pressed ? "opacity-50" : ""}`}>
        <button type="button" aria-pressed={pressed} disabled={waiting && !pressed} onClick={() => onChoose(option)} className="block min-h-12 w-full rounded-lg px-3 py-2 text-left active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span className={`block ${pressed && waiting ? "opacity-0" : ""}`}>
            <span className="font-medium">{option.label}</span>
            {option.detail && <span className="mt-1 block text-muted-foreground">{option.detail}</span>}
            {option.cost && <span className="mt-1 block text-xs">Cost: {option.cost}</span>}
          </span>
        </button>
        {/* The wait lies over the option, which keeps its size: nothing moves while Undo is on offer. */}
        {pressed && waiting && <div className="pointer-events-none absolute inset-0 flex items-center gap-2 overflow-hidden rounded-lg px-3">
          <span aria-hidden className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
          <span className="tnum shrink-0 text-xs">{sendingLabel(seconds)}</span>
          {seconds !== null && <button type="button" onClick={onUndo} className="pointer-events-auto min-h-10 shrink-0 rounded-lg border border-border bg-background px-3 font-medium">Undo</button>}
          {seconds !== null && <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-primary motion-safe:animate-out motion-safe:slide-out-to-left motion-safe:ease-linear motion-safe:fill-mode-forwards motion-reduce:hidden" style={{ animationDuration: `${ANSWER_UNDO_SECONDS}s` }} />}
        </div>}
      </div>;
    })}
  </fieldset>;
}
