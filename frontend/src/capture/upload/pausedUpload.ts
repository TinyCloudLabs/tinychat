// An upload a reload interrupted that waits for the user (TC-761): it uses
// their own AssemblyAI key and the vault is locked, so resuming it would
// prompt. UploadResumer publishes it at launch; the In progress row and the
// Upload sheet show "Upload paused · Continue", and Continue resumes it from
// the tap, so any unlock prompt follows the user's own action.
import { uploadRunner, type UploadDeps } from "@/lib/audioUpload";
import { isHomeReauthorizing } from "@/lib/homeReauthorizing";

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

/**
 * Continue: the user's tap resumes the paused upload (reading the key may unlock the vault, and prompt). Refused while
 * a Home re-authorise is in progress: nothing starts and the upload stays paused, with Continue. Otherwise the runner
 * admits the resume as Home work (lib/homeReauthorizing.ts) and holds its place until the run ends.
 */
export function continuePausedUpload(deps: UploadDeps): void {
  if (isHomeReauthorizing()) return;
  pausedUpload.set(null);
  uploadRunner.resume(deps);
}
