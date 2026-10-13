// The open note (TC-761): NoteDetailView over the Library's reads, with the
// transcript's Copy. Remounted per note (keyed by its id), so a copy's tick
// never carries over to the next note.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { copyText } from "@/lib/copyText";
import { transcriptCopyText } from "@/lib/connectors/meetingExplorer";
import { captureCapabilities, captureEngineAvailable } from "@/lib/voiceNotes/captureEngine";
import { getDesktopWhisperQueue } from "@/lib/voiceNotes/desktop/desktopWhisper";
import { VoiceNotes, type LocalTranscript } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { appPlatform } from "@/lib/platform";
import { VoiceNoteSaveTimeout, withVoiceNoteSaveDeadline } from "@/lib/voiceNotes/saveDeadline";
import { localTranscriptToSave, VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { NoteDetailView, type NoteDetailViewProps } from "./NoteDetailView";
import type { Library } from "./useLibrary";

/** Matches markdown-text's copy button: the tick reverts on its own. */
const COPIED_DURATION = 1500;

export async function readLocalTranscript(id: string, read: (id: string) => Promise<{ transcript: LocalTranscript | null }> =
  (noteId) => VoiceNotes.getTranscript({ id: noteId })):
  Promise<{ transcript: LocalTranscript | null; readError: "timeout" | "failed" | null }> {
  try {
    const { transcript } = await withVoiceNoteSaveDeadline(`local transcript read id=${id}`, () => read(id));
    return { transcript: transcript?.noteId === id ? transcript : null, readError: null };
  } catch (error) {
    return { transcript: null, readError: error instanceof VoiceNoteSaveTimeout ? "timeout" : "failed" };
  }
}

export function NoteDetail(props: {
  library: Library;
  pushed: boolean;
  onBack: () => void;
  transcription: VoiceNoteTranscriptionProps | undefined;
  savedNote?: NoteDetailViewProps["savedNote"];
}) {
  const { library } = props;
  const { item, reads, audio } = library.note;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [local, setLocal] = useState<{ id: string; transcript: LocalTranscript | null; readError: "timeout" | "failed" | null } | null>(null);
  const [localAttempt, setLocalAttempt] = useState(0);
  const localId = item?.source === VOICE_NOTE_SOURCE ? item.sourceId : null;
  useEffect(() => {
    if (!localId || !captureEngineAvailable()) return;
    let active = true;
    const read = () => { void readLocalTranscript(localId).then((result) => {
      if (active) setLocal({ id: localId, ...result });
    }); };
    read();
    const stopWhisper = appPlatform() === "tauri"
      ? getDesktopWhisperQueue()?.onDone((id) => { if (id === localId) read(); }) : undefined;
    let stopPhone: (() => void) | undefined;
    if (captureCapabilities().localTranscription) {
      void OnDeviceStt.addListener("transcribed", ({ id }) => { if (id === localId) read(); })
        .then((handle) => { if (active) stopPhone = () => { void handle.remove(); }; else void handle.remove(); })
        .catch(() => undefined);
    }
    return () => { active = false; stopWhisper?.(); stopPhone?.(); };
  }, [localId, localAttempt]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const text = useMemo(
    () => {
      if (reads.transcript?.status === "ok" && reads.transcript.sentences.length > 0) return transcriptCopyText(reads.transcript.sentences);
      if (reads.metadata?.status === "ok" && reads.metadata.metadata.transcription_outcome === "no_speech") return null;
      const saved = local?.id === localId && local.transcript?.outcome === "transcribed" ? localTranscriptToSave(local.transcript) : null;
      return saved && saved.sentences.length > 0 ? transcriptCopyText(saved.sentences) : null;
    },
    [reads.transcript, reads.metadata, local, localId],
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
      // Not listed yet while a list read is out (a note saved a moment ago): it waits for that read.
      listStatus={item === null && library.listing ? "loading" : library.status}
      metadata={reads.metadata}
      transcript={reads.transcript}
      localTranscript={local?.id === localId ? local.transcript : undefined}
      localTranscriptRead={local?.id === localId ? local.readError : null}
      onLocalTranscriptRetry={() => { setLocal(null); setLocalAttempt((attempt) => attempt + 1); }}
      audio={audio}
      // A note only on this phone is not in the space to transcribe from.
      transcription={item?.source === VOICE_NOTE_SOURCE && !item.onPhone ? props.transcription : undefined}
      copyState={copyState}
      onCopy={() => void onCopy()}
      onRetry={library.retry}
      pushed={props.pushed}
      onBack={props.onBack}
      savedNote={props.savedNote}
    />
  );
}
