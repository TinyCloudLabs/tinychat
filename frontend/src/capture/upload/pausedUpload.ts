// An upload a reload interrupted that waits for the user (TC-761): it uses
// their own AssemblyAI key and the vault is locked, so resuming it would
// prompt. UploadResumer publishes it at launch; the In progress row and the
// Upload sheet show "Upload paused · Continue", and Continue resumes it from
// the tap, so any unlock prompt follows the user's own action.
import { uploadRunner, type UploadDeps } from "@/lib/audioUpload";

export interface PausedUpload {
  fileName: string;
}

let current: PausedUpload | null = null;
const listeners = new Set<() => void>();

export const pausedUpload = {
  snapshot: (): PausedUpload | null => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  set(next: PausedUpload | null): void {
    if (next === current || (next !== null && current !== null && next.fileName === current.fileName)) return;
    current = next;
    for (const listener of [...listeners]) listener();
  },
};

/** Continue: the user's tap resumes the paused upload (reading the key may unlock the vault, and prompt). */
export function continuePausedUpload(deps: UploadDeps): void {
  pausedUpload.set(null);
  uploadRunner.resume(deps);
}
