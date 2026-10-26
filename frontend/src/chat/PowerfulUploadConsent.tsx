// The Powerful consent step for an uploaded file: the recorder's dialog and copy, the same account-scoped
// consent (`powerfulConsented` / `onPowerfulConsent` on the recorder's transcription props). Declining starts nothing.
import { useCallback, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { UploadEngine } from "@/lib/audioUpload";
import { SheetDialog } from "@/capture/recorder/final/SheetDialog";
import { POWERFUL_CONSENT_ACTION, POWERFUL_CONSENT_TITLE, POWERFUL_CONSENT_UPLOAD_BODY } from "@/capture/recorder/final/finalCopy";
import { PowerfulConsentDescription } from "@/capture/recorder/final/PowerfulConsentDescription";
import "@/capture/home/desktop/systemAudioStart.css";

export interface PowerfulUploadConsentOptions {
  /** This account has already agreed to Powerful (the recorder's stored consent). */
  consented: boolean;
  /** Records the agreement where the recorder reads it. */
  onConsent: () => void;
}

/**
 * `request(engine, start)` runs `start` now for any engine but Powerful, or when Powerful is already agreed to;
 * otherwise it asks first and runs `start` only on confirm. Cancelling, Escape and "Not now" run nothing.
 */
export function usePowerfulUploadConsent({ consented, onConsent }: PowerfulUploadConsentOptions): {
  request: (engine: UploadEngine, start: () => void) => void;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<{ start: () => void } | null>(null);
  const [agreedHere, setAgreedHere] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const agreed = consented || agreedHere;

  const request = useCallback((engine: UploadEngine, start: () => void) => {
    if (engine !== "assemblyai" || agreed) { start(); return; }
    opener.current = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPending({ start });
  }, [agreed]);

  const close = useCallback((confirmed: boolean) => {
    if (pending === null) return;
    setPending(null);
    if (!confirmed) return;
    onConsent();
    setAgreedHere(true);
    pending.start();
  }, [onConsent, pending]);

  const dialog = pending === null ? null : (
    <div className="dch-system-audio" data-testid="upload-powerful-consent">
      <SheetDialog role="dialog" titleId={titleId} descriptionId={descriptionId}
        title={POWERFUL_CONSENT_TITLE} description={<PowerfulConsentDescription body={POWERFUL_CONSENT_UPLOAD_BODY} />}
        onCancel={() => close(false)} returnFocus={opener}>
        <div className="dch-system-audio-actions">
          <Button type="button" variant="outline" data-initial="" onClick={() => close(false)}>Not now</Button>
          <Button type="button" onClick={() => close(true)}>{POWERFUL_CONSENT_ACTION}</Button>
        </div>
      </SheetDialog>
    </div>
  );
  return { request, dialog };
}
