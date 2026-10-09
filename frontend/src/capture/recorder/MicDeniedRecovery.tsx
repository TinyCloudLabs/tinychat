import { MicIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { VoiceNotes, type CaptureStatus } from "@/lib/voiceNotes/nativeVoiceNotes";
import { MicrophoneAccessOff } from "./MicrophoneAccessOff";

/** The signed-out gate reads native recovery state without taking presentRecorder events. */
export function micRecoveryMode(status: CaptureStatus): "denied" | "sign-in" | null {
  return status.micDeniedPresentation ? "denied"
    : status.shortcutRecordPending && status.microphonePermissionGranted ? "sign-in" : null;
}

export async function readMicRecoveryMode() { return micRecoveryMode(await VoiceNotes.status()); }

export function MicDeniedRecovery({ enabled, onContinue }: { enabled: boolean; onContinue(): void | Promise<void> }) {
  const [mode, setMode] = useState<"denied" | "sign-in" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) { setMode(null); return; }
    let mounted = true;
    const refresh = () => {
      void readMicRecoveryMode().then((next) => {
        if (!mounted) return;
        setError(null);
        setMode(next);
      }).catch((caught: unknown) => {
        if (mounted) {
          console.warn("[VoiceNotes] Could not check microphone recovery", caught);
          setError(`Could not check microphone access: ${caught instanceof Error ? caught.message : String(caught)}`);
        }
      });
    };
    refresh();
    const timer = setInterval(refresh, 500);
    return () => { mounted = false; clearInterval(timer); };
  }, [enabled]);

  const dismiss = async () => {
    await VoiceNotes.dismissShortcutRecovery();
    setMode(null);
  };

  if (!enabled || !mode) return null;
  return (
    <div className="fixed inset-0 z-50 h-dvh w-screen overflow-hidden bg-background" data-testid="signed-out-mic-recovery">
      {mode === "denied" ? (
        <MicrophoneAccessOff onMinimise={dismiss} onOpenSettings={() => VoiceNotes.openSettings()} />
      ) : (
        <div className="flex h-full flex-col bg-background text-foreground">
          <header className="flex min-h-14 items-center px-4 pt-[env(safe-area-inset-top)]">
            <Button type="button" variant="ghost" onClick={() => void dismiss().catch((caught: unknown) => setError(String(caught)))}>Dismiss</Button>
          </header>
          <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
            <MicIcon className="size-12 text-primary" aria-hidden />
            <h1 className="font-display text-title-1">Microphone access is on</h1>
            <p className="text-body text-muted-foreground">Sign in to record your voice note. Your shortcut will open the recorder after sign-in.</p>
            <Button type="button" size="lg" className="min-h-12" onClick={() => void onContinue()}>Continue to sign in</Button>
            {error && <p role="alert" className="text-callout text-destructive">{error}</p>}
          </main>
        </div>
      )}
    </div>
  );
}
