import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { AppPlatform } from "@/lib/platform";
import { logPipeline } from "@/lib/debugLog";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { LibraryItem } from "../library/LibraryRow";
import { FailureNotificationDedupe, failureNotifications, failureNotificationStorageKey, readFailureNotificationKeys, writeFailureNotificationKeys, type FailureNotification } from "./failureNotifications";
import { captureEvents } from "../captureEvents";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";

const TOAST_MS = 8000;

function nativeAvailable(): boolean {
  return typeof Notification !== "undefined";
}

export function nativeFailurePayload(failure: FailureNotification): { path: string; noteId: string; track: string } {
  return { path: failure.path, noteId: failure.noteId, track: failure.track };
}

function showMacNotification(failure: FailureNotification, open: (path: string) => void): boolean {
  if (!nativeAvailable() || Notification.permission !== "granted" || document.hasFocus()) return false;
  try {
    const notification = new Notification(failure.title, { body: failure.message, data: nativeFailurePayload(failure) });
    notification.onclick = () => {
      window.focus();
      open((notification.data as { path?: string } | undefined)?.path ?? failure.path);
      notification.close();
    };
    return true;
  } catch { return false; }
}

export function FailureNotificationHost(props: {
  accountDid: string;
  items: readonly LibraryItem[];
  views: ReadonlyMap<string, NotePipelineView>;
  platform: AppPlatform;
  visibleNoteId: string | null;
  onOpenPath: (path: string) => void;
}) {
  const storageKey = failureNotificationStorageKey(props.accountDid);
  const dedupe = useMemo(() => new FailureNotificationDedupe(readFailureNotificationKeys(storageKey)), [storageKey]);
  const [toasts, setToasts] = useState<FailureNotification[]>([]);
  const [askPermission, setAskPermission] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [permissionError, setPermissionError] = useState(false);

  useEffect(() => {
    const stored = readFailureNotificationKeys(storageKey);
    if (JSON.stringify(stored) !== JSON.stringify(dedupe.keys())) writeFailureNotificationKeys(storageKey, dedupe.keys());
  }, [dedupe, storageKey]);

  useEffect(() => {
    const before = dedupe.keys().length;
    dedupe.reconcile(props.views, props.platform);
    const failures = failureNotifications(props.items, props.views, props.platform);
    const fresh = dedupe.take(failures, props.visibleNoteId);
    if (dedupe.keys().length !== before) writeFailureNotificationKeys(storageKey, dedupe.keys());
    if (!fresh.length) {
      // A failure first seen in the note is still consumed, so leaving it cannot alert later.
      return;
    }
    const inApp: FailureNotification[] = [];
    for (const failure of fresh) {
      logPipeline("failure_notification", failure.noteId, "shown", { engine: failure.track, destination: props.platform });
      if (props.platform !== "tauri" || !showMacNotification(failure, props.onOpenPath)) inApp.push(failure);
    }
    if (inApp.length) setToasts((current) => [...current, ...inApp].slice(-5));
    if (props.platform === "tauri" && nativeAvailable() && Notification.permission === "default") {
      try {
        if (localStorage.getItem(`${storageKey}:permission-dismissed`) !== "yes") setAskPermission(true);
      } catch { setAskPermission(true); }
    }
  }, [dedupe, props.items, props.views, props.platform, props.visibleNoteId, props.onOpenPath, storageKey]);

  useEffect(() => captureEvents.on("note-deleted", (detail) => {
    if (detail?.source !== VOICE_NOTE_SOURCE) return;
    dedupe.pruneDeleted(detail.sourceId);
    writeFailureNotificationKeys(storageKey, dedupe.keys());
  }), [dedupe, storageKey]);

  useEffect(() => {
    if (!toasts.length) return;
    const timer = setTimeout(() => setToasts((current) => current.slice(1)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toasts]);
  useEffect(() => {
    if (props.visibleNoteId !== null) setToasts((current) => current.some((entry) => entry.noteId === props.visibleNoteId)
      ? current.filter((entry) => entry.noteId !== props.visibleNoteId) : current);
  }, [props.visibleNoteId]);

  const requestPermission = async () => {
    if (!nativeAvailable()) return;
    setRequesting(true);
    try {
      await Notification.requestPermission();
      setAskPermission(false);
    } catch { setPermissionError(true); }
    finally { setRequesting(false); }
  };
  const dismissPermission = () => {
    try { localStorage.setItem(`${storageKey}:permission-dismissed`, "yes"); } catch { /* This session only. */ }
    setAskPermission(false);
  };

  if (!toasts.length && !askPermission) return null;
  return createPortal(<div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" data-testid="failure-notifications">
    {askPermission && <section className="rounded-lg bg-background p-4 text-callout text-foreground shadow-lg" aria-label="Mac notifications">
      <p className="font-medium">Get notified when a note needs attention?</p>
      <p className="mt-1 text-muted-foreground">Exo can show a Mac notification for a recording, transcription, or sync failure when the app is in the background.</p>
      {permissionError && <p role="alert" className="mt-2">Couldn't request permission. You can try again.</p>}
      <div className="mt-3 flex gap-4"><button type="button" className="min-h-11 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={requesting} onClick={() => void requestPermission()}>Notify me</button><button type="button" className="min-h-11 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={dismissPermission}>Not now</button></div>
    </section>}
    {toasts.map((failure) => <section key={failure.key} className="rounded-lg bg-background p-4 text-callout text-foreground shadow-lg" role="status">
      <p className="font-medium">{failure.title}</p><p className="mt-1 text-muted-foreground">{failure.message}</p>
      <div className="mt-2 flex gap-4"><button type="button" className="min-h-11 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { props.onOpenPath(failure.path); setToasts((current) => current.filter((entry) => entry.key !== failure.key)); }}>Open note</button><button type="button" className="min-h-11 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setToasts((current) => current.filter((entry) => entry.key !== failure.key))} aria-label={`Dismiss notification for ${failure.title}`}>Dismiss</button></div>
    </section>)}
  </div>, document.body);
}
