// The final desktop recorder (D1) in the real app shell: the ring view fills the main region and the
// sidebar (1280 wide) or rail (900 wide) stays visible. The static screens run over a fixed recorder on
// the frozen clock; the interactive one runs the real recorder over the fake native plugin, for
// test/recorder-final-desktop.e2e.test.ts. The harness build has no env, so FinalRecorderShell stands in
// for the flag, and DesktopRecorderSeedContext opens the surfaces that start closed.
import { useContext, useEffect, useMemo, useRef } from "react";

import {
  DesktopRecorderSeedContext,
  type DesktopRecorderSeed,
} from "@/capture/recorder/final/desktop/DesktopRecorder";
import type { AudioInputsSnapshot } from "@/capture/recorder/final/useAudioInputs";
import {
  clearNotesUi,
  updateNotesUi,
  type NotesUiFields,
} from "@/capture/recorder/final/notes";
import { useRecorder, type RecorderValue } from "@/capture/recorder/RecorderProvider";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { PlatformContext } from "@/lib/platform";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import {
  __setVoiceNotesForTests,
  type VoiceNotesPlugin,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import {
  __setOnDeviceSttForTests,
  type OnDeviceSttPlugin,
  type OnDeviceSttStatus,
} from "@/lib/voiceNotes/onDeviceStt";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";
import { FROZEN_NOW } from "../stubs";

declare global {
  interface Window {
    /** The real recorder over the fake native plugin: the control calls in order. */
    exoDesktop?: { calls: string[] };
  }
}

const noop = () => {};

// A steady moderate level, re-sent so the ring stays active (it goes quiet 450ms after the last sample).
const STEADY_LEVEL = 0.15;
export const steadyLevel: RecorderValue["subscribeLevel"] = (listener) => {
  listener(STEADY_LEVEL);
  const timer = setInterval(() => listener(STEADY_LEVEL), 100);
  return () => clearInterval(timer);
};

const PRIVATE_CLOUD_ON: VoiceNoteTranscriptionProps = {
  availability: "available",
  consented: true,
  maxSeconds: 600,
  jobs: new Map(),
  onTranscribe: noop,
  onConsent: noop,
  onTurnOff: noop,
  onRecheck: noop,
};

const minutes = (m: number, s = 0) => (m * 60 + s) * 1000;

export const LIVE: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: FROZEN_NOW - minutes(12, 48),
  recordingId: "rec-harness",
  audioMs: minutes(12, 48),
  elapsedMs: minutes(12, 48),
  transcription: PRIVATE_CLOUD_ON,
  transcriber: {
    id: "private-cloud",
    identifySpeakers: false,
    source: "recording",
  },
  noteStatus: "ready",
  sheetOpen: true,
};

const SNAPSHOT: AudioInputsSnapshot = {
  inputs: [
    { id: "mac", name: "MacBook Pro Microphone", kind: "built_in" },
    { id: "airpods", name: "AirPods Pro", kind: "bluetooth" },
    { id: "usb", name: "USB Audio", kind: "usb" },
  ],
  selectedId: "mac",
  activeId: "mac",
};

export const INPUTS: NonNullable<DesktopRecorderSeed["inputs"]> = {
  list: async () => SNAPSHOT,
  select: async () => {},
  subscribe: () => noop,
};

const MODEL_READY: OnDeviceSttStatus = {
  models: [
    {
      id: "parakeet-tdt-0.6b-v3-int8",
      state: "ready",
      bytes: 1,
      totalBytes: 1,
      error: null,
    },
  ],
  pack: "full",
  autoDownload: true,
  download: { policy: "wifi", state: "idle" },
  engine: "parakeet",
  appleSpeech: "ready",
  queue: [],
};

export const ON_DEVICE_STT: OnDeviceSttPlugin = {
  status: async () => MODEL_READY,
  setAutoDownload: async () => {},
  downloadNow: async () => {},
  cancelDownload: async () => {},
  deleteModels: async () => {},
  enqueue: async () => {},
  cancel: async () => {},
  addListener: async () => ({ remove: async () => {} }),
};

export function Frame({
  seed,
  recorder,
  start = false,
}: {
  seed: DesktopRecorderSeed;
  recorder?: Partial<RecorderValue>;
  start?: boolean;
}) {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  return (
    <DesktopRecorderSeedContext.Provider value={seed}>
      <ShellApp
        platform={platform}
        shim={shim}
        state="ready"
        recorder={recorder}
        finalRecorder
        inside={
          start ? <StartRecording /> : null
        }
      />
    </DesktopRecorderSeedContext.Provider>
  );
}

function screen(
  id: string,
  value: Partial<RecorderValue>,
  seed: DesktopRecorderSeed = {},
  platform: HarnessScreen["platform"] = "tauri",
  notes?: Partial<NotesUiFields>,
): HarnessScreen {
  return {
    id: `recorder-final-desktop-${id}`,
    group: "recorder",
    layout: "pane",
    displayTitle: false,
    path: "/chat/capture",
    platform,
    render: () => {
      __setOnDeviceSttForTests(ON_DEVICE_STT);
      clearNotesUi();
      if (notes) updateNotesUi("rec-harness", () => notes);
      return (
        <Frame
          seed={{ inputs: INPUTS, ...seed }}
          recorder={{ subscribeLevel: steadyLevel, ...LIVE, ...value }}
        />
      );
    },
  };
}

// The real recorder over the fake native plugin, with each control call recorded for the test.
export function installNativePlugin(): VoiceNotesPlugin {
  const log = (window.exoDesktop ??= { calls: [] });
  const fake = createFakeVoiceNotes();
  const plugin: VoiceNotesPlugin = { ...fake.plugin };
  for (const name of ["pause", "resume", "stop", "discard"] as const) {
    const call = fake.plugin[name].bind(fake.plugin) as () => Promise<unknown>;
    (plugin as unknown as Record<string, () => Promise<unknown>>)[name] =
      async () => {
        log.calls.push(name);
        return call();
      };
  }
  __setVoiceNotesForTests(plugin, { available: true });
  return plugin;
}

// Starts a recording once the provider is ready and leaves the ring view open.
function StartRecording() {
  const recorder = useRecorder();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    if (!recorder.ready || recorder.phase !== "idle") return;
    started.current = true;
    recorder.record();
  }, [recorder]);
  return null;
}

const interactiveScreen: HarnessScreen = {
  id: "recorder-final-desktop-interactive",
  group: "recorder",
  layout: "pane",
  displayTitle: false,
  path: "/chat/capture",
  platform: "tauri",
  interactive: true,
  render: () => {
    installNativePlugin();
    __setOnDeviceSttForTests(ON_DEVICE_STT);
    return <Frame seed={{ inputs: INPUTS }} start />;
  },
};

const NOTE_MD = [
  "# Sync with Hunter",
  "",
  "- **0:08** Hunter mentions the TTL setting",
  "- **0:20** Decision: ship the cache behind a flag",
  "",
  "Follow-ups:",
  "",
  "- [ ] Send the **benchmark** numbers",
  "- [ ] Write up the _rollout_ plan",
].join("\n");
const NOTED: Partial<RecorderValue> = {
  note: { md: NOTE_MD, moments: [] },
  noteStatus: "ready",
};

// The note view is drawn at desktop layouts only; the phone viewports show the phone recorder's notes sheet instead.
const NOTE_VIEWPORTS = ["tablet", "tablet-land", "desktop-min", "desktop", "text200-desktop"];

export const recorderFinalDesktopScreens: HarnessScreen[] = [
  interactiveScreen,
  screen("recording", {}),
  screen("recording-web", {}, {}, "web"),
  screen("recording-notes", {
    note: { md: "Ask Dana about the launch date.", moments: [] },
  }),
  screen("paused", { mic: { state: "paused", reason: "user" } }),
  screen("interrupted", {
    mic: { state: "needs_user", reason: "resume_not_allowed" },
  }),
  screen(
    "silenced",
    { mic: { state: "silenced", reason: "no_signal" } },
    { silencedSinceMs: FROZEN_NOW - 6000 },
  ),
  screen("countdown", {
    elapsedMs: minutes(170, 12),
    audioMs: minutes(170, 12),
    startedAt: FROZEN_NOW - minutes(170, 12),
  }),
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
  {
    ...screen("note-write", NOTED, {}, "tauri", { open: true, view: "write" }),
    viewports: NOTE_VIEWPORTS,
    readyWhen: ".nv textarea",
  },
  {
    ...screen("note-preview", NOTED, {}, "tauri", { open: true, view: "preview" }),
    viewports: NOTE_VIEWPORTS,
    readyWhen: ".nv .fmd",
  },
  {
    ...screen("note-save-failed", NOTED, {}, "tauri", {
      open: true,
      view: "write",
      saveFailed: true,
    }),
    viewports: NOTE_VIEWPORTS,
    readyWhen: ".nv .nv-err",
  },
  {
    ...screen("note-loading", { noteStatus: "loading", note: null }, {}, "tauri", {
      open: true,
      view: "write",
    }),
    viewports: NOTE_VIEWPORTS,
    readyWhen: ".nv .pr-nwait",
  },
  screen("modes", {}, { defaultOpen: "modes" }),
  screen("via", {}, { defaultOpen: "via" }),
  screen("discard", {}, { defaultOpen: "discard" }),
];
