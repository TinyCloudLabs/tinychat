// The retained microphone recovery views (MicrophoneAccessOff, and the signed-out MicDeniedRecovery) over native
// calls that reject with native details, for test/mic-recovery.e2e.test.ts. Not captured.
import { MicDeniedRecovery } from "@/capture/recorder/MicDeniedRecovery";
import { MicrophoneAccessOff } from "@/capture/recorder/MicrophoneAccessOff";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { __setVoiceNotesForTests, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { HarnessScreen } from "../screen";

declare global {
  interface Window {
    exoMicStatusFails?: boolean;
  }
}

const NATIVE_DETAILS = "NSCocoaErrorDomain Code=4099 com.apple.avfoundation.session 0x7f3a (native detail)";

function reject(): Promise<never> {
  return Promise.reject(new Error(NATIVE_DETAILS));
}

function signedOut(name: string, plugin: (base: VoiceNotesPlugin) => Partial<VoiceNotesPlugin>): HarnessScreen {
  return {
    id: `mic-recovery-${name}`,
    group: "recorder",
    layout: "pane",
    platform: "android",
    interactive: true,
    render: () => {
      const base = createFakeVoiceNotes().plugin;
      __setVoiceNotesForTests({ ...base, ...plugin(base) }, { available: true });
      return <MicDeniedRecovery enabled onContinue={() => {}} />;
    },
  };
}

export const micRecoveryScreens: HarnessScreen[] = [
  {
    id: "mic-recovery-off",
    group: "recorder",
    layout: "pane",
    platform: "ios",
    interactive: true,
    render: () => <MicrophoneAccessOff onMinimise={reject} onOpenSettings={reject} />,
  },
  signedOut("denied", (base) => ({
    status: async () => ({ ...(await base.status()), micDeniedPresentation: true }),
    openSettings: reject,
    dismissShortcutRecovery: reject,
  })),
  // Reads succeed until the test sets window.exoMicStatusFails, then fail: the line shows under the recovery.
  signedOut("check-failed", (base) => ({
    status: async () =>
      window.exoMicStatusFails
        ? reject()
        : { ...(await base.status()), shortcutRecordPending: true, microphonePermissionGranted: true },
  })),
  signedOut("sign-in", (base) => ({
    status: async () => ({ ...(await base.status()), shortcutRecordPending: true, microphonePermissionGranted: true }),
    dismissShortcutRecovery: reject,
  })),
];
