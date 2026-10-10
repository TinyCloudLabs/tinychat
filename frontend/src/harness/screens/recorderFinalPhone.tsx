// The final phone recorder (TC-867) in each state, over a StaticRecorderProvider
// on the frozen clock. Night and Day come from the harness theme.
import {
  PhoneRecorder,
  type PhoneRecorderProps,
} from "@/capture/recorder/final/PhoneRecorder";
import type { AudioInputsSnapshot } from "@/capture/recorder/final/useAudioInputs";
import {
  StaticRecorderProvider,
  type RecorderValue,
} from "@/capture/recorder/RecorderProvider";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import {
  __setOnDeviceSttForTests,
  type OnDeviceSttPlugin,
  type OnDeviceSttStatus,
} from "@/lib/voiceNotes/onDeviceStt";
import { FROZEN_NOW } from "../stubs";
import type { HarnessScreen } from "../screen";

const noop = () => {};

// A steady moderate level, re-sent so the halo stays active (it goes quiet 450ms after the last sample).
const STEADY_LEVEL = 0.15;
const steadyLevel: RecorderValue["subscribeLevel"] = (listener) => {
  listener(STEADY_LEVEL);
  const timer = setInterval(() => listener(STEADY_LEVEL), 100);
  return () => clearInterval(timer);
};
const QUIET = [0];

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

const LIVE: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: FROZEN_NOW - minutes(12, 48),
  audioMs: minutes(12, 48),
  elapsedMs: minutes(12, 48),
  transcription: PRIVATE_CLOUD_ON,
  transcriber: {
    id: "private-cloud",
    identifySpeakers: false,
    source: "recording",
  },
  sheetOpen: true,
};

const SNAPSHOT: AudioInputsSnapshot = {
  inputs: [
    { id: "phone", name: "iPhone Microphone", kind: "built_in" },
    { id: "airpods", name: "AirPods Pro", kind: "bluetooth" },
    { id: "usb", name: "USB Audio", kind: "usb" },
  ],
  selectedId: "phone",
  activeId: "phone",
};

const INPUTS: NonNullable<PhoneRecorderProps["inputs"]> = {
  list: async () => SNAPSHOT,
  select: async () => {},
  subscribe: () => noop,
};

// The Android emulator's built-in mic and a headset with a name as long as they come, for the 320 px phone.
const LONG_SNAPSHOT: AudioInputsSnapshot = {
  inputs: [
    { id: "emulator", name: "sdk_gphone64_arm64", kind: "built_in" },
    {
      id: "headset",
      name: "Samuel's Pixel Buds Pro 2 Wireless Headset",
      kind: "bluetooth",
    },
  ],
  selectedId: "emulator",
  activeId: "emulator",
};

const LONG_INPUTS: NonNullable<PhoneRecorderProps["inputs"]> = {
  list: async () => LONG_SNAPSHOT,
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
    { id: "silero-vad", state: "ready", bytes: 1, totalBytes: 1, error: null },
  ],
  pack: "full",
  autoDownload: true,
  download: { policy: "wifi", state: "idle" },
  engine: "parakeet",
  appleSpeech: "ready",
  queue: [],
};

const ON_DEVICE_STT: OnDeviceSttPlugin = {
  status: async () => MODEL_READY,
  setAutoDownload: async () => {},
  downloadNow: async () => {},
  cancelDownload: async () => {},
  deleteModels: async () => {},
  enqueue: async () => {},
  cancel: async () => {},
  addListener: async () => ({ remove: async () => {} }),
};

function screen(
  id: string,
  value: Partial<RecorderValue>,
  props: PhoneRecorderProps = {},
  levels?: readonly number[],
): HarnessScreen {
  return {
    id: `recorder-final-phone-${id}`,
    group: "recorder",
    layout: "pane",
    platform: "ios",
    displayTitle: false,
    render: () => {
      __setOnDeviceSttForTests(ON_DEVICE_STT);
      return (
        <StaticRecorderProvider
          value={{
            ...LIVE,
            ...(levels ? {} : { subscribeLevel: steadyLevel }),
            ...value,
          }}
          levels={levels}
        >
          <PhoneRecorder inputs={INPUTS} {...props} />
        </StaticRecorderProvider>
      );
    },
  };
}

export const recorderFinalPhoneScreens: HarnessScreen[] = [
  screen("recording", {}),
  screen("paused", { mic: { state: "paused", reason: "user" } }, {}, QUIET),
  screen("modes", {}, { defaultOpen: "modes" }),
  screen("via", {}, { defaultOpen: "via" }),
  screen("discard", {}, { defaultOpen: "discard" }),
  screen("long-device", {}, { inputs: LONG_INPUTS }),
  screen("long-device-menu", {}, { inputs: LONG_INPUTS, defaultOpen: "via" }),
  screen(
    "long-device-paused",
    { mic: { state: "paused", reason: "user" } },
    { inputs: LONG_INPUTS },
    QUIET,
  ),
  screen(
    "stalled",
    { mic: { state: "interrupted", reason: "stalled" } },
    {},
    QUIET,
  ),
  screen(
    "needs-user",
    { mic: { state: "needs_user", reason: "resume_not_allowed" } },
    {},
    QUIET,
  ),
  screen(
    "mic-unavailable",
    { mic: { state: "needs_user", reason: "mic_unavailable" } },
    {},
    QUIET,
  ),
  screen(
    "write-failed",
    { mic: { state: "needs_user", reason: "write_failed" } },
    {},
    QUIET,
  ),
  screen(
    "revoked",
    {
      mic: { state: "needs_user", reason: "permission_revoked" },
      permissionDenied: true,
    },
    {},
    QUIET,
  ),
  screen(
    "silenced",
    { mic: { state: "silenced", reason: "no_signal" } },
    { silencedSinceMs: FROZEN_NOW - 6000 },
    QUIET,
  ),
  screen("countdown", {
    elapsedMs: minutes(170, 12),
    audioMs: minutes(170, 12),
    startedAt: FROZEN_NOW - minutes(170, 12),
  }),
  screen(
    "mic-denied",
    {
      phase: "idle",
      mic: { state: "idle", reason: null },
      permissionDenied: true,
      startedAt: null,
      audioMs: 0,
      elapsedMs: 0,
    },
    {},
    QUIET,
  ),
  screen(
    "saving",
    { phase: "saving", mic: { state: "idle", reason: null }, savePercent: 40 },
    {},
    QUIET,
  ),
];
