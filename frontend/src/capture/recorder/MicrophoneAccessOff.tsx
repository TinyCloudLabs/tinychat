import { ChevronDownIcon, MicOffIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

export function MicrophoneAccessOff({ onMinimise, onOpenSettings }: {
  onMinimise(): void;
  onOpenSettings(): Promise<void>;
}) {
  const [settingsError, setSettingsError] = useState<string | null>(null);
  return (
    <div data-testid="voice-note-recorder" data-phase="permission-denied" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-14 shrink-0 items-center px-4 pt-[env(safe-area-inset-top)]">
        <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Minimise recorder" onClick={onMinimise}><ChevronDownIcon className="!size-5" /></Button>
      </header>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-5 px-6 pb-[env(safe-area-inset-bottom)] text-center">
        <MicOffIcon className="size-12 text-warning" aria-hidden />
        <h1 className="font-display text-title-1">Microphone access is off</h1>
        <p className="text-body text-muted-foreground">Allow microphone access in Settings to record a voice note.</p>
        <Button type="button" size="lg" className="min-h-12 min-w-36" data-testid="voice-note-open-settings" onClick={() => {
          setSettingsError(null);
          void onOpenSettings().catch((error: unknown) => setSettingsError(error instanceof Error ? error.message : String(error)));
        }}>Open Settings</Button>
        {settingsError && <p role="alert" className="text-callout text-destructive">{settingsError}</p>}
      </main>
    </div>
  );
}
