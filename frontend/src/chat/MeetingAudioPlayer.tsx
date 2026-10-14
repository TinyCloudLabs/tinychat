import { useContext, useEffect, useRef, useState } from "react";
import { Loader2Icon, PauseIcon, PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClockDuration } from "@/capture/library/formatters";
import { playbackBlocked, playbackVisible, registerPlayback } from "@/lib/audio/playback";
import { NotePlaybackContext } from "@/lib/audio/notePlayback";
import { PHONE_AUDIO_UNAVAILABLE, isSeekable, playbackDuration, scrubTarget } from "./audioPlayback";

interface MeetingAudioPlayerProps {
  /**
   * Reads the stored audio. The caller owns serializing it with its other
   * storage reads; `onProgress` reports bytes read so far.
   */
  load?: (
    signal: AbortSignal,
    onProgress: (loadedBytes: number, totalBytes: number) => void,
  ) => Promise<Blob | string | null>;
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
  /** Committed capture layout. Only stereo notes need a Web Audio downmix. */
  channels?: 1 | 2;
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
    console.error("[Audio] Could not resolve local audio", error);
    return { phase: "failed", reason: PHONE_AUDIO_UNAVAILABLE };
  }
}

/** What the audio element has reported so far. */
export interface PlayerMedia {
  playing: boolean;
  /** The header has not been read yet, or playback is stalled waiting for data. */
  loading: boolean;
  /** The media's position, or the position the user asked for while that seek is still pending. */
  elapsed: number;
  /** The media's own length: NaN, Infinity or 0 until it has been read. */
  mediaSecs: number;
}

const NO_MEDIA: PlayerMedia = { playing: false, loading: true, elapsed: 0, mediaSecs: NaN };

/**
 * The original audio of one note, fetched only when the user asks for it:
 * a stored file can be tens of megabytes, so opening a note never reads it.
 * Unmounting (closing the meeting) aborts an in-flight read and releases the
 * object URL.
 *
 * One `<audio>` stays mounted for the player's whole life. Browsers allow audible playback only
 * from a user gesture, and the first tap often has to resolve or read the audio before it has a
 * source; so the tap calls `play()` on the mounted element at once (which unlocks it), and plays
 * again once the source is set.
 */
export function MeetingAudioPlayer({ load, url, resolveUrl, durationSecs, channels, onPlayingChange, seek }: MeetingAudioPlayerProps) {
  const notePlayback = useContext(NotePlaybackContext);
  const notePlaybackRef = useRef(notePlayback);
  notePlaybackRef.current = notePlayback;
  const [state, setState] = useState<PlayerState>({ phase: "idle" });
  const [media, setMedia] = useState<PlayerMedia>(NO_MEDIA);
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
  const audioRef = useRef<HTMLAudioElement>(null);
  const downmixRef = useRef<AudioContext | null>(null);
  const queuedSeek = useRef<number | null>(null);
  const playWhenSourceSet = useRef(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let mounted = true;
    const unregister = registerPlayback(audio, () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      playWhenSourceSet.current = false;
      queuedSeek.current = null;
      audio.pause();
      if (mounted) {
        setPendingSeek(null);
        setState((current) => current.phase === "loading" ? { phase: "idle" } : current);
      }
    });
    return () => { mounted = false; unregister(); };
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      void downmixRef.current?.close();
      onPlayingChangeRef.current?.(false);
    },
    [],
  );

  const patchMedia = (patch: Partial<PlayerMedia>) => setMedia((current) => ({ ...current, ...patch }));
  const setPlaying = (playing: boolean) => {
    patchMedia({ playing });
    onPlayingChange?.(playing);
    notePlaybackRef.current?.onClock(audioRef.current?.currentTime ?? 0, playing);
  };
  const fail = (reason?: string) => {
    setPlaying(false);
    setState({ phase: "failed", reason });
  };
  const readClock = (audio: HTMLAudioElement) => {
    patchMedia({ elapsed: audio.currentTime, mediaSecs: audio.duration });
    notePlaybackRef.current?.onClock(audio.currentTime, !audio.paused);
  };

  /** A play() that was superseded by a pause() or a new source (AbortError) is not a failure; anything else is shown. */
  const playNow = (audio: HTMLAudioElement) => {
    if (playbackBlocked() || !playbackVisible(audio)) return;
    audio.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("[Audio] Could not play", error);
      fail();
    });
  };

  const seekTo = (audio: HTMLAudioElement, requested: number) => {
    if (audio.readyState < 1) {
      queuedSeek.current = requested;
      setPendingSeek(requested);
      return;
    }
    // The saved length can be longer than the file; a seek past its real end lands on the end.
    const seconds = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.min(requested, audio.duration) : requested;
    if (!isSeekable(audio.seekable, seconds)) {
      console.warn("[Audio] The audio cannot seek to", seconds);
      setPendingSeek(null);
      return;
    }
    setPendingSeek(seconds);
    audio.currentTime = seconds;
  };

  // The first tap: play() runs inside the gesture whatever the source is doing.
  const begin = () => {
    const audio = audioRef.current;
    if (!audio || playbackBlocked() || !playbackVisible(audio)) return;
    // A stereo note needs one speaker-interpreted mono input. The browser
    // averages L and R; a discrete splitter would halve a mono signal too.
    if (channels === 2 && !downmixRef.current && typeof AudioContext !== "undefined") {
      const context = new AudioContext();
      const source = context.createMediaElementSource(audio);
      const mono = context.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = "explicit";
      mono.channelInterpretation = "speakers";
      source.connect(mono);
      mono.connect(context.destination);
      downmixRef.current = context;
    }
    if (downmixRef.current?.state === "suspended") void downmixRef.current.resume();
    patchMedia({ loading: true });
    if (url) {
      if (audio.error) audio.load();
      setState({ phase: "ready", url });
      playNow(audio);
      return;
    }
    // No source yet: this call only unlocks the element for the play() that follows the source.
    audio.play().catch(() => {});
    void resolveSource();
  };

  const resolveSource = async () => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ phase: "loading", percent: null });
    if (resolveUrl) {
      const next = await stateForResolvedUrl(resolveUrl);
      if (controller.signal.aborted) return;
      playWhenSourceSet.current = next.phase === "ready";
      setState(next);
      return;
    }
    if (!load) return;
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
      if (typeof blob === "string") {
        playWhenSourceSet.current = true;
        setState({ phase: "ready", url: blob });
        return;
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const objectUrl = URL.createObjectURL(blob);
      urlRef.current = objectUrl;
      playWhenSourceSet.current = true;
      setState({ phase: "ready", url: objectUrl });
    } catch (error) {
      if (!controller.signal.aborted) setState({ phase: "failed",
        reason: error instanceof Error && error.message === "This audio changed; reconnect to play the latest version"
          ? error.message : undefined });
    }
  };

  const stateKey = state.phase === "ready" ? state.url : state.phase;
  useEffect(() => {
    if (state.phase !== "ready" || !playWhenSourceSet.current) return;
    playWhenSourceSet.current = false;
    if (audioRef.current) playNow(audioRef.current);
  }, [stateKey]);

  const applyRequestedSeek = (requested: { seconds: number; nonce: number } | null | undefined) => {
    const audio = audioRef.current;
    if (!requested || !audio) return;
    seekTo(audio, requested.seconds);
    if (state.phase === "ready") playNow(audio);
    else if (state.phase === "idle" || state.phase === "failed") begin();
  };
  useEffect(() => {
    applyRequestedSeek(seek);
    // A request is one nonce; the state it waits on is read when it arrives.
  }, [seek?.nonce]);
  useEffect(() => {
    applyRequestedSeek(notePlayback?.seek);
  }, [notePlayback?.seek?.nonce]);

  const onLoadedMetadata = (audio: HTMLAudioElement) => {
    patchMedia({ loading: false, elapsed: audio.currentTime, mediaSecs: audio.duration });
    const queued = queuedSeek.current;
    if (queued === null) return;
    queuedSeek.current = null;
    seekTo(audio, queued);
  };

  const src = state.phase === "ready" ? state.url : url;
  return (
    <>
      <audio
        ref={audioRef}
        preload={state.phase === "idle" ? "none" : "auto"}
        src={src}
        className="sr-only"
        data-testid="note-audio-player"
        onLoadedMetadata={(event) => onLoadedMetadata(event.currentTarget)}
        onDurationChange={(event) => patchMedia({ mediaSecs: event.currentTarget.duration })}
        onTimeUpdate={(event) => readClock(event.currentTarget)}
        onSeeked={(event) => {
          setPendingSeek(null);
          readClock(event.currentTarget);
        }}
        onWaiting={() => patchMedia({ loading: true })}
        onCanPlay={() => patchMedia({ loading: false })}
        onPlaying={() => patchMedia({ loading: false })}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => fail()}
      />
      <MeetingAudioPlayerView
        state={state}
        onPlay={begin}
        durationSecs={durationSecs}
        media={{ ...media, elapsed: pendingSeek ?? media.elapsed }}
        onToggle={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (audio.paused) playNow(audio);
          else audio.pause();
        }}
        onScrub={(seconds) => {
          if (audioRef.current) seekTo(audioRef.current, seconds);
        }}
      />
    </>
  );
}

interface ViewProps {
  state: PlayerState;
  onPlay: () => void;
  durationSecs?: number | null;
  media?: PlayerMedia;
  onToggle?: () => void;
  onScrub?: (seconds: number) => void;
}

/** What the player shows in each state (rendered on the server in the tests). The audio element is the caller's. */
export function MeetingAudioPlayerView({ state, onPlay, durationSecs, media = NO_MEDIA, onToggle, onScrub }: ViewProps) {
  if (state.phase === "ready") {
    return <ReadyControls durationSecs={durationSecs} media={media} onToggle={onToggle} onScrub={onScrub} />;
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
 * until the file's header has been read. The scrubber spans the saved length from the start; a
 * seek made before the media can take it waits for it.
 */
function ReadyControls({ durationSecs, media, onToggle, onScrub }: Pick<ViewProps, "durationSecs" | "onToggle" | "onScrub"> & { media: PlayerMedia }) {
  const { playing, loading } = media;
  const total = playbackDuration(durationSecs, media.mediaSecs);
  const shownElapsed = total === null ? media.elapsed : Math.min(media.elapsed, total);
  const elapsedText = formatClockDuration(Math.floor(shownElapsed));
  const readout = total !== null ? `${elapsedText} / ${formatClockDuration(total)}` : loading ? "Loading…" : elapsedText;

  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-2 rounded-lg bg-muted/50 py-0.5 pr-3" data-testid="note-audio-controls" data-loading={loading || undefined}>
      <Button type="button" variant="ghost" size="icon" onClick={onToggle} aria-label={playing ? "Pause" : "Play"} data-testid="note-audio-toggle">
        {playing ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
      </Button>
      <input
        type="range"
        aria-label="Seek"
        aria-valuetext={total === null ? elapsedText : `${elapsedText} of ${formatClockDuration(total)}`}
        className="h-11 min-w-[96px] flex-1 basis-[96px] cursor-pointer accent-primary disabled:cursor-default disabled:opacity-50"
        min={0}
        max={total ?? 1}
        step={0.1}
        value={total === null ? 0 : shownElapsed}
        disabled={total === null}
        onChange={(event) => onScrub?.(scrubTarget(Number(event.currentTarget.value), total))}
      />
      <span className="tnum ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-meta text-muted-foreground" data-testid="note-audio-time">
        {loading && <Loader2Icon className="size-3.5 motion-safe:animate-spin" aria-hidden />}
        {readout}
      </span>
      {loading && <span className="sr-only" role="status">Loading audio…</span>}
    </div>
  );
}
