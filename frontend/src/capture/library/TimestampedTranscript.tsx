import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { NotePlaybackContext } from "@/lib/audio/notePlayback";
import { formatClockDuration } from "./formatters";
import { sentenceTime } from "./transcriptSegments";

export function TimestampedTranscript({ sentences, hasAudio }: { sentences: readonly FirefliesSentence[]; hasAudio: boolean }) {
  const playback = useContext(NotePlaybackContext);
  const [following, setFollowing] = useState(true);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const speakers = useMemo(() => new Set(sentences.map((sentence) => sentence.speaker_name).filter(Boolean)), [sentences]);
  const active = playback?.playing ? sentences.flatMap((sentence, index) => {
    const start = sentenceTime(sentence);
    return start !== null && playback.elapsed >= start && playback.elapsed < sentence.end_time ? [index] : [];
  }) : [];
  const firstActive = active[0];

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
    if (!following || firstActive === undefined) return;
    const row = rows.current[firstActive];
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const upper = window.innerHeight / 3;
    const lower = window.innerHeight * 2 / 3;
    if (rect.top < upper || rect.bottom > lower) {
      row.scrollIntoView({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
  }, [firstActive, following]);

  return (
    <div className="relative max-w-[68ch] select-text" onPointerDownCapture={(event) => {
        if (!(event.target as HTMLElement).closest("button")) setFollowing(false);
      }}>
      <div className="flex flex-col gap-1" data-testid="timed-transcript">
        {sentences.map((sentence, index) => {
          const start = sentenceTime(sentence);
          const speaker = speakers.size > 1 && sentence.speaker_name !== sentences[index - 1]?.speaker_name ? sentence.speaker_name : null;
          const selected = active.includes(index);
          return (
            <div key={`${sentence.index}-${index}`} ref={(element) => { rows.current[index] = element; }}
              data-testid="transcript-segment" data-active={selected || undefined} aria-current={selected ? "true" : undefined}
              className={`rounded-md px-2 py-1 ${selected ? "bg-accent/40" : ""}`}>
              {speaker && <p className="mb-1 text-meta font-semibold text-muted-foreground">{speaker}</p>}
              <div className="flex items-start gap-3">
                <div className="tnum w-[7ch] shrink-0 text-meta text-muted-foreground">
                  {start !== null && (hasAudio ? (
                    <button type="button" className="rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                      aria-label={`Play from ${formatClockDuration(Math.floor(start))}`} onClick={() => {
                        setFollowing(true);
                        playback?.playFrom(start);
                      }}>{formatClockDuration(Math.floor(start))}</button>
                  ) : <span title="Audio is not available for this note">{formatClockDuration(Math.floor(start))}</span>)}
                </div>
                <p className="min-w-0 whitespace-pre-wrap break-words text-body">{sentence.text}</p>
              </div>
            </div>
          );
        })}
      </div>
      {!hasAudio && <p className="mt-2 text-meta text-muted-foreground">Audio is not available for this note, so seeking is unavailable.</p>}
      {!following && playback?.playing && <button type="button" className="sticky bottom-3 mt-3 rounded-full bg-background px-3 py-1.5 text-meta font-medium text-foreground shadow-sm ring-1 ring-border"
        onClick={() => setFollowing(true)}>Follow playback</button>}
    </div>
  );
}
