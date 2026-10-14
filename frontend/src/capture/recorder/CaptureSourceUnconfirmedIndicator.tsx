import { useRecorder } from "./RecorderProvider";

/** Stays mounted with RecorderShell across routes until native polling clears it or Exo restarts. */
export function CaptureSourceUnconfirmedIndicator() {
  const recorder = useRecorder();
  if (!recorder.captureSourceUnconfirmed) return null;

  return (
    <div className="pointer-events-none fixed inset-x-4 top-3 z-50 flex justify-center">
      <p role="status" aria-live="polite" data-testid="capture-source-unconfirmed"
        className="max-w-xl rounded-lg border border-amber-500/40 bg-amber-50 px-4 py-2 text-callout font-medium text-amber-950 shadow-sm dark:bg-amber-950 dark:text-amber-100">
        The recording was saved. The microphone Exo used may still be in use. This warning clears when that input stops or Exo restarts; another app using the same input can keep it on.
      </p>
    </div>
  );
}
