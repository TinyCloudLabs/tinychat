// The open note (TC-761): NoteDetailView over the Library's reads, with the
// transcript's Copy. Remounted per note (keyed by its id), so a copy's tick
// never carries over to the next note.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { copyText } from "@/lib/copyText";
import { transcriptCopyText } from "@/lib/connectors/meetingExplorer";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { NoteDetailView } from "./NoteDetailView";
import type { Library } from "./useLibrary";

/** Matches markdown-text's copy button: the tick reverts on its own. */
const COPIED_DURATION = 1500;

export function NoteDetail(props: {
  library: Library;
  pushed: boolean;
  onBack: () => void;
  transcription: VoiceNoteTranscriptionProps | undefined;
}) {
  const { library } = props;
  const { item, reads, loadAudio } = library.note;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const text = useMemo(
    () => (reads.transcript?.status === "ok" && reads.transcript.sentences.length > 0 ? transcriptCopyText(reads.transcript.sentences) : null),
    [reads.transcript],
  );
  const onCopy = useCallback(async () => {
    if (!text) return;
    const ok = await copyText(text);
    if (!mounted.current) return;
    setCopyState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopyState("idle");
    }, COPIED_DURATION);
  }, [text]);

  return (
    <NoteDetailView
      item={item}
      listStatus={library.status}
      metadata={reads.metadata}
      transcript={reads.transcript}
      loadAudio={loadAudio}
      transcription={item?.source === VOICE_NOTE_SOURCE ? props.transcription : undefined}
      copyState={copyState}
      onCopy={() => void onCopy()}
      onRetry={library.retry}
      pushed={props.pushed}
      onBack={props.onBack}
    />
  );
}
