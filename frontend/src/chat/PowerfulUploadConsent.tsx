// The Powerful consent step for an uploaded file: the recorder's dialog and copy, the same account-scoped
// consent (`powerfulConsented` / `onPowerfulConsent` on the recorder's transcription props). Declining starts nothing.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

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
    <ConsentFrame onCancel={() => close(false)}>
      <SheetDialog role="dialog" titleId={titleId} descriptionId={descriptionId}
        title={POWERFUL_CONSENT_TITLE} description={<PowerfulConsentDescription body={POWERFUL_CONSENT_UPLOAD_BODY} />}
        onCancel={() => close(false)} returnFocus={opener}>
        <div className="dch-system-audio-actions">
          <Button type="button" variant="outline" data-initial="" onClick={() => close(false)}>Not now</Button>
          <Button type="button" onClick={() => close(true)}>{POWERFUL_CONSENT_ACTION}</Button>
        </div>
      </SheetDialog>
    </ConsentFrame>
  );
  return { request, dialog };
}

/**
 * The dialog's frame inside the upload sheet, which is itself a modal (Radix Dialog or vaul) and the dialog sits in its
 * content. Three things the recorder gets for free (its dialog has no modal parent) need doing here:
 * - the sheet behind is `inert`, as the recorder's views are while its dialog is open (`inert={dialogOpen}`): Back,
 *   Close, the file field and Transcribe leave the tab order;
 * - Tab is not passed on to the sheet's focus scope, which would count the dialog's last button as the sheet's last
 *   control and wrap focus out to the sheet's first one (SheetDialog's own trap already cycles inside the dialog);
 * - Escape is taken before the sheet's document-level handler, so it closes only this dialog.
 */
function ConsentFrame({ onCancel, children }: { onCancel: () => void; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  // A layout effect: the sheet is live again before SheetDialog's cleanup hands focus back to the opener.
  useLayoutEffect(() => {
    const made: Element[] = [];
    const stop = frame.current?.parentElement?.closest('[role="dialog"]') ?? document.body;
    for (let node: Element | null = frame.current; node && node !== stop; node = node.parentElement) {
      for (const sibling of node.parentElement?.children ?? []) {
        if (sibling === node || sibling.hasAttribute("inert")) continue;
        sibling.setAttribute("inert", "");
        made.push(sibling);
      }
    }
    return () => made.forEach((element) => element.removeAttribute("inert"));
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      cancel.current();
    };
    // Capture on the window runs before Radix's capture listener on the document.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const keepTab = (event: KeyboardEvent) => {
    if (event.key === "Tab") event.stopPropagation();
  };
  return (
    <div ref={frame} className="dch-system-audio" data-testid="upload-powerful-consent" onKeyDown={keepTab}>
      {children}
    </div>
  );
}
