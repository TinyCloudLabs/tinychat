import { useEffect, useState, type ReactNode } from "react";

import { captureEngineInstallPending, installCaptureEngine } from "@/lib/voiceNotes/captureEngine";
import { trimCachedAudio } from "@/lib/voiceNotes/audioPlaybackCache";

/**
 * Installs web and Tauri before the app mounts. Native and "no engine" render at once.
 * A failed install is logged and the app renders without a
 * recorder: it never falls back to the native binding.
 */
export function CaptureEngineGate({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState(captureEngineInstallPending);
  useEffect(() => {
    let active = true;
    installCaptureEngine().then(
      () => { void trimCachedAudio().catch((error: unknown) => console.error("[VoiceNotes] Audio cache reconciliation failed", error));
        if (active) setPending(false); },
      (caught: unknown) => {
        console.error("[VoiceNotes] Could not start the recorder engine", caught);
        if (active) setPending(false);
      },
    );
    return () => { active = false; };
  }, []);
  return pending ? null : <>{children}</>;
}
