// The open note (TC-761): NoteDetailView over the Library's reads, with the
// transcript's Copy. Remounted per note (keyed by its id), so a copy's tick
// never carries over to the next note.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { copyText } from "@/lib/copyText";
import { findMeetingId, readMeetingMetadata, readTranscript, transcriptCopyText } from "@/lib/connectors/meetingExplorer";
import { captureCapabilities, captureEngineAvailable } from "@/lib/voiceNotes/captureEngine";
import { getDesktopWhisperQueue } from "@/lib/voiceNotes/desktop/desktopWhisper";
import { VoiceNotes, type LocalTranscript } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { appPlatform } from "@/lib/platform";
import type { AppPlatform } from "@/lib/platform";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import { VoiceNoteSaveTimeout, withVoiceNoteSaveDeadline } from "@/lib/voiceNotes/saveDeadline";
import { localTranscriptToSave, VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { gateCombinedSummary, readAutomaticSummaries } from "@/lib/meetingSummary/automaticSummaries";
import { NoteDetailView, type NoteDetailViewProps } from "./NoteDetailView";
import { CombineSheet } from "./combine/CombineSheet";
import { canCombine } from "./combine/candidates";
import { displayMembers, isCombined, memberLines, type CombineDetail } from "./combine/combinedView";
import { DeleteCombinedSheet } from "./combine/DeleteCombinedSheet";
import { useCombineFlow } from "./combine/useCombineFlow";
import { useCombinedMeeting } from "./combine/useCombinedMeeting";
import { useCombinedSummary } from "./combine/useCombinedSummary";
import type { SummaryRunner } from "@/lib/meetingSummary/summaryRunner";
import { applySpeakerNames } from "./speakerNames";
import { useSpeakerNames } from "./useSpeakerNames";
import { useWordFixApplier, useWordFixedSentences } from "@/lib/wordFixes/wordFixesStore";
import { hasPrivateCloudTimingProvenance, hasSegmentTimes, transcriptWithTimestamps } from "./transcriptSegments";
import type { Library } from "./useLibrary";
import { notePath } from "@/shell/routes";
import { EXO_MERGED_SOURCE } from "@tinyboilerplate/core";
import { captureEvents } from "../captureEvents";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ExoTranscriptShareContext, prepareTranscriptShare, publishTranscriptShare,
  transcriptShareNeedsSignIn, transcriptShareOrigins, transcriptShareSnapshot, transcriptShareUnavailable,
} from "@/lib/exoTranscriptShare";
import type { TranscriptShareOrigins, TranscriptShareReview } from "@/lib/exoTranscriptShare";
import { scheduledSpace } from "@/lib/spaceQueue";
import { voiceNoteTranscriptLocator } from "@/lib/voiceNotes/voiceNoteCommits";
import { isStorageAccountScopeCurrent, storageScopeFor } from "@/lib/storageStatus";

/** Matches markdown-text's copy button: the tick reverts on its own. */
const COPIED_DURATION = 1500;
const SHARE_ABORTED = "The note or account changed. Review the transcript again.";

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
  /** Local integration can inject loopback endpoints without changing the SDK transport. */
  transcriptShareOrigins?: TranscriptShareOrigins;
}) {
  const { library } = props;
  const { item, reads, audio } = library.note;
  const navigate = useNavigate();
  const combined = useCombinedMeeting({ tcw: props.tcw, item, onChanged: library.refresh, onDeleted: props.onBack });
  const summary = useCombinedSummary({ tcw: props.tcw, runner: props.summaries, item });
  const flow = useCombineFlow({ tcw: props.tcw, onCombined: ({ id, sourceId, created }) => {
    // The combined text is new: the summary gate decides (setting on or unreadable: a run; off: none).
    void gateCombinedSummary(() => readAutomaticSummaries(props.tcw), props.summaries, { id, created });
    // A Re-combine rewrites the open row in place: drop its cached reads and check its members again.
    captureEvents.emit("library-changed", { source: EXO_MERGED_SOURCE, sourceId });
    combined.recheck();
    library.refresh();
    navigate(notePath(id));
  } });
  const combine = useMemo<CombineDetail | undefined>(() => {
    if (item === null) return undefined;
    if (isCombined(item)) {
      // Sources are resolved from EVERY row: the list hides them, but they are still here to open.
      const members = memberLines(displayMembers(reads.metadata?.status === "ok" ? reads.metadata.metadata : null), library.all);
      const [a, b] = members.map((m) => library.all.find((entry) => entry.source === m.source && entry.sourceId === m.sourceId));
      return { combined: { members, stale: combined.stale, onRecombine: members.length === 2 && a && b ? () => flow.open(a, b) : undefined, onDelete: combined.remove.request, summary: summary.view, onRetrySummary: summary.retry } };
    }
    // A source that is already a member of a combined meeting is not combined again.
    return canCombine(item) && !library.isCombinedMember(item) ? { onCombine: () => flow.open(item) } : undefined;
  }, [item, reads.metadata, library.all, library.isCombinedMember, combined.stale, combined.remove.request, summary.view, summary.retry, flow.open]);
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
  const storedSentences = useMemo(
    () => {
      if (remoteTranscript?.status === "ok" && remoteTranscript.sentences.length > 0) return remoteTranscript.sentences;
      if (reads.metadata?.status === "ok" && reads.metadata.metadata.transcription_outcome === "no_speech") return null;
      const saved = local?.id === localId && local.transcript?.outcome === "transcribed" ? localTranscriptToSave(local.transcript) : null;
      return saved && saved.sentences.length > 0 ? saved.sentences : null;
    },
    [remoteTranscript, reads.metadata, local, localId],
  );
  // The copy actions carry the user's word fixes (TC-2199), as the page shows them.
  const sentences = useWordFixedSentences(storedSentences);
  const applyWordFixes = useWordFixApplier();
  const isPrivateCloud = remoteTranscript?.status === "ok" && remoteTranscript.sentences.length > 0
    && hasPrivateCloudTimingProvenance(
      reads.metadata?.status === "ok" ? reads.metadata.metadata : null,
      selectedTranscript?.provenance,
    );
  const speakerNames = useSpeakerNames({
    tcw: props.tcw,
    row: item !== null && !item.onPhone && reads.metadata?.status === "ok" ? item : null,
    metadata: reads.metadata?.status === "ok" ? reads.metadata.metadata : null,
    localId: item?.onPhone === true && item.source === VOICE_NOTE_SOURCE ? item.sourceId : null,
  });
  const names = speakerNames?.names;
  const onCopy = useCallback(async (withTimestamps = false) => {
    const pasted = item?.metadata?.capture === "pasted" && reads.metadata?.status === "ok"
      ? reads.metadata.metadata.transcript_text : null;
    const named = sentences && names ? applySpeakerNames(sentences, names) : sentences;
    const text = typeof pasted === "string" ? applyWordFixes(pasted) : named && (withTimestamps && hasSegmentTimes(named, isPrivateCloud)
      ? transcriptWithTimestamps(named, isPrivateCloud) : transcriptCopyText(named));
    if (!text) return;
    const ok = await copyText(text);
    if (!mounted.current) return;
    setCopyState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopyState("idle");
    }, COPIED_DURATION);
  }, [sentences, names, applyWordFixes, isPrivateCloud, item, reads.metadata]);

  const shareEmailId = useId();
  const [shareOpen, setShareOpen] = useState(false);
  const [shareRecipient, setShareRecipient] = useState("");
  const [shareReview, setShareReview] = useState<TranscriptShareReview | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareResult, setShareResult] = useState<{ url: string; recipient: string; expiresAt: string } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const shareGeneration = useRef(0);
  const shareInFlight = useRef(false);
  const localTranscriptSyncing = props.activityView?.input?.transcript.onDevice?.sync?.state === "syncing";
  const shareSnapshot = useMemo(() => localTranscriptSyncing ? null
    : transcriptShareSnapshot(item, reads.metadata, remoteTranscript, applyWordFixes),
  [item, reads.metadata, remoteTranscript, applyWordFixes, localTranscriptSyncing]);
  const shareSession = typeof props.tcw.session === "function" ? props.tcw.session() : undefined;
  const shareSpaceId = props.tcw.spaceId;
  const shareSessionDid = shareSession ? props.tcw.sessionDid : null;
  const shareHolderDid = shareSession ? props.tcw.credentialHolderDid : null;
  const shareSignInRequired = shareSnapshot !== null && transcriptShareNeedsSignIn(props.tcw);
  const shareScope = storageScopeFor(props.tcw);
  const shareScopeCurrent = !shareScope || isStorageAccountScopeCurrent(shareScope);
  const shareWalletAddress = shareSession?.walletAddress?.toLowerCase();
  // Rehydrated reads and SDK wrappers are not identities. A grant keeps the owner,
  // session key and storage epoch; changed content or a retired account still aborts.
  const shareIdentity = useMemo(() => ({
    id: shareSnapshot?.id, source: shareSnapshot?.source, sourceId: shareSnapshot?.sourceId,
    title: shareSnapshot?.title, rawText: shareSnapshot?.rawText, text: shareSnapshot?.text,
    spaceId: shareSpaceId, sessionDid: shareSessionDid, holderDid: shareHolderDid,
    walletAddress: shareWalletAddress, chainId: shareSession?.chainId,
    nodeOrigin: props.tcw.hosts?.[0], scope: shareScope, scopeCurrent: shareScopeCurrent, signInRequired: shareSignInRequired,
  }), [shareSnapshot?.id, shareSnapshot?.source, shareSnapshot?.sourceId, shareSnapshot?.title,
    shareSnapshot?.rawText, shareSnapshot?.text, shareSpaceId, shareSessionDid, shareHolderDid,
    shareWalletAddress, shareSession?.chainId, props.tcw.hosts?.[0], shareScope, shareScopeCurrent, shareSignInRequired]);
  const latestShare = useRef(shareIdentity);
  latestShare.current = shareIdentity;
  const shareOpenedFor = useRef<typeof shareIdentity | null>(null);
  const closeShare = useCallback((error: string | null = null) => {
    shareGeneration.current += 1;
    shareOpenedFor.current = null;
    setShareOpen(false); setShareReview(null); setShareResult(null); setShareRecipient("");
    setShareError(error); setShareCopied(false);
  }, []);
  useEffect(() => {
    if (shareOpenedFor.current && shareOpenedFor.current !== shareIdentity) {
      closeShare(shareInFlight.current ? SHARE_ABORTED : null);
    }
  }, [shareIdentity, closeShare]);
  const openShare = useCallback(() => {
    if (!shareSnapshot || shareInFlight.current) return;
    shareGeneration.current += 1;
    shareOpenedFor.current = shareIdentity;
    setShareRecipient(""); setShareReview(null); setShareResult(null); setShareCopied(false);
    setShareError(transcriptShareUnavailable(props.tcw));
    setShareOpen(true);
  }, [shareSnapshot, props.tcw, shareIdentity]);
  const callerShareUnavailable = shareSnapshot ? transcriptShareUnavailable(props.tcw) : null;
  const shareAction = useMemo(() => shareSnapshot && callerShareUnavailable === null
    ? { open: openShare, busy: shareBusy, signInRequired: shareSignInRequired } : null,
    [shareSnapshot, callerShareUnavailable, openShare, shareBusy, shareSignInRequired]);
  const reviewShare = () => {
    if (!shareSnapshot || shareInFlight.current) return;
    try {
      const unavailable = transcriptShareUnavailable(props.tcw);
      if (unavailable) { setShareError(unavailable); return; }
      setShareReview(prepareTranscriptShare(props.tcw, shareSnapshot, shareRecipient));
      setShareError(null);
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "Enter one exact recipient email.");
    }
  };
  const confirmShare = async () => {
    if (!item || !shareReview || shareInFlight.current) return;
    const tcw = props.tcw;
    const reviewed = shareReview;
    const identity = shareIdentity;
    const generation = ++shareGeneration.current;
    const isCurrent = () => mounted.current && generation === shareGeneration.current
      && latestShare.current === identity && (!shareScope || isStorageAccountScopeCurrent(shareScope));
    shareInFlight.current = true;
    setShareBusy(true); setShareError(null);
    try {
      const space = scheduledSpace(tcw);
      const result = await publishTranscriptShare({
        tcw, review: reviewed, origins: transcriptShareOrigins(props.transcriptShareOrigins), isCurrent,
        // Reuse the Library's committed-body selection, not a local fallback or a plaintext KV pointer.
        readPersisted: async () => {
          const row = await findMeetingId(space, reviewed.snapshot.source, reviewed.snapshot.sourceId);
          if (!isCurrent() || row.status !== "ok" || row.id !== reviewed.snapshot.id) return null;
          const locator = reviewed.snapshot.source === VOICE_NOTE_SOURCE
            ? await voiceNoteTranscriptLocator(space, reviewed.snapshot.sourceId) : null;
          if (!isCurrent() || (locator && !locator.bodyKey)) return null;
          let metadata = await readMeetingMetadata(space, row.id);
          if (!isCurrent() || metadata.status !== "ok") return null;
          if (locator) metadata = { status: "ok", metadata: { ...metadata.metadata,
            transcription_outcome: locator.outcome === "none" ? metadata.metadata.transcription_outcome : locator.outcome,
            transcript_text: locator.committed ? null : locator.expectedText } };
          const transcript = locator?.bodyKey
            ? await readTranscript(space, reviewed.snapshot.source, reviewed.snapshot.sourceId, locator.bodyKey, locator.expectedText)
            : await readTranscript(space, reviewed.snapshot.source, reviewed.snapshot.sourceId);
          if (!isCurrent()) return null;
          return transcriptShareSnapshot(item, metadata, transcript, applyWordFixes);
        },
      });
      if (!isCurrent()) throw new Error(SHARE_ABORTED);
      if (result.status === "declined") { setShareReview(null); setShareError("Sharing was cancelled."); }
      else setShareResult({ url: result.published.url, recipient: reviewed.recipient, expiresAt: result.published.metadata.expiresAt });
    } catch (error) {
      if (mounted.current) {
        if (isCurrent()) {
          setShareReview(null); setShareError(error instanceof Error ? error.message : "Transcript sharing stopped. No link was returned.");
        } else if (generation === shareGeneration.current) {
          closeShare(SHARE_ABORTED);
        } else {
          // A scope change or explicit cancellation may already have hidden private material.
          setShareError((current) => current ?? SHARE_ABORTED);
        }
      }
    } finally {
      shareInFlight.current = false;
      if (mounted.current) setShareBusy(false);
    }
  };
  // Hide old-account recipient/link material in this render, not one passive effect later.
  const shareVisible = shareOpen && shareScopeCurrent && shareOpenedFor.current === shareIdentity;
  const shareUnavailable = shareVisible ? transcriptShareUnavailable(props.tcw) : null;
  const shareExpiry = shareResult?.expiresAt ?? shareReview?.expiresAt;

  return (
    <>
      <ExoTranscriptShareContext.Provider value={shareAction}>
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
        speakerNames={speakerNames}
      />
      </ExoTranscriptShareContext.Provider>
      {/* The visible list: a capture already inside a combined meeting is never offered for a new combine. */}
      <CombineSheet flow={flow} items={library.items} now={new Date()} />
      {combined.remove.open && <DeleteCombinedSheet remove={combined.remove} title={item?.title ?? "Combined meeting"} />}
      {!shareVisible && shareError && <p role="alert" className="text-callout text-destructive">{shareError}</p>}
      <Dialog open={shareVisible} onOpenChange={(open) => {
        // The SDK's consent sheet is outside this dialog. It must not dismiss the
        // in-flight share; the explicit Cancel button remains available.
        if (!open && !shareInFlight.current) closeShare();
      }}>
        {shareVisible && <DialogContent className="max-w-lg" aria-describedby={`${shareEmailId}-description`}>
          <DialogHeader>
            <DialogTitle>Share transcript</DialogTitle>
            <DialogDescription id={`${shareEmailId}-description`}>
              {shareExpiry === undefined ? "Choose who can read this transcript."
                : `Recipients can read this transcript until ${new Date(shareExpiry).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`}
            </DialogDescription>
          </DialogHeader>
          {shareResult ? (
            <div className="flex flex-col gap-3">
              <p className="text-callout">Recipient: <strong>{shareResult.recipient}</strong></p>
              <label className="text-meta" htmlFor={`${shareEmailId}-link`}>Recipient-only link</label>
              <input id={`${shareEmailId}-link`} readOnly value={shareResult.url} className="w-full rounded-md border bg-background px-3 py-2 text-meta" />
              <Button type="button" onClick={() => {
                const generation = shareGeneration.current;
                void copyText(shareResult.url).then((ok) => {
                  if (mounted.current && generation === shareGeneration.current) {
                    setShareCopied(ok); if (!ok) setShareError("Couldn’t copy. Select the recipient-only link and copy it instead.");
                  }
                });
              }}>{shareCopied ? "Copied" : "Copy recipient-only link"}</Button>
            </div>
          ) : shareReview ? (
            <div className="flex flex-col gap-3">
              <p className="text-callout">Recipient: <strong>{shareReview.recipient}</strong></p>
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer text-meta">Review transcript</summary>
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-callout">{shareReview.snapshot.text}</pre>
              </details>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={shareBusy} onClick={() => setShareReview(null)}>Back</Button>
                <Button type="button" disabled={shareBusy || shareUnavailable !== null} onClick={() => void confirmShare()}>
                  {shareBusy ? "Sharing…" : "Share transcript"}
                </Button>
              </div>
            </div>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); reviewShare(); }}>
              <label htmlFor={shareEmailId} className="text-callout">Exact recipient email</label>
              <input id={shareEmailId} type="email" autoComplete="email" required value={shareRecipient}
                onChange={(event) => setShareRecipient(event.target.value)} disabled={shareBusy}
                className="w-full rounded-md border bg-background px-3 py-2 text-callout" />
              <Button type="submit" disabled={shareBusy || shareUnavailable !== null}>Review recipient</Button>
            </form>
          )}
          {(shareUnavailable || shareError) && <p role="alert" className="text-callout text-destructive">{shareUnavailable ?? shareError}</p>}
          <Button type="button" variant="outline" onClick={() => closeShare(shareInFlight.current ? "Sharing was cancelled." : null)}>{shareResult ? "Done" : "Cancel"}</Button>
        </DialogContent>}
      </Dialog>
    </>
  );
}
