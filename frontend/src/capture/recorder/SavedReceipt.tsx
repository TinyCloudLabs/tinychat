// The receipt when a recording lands (plan §2.7): it says where the note is,
// with the route's last node checked. A save that failed says the note is
// still on the phone and offers Save now. On-device transcription works signed
// out and offline, so its text (or "Couldn't transcribe on this phone" plus
// Retry) comes from the native STT queue directly, not from the space's
// transcript, which may still be unsaved or unsynced here.
import { FINAL_COPY, TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PlatformContext, deviceName } from "@/lib/platform";
import { Capacitor } from "@capacitor/core";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MeetingAudioPlayer } from "@/chat/MeetingAudioPlayer";
import { audioUnavailableMessage } from "@/chat/audioPlayback";
import { cn } from "@/lib/utils";
import { activityForNote, noteStatus } from "@/capture/activity/activitySelector";
import type { PipelineHeldReason } from "@/lib/voiceNotes/notePipeline";
import { type NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import "./final/soft.css";
import { VoiceNotes, type LocalTranscript, type NoteSttState, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { localTranscriptionUnavailable } from "@/lib/voiceNotes/captureEngine";
import { openManageStorage } from "@/lib/openManageStorage";
import { useStorageReadOnly } from "@/lib/useStorageReadOnly";
import { isOnDeviceReady, isOnDeviceStatusLoaded, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { downloadOnDeviceModel, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { onDeviceQueuePlace } from "@/lib/voiceNotes/onDeviceQueue";
import { localModelGuide, modelActionLabel } from "./final/localModelGuide";
import { receiptMetaText } from "./recorderCopy";
import { RouteLine, type RouteNode } from "./RouteLine";

export interface SavedReceiptProps {
  device?: "phone" | "mac";
  outcome: "local" | "saved" | "failed";
  localUpload?: "uploading" | "held" | "in-flight" | null;
  localUploadHeldReason?: "signed-out" | "other-account" | "legacy" | "unowned";
  /** The actual hold on this recording, when localUpload is held. */
  holdReason?: PipelineHeldReason | null;
  /** The saved note (absent after a failure). */
  saved?: { id: string; durationMs: number; at: number; channels?: 1 | 2 } | null;
  route: readonly RouteNode[];
  /** The note's live pipeline; the stepper replaces the route line and the saving lines until it is done. Absent where the caller shows none. */
  pipeline?: NotePipelineView | null;
  /** The pipeline's inputs are still being read: nothing stands in its place yet, so the old saving lines do not flash. */
  pipelineReading?: boolean;
  /** This note's chosen transcriber, looked up natively; null once it's known not to be on-device. */
  transcriber?: TranscriberId | null;
  /** The sidecar's durable on-device STT state, from the same native `listPending()` read
   * ReceiptView already made to learn `transcriber` — the seed for useOnDeviceReceipt's first
   * render, so this component does not repeat that read (and the recovery scan behind it) on
   * every mount. */
  sttHint?: NoteSttState | null;
  /** Private cloud has the note now. */
  transcribing?: boolean;
  /** A note committed to Local that the user moved to private cloud: its on-device state steps aside. */
  movedToPrivate?: boolean;
  /** Why private cloud could not transcribe the note, once it has failed. */
  privateFailure?: string | null;
  /** How private cloud's job for the note ended, once it has finished. */
  privateOutcome?: "transcribed" | "no_speech" | null;
  /** Why this note was not sent for transcription (it began outside the app); the note's own Transcribe sends it. */
  held?: string | null;
  error?: string | null;
  /** Saved, but some audio could not be written: an informational line, not an error. */
  notice?: string | null;
  /** A save of the notes on this phone is running. */
  retrying?: boolean;
  localAudioState?: "preparing" | "ready" | "failed";
  onRetryPreparation?: () => void;
  /** Moves a note committed to Local over to private cloud ("Use Private instead"); the reason it could not, or null. Absent unless private cloud is on offer for this saved note. */
  onUsePrivate?: () => Promise<string | null>;
  /** The receipt is offering something to press (so the sheet stays open longer). */
  onActionableChange?: (actionable: boolean) => void;
  onOpen?: () => void;
  onDone: () => void;
  onSaveNow: () => void;
  onPlayingChange?: (playing: boolean) => void;
  /** The local Play control is ready to show (or has visibly failed to load) — the provider's
   * receipt-display clock starts here, not at commit, so it can never run out before there is
   * anything to look at. Called at most once per note. */
  onReady?: () => void;
  className?: string;
}

/** On-device transcription's state for this note: the sidecar's durable `stt.state` is the source
 * of truth (round-2 finding 1) — a missed `transcribed`/`failed` event (fired before this
 * component mounted, or before a previous mount's listeners were attached) never strands the UI.
 * The initial read comes from `sttHint`, the caller's own `listPending()` call (ReceiptView
 * already makes one to learn the note's transcriber) — not a second one here. Two `listPending()`
 * calls on every receipt mount used to serialize behind native's recovery-scan lock and could
 * outrun the saved receipt's fixed display window on a phone with many notes (TC-781 round 4). A
 * fresh native read still happens after a `transcribed`/`failed` event or Retry, since those are
 * not on every mount. The live native queue (`onDeviceSttStore`) still drives the "Transcribing…"
 * progress line while a job runs. Works signed out and offline — never touches the space. */
export function useOnDeviceReceipt(id: string | undefined, wantsOnDevice: boolean, sttHint?: NoteSttState | null) {
  const onDevice = wantsOnDevice && !localTranscriptionUnavailable();
  const sttStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const [transcript, setTranscript] = useState<LocalTranscript | null>(null);
  const [durable, setDurable] = useState<NoteSttState | null>(null);
  const active = useRef(false);

  const readTranscript = () => {
    void VoiceNotes.getTranscript({ id: id! }).then(
      ({ transcript: found }) => { if (active.current) setTranscript(found); },
      () => { /* Best-effort: the durable/queue state below still renders. */ },
    );
  };
  const read = () => {
    readTranscript();
    void VoiceNotes.listPending().then(
      ({ recordings }) => {
        if (!active.current) return;
        const stt = recordings.find((recording) => recording.id === id)?.stt;
        if (stt) setDurable(stt);
      },
      () => { /* Best-effort: the queue state below still renders. */ },
    );
  };

  useEffect(() => {
    setTranscript(null);
    setDurable(sttHint ?? null);
    if (!id || !onDevice) return;
    active.current = true;
    readTranscript();
    const subs = [
      OnDeviceStt.addListener("transcribed", (event) => { if (active.current && event.id === id) read(); }),
      OnDeviceStt.addListener("failed", (event) => { if (active.current && event.id === id) read(); }),
    ];
    return () => {
      active.current = false;
      for (const sub of subs) void sub.then((handle) => handle.remove());
    };
  }, [id, onDevice, sttHint]);

  if (!id || !onDevice) return { kind: "none" as const, retry: () => {} };
  const retry = () => {
    setDurable((previous) => previous && { ...previous, state: "queued", error: null }); // clears the failure display the instant Retry starts
    void OnDeviceStt.enqueue({ id }).then(read);
  };
  if (transcript) return { kind: "transcribed" as const, transcript, retry };
  if (durable?.state === "failed") return { kind: "failed" as const, retry };
  const place = onDeviceQueuePlace(sttStatus, id);
  if (place) return { kind: "pending" as const, state: place.entry.state, position: place.position, percent: place.percent, retry };
  return { kind: "pending" as const, state: durable?.state ?? "queued", position: null, percent: null, retry };
}

type OnDeviceReceipt = ReturnType<typeof useOnDeviceReceipt>;

/** What the receipt offers for a Local note: whether it is waiting on the model, and whether anything is there to press. */
export function onDeviceOffer(args: {
  onDevice: OnDeviceReceipt;
  guide: { action?: unknown };
  saved: boolean;
  hasNote: boolean;
  movedToPrivate: boolean;
  canUsePrivate: boolean;
  /** The receipt shows an Open button for the note. */
  canOpen: boolean;
  /** The on-device model is on the phone. A note's `waiting_for_model` is only its starting state until the queue picks it up. */
  modelReady: boolean;
}) {
  const { onDevice, movedToPrivate } = args;
  const needsModel = !movedToPrivate && !args.modelReady && onDevice.kind === "pending" && onDevice.state === "waiting_for_model";
  const usePrivate = needsModel && args.saved && args.canUsePrivate;
  const actionable = args.canOpen || (needsModel && (args.guide.action !== undefined || usePrivate)) || (!movedToPrivate && onDevice.kind === "failed" && args.hasNote);
  return { needsModel, usePrivate, actionable };
}

/** The source reads "This phone" until a transcript made there exists. */
export function honestSourceRoute(route: readonly RouteNode[], transcribedHere: boolean): RouteNode[] {
  return route.map((node) => (node.kind === "source" && node.label.endsWith(" (transcribed here)") && !transcribedHere ? { ...node, label: node.label.replace(/ \(transcribed here\)$/, "") } : node));
}

/** A Local note whose model is not on the phone: what it needs and what can be done, with no spinner (nothing is running). */
export function NeedsOnDeviceModel(props: { guide: ReturnType<typeof localModelGuide>; error: string | null; onUsePrivate?: () => void; switching?: boolean; stepperShown?: boolean }) {
  const { action } = props.guide;
  if (props.stepperShown) {
    // The stepper names what the note needs and offers the download; the way off the phone's model stays here.
    if (!props.onUsePrivate) return null;
    return (
      <div className="flex flex-col gap-2" data-testid="voice-note-on-device-needs-model">
        <Button type="button" variant="outline" disabled={props.switching} onClick={props.onUsePrivate} data-testid="voice-note-use-private">
          {props.switching ? `Switching to ${TRANSCRIBER_NAME["private-cloud"]}…` : `Use ${TRANSCRIBER_NAME["private-cloud"]} instead`}
        </Button>
        {props.error && <p role="alert" className="text-callout text-destructive">Couldn't switch to Private. Try again.</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="voice-note-on-device-needs-model">
      <p role="status" className="text-callout text-muted-foreground">{action?.label === FINAL_COPY.modelUnavailable ? "Needs the on-device model" : props.guide.reason}</p>
      {(action || props.onUsePrivate) && (
        <div className="flex flex-wrap gap-2">
          {action && (
            <Button type="button" variant="outline" onClick={action.run} data-testid="voice-note-model-download-action">
              {modelActionLabel(action)}
            </Button>
          )}
          {props.onUsePrivate && (
            <Button type="button" variant="outline" disabled={props.switching} onClick={props.onUsePrivate} data-testid="voice-note-use-private">
              {props.switching ? `Switching to ${TRANSCRIBER_NAME["private-cloud"]}…` : `Use ${TRANSCRIBER_NAME["private-cloud"]} instead`}
            </Button>
          )}
        </div>
      )}
      {props.error && <p role="alert" className="text-callout text-destructive">Couldn't switch to Private. Try again.</p>}
    </div>
  );
}

/** The stepper on the Soft skin's tokens, which the receipt's own page does not carry. */
function ReceiptStepper(props: { view: NotePipelineView }) {
  const jobs = activityForNote(props.view, props.view.input?.device === "mac" ? "tauri" : props.view.input?.device === "browser" ? "web" : props.view.input?.device === "android" ? "android" : "ios");
  const status = noteStatus(jobs, props.view.pipeline);
  const actions = jobs.flatMap((job) => job.action ? [job.action] : job.retry ? [{ label: "Try again", run: job.retry }] : []);
  return (
    <div className="flex flex-wrap items-center gap-3 text-callout" data-testid="voice-note-receipt-pipeline">
      {status && <p role="status" className="text-muted-foreground">{status}</p>}
      {actions.map((action, index) => <button key={`${action.label}:${index}`} type="button" className="min-h-11 text-primary" onClick={action.run}>{action.label}</button>)}
      {props.view.actionError && <p role="alert" className="text-destructive">{props.view.actionError}</p>}
    </div>
  );
}

export function SavedReceipt(props: SavedReceiptProps) {
  const platform = useContext(PlatformContext);
  const localDevice = deviceName(props.device === "mac" ? "tauri" : platform);
  const saved = props.outcome === "saved";
  const storageFull = useStorageReadOnly();
  const holdReason = props.holdReason ?? props.localUploadHeldReason;
  const pipelineView = props.outcome === "failed" ? null : props.pipeline ?? null;
  const stepperShown = pipelineView !== null && !pipelineView.pipeline.done;
  const pipelineWaiting = props.outcome !== "failed" && props.pipelineReading === true;
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // A ref, not a dependency: onReady must fire exactly once per note's own fetch (keyed on
  // props.saved?.id below), regardless of whether the caller's callback identity happens to change
  // across renders in between.
  const onReadyRef = useRef(props.onReady);
  onReadyRef.current = props.onReady;
  useEffect(() => {
    if (!props.saved) return;
    let active = true;
    setLocalUrl(null);
    setLocalError(null);
    if (props.localAudioState === "preparing" || props.localAudioState === "failed") {
      onReadyRef.current?.();
      return;
    }
    void VoiceNotes.localAudioUrl({ id: props.saved.id }).then(
      ({ url }) => { if (active) { setLocalUrl(Capacitor.convertFileSrc(url)); onReadyRef.current?.(); } },
      (caught: unknown) => { if (active) { console.error("[Receipt] Could not open local audio", caught); setLocalError(audioUnavailableMessage(platform)); onReadyRef.current?.(); } },
    );
    return () => { active = false; };
  }, [props.saved?.id, props.localAudioState, platform]);
  const onDevice = useOnDeviceReceipt(props.saved?.id, props.transcriber === "on-device", props.sttHint);
  const sttStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const downloadError = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.downloadError, onDeviceSttStore.downloadError);
  const [modelError, setModelError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const guide = localModelGuide(isOnDeviceStatusLoaded(sttStatus) ? sttStatus : null, {
    start: () => void downloadOnDeviceModel(),
    error: downloadError,
  });
  // A Local note moved to private cloud: that line below says so, and the on-device ones step aside.
  const movedToPrivate = props.movedToPrivate === true;
  const offer = onDeviceOffer({ onDevice, guide, modelReady: isOnDeviceReady(sttStatus), saved, hasNote: !!props.saved, movedToPrivate, canUsePrivate: props.onUsePrivate !== undefined, canOpen: (saved || props.outcome === "local") && props.onOpen !== undefined });
  const { needsModel } = offer;
  const actionable = offer.actionable || (stepperShown && pipelineView.pipeline.blocker?.action !== undefined);
  const usePrivate = offer.usePrivate ? props.onUsePrivate : undefined;
  const onActionableChange = props.onActionableChange;
  useEffect(() => {
    onActionableChange?.(actionable);
    return () => onActionableChange?.(false);
  }, [actionable, onActionableChange]);
  const route = honestSourceRoute(props.route, onDevice.kind === "transcribed" && onDevice.transcript.outcome !== "no_speech")
    .map((node) => props.device === "mac" && node.kind === "source"
      ? { ...node, label: node.label.replaceAll("phone", "Mac") } : node);
  return (
    <section
      aria-label={`Saved on ${localDevice}`}
      data-testid="voice-note-receipt"
      data-outcome={props.outcome}
      className={cn("flex flex-col gap-3 rounded-xl border border-border p-4 motion-safe:animate-rise-in", props.className)}
    >
      <div className="flex flex-col gap-0.5">
        {props.saved && <p className="tnum text-meta text-muted-foreground">{receiptMetaText(props.saved.durationMs, props.saved.at)}</p>}
        {props.notice && (
          <p className="text-meta text-muted-foreground" data-testid="voice-note-partial-audio">
            {props.notice}
          </p>
        )}
        {props.error && (
          <p role="alert" className="text-meta text-muted-foreground">
            {props.error}
          </p>
        )}
      </div>
      {localUrl && <MeetingAudioPlayer url={localUrl} durationSecs={props.saved ? props.saved.durationMs / 1000 : null}
        channels={props.saved?.channels} onPlayingChange={props.onPlayingChange} />}
      {localError && <p role="alert" className="text-callout text-destructive">{localError}</p>}
      {props.localAudioState === "preparing" && <p role="status" className="text-meta text-muted-foreground">Preparing audio · View activity</p>}
      {props.localAudioState === "failed" && <div role="alert" className="flex items-center gap-3 text-callout text-destructive">
        <span>Recording saved. Couldn&apos;t prepare audio.</span>
        {props.onRetryPreparation && <Button type="button" variant="outline" onClick={props.onRetryPreparation}>Retry preparation</Button>}
      </div>}
      {!localUrl && !localError && props.saved && props.localAudioState !== "preparing" && props.localAudioState !== "failed" && <p role="status" className="text-meta text-muted-foreground">Getting {localDevice}&apos;s audio…</p>}
      {stepperShown ? <ReceiptStepper view={pipelineView} /> : pipelineWaiting ? null : (
        <>
          {!pipelineView && <RouteLine nodes={route} landed={saved} />}
          {props.outcome === "local" && !pipelineView && !pipelineWaiting && <p className="text-meta text-muted-foreground">{props.localUpload === "held"
            ? holdReason === "other-account" ? "Recorded on another account"
                : holdReason === "signed-out" ? "Sign in to sync to your TinyCloud space"
                  : holdReason === "legacy" || holdReason === "unowned" ? `Exo can't tell which account this note belongs to. It stays on ${localDevice}.`
                    : "Waiting to sync to your TinyCloud space"
            : props.localUpload === "in-flight" ? "Another save is finishing in your TinyCloud space…"
              : "Waiting to sync to your TinyCloud space"}</p>}
          {saved && <p className="text-meta text-muted-foreground">In your TinyCloud space</p>}
        </>
      )}
      {saved && !pipelineView && !pipelineWaiting && props.transcribing && <p className="text-meta text-muted-foreground">{props.transcriber === "assemblyai" ? "Transcribing with Powerful…" : "Transcribing in private cloud…"}</p>}
      {saved && !pipelineView && props.held && <p role="status" className="text-meta text-muted-foreground" data-testid="voice-note-held">{props.held}</p>}
      {saved && !pipelineView && !pipelineWaiting && props.privateOutcome && (
        <p className="text-meta text-muted-foreground" data-testid="voice-note-private-done">
          {props.privateOutcome === "no_speech" ? "No speech found" : props.transcriber === "assemblyai" ? "Transcribed with Powerful" : "Transcribed in private cloud"}
        </p>
      )}
      {props.privateFailure && !pipelineView && !pipelineWaiting && (
        <p role="alert" className="text-callout text-destructive" data-testid="voice-note-private-failed">{props.transcriber === "assemblyai" ? "Powerful transcription didn't finish." : "Private transcription didn't finish."}</p>
      )}
      {needsModel && (
        <NeedsOnDeviceModel
          guide={guide}
          error={modelError}
          switching={switching}
          stepperShown={stepperShown}
          onUsePrivate={usePrivate && (() => {
            setModelError(null);
            setSwitching(true);
            void usePrivate().then((failure) => {
              if (failure) console.error("[Receipt] Could not switch transcription to Private", failure);
              setModelError(failure ? "Couldn't switch to Private. Try again." : null);
              setSwitching(false);
            });
          })}
        />
      )}
      {!movedToPrivate && !stepperShown && onDevice.kind === "pending" && !needsModel && (
        <p role="status" className="flex items-center gap-2 text-meta text-muted-foreground" data-testid="voice-note-on-device-pending">
          <Loader2Icon className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
          Transcribing on {localDevice}…
        </p>
      )}
      {onDevice.kind === "transcribed" && (
        onDevice.transcript.outcome === "no_speech" ? (
          <p className="text-meta text-muted-foreground" data-testid="voice-note-on-device-no-speech">No speech found</p>
        ) : (
          <div className="flex flex-col gap-1" data-testid="voice-note-on-device-transcript">
            <p className="text-meta text-muted-foreground">Transcribed on {localDevice}</p>
            <p className="max-w-[60ch] whitespace-pre-wrap break-words text-callout">
              {onDevice.transcript.segments.map((segment) => segment.text).join(" ")}
            </p>
          </div>
        )
      )}
      {!movedToPrivate && !stepperShown && onDevice.kind === "failed" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="voice-note-on-device-failed">
          <p role="alert" className="min-w-0 flex-1 text-callout text-destructive">Couldn&apos;t transcribe on {localDevice}.</p>
          {props.saved && (
            <Button type="button" variant="outline" onClick={onDevice.retry} data-testid="voice-note-on-device-retry">
              <RefreshCwIcon aria-hidden /> Retry
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {saved || props.outcome === "local" || props.localAudioState === "failed" ? (
          <>
            {props.onOpen && (
              <Button type="button" variant="outline" onClick={props.onOpen} data-testid="voice-note-receipt-open">
                Open
              </Button>
            )}
            <Button type="button" onClick={props.onDone} data-testid="voice-note-receipt-done">
              Done
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={props.onDone} data-testid="voice-note-receipt-done">
              Done
            </Button>
            <Button type="button" onClick={storageFull ? openManageStorage : props.onSaveNow} disabled={props.retrying} data-testid="voice-note-retry">
              {props.retrying && <Loader2Icon className="animate-spin" aria-hidden="true" />} {storageFull ? "Manage storage" : "Save now"}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
