// The open note (TC-761): NoteDetailView over the Library's reads, with the
// transcript's Copy. Remounted per note (keyed by its id), so a copy's tick
// never carries over to the next note.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { copyText } from "@/lib/copyText";
import { transcriptCopyText } from "@/lib/connectors/meetingExplorer";
import { captureCapabilities, captureEngineAvailable } from "@/lib/voiceNotes/captureEngine";
import { getDesktopWhisperQueue } from "@/lib/voiceNotes/desktop/desktopWhisper";
import { VoiceNotes, type LocalTranscript } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { appPlatform } from "@/lib/platform";
import type { AppPlatform } from "@/lib/platform";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import { VoiceNoteSaveTimeout, withVoiceNoteSaveDeadline } from "@/lib/voiceNotes/saveDeadline";
import { localTranscriptToSave, VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { NoteDetailView, type NoteDetailViewProps } from "./NoteDetailView";
import { CombineSheet } from "./combine/CombineSheet";
import { canCombine } from "./combine/candidates";
import { displayMembers, isCombined, memberLines, type CombineDetail } from "./combine/combinedView";
import { DeleteCombinedSheet } from "./combine/DeleteCombinedSheet";
import { useCombineFlow } from "./combine/useCombineFlow";
import { useCombinedMeeting } from "./combine/useCombinedMeeting";
import { useCombinedSummary } from "./combine/useCombinedSummary";
import type { SummaryRunner } from "@/lib/meetingSummary/summaryRunner";
import { hasPrivateCloudTimingProvenance, hasSegmentTimes, transcriptWithTimestamps } from "./transcriptSegments";
import type { Library } from "./useLibrary";
import { notePath } from "@/shell/routes";
import { EXO_MERGED_SOURCE } from "@tinyboilerplate/core";
import { captureEvents } from "../captureEvents";

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
  /** The signed-in account's space: where Combine reads the two captures and writes the combined meeting. */
  tcw: TinyCloudWeb;
  pushed: boolean;
  onBack: () => void;
  transcription: VoiceNoteTranscriptionProps | undefined;
  activityView?: NotePipelineView;
  platform?: AppPlatform;
  savedNote?: NoteDetailViewProps["savedNote"];
  activityControl?: ReactNode;
  /** Makes a combined meeting's summary (CaptureSurface owns it); without one no summary is shown. */
  summaries?: SummaryRunner;
}) {
  const { library } = props;
  const { item, reads, audio } = library.note;
  const navigate = useNavigate();
  const combined = useCombinedMeeting({ tcw: props.tcw, item, onChanged: library.refresh, onDeleted: props.onBack });
  const summary = useCombinedSummary({ tcw: props.tcw, runner: props.summaries, item });
  const flow = useCombineFlow({ tcw: props.tcw, onCombined: ({ id, sourceId, created }) => {
    // The combined text is new: make its summary (a Re-combine replaces the old one).
    props.summaries?.start(id, { replacing: !created });
    // A Re-combine rewrites the open row in place: drop its cached reads and check its members again.
    captureEvents.emit("library-changed", { source: EXO_MERGED_SOURCE, sourceId });
    combined.recheck();
    library.refresh();
    navigate(notePath(id));
  } });
  const combine = useMemo<CombineDetail | undefined>(() => {
    if (item === null) return undefined;
    if (isCombined(item)) {
      const members = memberLines(displayMembers(reads.metadata?.status === "ok" ? reads.metadata.metadata : null), library.items);
      const [a, b] = members.map((m) => library.items.find((entry) => entry.source === m.source && entry.sourceId === m.sourceId));
      return { combined: { members, stale: combined.stale, onRecombine: members.length === 2 && a && b ? () => flow.open(a, b) : undefined, onDelete: combined.remove.request, summary: summary.view, onRetrySummary: summary.retry } };
    }
    return canCombine(item) ? { onCombine: () => flow.open(item) } : undefined;
  }, [item, reads.metadata, library.items, combined.stale, combined.remove.request, summary.view, summary.retry, flow.open]);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [local, setLocal] = useState<{ id: string; transcript: LocalTranscript | null; readError: "timeout" | "failed" | null } | null>(null);
  const [localAttempt, setLocalAttempt] = useState(0);
  const localId = item?.source === VOICE_NOTE_SOURCE && item.metadata?.capture !== "pasted" ? item.sourceId : null;
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

  const selectedTranscript = reads.transcript;
  const remoteTranscript = selectedTranscript?.transcript;
  const sentences = useMemo(
    () => {
      if (remoteTranscript?.status === "ok" && remoteTranscript.sentences.length > 0) return remoteTranscript.sentences;
      if (reads.metadata?.status === "ok" && reads.metadata.metadata.transcription_outcome === "no_speech") return null;
      const saved = local?.id === localId && local.transcript?.outcome === "transcribed" ? localTranscriptToSave(local.transcript) : null;
      return saved && saved.sentences.length > 0 ? saved.sentences : null;
    },
    [remoteTranscript, reads.metadata, local, localId],
  );
  const isPrivateCloud = remoteTranscript?.status === "ok" && remoteTranscript.sentences.length > 0
    && hasPrivateCloudTimingProvenance(
      reads.metadata?.status === "ok" ? reads.metadata.metadata : null,
      selectedTranscript?.provenance,
    );
  const onCopy = useCallback(async (withTimestamps = false) => {
    const pasted = item?.metadata?.capture === "pasted" && reads.metadata?.status === "ok"
      ? reads.metadata.metadata.transcript_text : null;
    const text = typeof pasted === "string" ? pasted : sentences && (withTimestamps && hasSegmentTimes(sentences, isPrivateCloud)
      ? transcriptWithTimestamps(sentences, isPrivateCloud) : transcriptCopyText(sentences));
    if (!text) return;
    const ok = await copyText(text);
    if (!mounted.current) return;
    setCopyState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopyState("idle");
    }, COPIED_DURATION);
  }, [sentences, isPrivateCloud, item, reads.metadata]);

  return (
    <>
      <NoteDetailView
        item={item}
        // Not listed yet while a list read is out (a note saved a moment ago): it waits for that read.
        listStatus={item === null && library.listing ? "loading" : library.status}
        metadata={reads.metadata}
        transcriptProvenance={selectedTranscript?.provenance}
        transcript={remoteTranscript}
        localTranscript={local?.id === localId ? local.transcript : undefined}
        localTranscriptRead={local?.id === localId ? local.readError : null}
        onLocalTranscriptRetry={() => { setLocal(null); setLocalAttempt((attempt) => attempt + 1); }}
        audio={audio}
        // A note only on this phone is not in the space to transcribe from.
        transcription={item?.source === VOICE_NOTE_SOURCE && item.metadata?.capture !== "pasted" && !item.onPhone ? props.transcription : undefined}
        activityView={props.activityView}
        platform={props.platform}
        copyState={copyState}
        onCopy={() => void onCopy()}
        onCopyWithTimestamps={() => void onCopy(true)}
        onRetry={library.retry}
        pushed={props.pushed}
        onBack={props.onBack}
        savedNote={props.savedNote}
        activityControl={props.activityControl}
        combine={combine}
      />
      <CombineSheet flow={flow} items={library.items} now={new Date()} />
      {combined.remove.open && <DeleteCombinedSheet remove={combined.remove} title={item?.title ?? "Combined meeting"} />}
    </>
  );
}
