// TC-515: voice notes recorded offline (or whose save failed) wait on the phone
// (`listPending()`). Once the session is back, save them, without waiting for the
// user to open Connectors, where the Voice notes card's own mount-time retry
// would otherwise be the only thing to try.
//
// It is the card's retry: the same module-level single-flight
// (`savePendingRecordings`), so it never uploads a recording a second time
// alongside the card or the chat screen's bar. Saved notes go to private cloud
// transcription exactly as the card hands them over (when it is on for this
// account). Headless, like the app's other once-per-session lanes.

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { captureCapabilities, captureEngineAvailable } from "@/lib/voiceNotes/captureEngine";
import { OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { syncOnDeviceTranscript } from "@/lib/voiceNotes/onDeviceTranscriber";
import { getDesktopWhisperQueue } from "@/lib/voiceNotes/desktop/desktopWhisper";
import { isTinyCloudNetworkFailure, logVoiceNoteError, pendingSaveMessage, pendingStore, whenVoiceNoteSavesIdle } from "@/lib/voiceNotes/recorderSaves";
import { advanceAccountGeneration, captureAccountContext, currentAccountGeneration, isAccountContextCurrent, mountVoiceNoteAccount } from "@/lib/voiceNotes/accountContext";
import { saveDeferredForAccountTransition, type VoiceNotePipeline } from "@/lib/voiceNotes/voiceNotePipeline";
import { recheckVoiceNoteAvailabilityAutomatically, resumeStorageHeldTranscripts, transcribeSavedNote, voiceNoteTranscriberFor } from "@/lib/voiceNotes/voiceNoteTranscription";
import { isStorageReadOnly, subscribeStorageReadOnly } from "@/lib/storageStatus";

let recovery: (() => Promise<void>) | null = null;
/** Keep the mounted saver available to renewal without remounting the view. */
export function registerPendingVoiceNotesRecovery(run: () => Promise<void>): () => void {
  recovery = run;
  return () => { if (recovery === run) recovery = null; };
}
/** A forced native session swap can abort a save without remounting this component. */
export function schedulePendingVoiceNotesRecovery(): void {
  void whenVoiceNoteSavesIdle().then(() => recovery?.());
}

/**
 * An on-device transcription that finishes after its note is already saved (the common case: the
 * space save is quick, on-device decode is not) has nothing left to trigger `saveRecording`'s own
 * sync, so this listens for it directly. `saveRecording` covers the opposite ordering.
 */
function installOnDeviceTranscriptSync(tcw: TinyCloudWeb, pipeline: VoiceNotePipeline): () => void {
  let disposed = false;
  const accountWorkAllowed = () => pipeline.isAccepting?.() ?? true;
  const sync = (event: { id: string }, eventType: "transcribed" | "failed") => {
    const { id } = event;
    if (disposed) return;
    if (!accountWorkAllowed()) {
      console.info(`[OnDeviceStt] Dropped ${eventType} event id=${id}: account work paused`);
      return;
    }
    const account = captureAccountContext(tcw);
    void VoiceNotes.listPending()
      .then(({ recordings }) => {
        if (disposed) return;
        if (!accountWorkAllowed() || !isAccountContextCurrent(account, tcw)) {
          console.info(`[OnDeviceStt] Dropped ${eventType} event id=${id}: account changed or work paused during phone read`);
          return;
        }
        const recording = recordings.find((note) => note.id === id);
        if (recording) return syncOnDeviceTranscript(tcw, recording, account);
      })
      .catch((err: unknown) => console.warn("[OnDeviceStt] Could not sync a finished transcription", err));
  };
  const transcribed = OnDeviceStt.addListener("transcribed", (event) => sync(event, "transcribed"));
  const failed = OnDeviceStt.addListener("failed", (event) => sync(event, "failed"));
  return () => {
    disposed = true;
    void transcribed.then((handle) => handle.remove());
    void failed.then((handle) => handle.remove());
  };
}

export function PendingVoiceNotesSaver({
  tcw,
  pipeline,
  backendUrl,
  sessionStore,
}: {
  tcw: TinyCloudWeb;
  pipeline: VoiceNotePipeline;
  backendUrl: string;
  sessionStore: SessionStore;
}) {
  useEffect(() => {
    if (!captureEngineAvailable() || !captureCapabilities().localTranscription) return;
    return installOnDeviceTranscriptSync(tcw, pipeline);
  }, [pipeline, tcw]);

  useEffect(() => {
    const queue = getDesktopWhisperQueue();
    if (!queue) return;
    let disposed = false;
    const accountWorkAllowed = () => pipeline.isAccepting?.() ?? true;
    const sync = (id: string) => {
      if (disposed) return;
      if (!accountWorkAllowed()) {
        console.info(`[desktopWhisper] Dropped transcript id=${id}: account work paused`);
        return;
      }
      const account = captureAccountContext(tcw);
      void VoiceNotes.listPending().then(({ recordings }) => {
        if (disposed) return;
        if (!accountWorkAllowed() || !isAccountContextCurrent(account, tcw)) {
          console.info(`[desktopWhisper] Dropped transcript id=${id}: account changed or work paused during phone read`);
          return;
        }
        const recording = recordings.find((note) => note.id === id);
        if (recording) return syncOnDeviceTranscript(tcw, recording, account);
      }).catch((error: unknown) => console.warn("[desktopWhisper] Could not sync transcript", error));
    };
    const unsubscribe = queue.onDone(sync);
    const unsubscribeFailed = queue.onFailed(sync);
    return () => { disposed = true; unsubscribe(); unsubscribeFailed(); };
  }, [pipeline, tcw]);

  useEffect(() => {
    if (!captureEngineAvailable()) return;
    advanceAccountGeneration();
    const did = tcw.did;
    const spaceId = tcw.spaceId;
    if (!did || !spaceId) return;
    pendingStore.setAccount(did);
    pendingStore.setOnline(typeof navigator === "undefined" ? true : navigator.onLine !== false);
    const unmountAccount = mountVoiceNoteAccount(did);
    const accountGeneration = currentAccountGeneration();
    const isAccountCurrent = () => accountGeneration === currentAccountGeneration();
    pipeline.resume();
    const transcriber = voiceNoteTranscriberFor(tcw, backendUrl, sessionStore);
    let runInFlight: Promise<void> | null = null;
    let dirty = false;
    let disposed = false;
    let appStateHandle: { remove(): Promise<void> } | undefined;
    const run = (): Promise<void> => {
      if (runInFlight) {
        dirty = true;
        return runInFlight;
      }
      const runOnce = async () => {
        const generation = currentAccountGeneration();
        const account = pendingStore.forAccount(did);
        try {
          await pipeline.reconcileAll({ did, spaceId, generation }, "reconcile", (note) => {
            if (transcriber) transcribeSavedNote(transcriber, note, () => generation === currentAccountGeneration());
          });
          await account.refresh(null);
        } catch (error) {
          if (saveDeferredForAccountTransition(error)) return;
          const message = pendingSaveMessage(error);
          // Network errors are already logged by messageOf through the redacting formatter.
          if (!isTinyCloudNetworkFailure(error)) logVoiceNoteError("Saving pending notes failed", error);
          account.reportError(message);
        }
      };
      runInFlight = (async () => {
        do {
          dirty = false;
          await runOnce();
        } while (dirty && !disposed);
      })().finally(() => { runInFlight = null; });
      return runInFlight;
    };
    const unregister = registerPendingVoiceNotesRecovery(run);
    if (transcriber) void recheckVoiceNoteAvailabilityAutomatically(transcriber, isAccountCurrent);
    void run();
    // Freed storage resumes the queued audio now, not on the next focus or poll.
    let storageWasFull = isStorageReadOnly();
    const unsubscribeStorage = subscribeStorageReadOnly(() => {
      const full = isStorageReadOnly();
      if (storageWasFull && !full) {
        void run();
        if (transcriber) resumeStorageHeldTranscripts(transcriber);
      }
      storageWasFull = full;
    });
    const onOnline = () => {
      pendingStore.setOnline(true);
      if (transcriber) void recheckVoiceNoteAvailabilityAutomatically(transcriber, isAccountCurrent);
      void run();
    };
    const onOffline = () => pendingStore.setOnline(false);
    const windowTarget = typeof window !== "undefined" && typeof window.addEventListener === "function" ? window : undefined;
    const documentTarget = typeof document !== "undefined" && typeof document.addEventListener === "function" ? document : undefined;
    windowTarget?.addEventListener("online", onOnline);
    windowTarget?.addEventListener("offline", onOffline);
    const onVisible = () => {
      if (documentTarget?.visibilityState !== "visible") return;
      if (transcriber) void recheckVoiceNoteAvailabilityAutomatically(transcriber, isAccountCurrent);
      void run();
    };
    documentTarget?.addEventListener("visibilitychange", onVisible);
    if (Capacitor.isNativePlatform()) {
      void import("@capacitor/app").then(({ App }) => App.addListener("appStateChange", ({ isActive }) => {
        if (isActive) {
          if (transcriber) void recheckVoiceNoteAvailabilityAutomatically(transcriber, isAccountCurrent);
          void run();
        }
      })).then((handle) => {
        if (disposed) void handle.remove();
        else appStateHandle = handle;
      }).catch((error: unknown) => console.warn("[VoiceNotes] Could not listen for foreground recovery", error));
    }
    return () => {
      disposed = true;
      windowTarget?.removeEventListener("online", onOnline);
      windowTarget?.removeEventListener("offline", onOffline);
      documentTarget?.removeEventListener("visibilitychange", onVisible);
      if (appStateHandle) void appStateHandle.remove();
      unsubscribeStorage();
      unregister(); unmountAccount(); pipeline.cancelAll(); pendingStore.setAccount(null);
    };
  }, [backendUrl, pipeline, sessionStore, tcw]);
  return null;
}
