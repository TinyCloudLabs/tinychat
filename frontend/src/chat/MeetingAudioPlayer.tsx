import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Loader2Icon, PauseIcon, PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClockDuration } from "@/capture/library/formatters";
import { PHONE_AUDIO_UNAVAILABLE, playbackDuration, scrubTarget } from "./audioPlayback";

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
  /**
   * Resolves a local native file URL when Play is tapped (or a moment is sought); the URL is
   * handed straight to the audio element, with no fetch and no read into memory. A rejection
   * is shown as the reason.
   */
  resolveUrl?: () => Promise<string>;
  /** How long the recording is, in seconds, when it is known before the audio loads. */
  durationSecs?: number | null;
  onPlayingChange?: (playing: boolean) => void;
  /** Plays from `seconds` in: loads the audio first if it is not loaded yet. A new `nonce` is a new request. */
  seek?: { seconds: number; nonce: number } | null;
}

export type PlayerState =
  | { phase: "idle" }
  | { phase: "loading"; percent: number | null }
  | { phase: "ready"; url: string }
  | { phase: "missing" }
  | { phase: "failed"; reason?: string };

/** Ready with the resolved URL, or failed with calm copy; the real reason it could not be resolved goes to the console. */
export async function stateForResolvedUrl(resolveUrl: () => Promise<string>): Promise<PlayerState> {
  try {
    return { phase: "ready", url: await resolveUrl() };
  } catch (error) {
    console.error("[Audio] Could not resolve this phone's audio", error);
    return { phase: "failed", reason: PHONE_AUDIO_UNAVAILABLE };
  }
}

/**
 * The original audio of one note, fetched only when the user asks for it:
 * a stored file can be tens of megabytes, so opening a note never reads it.
 * Unmounting (closing the meeting) aborts an in-flight read and releases the
 * object URL.
 */
export function MeetingAudioPlayer({ load, url, resolveUrl, durationSecs, onPlayingChange, seek }: MeetingAudioPlayerProps) {
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
    const controller = new AbortController();
    if (resolveUrl) {
      controllerRef.current = controller;
      setState({ phase: "loading", percent: null });
      const next = await stateForResolvedUrl(resolveUrl);
      if (!controller.signal.aborted) setState(next);
      return;
    }
    if (!load) return;
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
  }, [load, resolveUrl, url]);

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

  return <MeetingAudioPlayerView state={state} onPlay={() => void onPlay()} durationSecs={durationSecs} onPlayingChange={onPlayingChange}
    audioRef={audioRef} onLoadedMetadata={onLoadedMetadata}
    onError={() => { onPlayingChange?.(false); setState({ phase: "failed" }); }} />;
}

interface ViewProps {
  state: PlayerState;
  onPlay: () => void;
  durationSecs?: number | null;
  onPlayingChange?: (playing: boolean) => void;
  onError?: () => void;
  audioRef?: RefObject<HTMLAudioElement | null>;
  onLoadedMetadata?: () => void;
}

/** What the player shows in each state (rendered on the server in the tests). */
export function MeetingAudioPlayerView({ state, onPlay, durationSecs, onPlayingChange, onError, audioRef, onLoadedMetadata }: ViewProps) {
  if (state.phase === "ready") {
    return <ReadyPlayer url={state.url} durationSecs={durationSecs} audioRef={audioRef} onLoadedMetadata={onLoadedMetadata} onPlayingChange={onPlayingChange} onError={onError} />;
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
      <Button type="button" variant="outline" className="h-auto min-h-11 whitespace-normal text-left" onClick={onPlay} data-testid="note-audio-play">
        <PlayIcon aria-hidden />
        <span>{state.phase === "failed" ? "Try again" : "Play audio"}</span>
      </Button>
      {state.phase === "failed" && (
        <p role="alert" className="text-callout text-muted-foreground">
          {state.reason ?? "Couldn\u2019t load the audio just now."}
        </p>
      )}
    </div>
  );
}

/**
 * One player for every note: play or pause, elapsed over total, and a scrubber. The audio element
 * is the engine and stays out of sight, because the native controls show 00:00 for the length
 * until the file's header has been read.
 */
function ReadyPlayer({ url, durationSecs, audioRef, onLoadedMetadata, onPlayingChange, onError }: Pick<ViewProps, "durationSecs" | "audioRef" | "onLoadedMetadata" | "onPlayingChange" | "onError"> & { url: string }) {
  const ownRef = useRef<HTMLAudioElement>(null);
  const ref = audioRef ?? ownRef;
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [mediaSecs, setMediaSecs] = useState(NaN);
  const total = playbackDuration(durationSecs, mediaSecs);
  const loading = !metadataLoaded || waiting;
  const shownElapsed = total === null ? elapsed : Math.min(elapsed, total);
  const elapsedText = formatClockDuration(Math.floor(shownElapsed));
  const readout = total !== null ? `${elapsedText} / ${formatClockDuration(total)}` : loading ? "Loading…" : elapsedText;

  const readClock = (audio: HTMLAudioElement) => {
    setElapsed(audio.currentTime);
    setMediaSecs(audio.duration);
  };
  const setPlayingState = (next: boolean) => {
    setPlaying(next);
    onPlayingChange?.(next);
  };
  const toggle = () => {
    const audio = ref.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    audio.play().catch((error: unknown) => {
      console.error("[Audio] Could not play", error);
      onError?.();
    });
  };

  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-2 rounded-lg bg-muted/50 py-0.5 pr-3" data-testid="note-audio-controls" data-loading={loading || undefined}>
      <Button type="button" variant="ghost" size="icon" onClick={toggle} aria-label={playing ? "Pause" : "Play"} data-testid="note-audio-toggle">
        {playing ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
      </Button>
      <input
        type="range"
        aria-label="Seek"
        className="h-11 min-w-[96px] flex-1 basis-[96px] cursor-pointer accent-primary disabled:cursor-default disabled:opacity-50"
        min={0}
        max={total ?? 1}
        step={0.1}
        value={total === null ? 0 : shownElapsed}
        disabled={!metadataLoaded || total === null}
        onChange={(event) => {
          const audio = ref.current;
          if (!audio) return;
          const target = scrubTarget(Number(event.currentTarget.value), total);
          audio.currentTime = target;
          setElapsed(target);
        }}
      />
      <span className="tnum ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-meta text-muted-foreground" data-testid="note-audio-time">
        {loading && <Loader2Icon className="size-3.5 motion-safe:animate-spin" aria-hidden />}
        {readout}
      </span>
      {loading && <span className="sr-only" role="status">Loading audio…</span>}
      <audio
        ref={ref}
        autoPlay
        preload="auto"
        src={url}
        className="sr-only"
        data-testid="note-audio-player"
        onLoadedMetadata={(event) => {
          setMetadataLoaded(true);
          readClock(event.currentTarget);
          onLoadedMetadata?.();
        }}
        onDurationChange={(event) => setMediaSecs(event.currentTarget.duration)}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
        onSeeked={(event) => readClock(event.currentTarget)}
        onWaiting={() => setWaiting(true)}
        onCanPlay={() => setWaiting(false)}
        onPlaying={() => setWaiting(false)}
        onPlay={() => setPlayingState(true)}
        onPause={() => setPlayingState(false)}
        onEnded={() => setPlayingState(false)}
        onError={onError}
      />
    </div>
  );
}
