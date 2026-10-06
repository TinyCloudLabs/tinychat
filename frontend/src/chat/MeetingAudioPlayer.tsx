import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

interface MeetingAudioPlayerProps {
  /**
   * Reads the stored audio. The caller owns serializing it with its other
   * storage reads; `onProgress` reports bytes read so far.
   */
  load: (
    signal: AbortSignal,
    onProgress: (loadedBytes: number, totalBytes: number) => void,
  ) => Promise<Blob | null>;
}

type PlayerState =
  | { phase: "idle" }
  | { phase: "loading"; percent: number | null }
  | { phase: "ready"; url: string }
  | { phase: "missing" }
  | { phase: "failed" };

/**
 * The original audio of one note, fetched only when the user asks for it:
 * a stored file can be tens of megabytes, so opening a note never reads it.
 * Unmounting (closing the meeting) aborts an in-flight read and releases the
 * object URL.
 */
export function MeetingAudioPlayer({ load }: MeetingAudioPlayerProps) {
  const [state, setState] = useState<PlayerState>({ phase: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const onPlay = useCallback(async () => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ phase: "loading", percent: null });
    try {
      const blob = await load(controller.signal, (loaded, total) => {
        if (!controller.signal.aborted && total > 0) {
          setState({ phase: "loading", percent: Math.floor((loaded / total) * 100) });
        }
      });
      if (controller.signal.aborted) return;
      if (!blob) {
        setState({ phase: "missing" });
        return;
      }
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setState({ phase: "ready", url });
    } catch {
      if (!controller.signal.aborted) setState({ phase: "failed" });
    }
  }, [load]);

  if (state.phase === "ready") {
    return <audio controls autoPlay src={state.url} className="h-11 w-full" data-testid="note-audio-player" />;
  }
  if (state.phase === "loading") {
    return (
      <p className="flex min-h-11 items-center gap-1.5 text-callout text-muted-foreground" role="status">
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
        <span className="tnum">Loading audio…{state.percent === null ? "" : ` ${state.percent}%`}</span>
      </p>
    );
  }
  if (state.phase === "missing") {
    return <p className="text-callout text-muted-foreground">The audio is no longer stored.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button type="button" variant="outline" onClick={() => void onPlay()} data-testid="note-audio-play">
        <PlayIcon aria-hidden />
        <span>{state.phase === "failed" ? "Try again" : "Play audio"}</span>
      </Button>
      {state.phase === "failed" && (
        <p role="alert" className="text-callout text-muted-foreground">
          Couldn&apos;t load the audio just now.
        </p>
      )}
    </div>
  );
}
