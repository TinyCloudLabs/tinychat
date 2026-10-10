// The final phone recorder (TC-867) wired to a recorder that remembers what it is asked to do, for
// test/recorder-final-phone.e2e.test.ts to drive. Not captured: the states are the ones in
// recorderFinalPhone.tsx. The page exposes `window.exoRecorder`: the calls in order, a patch for the
// recorder's state, and the flags that make its plugins fail.
import { useEffect, useMemo, useRef, useState } from "react";
import { TranscriptionRouteControl } from "@/capture/recorder/TranscriptionRouteControl";
import { clearNotesUi } from "@/capture/recorder/final/notes";
import { useHarnessNote } from "../harnessNote";
import { PhoneRecorder } from "@/capture/recorder/final/PhoneRecorder";
import type { TranscriberApi } from "@/capture/recorder/final/useTranscriptionChoice";
import type { SetTranscriberResult } from "@/capture/recorder/voiceNoteRecorderController";
import type { TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { AudioInputsSnapshot } from "@/capture/recorder/final/useAudioInputs";
import {
  RecorderProvider,
  StaticRecorderProvider,
  useRecorder,
  type RecorderValue,
} from "@/capture/recorder/RecorderProvider";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import {
  __setOnDeviceSttForTests,
  type OnDeviceSttPlugin,
  type OnDeviceSttStatus,
} from "@/lib/voiceNotes/onDeviceStt";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import {
  __setVoiceNotesForTests,
  type VoiceNotesPlugin,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { FROZEN_NOW, harnessSessionStore, harnessTcw } from "../stubs";
import type { HarnessScreen } from "../screen";

declare global {
  interface Window {
    exoRecorder?: {
      calls: string[];
      patch: (patch: Partial<RecorderValue>) => void;
      /** Plugin calls that reject while their flag is set (all of them on the failing screen). */
      fail: Record<"openSettings" | "listInputs" | "modelStatus", boolean>;
      /** What the provider answers to the next setTranscriber calls (null: decide as it would). */
      transcriberResult: SetTranscriberResult | null;
      /** The provider's transcriber changes from outside this screen. */
      patchTranscriber: (patch: Partial<RecorderValue["transcriber"]>) => void;
    };
    /** The default recorder's route control over a provider that can be told to reject. */
    exoRoute?: {
      calls: string[];
      rejectSetter: boolean;
      rejectConsent: boolean;
    };
    /** The real recorder over the fake native plugin: the control calls in order, and the ones that reject while flagged. */
    /** The notes screen's recorder: the control calls in order. */
    exoNotes?: { calls: string[] };
    exoNative?: {
      calls: string[];
      fail: Record<"pause" | "resume" | "stop" | "discard", boolean>;
    };
  }
}

const SNAPSHOT: AudioInputsSnapshot = {
  inputs: [
    { id: "phone", name: "iPhone Microphone", kind: "built_in" },
    { id: "airpods", name: "AirPods Pro", kind: "bluetooth" },
  ],
  selectedId: "phone",
  activeId: "phone",
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

const minutes = (m: number) => m * 60_000;

interface Setup {
  consented: boolean;
  /** The transcriber the provider starts with. */
  transcriber: TranscriberId;
  /** Starts with every plugin call rejecting. */
  failing: boolean;
}

function Interactive({
  consented: consentedAtStart,
  transcriber: transcriberAtStart,
  failing,
}: Setup) {
  const [consented, setConsented] = useState(consentedAtStart);
  const [transcriber, setTranscriber] = useState<RecorderValue["transcriber"]>({
    id: transcriberAtStart,
    identifySpeakers: false,
    source: "recording",
  });
  const consentedNow = useRef(consented);
  consentedNow.current = consented;
  const [state, setState] = useState<Partial<RecorderValue>>({
    phase: "recording",
    mic: { state: "recording", reason: null },
    startedAt: FROZEN_NOW - minutes(12),
    recordingId: "rec-harness",
    audioMs: minutes(12),
    elapsedMs: minutes(12),
    sheetOpen: true,
  });

  const log = useMemo(() => {
    const api = (window.exoRecorder ??= {
      calls: [],
      patch: () => {},
      fail: {
        openSettings: failing,
        listInputs: failing,
        modelStatus: failing,
      },
      transcriberResult: null,
      patchTranscriber: () => {},
    });
    return api;
  }, []);
  log.patch = (patch) => setState((current) => ({ ...current, ...patch }));
  log.patchTranscriber = (patch) =>
    setTranscriber((current) => ({ ...current, ...patch }));

  // The provider's transcriber API, over this screen's state.
  const transcriberApi: TranscriberApi = {
    transcriber,
    setTranscriber: async (id, { scope }) => {
      log.calls.push(`transcriber:${id}:${scope}`);
      if (log.transcriberResult !== null) {
        if (log.transcriberResult === "locked_signed_out")
          setTranscriber((current) => ({ ...current, id: "on-device" }));
        return log.transcriberResult;
      }
      if (id === "private-cloud" && !consentedNow.current)
        return "needs_consent";
      setTranscriber((current) => ({ ...current, id }));
      return "ok";
    },
    setIdentifySpeakers: async (on, scope) => {
      log.calls.push(`identifySpeakers:${on}:${scope}`);
      setTranscriber((current) => ({ ...current, identifySpeakers: on }));
      return "ok";
    },
  };

  const transcription: VoiceNoteTranscriptionProps = {
    availability: "available",
    consented,
    maxSeconds: 600,
    jobs: new Map(),
    onTranscribe: () => {},
    onConsent: () => {
      log.calls.push("consent");
      setConsented(true);
    },
    onTurnOff: () => {
      log.calls.push("turnOff");
      setConsented(false);
    },
    onRecheck: () => {},
  };

  const value = useMemo<Partial<RecorderValue>>(
    () => ({
      ...state,
      transcription,
      subscribeLevel: (listener) => {
        listener(0.15);
        const timer = setInterval(() => listener(0.15), 100);
        return () => clearInterval(timer);
      },
      pause: () => {
        log.calls.push("pause");
        setState((current) => ({
          ...current,
          mic: { state: "paused", reason: "user" },
        }));
      },
      resume: () => {
        log.calls.push("resume");
        setState((current) => ({
          ...current,
          mic: { state: "recording", reason: null },
        }));
      },
      stop: () => log.calls.push("stop"),
      discard: () => log.calls.push("discard"),
      minimiseSheet: async () => void log.calls.push("minimise"),
      openSettings: async () => {
        log.calls.push("openSettings");
        if (log.fail.openSettings) throw new Error("Settings would not open");
      },
    }),
    [state, consented, failing],
  );

  const inputs = useMemo(
    () => ({
      list: async () => {
        if (log.fail.listInputs)
          throw new Error("The input list is unavailable");
        return SNAPSHOT;
      },
      select: async (id: string | null) => void log.calls.push(`select:${id}`),
      subscribe: () => () => {},
    }),
    [failing],
  );

  return (
    <StaticRecorderProvider value={value}>
      <PhoneRecorder inputs={inputs} transcriberApi={transcriberApi} />
    </StaticRecorderProvider>
  );
}

// The real provider and controller on the fake native plugin, whose Pause, Resume, Stop and Discard
// reject while window.exoNative.fail says so: the errors reach the screen as they do on a phone.
function Starter() {
  const recorder = useRecorder();
  const started = useRef(false);
  useEffect(() => {
    if (!recorder.ready || recorder.phase !== "idle" || started.current) return;
    started.current = true;
    recorder.record();
  }, [recorder]);
  return null;
}

function Native() {
  const inputs = useMemo(
    () => ({
      list: async () => SNAPSHOT,
      select: async () => {},
      subscribe: () => () => {},
    }),
    [],
  );
  return (
    <RecorderProvider tcw={harnessTcw} sessionStore={harnessSessionStore}>
      <Starter />
      <PhoneRecorder inputs={inputs} />
    </RecorderProvider>
  );
}

function installNativePlugin() {
  const native = (window.exoNative ??= {
    calls: [],
    fail: { pause: false, resume: false, stop: false, discard: false },
  });
  const fake = createFakeVoiceNotes();
  const plugin: VoiceNotesPlugin = { ...fake.plugin };
  for (const name of ["pause", "resume", "stop", "discard"] as const) {
    const call = fake.plugin[name].bind(fake.plugin) as () => Promise<unknown>;
    (plugin as unknown as Record<string, () => Promise<unknown>>)[name] =
      async () => {
        native.calls.push(name);
        if (native.fail[name]) {
          throw Object.assign(new Error(`${name} was refused`), {
            code: `${name}_refused`,
          });
        }
        return call();
      };
  }
  __setVoiceNotesForTests(plugin, { available: true });
}

function screen(name: string, setup: Setup): HarnessScreen {
  return {
    id: `recorder-final-phone-interactive-${name}`,
    group: "recorder",
    layout: "pane",
    platform: "ios",
    displayTitle: false,
    interactive: true,
    render: () => {
      __setOnDeviceSttForTests({
        status: async () => {
          if (window.exoRecorder?.fail.modelStatus)
            throw new Error("The model check failed");
          return MODEL_READY;
        },
        setAutoDownload: async () => {},
        downloadNow: async () => {},
        cancelDownload: async () => {},
        deleteModels: async () => {},
        enqueue: async () => {},
        cancel: async () => {},
        addListener: async () => ({ remove: async () => {} }),
      } satisfies OnDeviceSttPlugin);
      return <Interactive {...setup} />;
    },
  };
}

function RouteControl() {
  const control = (window.exoRoute ??= {
    calls: [],
    rejectSetter: false,
    rejectConsent: false,
  });
  const [consented, setConsented] = useState(false);
  const [transcriber, setTranscriber] = useState<RecorderValue["transcriber"]>({
    id: "on-device",
    identifySpeakers: false,
    source: "recording",
  });
  const transcription: VoiceNoteTranscriptionProps = {
    availability: "available",
    consented,
    maxSeconds: 600,
    jobs: new Map(),
    onTranscribe: () => {},
    onConsent: () => {
      control.calls.push("consent");
      if (control.rejectConsent) throw new Error("Consent was not saved");
      setConsented(true);
    },
    onTurnOff: () => {},
    onRecheck: () => {},
  };
  return (
    <div className="p-4">
      <TranscriptionRouteControl
        transcription={transcription}
        signedIn
        recorder={{
          transcriber,
          setTranscriber: async (id) => {
            control.calls.push(`transcriber:${id}`);
            if (control.rejectSetter) throw new Error("Plugin is down");
            setTranscriber((current) => ({ ...current, id }));
            return "ok";
          },
        }}
      />
    </div>
  );
}

const routeControlScreen: HarnessScreen = {
  id: "recorder-final-phone-interactive-route-control",
  group: "recorder",
  layout: "pane",
  platform: "ios",
  displayTitle: false,
  interactive: true,
  render: () => {
    __setOnDeviceSttForTests({
      status: async () => MODEL_READY,
      setAutoDownload: async () => {},
      downloadNow: async () => {},
      cancelDownload: async () => {},
      deleteModels: async () => {},
      enqueue: async () => {},
      cancel: async () => {},
      addListener: async () => ({ remove: async () => {} }),
    } satisfies OnDeviceSttPlugin);
    return <RouteControl />;
  },
};

// 0:42 in, the note in the screen's own memory, and a Discard that only logs.
function Notes() {
  useState(clearNotesUi);
  const note = useHarnessNote(null, 42_000);
  const value = useMemo<Partial<RecorderValue>>(() => {
    const notes = (window.exoNotes ??= { calls: [] });
    return {
      phase: "recording",
      mic: { state: "recording", reason: null },
      startedAt: FROZEN_NOW - 42_000,
      recordingId: "rec-harness",
      audioMs: 42_000,
      elapsedMs: 42_000,
      sheetOpen: true,
      subscribeLevel: (listener) => {
        listener(0.15);
        return () => {};
      },
      pause: () => void notes.calls.push("pause"),
      resume: () => void notes.calls.push("resume"),
      stop: () => void notes.calls.push("stop"),
      discard: () => void notes.calls.push("discard"),
    };
  }, []);
  // The note half changes with every write; the rest is fixed.
  const withNote = useMemo(() => ({ ...value, ...note }), [value, note]);
  return (
    <StaticRecorderProvider value={withNote}>
      <PhoneRecorder inputs={NOTES_INPUTS} />
    </StaticRecorderProvider>
  );
}

const NOTES_INPUTS = {
  list: async () => SNAPSHOT,
  select: async () => {},
  subscribe: () => () => {},
};

const notesScreen: HarnessScreen = {
  id: "recorder-final-phone-interactive-notes",
  group: "recorder",
  layout: "pane",
  platform: "ios",
  displayTitle: false,
  interactive: true,
  render: () => {
    __setOnDeviceSttForTests({
      status: async () => MODEL_READY,
      setAutoDownload: async () => {},
      downloadNow: async () => {},
      cancelDownload: async () => {},
      deleteModels: async () => {},
      enqueue: async () => {},
      cancel: async () => {},
      addListener: async () => ({ remove: async () => {} }),
    } satisfies OnDeviceSttPlugin);
    return <Notes />;
  },
};

const nativeScreen: HarnessScreen = {
  id: "recorder-final-phone-interactive-native",
  group: "recorder",
  layout: "pane",
  platform: "ios",
  displayTitle: false,
  interactive: true,
  render: () => {
    installNativePlugin();
    __setOnDeviceSttForTests({
      status: async () => MODEL_READY,
      setAutoDownload: async () => {},
      downloadNow: async () => {},
      cancelDownload: async () => {},
      deleteModels: async () => {},
      enqueue: async () => {},
      cancel: async () => {},
      addListener: async () => ({ remove: async () => {} }),
    } satisfies OnDeviceSttPlugin);
    return <Native />;
  },
};

export const recorderFinalPhoneInteractiveScreens: HarnessScreen[] = [
  nativeScreen,
  routeControlScreen,
  notesScreen,
  screen("consented", {
    consented: true,
    transcriber: "private-cloud",
    failing: false,
  }),
  screen("first-run", {
    consented: false,
    transcriber: "off",
    failing: false,
  }),
  screen("failing", {
    consented: true,
    transcriber: "private-cloud",
    failing: true,
  }),
];
