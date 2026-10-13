import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { Link, useNavigate } from "react-router-dom";
import { MicIcon, UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { PageHeader } from "@/shell/PageHeader";
import { PATHS, type Screen } from "@/shell/routes";
import { useSizeClass } from "@/lib/sizeClass";
import { PlatformContext } from "@/lib/platform";
import { notePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import { combinedModel, type NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import { onDeviceQueuePlace } from "@/lib/voiceNotes/onDeviceQueue";
import { downloadOnDeviceModel, retryOnDeviceNote } from "@/lib/voiceNotes/onDeviceSttStore";
import { VoiceNotes, type LocalTranscript } from "@/lib/voiceNotes/nativeVoiceNotes";
import { isAppleSpeech, isOnDeviceReady, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { useLocalNotes } from "./local/useLocalNotes";
import { EarlierVersionNotes } from "./local/EarlierVersionNotes";
import { onPhoneItem } from "./library/onPhone";
import { LibraryRow } from "./library/LibraryRow";
import { LibraryListView } from "./library/LibraryListView";
import type { LibraryFilter } from "./library/libraryKinds";
import { NoteDetailView } from "./library/NoteDetailView";
import { VoiceNotesTranscriberSettings } from "@/chat/VoiceNotesTranscriberSettings";
import { useRecorder } from "./recorder/RecorderProvider";
import { SoftHomeProvider } from "./home/softHome";
import { SystemAudioStart } from "./home/desktop/SystemAudioStart";
import { ActivityPanel } from "./activity/ActivityPanel";

/** The regular Capture and Library visual language, backed by the phone while no space is available. */
export function DeviceCaptureSurface({ did, offline, error, onSignIn, onRetry, screen }: {
  did: string | null; offline: boolean; error: string | null;
  onSignIn: () => void; onRetry: () => void; screen: Screen;
}) {
  const recorder = useRecorder();
  const compact = useSizeClass().size === "compact";
  const platform = useContext(PlatformContext);
  const navigate = useNavigate();
  const { notes, error: notesError, refresh, remove } = useLocalNotes(did, offline || error !== null);
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const status = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const enqueued = useRef(new Set<string>());
  useEffect(() => {
    if (!isOnDeviceReady(status)) return;
    const waiting = notes.filter((note) => note.options?.transcriber === "on-device" && note.stt?.state === "waiting_for_model" && !enqueued.current.has(note.id));
    if (waiting.length === 0) return;
    for (const note of waiting) enqueued.current.add(note.id);
    if (isAppleSpeech(status)) {
      // iOS's existing waiting jobs are already reserved. Installing ready assets is a
      // no-op, then the native plugin reconciles and wakes the queue.
      void OnDeviceStt.installSpeechAssets().then(refresh, () => {
        for (const note of waiting) enqueued.current.delete(note.id);
      });
    } else {
      for (const note of waiting) void OnDeviceStt.enqueue({ id: note.id }).then(refresh, () => enqueued.current.delete(note.id));
    }
  }, [notes, status, refresh]);
  useEffect(() => {
    const handle = OnDeviceStt.addListener("transcribed", () => { void refresh(); });
    return () => { void handle.then((listener) => listener.remove()); };
  }, [refresh]);
  const currentNotes = useMemo(() => notes.filter((note) => !note.ownerUnknown), [notes]);
  const earlierNotes = useMemo(() => notes.filter((note) => note.ownerUnknown), [notes]);
  const items = useMemo(() => currentNotes.map((note) => onPhoneItem(note)), [currentNotes]);
  const activityItems = useMemo(() => notes.map((note) => onPhoneItem(note)), [notes]);
  const activityViews = useMemo(() => new Map(notes.map((note): [string, NotePipelineView] => {
    const pending = recorder.pending.notes?.find((entry) => entry.id === note.id);
    const queue = onDeviceQueuePlace(status, note.id);
    const route = note.options?.transcriber === "on-device" ? "on-device" : note.options?.transcriber === "off" ? "off" : "private-cloud";
    const input: NotePipelineInput = {
      device: platform === "android" ? "android" : "iphone", route, transcriptProvider: note.options?.transcriber === "assemblyai" ? "powerful" : "private",
      audioUploadIntent: (note.options as { uploadAudio?: boolean } | undefined)?.uploadAudio ?? true,
      hasNotesOrMoments: false, online: !offline,
      capture: { finalizing: recorder.finalizationPendingId === note.id, issue: null },
      space: { saved: !note.ownerUnknown && note.ledger?.audio?.state === "saved", pending: pending ?? (note.ownerUnknown ? { held: "unowned" } : offline ? {} : { held: "signed-out" }), lane: { busy: false, depth: 0 } },
      transcript: { inSpace: null, cloud: route === "private-cloud" ? recorder.transcription?.jobs.get(note.id) ?? null : null,
        onDevice: route === "on-device" ? { stt: queue ? { state: queue.entry.state, error: queue.entry.error } : note.stt ? { state: note.stt.state, error: note.stt.error } : null,
          queue: queue ? { position: queue.position, inLine: queue.inLine, percent: queue.percent } : null, model: combinedModel(status), download: status.download.state, sync: null } : null },
      notes: { state: "idle" },
    };
    const pipeline = notePipeline(input);
    return [note.id, { input, pipeline, provider: route === "on-device" ? "local" : note.options?.transcriber === "assemblyai" ? "powerful" : "private",
      onAction: (kind) => { if (kind === "sign-in") onSignIn(); else if (kind === "get-model") void downloadOnDeviceModel(); else if (kind === "retry") { if (pipeline.current === "transcript") void retryOnDeviceNote(note.id); else void recorder.retryPending(); } else if (kind === "check-again") void recorder.transcription?.onRecheck(); else if (kind === "review-consent") recorder.reviewPrivateConsent?.(); },
      onRetryStep: (key) => { if (key === "transcript") void retryOnDeviceNote(note.id); else void recorder.retryPending(); }, actionError: null }];
  })), [notes, recorder, status, platform, offline, onSignIn]);
  const selected = notes.find((note) => onPhoneItem(note).id === screen.noteId);
  const noteItem = selected ? onPhoneItem(selected) : null;
  const library = screen.id === "library";
  const detail = screen.id === "note";
  const soft = compact;
  const activity = <ActivityPanel items={activityItems} views={activityViews} platform={platform} onOpenNote={(id) => navigate(PATHS.library + "/" + id)} />;
  const notice = <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-callout">
    <p>{offline ? "You're offline. Recordings stay on this phone until Exo reconnects." : "Recordings stay on this phone until you sign in."}</p>
    {error && !offline && <p role="alert" className="mt-1 text-destructive">{error}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      {offline && <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}
      {!offline && <Button size="sm" onClick={onSignIn}>Sign in</Button>}
    </div>
  </div>;
  return <SoftHomeProvider enabled={soft} issues={recorder.captureIssues} onDismissIssue={recorder.dismissCaptureIssue}>
    <div className={`h-full min-h-0 ${soft ? "soft-skin soft-home" : ""}`} data-testid="capture-surface">
      {detail ? <DeviceNoteDetail id={selected?.id ?? null} item={noteItem} activityView={selected ? activityViews.get(selected.id) : undefined} platform={platform} activity={activity} onBack={() => navigate(PATHS.library)} /> : library ?
        <div className="h-full overflow-y-auto" data-scroll-root>
          <PageHeader title="Library" back={() => navigate(PATHS.capture)} className="mx-auto w-full max-w-2xl px-4" trailing={activity} />
          <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2">
            {notice}
            <LibraryListView status="ready" items={items} filter={filter} onFilterChange={setFilter} onRetry={() => void refresh()} now={new Date()} activityViews={activityViews} platform={platform} />
          </div>
        </div> : <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto" data-scroll-root>
            <PageHeader title="Capture" className="mx-auto w-full max-w-2xl px-4" trailing={<div className="flex flex-wrap items-center gap-2">{activity}<Link to={PATHS.library} className="soft-header-link">Library</Link></div>} />
            <div className="mx-auto w-full max-w-2xl space-y-6 px-4 pb-6 pt-2">
              {notice}
              {notesError && <p role="alert" className="text-callout text-destructive">{notesError}</p>}
              <section aria-labelledby="device-recent-title" className="soft-recent">
                <div className="soft-sect-row"><h2 id="device-recent-title" className="soft-sect">Recent</h2><Link to={PATHS.library} className="soft-link">See all</Link></div>
                {items.length ? <ul className="soft-list">{items.slice(0, 5).map((item) =>
                  <LibraryRow key={item.id} item={item} now={new Date()} grouped={false} activityView={activityViews.get(item.sourceId)} platform={platform} />)}</ul>
                  : <p className="soft-empty">Your recordings will appear here.</p>}
              </section>
              <EarlierVersionNotes notes={earlierNotes} did={did} onChange={refresh} onDelete={remove} />
            </div>
          </div>
          <div className="bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
            <div className="mx-auto max-w-2xl"><SystemAudioStart renderTrigger={(start, disabled, ref) =>
              <button ref={ref} type="button" className="soft-act soft-act-main w-full" onClick={start} disabled={disabled || !recorder.available}>Record</button>} /></div>
          </div>
        </div>}
    </div>
  </SoftHomeProvider>;
}

function DeviceNoteDetail({ id, item, onBack, activityView, platform, activity }: { id: string | null; item: ReturnType<typeof onPhoneItem> | null; onBack: () => void; activityView?: NotePipelineView; platform: "ios" | "android" | "tauri" | "web"; activity: React.ReactNode }) {
  const [transcript, setTranscript] = useState<LocalTranscript | null | undefined>(undefined);
  useEffect(() => {
    if (!id) return;
    let live = true;
    void VoiceNotes.getTranscript({ id }).then((result) => { if (live) setTranscript(result.transcript); }, () => { if (live) setTranscript(null); });
    const listener = OnDeviceStt.addListener("transcribed", (event) => {
      if (event.id === id) void VoiceNotes.getTranscript({ id }).then((result) => { if (live) setTranscript(result.transcript); });
    });
    return () => { live = false; void listener.then((handle) => handle.remove()); };
  }, [id]);
  const sentences = transcript?.segments.map((segment, index) => ({
    index, speaker_name: segment.speaker, text: segment.text, start_time: segment.start / 1000, end_time: segment.end / 1000,
  }));
  return <div className="h-full overflow-y-auto" data-scroll-root>
    <NoteDetailView item={item} listStatus="ready" metadata={{ status: "absent" }}
      transcript={transcript === undefined ? undefined : sentences ? { status: "ok", sentences } : { status: "absent" }}
      audio={id ? { localUrl: async () => Capacitor.convertFileSrc((await VoiceNotes.localAudioUrl({ id })).url) } : null}
      copyState="idle" onCopy={() => { if (sentences) void navigator.clipboard.writeText(sentences.map((part) => part.text).join("\n")); }}
      onRetry={() => { if (id) void VoiceNotes.getTranscript({ id }).then((result) => setTranscript(result.transcript)); }}
      activityView={activityView} platform={platform} activityControl={activity}
      pushed onBack={onBack} />
  </div>;
}

export function DeviceCaptureSettings({ onBack, onSignIn, offline = false }: { onBack: () => void; onSignIn: () => void; offline?: boolean }) {
  return <div className="h-full overflow-y-auto" data-scroll-root>
    <PageHeader title="Settings" back={onBack} className="mx-auto w-full max-w-2xl px-4" />
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-8 pt-2">
      <SectionCard icon={UserIcon} title="Account"><p className="text-callout text-muted-foreground">{offline ? "Exo will sync when it reconnects." : "Sign in to sync your recordings."}</p><Button className="mt-3" onClick={onSignIn}>{offline ? "Try again" : "Sign in"}</Button></SectionCard>
      <SectionCard icon={MicIcon} title="Voice notes"><VoiceNotesTranscriberSettings /></SectionCard>
    </div>
  </div>;
}
