import { useState } from "react";
import { readableError } from "@/lib/readableError";
import { useRecorder } from "../RecorderProvider";
import { ADD_15_MIN, ADD_30_MIN, LIMIT_CHANGE_FAILED, LIMIT_CONTROLS_LABEL, NO_LIMIT, NO_LIMIT_HINT } from "../recorderCopy";
import type { LimitExtension } from "@/lib/voiceNotes/nativeVoiceNotes";

const MINUTE_MS = 60_000;
const CHOICES: readonly { label: string; extension: LimitExtension; testId: string; title?: string }[] = [
  { label: ADD_15_MIN, extension: 15 * MINUTE_MS, testId: "limit-add-15" },
  { label: ADD_30_MIN, extension: 30 * MINUTE_MS, testId: "limit-add-30" },
  { label: NO_LIMIT, extension: "none", testId: "limit-none", title: NO_LIMIT_HINT },
];

/**
 * Under "Stops at …": move this recording's stop time later, or cancel it. Each press changes the running recording
 * only; the default for new recordings is the Stop recording after setting. Absent where the engine fixes the limit
 * at start.
 */
export function AutoStopControls() {
  const { extendLimit } = useRecorder();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (extendLimit === undefined) return null;
  const apply = async (extension: LimitExtension) => {
    setPending(true);
    setError(null);
    try {
      await extendLimit(extension);
    } catch (caught) {
      console.warn("[AutoStopControls] The recording's limit could not be changed", caught);
      setError(`${LIMIT_CHANGE_FAILED} (${readableError(caught)})`);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <div className="pr-limit" role="group" aria-label={LIMIT_CONTROLS_LABEL} data-testid="limit-controls">
        {CHOICES.map(({ label, extension, testId, title }) => (
          <button key={testId} type="button" className="pr-limit-btn" disabled={pending} title={title} data-testid={testId}
            onClick={() => void apply(extension)}>
            {label}
          </button>
        ))}
      </div>
      {error && <p className="pr-alert" role="alert">{error}</p>}
    </>
  );
}
