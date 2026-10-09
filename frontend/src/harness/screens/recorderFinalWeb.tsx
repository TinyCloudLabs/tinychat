// The final recorder in a browser tab (W2): the same screens as the desktop and phone ones, on a web
// engine's capabilities (no Settings to open, no on-device speech), with the tab title shown in a small
// strip at the top. The harness build has no env, so a web engine is installed by hand. The interactive
// screen runs the real recorder over the fake plugin, for test/recorder-final-web.e2e.test.ts.
import { useEffect } from "react";

import { recordingTitle } from "@/capture/recorder/final/shell/recordingTitle";
import { keepOpenMessage } from "@/capture/recorder/final/shell/keepOpenToast";
import { PhoneToast } from "@/capture/recorder/final/shell/ShellChrome";
import { showToast } from "@/capture/recorder/final/desktop/Toasts";
import { recorderLayout } from "@/capture/recorder/final/shellCapabilities";
import type { DesktopRecorderSeed } from "@/capture/recorder/final/desktop/DesktopRecorder";
import type { RecorderValue } from "@/capture/recorder/RecorderProvider";
import {
  __setInstalledEngineForTests,
  type CaptureCapabilities,
} from "@/lib/voiceNotes/captureEngine";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { __setOnDeviceSttForTests } from "@/lib/voiceNotes/onDeviceStt";
import type { HarnessScreen } from "../screen";
import {
  Frame,
  INPUTS,
  LIVE,
  ON_DEVICE_STT,
  steadyLevel,
} from "./recorderFinalDesktop";

const WEB_CAPABILITIES: CaptureCapabilities = {
  nativeShortcuts: false,
  presentRecorder: false,
  openSettings: false,
  micDeniedPresentation: false,
  background: false,
  localTranscription: false,
  offlineRecorder: false,
};

const installWebEngine = () =>
  __setInstalledEngineForTests("web", WEB_CAPABILITIES);

// What the browser would show on the tab while this state runs; plain "Exo" otherwise.
function TabStrip({ value }: { value: Partial<RecorderValue> }) {
  const title =
    recordingTitle(
      value.phase ?? "idle",
      value.mic?.state ?? "idle",
      value.elapsedMs ?? 0,
    ) ?? "Exo";
  return (
    <div
      data-testid="tab-strip"
      className="pointer-events-none fixed left-1/2 top-0 z-[80] -translate-x-1/2 rounded-b-md border border-t-0 bg-background px-3 py-0.5 text-xs text-muted-foreground shadow"
    >
      {title}
    </div>
  );
}

function KeepOpenNotice() {
  const message = keepOpenMessage(recorderLayout(window.innerWidth));
  useEffect(() => {
    if (recorderLayout(window.innerWidth) !== "phone") showToast(message);
  }, [message]);
  return recorderLayout(window.innerWidth) === "phone" ? (
    <PhoneToast message={message} />
  ) : null;
}

function screen(
  id: string,
  value: Partial<RecorderValue>,
  seed: DesktopRecorderSeed = {},
  notice = false,
): HarnessScreen {
  return {
    id: `recorder-final-web-${id}`,
    group: "recorder",
    layout: "pane",
    displayTitle: false,
    path: "/chat/capture",
    platform: "web",
    render: () => {
      installWebEngine();
      __setOnDeviceSttForTests(ON_DEVICE_STT);
      const recorder = { subscribeLevel: steadyLevel, ...LIVE, ...value };
      return (
        <>
          <TabStrip value={recorder} />
          {notice ? <KeepOpenNotice /> : null}
          <Frame seed={{ inputs: INPUTS, ...seed }} recorder={recorder} />
        </>
      );
    },
  };
}

const interactiveScreen: HarnessScreen = {
  id: "recorder-final-web-interactive",
  group: "recorder",
  layout: "pane",
  displayTitle: false,
  path: "/chat/capture",
  platform: "web",
  interactive: true,
  render: () => {
    installWebEngine();
    __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: true });
    __setOnDeviceSttForTests(ON_DEVICE_STT);
    return <Frame seed={{ inputs: INPUTS }} start />;
  },
};

export const recorderFinalWebScreens: HarnessScreen[] = [
  interactiveScreen,
  screen("recording", {}),
  screen("paused", { mic: { state: "paused", reason: "user" } }),
  screen("keep-open", {}, {}, true),
  screen("mic-revoked", {
    mic: { state: "needs_user", reason: "permission_revoked" },
  }),
  screen("mic-denied", {
    phase: "idle",
    mic: { state: "idle", reason: null },
    permissionDenied: true,
    startedAt: null,
    audioMs: 0,
    elapsedMs: 0,
  }),
  screen("modes", {}, { defaultOpen: "modes" }),
  screen("via", {}, { defaultOpen: "via" }),
];
