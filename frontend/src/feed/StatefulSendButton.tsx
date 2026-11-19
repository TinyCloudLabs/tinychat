// One Send button that shows the whole life of a send: Send → spinner → a small
// dark "Sent" pill (the same look as the history pill) → back to Send, or
// "Couldn't send · Retry" when it fails. It stays a real <button> the whole time,
// so focus never jumps while the state changes. `compact` is the round arrow that
// sits inside a composer's field (ComposerField.tsx).
import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon } from "lucide-react";
import { AnimatePresence, MotionConfig, m } from "motion/react";
import { cn } from "@/lib/utils";

export type SendState = "idle" | "sending" | "sent" | "error";

const STATUS: Record<SendState, string> = {
  idle: "",
  sending: "Sending…",
  sent: "Sent",
  error: "Couldn't send. Choose Retry to try again.",
};

export function StatefulSendButton({ onSend, disabled = false, label = "Send", className, state, keepSent = false, sentFor = 1500, compact = false }: {
  // Runs the real send. Throwing (or rejecting) shows the error state.
  onSend: () => Promise<unknown> | void;
  disabled?: boolean;
  label?: string;
  className?: string;
  // Pass to drive the button from outside when the caller owns the send (for
  // example an undo window that saves later). Leave unset to let the button
  // follow onSend's promise itself.
  state?: SendState;
  // Stay on "Sent" instead of returning to the label.
  keepSent?: boolean;
  sentFor?: number;
  // A round arrow, 32px to see in a 44px target (36px with a mouse), for inside a composer's field. `label` is then
  // what a screen reader hears; "Sent" and "Couldn't send · Retry" still show as words in a pill.
  compact?: boolean;
}) {
  const [own, setOwn] = useState<SendState>("idle");
  const current = state ?? own;
  const busy = useRef(false);

  // "Sent" is a moment, not a place: it fades back to Send unless told to stay.
  useEffect(() => {
    if (state !== undefined || own !== "sent" || keepSent) return;
    const timer = setTimeout(() => setOwn("idle"), sentFor);
    return () => clearTimeout(timer);
  }, [state, own, keepSent, sentFor]);

  async function run() {
    // Guard against a double tap starting two sends.
    if (busy.current || disabled || current === "sending" || current === "sent") return;
    if (state !== undefined) { void onSend(); return; }
    busy.current = true;
    setOwn("sending");
    try { await onSend(); setOwn("sent"); }
    catch { setOwn("error"); }
    finally { busy.current = false; }
  }

  // aria-disabled rather than disabled while busy, so focus stays on the button.
  const inert = current === "sending" || current === "sent";
  const spinner = <span aria-hidden className="size-3.5 rounded-full border-2 border-current border-r-transparent animate-spin [animation-duration:0.8s] motion-reduce:animate-none" />;
  return <MotionConfig reducedMotion="user">
    <m.button type="button" layout="size" transition={{ type: "spring", bounce: 0, duration: 0.3 }}
      disabled={disabled && current === "idle"} aria-disabled={inert || undefined} aria-busy={current === "sending" || undefined}
      onClick={() => void run()}
      className={compact
        // The button is the target; the span inside is what you see, and it carries the focus ring.
        ? cn("group inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-sm font-medium focus-visible:outline-none disabled:opacity-50 fine:min-h-9 fine:min-w-9", inert && "cursor-default", className)
        : cn("inline-flex min-h-11 items-center justify-center gap-2 overflow-hidden px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 fine:min-h-10",
          current === "sent" ? "rounded-full bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
            : current === "error" ? "rounded-lg border border-destructive/60 bg-destructive/10 text-destructive"
              : "rounded-lg bg-primary text-primary-foreground",
          inert && "cursor-default", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span key={current} className={compact
          ? cn("inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-full group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background",
            current === "sent" ? "bg-neutral-900 px-3 text-white dark:bg-neutral-100 dark:text-neutral-900"
              : current === "error" ? "border border-destructive/60 bg-destructive/10 px-3 text-destructive"
                : "w-8 bg-primary text-primary-foreground")
          : "inline-flex items-center gap-2 whitespace-nowrap"}
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }}>
          {current === "sending" && (compact ? <>{spinner}<span className="sr-only">Sending…</span></> : <>{spinner}Sending…</>)}
          {current === "sent" && <span className="text-[11px] font-semibold uppercase tracking-wider">Sent</span>}
          {current === "error" && <>Couldn't send · Retry</>}
          {current === "idle" && (compact ? <><ArrowUpIcon aria-hidden className="size-4" /><span className="sr-only">{label}</span></> : label)}
        </m.span>
      </AnimatePresence>
    </m.button>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{STATUS[current]}</span>
  </MotionConfig>;
}
