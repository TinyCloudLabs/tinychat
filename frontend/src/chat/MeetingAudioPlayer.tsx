import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { Loader2Icon, PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

interface MeetingAudioPlayerProps {
  /**
   * Reads the stored audio. The caller owns serializing it with its other
   * storage reads; `onProgress` reports bytes read so far.
   */
  load?: (
    signal: AbortSignal,
    onProgress: (loadedBytes: number, totalBytes: number) => void,
  ) => Promise<Blob | null>;
  /** A local native file URL. It is handed straight to the audio element. */
  url?: string;
  onPlayingChange?: (playing: boolean) => void;
  /** Plays from `seconds` in: loads the audio first if it is not loaded yet. A new `nonce` is a new request. */
  seek?: { seconds: number; nonce: number } | null;
}

export type PlayerState =
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
export function MeetingAudioPlayer({ load, url, onPlayingChange, seek }: MeetingAudioPlayerProps) {
  const [state, setState] = useState<PlayerState>({ phase: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
  const audioRef = useRef<HTMLAudioElement>(null);
  const wanted = useRef<number | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      onPlayingChangeRef.current?.(false);
    },
    [],
  );

  const onPlay = useCallback(async () => {
    if (url) {
      setState({ phase: "ready", url });
      return;
    }
    if (!load) return;
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
  }, [load, url]);

  const playFrom = (audio: HTMLAudioElement, seconds: number) => {
    audio.currentTime = seconds;
    audio.play().catch((error: unknown) => console.error("[Audio] Could not play from a moment", error));
  };
  const seekNonce = seek?.nonce;
  useEffect(() => {
    if (!seek) return;
    const audio = audioRef.current;
    if (state.phase === "ready" && audio && audio.readyState >= 1) {
      playFrom(audio, seek.seconds);
      return;
    }
    wanted.current = seek.seconds;
    if (state.phase === "idle" || state.phase === "failed") void onPlay();
    // A request is one nonce; the state it waits on is read when it arrives.
  }, [seekNonce]);
  const onLoadedMetadata = () => {
    const audio = audioRef.current;
    if (wanted.current === null || !audio) return;
    const seconds = wanted.current;
    wanted.current = null;
    playFrom(audio, seconds);
  };

  return <MeetingAudioPlayerView state={state} onPlay={() => void onPlay()} onPlayingChange={onPlayingChange}
    audioRef={audioRef} onLoadedMetadata={onLoadedMetadata}
    onError={() => { onPlayingChange?.(false); setState({ phase: "failed" }); }} />;
}

/** What the player shows in each state (rendered on the server in the tests). */
export function MeetingAudioPlayerView({ state, onPlay, onPlayingChange, onError, audioRef, onLoadedMetadata }: { state: PlayerState; onPlay: () => void; onPlayingChange?: (playing: boolean) => void; onError?: () => void; audioRef?: Ref<HTMLAudioElement>; onLoadedMetadata?: () => void }) {
  if (state.phase === "ready") {
    return <audio ref={audioRef} onLoadedMetadata={onLoadedMetadata} controls autoPlay src={state.url} onPlay={() => onPlayingChange?.(true)} onPause={() => onPlayingChange?.(false)} onEnded={() => onPlayingChange?.(false)} onError={onError} className="h-11 w-full" data-testid="note-audio-player" />;
  }
  if (state.phase === "loading") {
    return (
      <p className="flex min-h-11 items-center gap-1.5 text-callout text-muted-foreground" role="status">
        <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden />
        <span className="tnum">Loading audio…{state.percent === null ? "" : ` ${state.percent}%`}</span>
      </p>
    );
  }
  if (state.phase === "missing") {
    return <p className="text-callout text-muted-foreground">The audio is no longer stored.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button type="button" variant="outline" onClick={onPlay} data-testid="note-audio-play">
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
