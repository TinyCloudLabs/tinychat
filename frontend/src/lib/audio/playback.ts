/** Every note player registers here so capture and navigation can silence it. */
const players = new Map<HTMLMediaElement, () => void>();
let observer: MutationObserver | null = null;
let captureActive = false;

export function setCapturePlaybackBlocked(blocked: boolean): void {
  if (captureActive === blocked) return;
  captureActive = blocked;
  if (blocked) stopAllPlayback();
}

export function playbackBlocked(): boolean {
  return captureActive;
}

export function playbackVisible(element: HTMLMediaElement): boolean {
  if (document.visibilityState === "hidden" || !element.isConnected) return false;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true" || node.classList.contains("hidden")) return false;
  }
  // A dialog outside the player's tree covers its controls, even when the pane stays mounted.
  for (const dialog of document.querySelectorAll('[role="dialog"][data-state="open"], [data-overlay-open="true"]')) {
    if (!dialog.contains(element)) return false;
  }
  const recorder = document.querySelector('[data-recorder-host]:not(:empty)');
  if (recorder && !recorder.contains(element)) return false;
  return true;
}

function stopCoveredPlayback(): void {
  for (const [element, stop] of players) if (!playbackVisible(element)) stop();
}

export function registerPlayback(element: HTMLMediaElement, stop: () => void = () => element.pause()): () => void {
  players.set(element, stop);
  if (!observer && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(stopCoveredPlayback);
    observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true, attributeFilter: ["class", "hidden", "inert", "aria-hidden", "data-state", "data-overlay-open"] });
    document.addEventListener("visibilitychange", stopCoveredPlayback);
  }
  stopCoveredPlayback();
  return () => {
    stop();
    players.delete(element);
    if (players.size === 0) {
      observer?.disconnect();
      observer = null;
      document.removeEventListener("visibilitychange", stopCoveredPlayback);
    }
  };
}

export function stopAllPlayback(): void {
  for (const stop of players.values()) stop();
}
