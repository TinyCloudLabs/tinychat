import { useEffect, useState } from "react";

import { VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { MicrophoneAccessOff } from "./MicrophoneAccessOff";

/** The native shortcut can be denied before an account exists and RecorderProvider mounts. */
export function MicDeniedRecovery({ enabled }: { enabled: boolean }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled && !visible) return;
    let mounted = true;
    let remove: (() => Promise<void>) | undefined;
    void VoiceNotes.addListener("presentRecorder", (event) => {
      if (!mounted || event.id !== null) return;
      if (event.reason === "permission_denied") setVisible(true);
      if (event.reason === "permission_granted") setVisible(false);
    }).then((handle) => {
      if (mounted) remove = () => handle.remove();
      else void handle.remove();
    }).catch((error: unknown) => console.warn("[VoiceNotes] Could not listen for microphone recovery", error));
    return () => { mounted = false; if (remove) void remove(); };
  }, [enabled, visible]);

  if (!visible) return null;
  return (
    <div className="fixed inset-0 z-50 h-dvh w-screen overflow-hidden bg-background" data-testid="signed-out-mic-recovery">
      <MicrophoneAccessOff onMinimise={() => setVisible(false)} onOpenSettings={() => VoiceNotes.openSettings()} />
    </div>
  );
}
