import { useEffect, useState, type ReactNode } from "react";

import { captureEngineInstallPending, installCaptureEngine } from "@/lib/voiceNotes/captureEngine";

/**
 * Installs the web or Tauri capture engine before the app (and its RecorderProvider) mounts.
 * Native and "no engine" render at once. A failed install is logged and the app renders without a
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
