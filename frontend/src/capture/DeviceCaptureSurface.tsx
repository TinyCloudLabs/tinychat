import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Capacitor } from "@capacitor/core";
import { Link, useNavigate } from "react-router-dom";
import { MicIcon, UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { PageHeader } from "@/shell/PageHeader";
import { PATHS, type Screen } from "@/shell/routes";
import { useSizeClass } from "@/lib/sizeClass";
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
import { AudioCacheSettings } from "./AudioCacheSettings";
import { useRecorder } from "./recorder/RecorderProvider";
import { SoftHomeProvider } from "./home/softHome";
import { SystemAudioStart } from "./home/desktop/SystemAudioStart";

/** The regular Capture and Library visual language, backed by the phone while no space is available. */
export function DeviceCaptureSurface({ did, offline, error, onSignIn, onRetry, screen }: {
  did: string | null; offline: boolean; error: string | null;
  onSignIn: () => void; onRetry: () => void; screen: Screen;
}) {
  const recorder = useRecorder();
  const compact = useSizeClass().size === "compact";
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
  const selected = notes.find((note) => onPhoneItem(note).id === screen.noteId);
  const noteItem = selected ? onPhoneItem(selected) : null;
  const library = screen.id === "library";
  const detail = screen.id === "note";
  const soft = compact;
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
      {detail ? <DeviceNoteDetail id={selected?.id ?? null} item={noteItem} onBack={() => navigate(PATHS.library)} /> : library ?
        <div className="h-full overflow-y-auto" data-scroll-root>
          <PageHeader title="Library" back={() => navigate(PATHS.capture)} className="mx-auto w-full max-w-2xl px-4" />
          <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2">
            {notice}
            <LibraryListView status="ready" items={items} filter={filter} onFilterChange={setFilter} onRetry={() => void refresh()} now={new Date()} />
          </div>
        </div> : <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto" data-scroll-root>
            <PageHeader title="Capture" className="mx-auto w-full max-w-2xl px-4" trailing={<Link to={PATHS.library} className="soft-header-link">Library</Link>} />
            <div className="mx-auto w-full max-w-2xl space-y-6 px-4 pb-6 pt-2">
              {notice}
              {notesError && <p role="alert" className="text-callout text-destructive">{notesError}</p>}
              <section aria-labelledby="device-recent-title" className="soft-recent">
                <div className="soft-sect-row"><h2 id="device-recent-title" className="soft-sect">Recent</h2><Link to={PATHS.library} className="soft-link">See all</Link></div>
                {items.length ? <ul className="soft-list">{items.slice(0, 5).map((item) =>
                  <LibraryRow key={item.id} item={item} now={new Date()} grouped={false} />)}</ul>
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

function DeviceNoteDetail({ id, item, onBack }: { id: string | null; item: ReturnType<typeof onPhoneItem> | null; onBack: () => void }) {
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
      pushed onBack={onBack} />
  </div>;
}

export function DeviceCaptureSettings({ onBack, onSignIn, offline = false }: { onBack: () => void; onSignIn: () => void; offline?: boolean }) {
  return <div className="h-full overflow-y-auto" data-scroll-root>
    <PageHeader title="Settings" back={onBack} className="mx-auto w-full max-w-2xl px-4" />
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 pb-8 pt-2">
      <SectionCard icon={UserIcon} title="Account"><p className="text-callout text-muted-foreground">{offline ? "Exo will sync when it reconnects." : "Sign in to sync your recordings."}</p><Button className="mt-3" onClick={onSignIn}>{offline ? "Try again" : "Sign in"}</Button></SectionCard>
      <SectionCard icon={MicIcon} title="Voice notes"><VoiceNotesTranscriberSettings /></SectionCard>
      <SectionCard icon={MicIcon} title="Storage"><AudioCacheSettings /></SectionCard>
    </div>
  </div>;
}
