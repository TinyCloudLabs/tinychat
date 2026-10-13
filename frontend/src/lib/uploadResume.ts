// Whether an interrupted upload may pick up on its own (TC-761).
//
// Resuming an AssemblyAI upload made with the user's own key reads that key
// from the vault first (lib/audioUpload.ts `run`), and reading it unlocks the
// vault, which prompts. Nothing may unlock the vault on mount, so such a job
// waits as "Upload paused" until the user taps Continue; the prompt then
// follows their tap. Private cloud and TinyCloud's AssemblyAI account need no
// key, and an already unlocked vault prompts for nothing: those resume at once.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { localStoragePendingUploadStore, type PendingUpload, type UploadDeps, type UploadRunner } from "./audioUpload";

export function resumeNeedsUnlock(job: PendingUpload | null, secretsUnlocked: boolean): boolean {
  if (job === null) return false;
  // `?? "own"` as the runner reads it: a record from before key modes was made with the user's key.
  return !(job.engine !== "assemblyai" || (job.assemblyAiMode ?? "own") === "hosted" || secretsUnlocked);
}

/** This account's stored upload (one a reload interrupted), or null. */
export function storedUploadFor(tcw: Pick<TinyCloudWeb, "did">): PendingUpload | null {
  return localStoragePendingUploadStore(tcw.did).read();
}

/**
 * What a mount does with the stored upload: resume it, or, when resuming would
 * unlock the vault, leave it and return it so the view can offer Continue.
 */
export function resumeUnlessLocked(
  runner: Pick<UploadRunner, "resume">,
  deps: UploadDeps,
  secretsUnlocked: boolean,
): PendingUpload | null {
  const stored = (deps.pending ?? localStoragePendingUploadStore(deps.tcw.did)).read();
  if (resumeNeedsUnlock(stored, secretsUnlocked)) return stored;
  runner.resume(deps);
  return null;
}
