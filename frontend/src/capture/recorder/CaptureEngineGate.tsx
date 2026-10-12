import { useEffect, useState, type ReactNode } from "react";

import { captureEngineInstallPending, installCaptureEngine } from "@/lib/voiceNotes/captureEngine";

/**
 * Resolves the capture engine and native capabilities before the app (and its RecorderProvider) mounts.
 * A shell with "no engine" renders at once. A failed install is logged and the app renders without a
 * recorder: it never falls back to the native binding.
 */
export function CaptureEngineGate({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState(captureEngineInstallPending);
  useEffect(() => {
    if (!pending) return;
    let active = true;
    installCaptureEngine().then(
      () => { if (active) setPending(false); },
      (caught: unknown) => {
        console.error("[VoiceNotes] Could not start the recorder engine", caught);
        if (active) setPending(false);
      },
    );
    return () => { active = false; };
  }, [pending]);
  return pending ? null : <>{children}</>;
}
