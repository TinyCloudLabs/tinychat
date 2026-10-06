// Discard in the recorder's header (TC-761, PR5; plan §2.9): a quiet text
// action, far from Stop. A tap turns it, in place, into "Discard?" with Keep
// and Discard (rareui's delete-button pattern, rather than an alert dialog
// stacked on the sheet). Focus moves to Keep. Keep, or 5 s without an answer,
// turns it back, and focus goes back to the action.
import { useCallback, useEffect, useId, useRef, useState, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { DISCARD_PROMPT, DISCARD_PROMPT_SPOKEN } from "./recorderCopy";

/** How long the question waits for an answer before it turns back into the action. */
export const DISCARD_REVERT_MS = 5000;

export interface DiscardConfirmViewProps {
  confirming: boolean;
  onAsk(): void;
  onKeep(): void;
  onDiscard(): void;
  askRef?: Ref<HTMLButtonElement>;
  keepRef?: Ref<HTMLButtonElement>;
  groupRef?: Ref<HTMLDivElement>;
}

export function DiscardConfirmView(props: DiscardConfirmViewProps) {
  const promptId = useId();
  if (!props.confirming) {
    return (
      <Button
        ref={props.askRef}
        type="button"
        variant="ghost"
        onClick={props.onAsk}
        className="shrink-0 px-3 text-callout text-muted-foreground hover:text-foreground"
        data-testid="recorder-discard"
      >
        Discard
      </Button>
    );
  }
  return (
    <div
      ref={props.groupRef}
      role="group"
      aria-labelledby={promptId}
      // Its right edge lines up with the sheet's content (20px in). With large text
      // the question takes its own line, above Keep and Discard.
      className="mr-3 flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
      data-testid="recorder-discard-confirm"
    >
      <p id={promptId} className="min-w-0 pr-1 text-right text-callout font-semibold">
        <span aria-hidden="true">{DISCARD_PROMPT}</span>
        <span className="sr-only">{DISCARD_PROMPT_SPOKEN}</span>
      </p>
      <Button ref={props.keepRef} type="button" variant="ghost" onClick={props.onKeep} className="shrink-0 px-3 text-callout" data-testid="recorder-discard-keep">
        Keep
      </Button>
      <Button type="button" variant="destructive" onClick={props.onDiscard} className="shrink-0 px-3 text-callout" data-testid="recorder-discard-yes">
        Discard
      </Button>
    </div>
  );
}

/**
 * The Discard action and its question. `held` starts on the question and keeps
 * it there (the screenshot harness).
 */
export function DiscardConfirm(props: { onDiscard(): void; held?: boolean }) {
  const { held = false } = props;
  const [confirming, setConfirming] = useState(held);
  const askRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  // The question had focus when it went: the action gets it back, so focus is never dropped.
  const refocusAsk = useRef(false);

  const revert = useCallback(() => {
    refocusAsk.current = groupRef.current?.contains(document.activeElement) ?? false;
    setConfirming(false);
  }, []);

  useEffect(() => {
    if (!confirming) {
      if (refocusAsk.current) askRef.current?.focus();
      refocusAsk.current = false;
      return;
    }
    keepRef.current?.focus();
    if (held) return;
    const timer = setTimeout(revert, DISCARD_REVERT_MS);
    return () => clearTimeout(timer);
  }, [confirming, held, revert]);

  return (
    <DiscardConfirmView
      confirming={confirming}
      onAsk={() => setConfirming(true)}
      onKeep={revert}
      onDiscard={props.onDiscard}
      askRef={askRef}
      keepRef={keepRef}
      groupRef={groupRef}
    />
  );
}
