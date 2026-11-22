// The owner's "Start a new chat" with Main, in Main's chat sheet next to its settings. It asks first, then the service
// clears Main's conversation and the questions it is waiting on and keeps the settings and saved history. TC-3808
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { BotsRouteMissing } from "./botsApi";
import { NEW_CHAT_STRINGS as COPY } from "./botsStrings";
import type { NewChatOutcome } from "./mainNewChat";

export interface NewChatApi {
  start(): Promise<NewChatOutcome>;
  /** Called once a new chat started, so the questions shown are read again. */
  onStarted?(): void;
}

const LINES: Record<NewChatOutcome | "failed", string> = {
  cleared: COPY.started,
  busy: COPY.busy,
  archive_pending: COPY.archivePending,
  failed: COPY.failed,
};

/** Renders nothing once the service answers 404 (the route is not on for this account). */
export function NewChat({ api }: { api: NewChatApi }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<NewChatOutcome | "failed" | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { if (confirming) box.current?.focus(); }, [confirming]);

  if (missing) return null;

  const start = async () => {
    setStarting(true);
    let outcome: NewChatOutcome | "failed";
    try {
      outcome = await api.start();
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof BotsRouteMissing) { setMissing(true); return; }
      outcome = "failed";
    }
    if (!alive.current) return;
    setStarting(false);
    setConfirming(false);
    setResult(outcome);
    if (outcome === "cleared") api.onStarted?.();
  };

  return (
    <section className="flex flex-col items-start gap-3" data-bots-new-chat="">
      {confirming ? (
        <div
          ref={box}
          tabIndex={-1}
          role="alertdialog"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-body`}
          className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p id={`${id}-title`} className="text-headline">{COPY.confirmTitle}</p>
          <p id={`${id}-body`} className="text-callout text-muted-foreground">{COPY.confirmBody}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={starting} onClick={() => void start()}>{COPY.confirm}</Button>
            <Button type="button" variant="outline" disabled={starting} onClick={() => setConfirming(false)}>{COPY.cancel}</Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => { setResult(null); setConfirming(true); }}>{COPY.start}</Button>
      )}
      {result ? <p role={result === "cleared" ? "status" : "alert"} className="text-callout text-muted-foreground">{LINES[result]}</p> : null}
    </section>
  );
}
