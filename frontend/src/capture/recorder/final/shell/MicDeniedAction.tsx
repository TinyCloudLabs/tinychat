import { openSettingsUnavailable } from "@/lib/voiceNotes/captureEngine";
import { BROWSER_MIC_GUIDANCE } from "../../MicrophoneAccessOff";

/**
 * What the final recorder offers when the microphone is denied. Where the shell can open settings
 * that is the button; in a browser it is the site-permission guidance, with Try again once idle
 * (record() does nothing over a running recording, so a revoked live recording gets only the guidance).
 */
export function MicDeniedAction({
  idle,
  onOpenSettings,
  onTryAgain,
}: {
  idle: boolean;
  onOpenSettings(): void;
  onTryAgain(): void;
}) {
  if (!openSettingsUnavailable()) {
    return (
      <button type="button" className="pr-b primary" onClick={onOpenSettings}>
        Open Settings
      </button>
    );
  }
  return (
    <div className="pr-controls-wrap" data-testid="browser-mic-guidance">
      <p className="pr-extra" style={{ minHeight: 0, margin: 0 }}>{BROWSER_MIC_GUIDANCE}</p>
      {idle && (
        <button type="button" className="pr-b primary" onClick={onTryAgain}>
          Try again
        </button>
      )}
    </div>
  );
}
