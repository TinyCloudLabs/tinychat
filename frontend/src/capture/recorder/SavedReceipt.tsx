// The receipt when a recording lands (plan §2.7): it says where the note is,
// with the route's last node checked. A save that failed says the note is
// still on the phone and offers Save now.
import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { CheckIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MeetingAudioPlayer } from "@/chat/MeetingAudioPlayer";
import { cn } from "@/lib/utils";
import { VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { receiptMetaText } from "./recorderCopy";
import { RouteLine, type RouteNode } from "./RouteLine";

export interface SavedReceiptProps {
  outcome: "local" | "saved" | "failed";
  localUpload?: "uploading" | "held" | "in-flight" | null;
  /** The saved note (absent after a failure). */
  saved?: { id: string; durationMs: number; at: number } | null;
  route: readonly RouteNode[];
  /** Private cloud has the note now. */
  transcribing?: boolean;
  error?: string | null;
  /** A save of the notes on this phone is running. */
  retrying?: boolean;
  onOpen?: () => void;
  onDone: () => void;
  onSaveNow: () => void;
  onPlayingChange?: (playing: boolean) => void;
  className?: string;
}

export function SavedReceipt(props: SavedReceiptProps) {
  const saved = props.outcome === "saved";
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (!props.saved) return;
    let active = true;
    setLocalUrl(null);
    setLocalError(null);
    void VoiceNotes.localAudioUrl({ id: props.saved.id }).then(
      ({ url }) => { if (active) setLocalUrl(Capacitor.convertFileSrc(url)); },
      (caught: unknown) => { if (active) setLocalError(`Could not open this phone's audio: ${caught instanceof Error ? caught.message : String(caught)}`); },
    );
    return () => { active = false; };
  }, [props.saved?.id]);
  return (
    <section
      aria-label="Saved on this phone"
      data-testid="voice-note-receipt"
      data-outcome={props.outcome}
      className={cn("flex flex-col gap-3 rounded-xl border border-border p-4 motion-safe:animate-rise-in", props.className)}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="flex items-center gap-2 text-headline">
          <CheckIcon className="size-5 text-primary" aria-hidden="true" /> Saved on this phone
        </h3>
        {props.saved && <p className="tnum text-meta text-muted-foreground">{receiptMetaText(props.saved.durationMs, props.saved.at)}</p>}
        {props.error && (
          <p role="alert" className="text-meta text-muted-foreground">
            {props.error}
          </p>
        )}
      </div>
      {localUrl && <MeetingAudioPlayer url={localUrl} onPlayingChange={props.onPlayingChange} />}
      {localError && <p role="alert" className="text-callout text-destructive">{localError}</p>}
      {!localUrl && !localError && props.saved && <p role="status" className="text-meta text-muted-foreground">Getting this phone&apos;s audio…</p>}
      <RouteLine nodes={props.route} landed={saved} />
      {props.outcome === "local" && <p className="text-meta text-muted-foreground">{
        props.localUpload === "held" ? "Kept on this phone. This note needs an ownership check before upload."
          : props.localUpload === "in-flight" ? "Another save is finishing in your TinyCloud space…"
          : "Saving to your TinyCloud space…"
      }</p>}
      {saved && <p className="text-meta text-muted-foreground">Saved to your TinyCloud space</p>}
      {saved && props.transcribing && <p className="text-meta text-muted-foreground">Transcribing in private cloud…</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {saved || props.outcome === "local" ? (
          <>
            {props.onOpen && (
              <Button type="button" variant="outline" onClick={props.onOpen} data-testid="voice-note-receipt-open">
                Open
              </Button>
            )}
            <Button type="button" onClick={props.onDone} data-testid="voice-note-receipt-done">
              Done
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={props.onDone} data-testid="voice-note-receipt-done">
              Done
            </Button>
            <Button type="button" onClick={props.onSaveNow} disabled={props.retrying} data-testid="voice-note-retry">
              {props.retrying && <Loader2Icon className="animate-spin" aria-hidden="true" />} Save now
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
