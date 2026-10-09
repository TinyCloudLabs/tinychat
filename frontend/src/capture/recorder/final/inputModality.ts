export type Modality = "keyboard" | "pointer";

export interface ModalityTracker {
  current(): Modality;
  dispose(): void;
}

/** Whether the last input was a key or a pointer; capture phase, so nothing stops it. */
export function trackModality(target: EventTarget): ModalityTracker {
  let modality: Modality = "pointer";
  const key = () => (modality = "keyboard");
  const pointer = () => (modality = "pointer");
  target.addEventListener("keydown", key, true);
  target.addEventListener("pointerdown", pointer, true);
  return {
    current: () => modality,
    dispose() {
      target.removeEventListener("keydown", key, true);
      target.removeEventListener("pointerdown", pointer, true);
    },
  };
}

// The app-wide tracker: one per page, installed at import so the event that
// opens a dialog is already seen, and taken down when this module is replaced.
let tracker: ModalityTracker | null = null;

export function installModalityTracking(
  target: EventTarget | undefined = globalThis.document,
): void {
  if (tracker || !target) return;
  tracker = trackModality(target);
}

export function disposeModalityTracking(): void {
  tracker?.dispose();
  tracker = null;
}

installModalityTracking();
import.meta.hot?.dispose(disposeModalityTracking);

export function inputModality(): Modality {
  installModalityTracking(); // a document that appeared after import
  return tracker?.current() ?? "pointer";
}

/** A dialog opened from the keyboard shows its focus ring at once; any later key press turns it on too. */
export function markKeyboardOpened(
  element: Pick<HTMLElement, "setAttribute"> | null,
  modality: Modality = inputModality(),
) {
  if (element && modality === "keyboard") element.setAttribute("data-kbd", "");
}
