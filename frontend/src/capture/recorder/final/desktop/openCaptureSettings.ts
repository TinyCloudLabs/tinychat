/** When ⚙︎ Capture settings is not mounted, so nothing can open it for a Whisper model. */
export const GET_WHISPER_NO_SETTINGS = "Open ⚙︎ Capture settings on the Capture page to get a Whisper model.";

const openers = new Set<() => void>();

/** A mounted ⚙︎ Capture settings registers how to open itself; the returned function unregisters it. */
export function onOpenCaptureSettings(open: () => void): () => void {
  openers.add(open);
  return () => {
    openers.delete(open);
  };
}

/** Opens ⚙︎ Capture settings. False when none is mounted, so the caller can say so. */
export function openCaptureSettings(): boolean {
  if (openers.size === 0) return false;
  for (const open of [...openers]) open();
  return true;
}
