import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { NotePlaybackContext } from "@/lib/audio/notePlayback";
import { formatClockDuration } from "./formatters";
import { sentenceTime } from "./transcriptSegments";

export interface TranscriptGap { start: number; end: number; speaker_name: string | null }
const NO_GAPS: readonly TranscriptGap[] = [];

/** Only the rows crossing the active boundary need a new render on a clock tick. */
class ActiveRowStore {
  active = new Set<number>();
  private listeners = new Map<number, Set<() => void>>();

  subscribe(index: number, listener: () => void) {
    const listeners = this.listeners.get(index) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(index, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(index);
    };
  }

  setActive(indices: Set<number>) {
    const previous = this.active;
    this.active = indices;
    for (const index of previous) {
      if (!indices.has(index)) this.listeners.get(index)?.forEach((listener) => listener());
    }
    for (const index of indices) {
      if (!previous.has(index)) this.listeners.get(index)?.forEach((listener) => listener());
    }
  }
}

function timedIndex(sentences: readonly FirefliesSentence[], isPrivateCloud: boolean) {
  const entries = sentences.flatMap((sentence, index) => {
    const start = sentenceTime(sentence, isPrivateCloud);
    return start === null ? [] : [{ index, start, end: sentence.end_time }];
  }).sort((a, b) => a.start - b.start || a.index - b.index);
  let maxEnd = 0;
  return entries.map((entry) => ({ ...entry, maxEnd: maxEnd = Math.max(maxEnd, entry.end) }));
}

/** Find every covering segment and the latest-starting one for follow-scroll. */
function activeRowsAt(index: ReturnType<typeof timedIndex>, elapsed: number) {
  let low = 0;
  let high = index.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index[middle]!.start <= elapsed) low = middle + 1;
    else high = middle;
  }
  const active = new Set<number>();
  let followRow = -1;
  for (let position = low - 1; position >= 0 && index[position]!.maxEnd > elapsed; position--) {
    const entry = index[position]!;
    if (entry.end <= elapsed) continue;
    active.add(entry.index);
    if (followRow < 0) followRow = entry.index;
  }
  return { active, followRow };
}

const TranscriptRow = memo(function TranscriptRow({ sentence, index, speaker, start, hasAudio, store, onSeek, registerRow, onRowRender }: {
  sentence: FirefliesSentence; index: number; speaker: string | null; start: number | null; hasAudio: boolean;
  store: ActiveRowStore; onSeek: (seconds: number) => void; registerRow: (index: number, element: HTMLDivElement | null) => void;
  onRowRender?: (index: number) => void;
}) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(index, listener), [store, index]);
  const selected = useSyncExternalStore(subscribe, () => store.active.has(index), () => false);
  onRowRender?.(index);
  return <div ref={(element) => registerRow(index, element)}
    data-testid="transcript-segment" data-active={selected || undefined} aria-current={selected ? "true" : undefined}
    className={`rounded-md px-2 py-1 ${selected ? "bg-accent/40" : ""}`}>
    {speaker && <p className="mb-1 text-meta font-semibold text-muted-foreground">{speaker}</p>}
    <div className="flex items-start gap-3">
      <div className="tnum w-[7ch] shrink-0 text-meta text-muted-foreground">
        {start !== null && (hasAudio ? (
          <button type="button" className="-mx-2 -my-1 min-h-11 min-w-11 rounded-sm px-2 py-1 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:fine)]:m-0 [@media(pointer:fine)]:min-h-0 [@media(pointer:fine)]:min-w-0 [@media(pointer:fine)]:p-0"
            aria-label={`Play from ${formatClockDuration(Math.floor(start))}`} onClick={() => onSeek(start)}>{formatClockDuration(Math.floor(start))}</button>
        ) : <span title="Audio is not available for this note">{formatClockDuration(Math.floor(start))}</span>)}
      </div>
      <p className="min-w-0 whitespace-pre-wrap break-words text-body">{sentence.text}{sentence.source && <span className="ml-2 text-meta text-muted-foreground">{sentence.source === "fallback" ? "Fallback transcript" : "Recovered from recording"}</span>}</p>
    </div>
  </div>;
});

export function TimestampedTranscript({ sentences, gaps = NO_GAPS, hasAudio, isPrivateCloud = false, onRowRender }: { sentences: readonly FirefliesSentence[]; gaps?: readonly TranscriptGap[]; hasAudio: boolean;
  isPrivateCloud?: boolean;
  /** Render-count probe used by the long-transcript regression test. */
  onRowRender?: (index: number) => void;
}) {
  const playback = useContext(NotePlaybackContext);
  const playFrom = useRef(playback?.playFrom);
  playFrom.current = playback?.playFrom;
  const [following, setFollowing] = useState(true);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const index = useMemo(() => timedIndex(sentences, isPrivateCloud), [sentences, isPrivateCloud]);
  const store = useMemo(() => new ActiveRowStore(), [sentences]);
  const { active, followRow } = playback?.playing ? activeRowsAt(index, playback.elapsed) : { active: new Set<number>(), followRow: -1 };
  const onSeek = useCallback((seconds: number) => { setFollowing(true); playFrom.current?.(seconds); }, []);
  const registerRow = useCallback((rowIndex: number, element: HTMLDivElement | null) => { rows.current[rowIndex] = element; }, []);
  const rowElements = useMemo(() => {
    const speakers = new Set(sentences.map((sentence) => sentence.speaker_name).filter(Boolean));
    const sentenceRows = sentences.map((sentence, rowIndex) => {
      const speaker = speakers.size > 1 && sentence.speaker_name !== sentences[rowIndex - 1]?.speaker_name ? sentence.speaker_name : null;
      return <TranscriptRow key={`${sentence.index}-${rowIndex}`} sentence={sentence} index={rowIndex} speaker={speaker}
        start={sentenceTime(sentence, isPrivateCloud)} hasAudio={hasAudio} store={store} onSeek={onSeek} registerRow={registerRow} onRowRender={onRowRender} />;
    });
    if (gaps.length === 0) return sentenceRows;
    return [
      ...sentenceRows.map((element, rowIndex) => ({ start: sentences[rowIndex]!.start_time, element })),
      ...gaps.map((gap, gapIndex) => ({ start: gap.start, element: <p key={`gap-${gapIndex}`} data-testid="transcript-gap" className="rounded-md px-2 py-1 text-meta text-muted-foreground">
        {formatClockDuration(Math.floor(gap.start))}–{formatClockDuration(Math.floor(gap.end))} could not be transcribed{gap.speaker_name ? ` — ${gap.speaker_name}` : ""}
      </p> })),
    ].sort((a, b) => a.start - b.start).map(({ element }) => element);
  }, [sentences, gaps, hasAudio, isPrivateCloud, store, onSeek, registerRow, onRowRender]);

  useEffect(() => { store.setActive(active); }, [store, active]);

  useEffect(() => {
    const stopFollowing = () => setFollowing(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) stopFollowing();
    };
    window.addEventListener("wheel", stopFollowing, { passive: true });
    window.addEventListener("touchmove", stopFollowing, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", stopFollowing);
      window.removeEventListener("touchmove", stopFollowing);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!following || followRow < 0) return;
    const row = rows.current[followRow];
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const upper = window.innerHeight / 3;
    const lower = window.innerHeight * 2 / 3;
    if (rect.top < upper || rect.bottom > lower) {
      row.scrollIntoView({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
  }, [followRow, following]);

  return (
    <div className="relative max-w-[68ch] select-text" onPointerDownCapture={(event) => {
        if (!(event.target as HTMLElement).closest("button")) setFollowing(false);
      }}>
      <div className="flex flex-col gap-1" data-testid="timed-transcript">
        {rowElements}
      </div>
      {!hasAudio && <p className="mt-2 text-meta text-muted-foreground">Audio is not available for this note, so seeking is unavailable.</p>}
      {!following && playback?.playing && <button type="button" className="sticky bottom-3 mt-3 rounded-full bg-background px-3 py-1.5 text-meta font-medium text-foreground shadow-sm ring-1 ring-border"
        onClick={() => setFollowing(true)}>Follow playback</button>}
    </div>
  );
}
