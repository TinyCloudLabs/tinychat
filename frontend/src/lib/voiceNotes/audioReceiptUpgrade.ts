import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useEffect } from "react";
import { logPipelineError } from "@/lib/debugLog";
import { assertAccountContext, captureAccountContext } from "./accountContext";
import { nativeRecordingSource, VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { reconcileSavedVoiceNoteAudio } from "./voiceNoteStore";
import { trimCachedAudio } from "./audioPlaybackCache";

let account: TinyCloudWeb | null = null;
const running = new WeakMap<TinyCloudWeb, Promise<void>>();
const completed = new Map<string, number>();
const PASS_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const accountListeners = new Set<() => void>();

function passKey(tcw: TinyCloudWeb): string {
  return `exo-audio-receipt-pass:${tcw.did}:${tcw.spaceId}`;
}

function lastCompleted(key: string): number {
  if (completed.has(key)) return completed.get(key)!;
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}

function markCompleted(key: string): void {
  const now = Date.now();
  completed.set(key, now);
  try { localStorage.setItem(key, String(now)); } catch { /* Storage can be disabled in a webview. */ }
}

export function setAudioCacheAccount(tcw: TinyCloudWeb | null): void {
  if (account === tcw) return;
  account = tcw;
  for (const listener of accountListeners) listener();
}
export function subscribeAudioCacheAccount(listener: () => void): () => void {
  accountListeners.add(listener);
  return () => accountListeners.delete(listener);
}

/** Authenticated app boot path; Settings joins the same pass if it opens early. */
export function useAudioCacheBoot(tcw: TinyCloudWeb | null): void {
  useEffect(() => {
    setAudioCacheAccount(tcw);
    if (tcw) void reconcileAudioCache(tcw)
      .catch((error: unknown) => logPipelineError("audio cache boot", error));
    return () => { if (account === tcw) setAudioCacheAccount(null); };
  }, [tcw]);
}

const hasReceipt = (note: VoiceNoteRecording) => {
  const receipt = note.ledger?.audio.verifiedInSpace;
  return !!receipt && /^[0-9a-f]{64}$/.test(receipt.sha256)
    && Number.isSafeInteger(receipt.size) && receipt.size > 0;
};

/** Reads the manifest and every part before giving a pre-upgrade file eviction authority. */
export async function upgradeSavedAudioReceipt(tcw: TinyCloudWeb, note: VoiceNoteRecording): Promise<void> {
  if (note.owner !== tcw.did || note.ledger?.audio.state !== "saved" || hasReceipt(note)) return;
  const context = captureAccountContext(tcw);
  try {
    if ((await VoiceNotes.localAudioSize({ id: note.id })).size <= 0) return;
    assertAccountContext(context, tcw);
    const receipt = await reconcileSavedVoiceNoteAudio(tcw, note.id, nativeRecordingSource(note));
    if (!receipt) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      assertAccountContext(context, tcw);
      const fresh = (await VoiceNotes.listPending()).recordings.find((row) => row.id === note.id);
      if (!fresh || fresh.owner !== tcw.did || fresh.ledger?.audio.state !== "saved") return;
      if (hasReceipt(fresh)) return;
      try {
        await VoiceNotes.updateLedger({ id: note.id, did: tcw.did, rev: fresh.rev ?? 0,
          patch: { audio: { ...fresh.ledger.audio, verifiedInSpace: receipt } } });
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== "rev_conflict" || attempt === 1) throw error;
      }
    }
  } catch (error) {
    logPipelineError("audio cache reconciliation", error, note.id);
  }
}

/** Shared boot and Settings pass. Sequential space reads and a yield every few files keep it quiet. */
export function reconcileAudioCache(tcw: TinyCloudWeb | null = account, force = false): Promise<void> {
  if (!tcw) return Promise.resolve();
  const existing = running.get(tcw);
  if (existing) return existing;
  const key = passKey(tcw);
  if (!force && Date.now() - lastCompleted(key) < PASS_COOLDOWN_MS) return Promise.resolve();
  const context = captureAccountContext(tcw);
  const work = (async () => {
    const notes = (await VoiceNotes.listPending()).recordings.filter((note) =>
      note.owner === tcw.did && note.ledger?.audio.state === "saved" && !hasReceipt(note));
    for (let index = 0; index < notes.length; index++) {
      if (account !== tcw) return;
      assertAccountContext(context, tcw);
      await upgradeSavedAudioReceipt(tcw, notes[index]!);
      if (index % 3 === 2 && index + 1 < notes.length)
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    if (account !== tcw) return;
    assertAccountContext(context, tcw);
    await trimCachedAudio();
    markCompleted(key);
  })();
  const settled = work.finally(() => running.delete(tcw));
  running.set(tcw, settled);
  return settled;
}
