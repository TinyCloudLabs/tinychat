// PhoneRecorder still carries its own copy of this wiring (TC-881 and #204 are editing it); these tests pin
// that the hook gives the same outputs for the same recorder state, so PhoneRecorder can move onto it
// afterwards without a change in behaviour.
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { PlatformContext, type AppPlatform } from "@/lib/platform";
import {
  StaticRecorderProvider,
  type RecorderValue,
} from "../RecorderProvider";
import type { VoiceNoteTranscriptionProps } from "../transcriptionProps";
import { PhoneRecorder } from "./PhoneRecorder";
import { modeShortLabel } from "./transcriptionModes";
import {
  useFinalRecorderControls,
  type FinalRecorderControlsOptions,
} from "./useFinalRecorderControls";
import {
  SIGNED_OUT,
  type TranscriberApi,
} from "./useTranscriptionChoice";

const noop = () => {};
const PRIVATE_ON: VoiceNoteTranscriptionProps = {
  availability: "available",
  consented: true,
  maxSeconds: 600,
  jobs: new Map(),
  onTranscribe: noop,
  onConsent: noop,
  onTurnOff: noop,
  onRecheck: noop,
};

const LIVE: Partial<RecorderValue> = {
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: 1,
  audioMs: 768_000,
  elapsedMs: 768_000,
  transcription: PRIVATE_ON,
  transcriber: {
    id: "private-cloud",
    identifySpeakers: false,
    source: "recording",
  },
  sheetOpen: true,
};

const unescape = (text: string) =>
  text
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

interface Outputs {
  ring: string | null;
  pillDot: string | null;
  pillLabel: string | null;
  timer: string | null;
  status: string | null;
  modeName: string | null;
  selected: string | null;
  stops: { id: string; available: string }[];
  alerts: string[];
  discardDisabled: boolean | null;
  pauseLabel: string | null;
  pauseDisabled: boolean | null;
  doneDisabled: boolean | null;
  openSettings: boolean;
  mustSave: boolean;
  inputsMenu: boolean;
}

const tag = (html: string, pattern: RegExp) => html.match(pattern)?.[0] ?? null;
const disabled = (button: string | null) =>
  button === null ? null : / disabled=""/.test(button);

/** What PhoneRecorder's own wiring rendered. */
function readPhone(html: string): Outputs {
  const text = (pattern: RegExp) => {
    const found = html.match(pattern)?.[1];
    return found === undefined ? null : unescape(found);
  };
  return {
    ring: text(/data-testid="phone-recorder"[^>]*data-ring="([^"]*)"/),
    pillDot: text(/class="pr-dot" data-dot="([^"]*)"/),
    pillLabel: text(/class="pr-dot"[^>]*><\/span><span>([^<]*)<\/span>/),
    timer: text(/role="timer"[^>]*><span>([^<]*)<\/span>/),
    status: text(/data-testid="phone-recorder-status">([^<]*)</),
    modeName: text(/class="pr-mname soft-title">([^<]*)</),
    selected: text(/aria-valuetext="([^"]*)"/),
    stops: [...html.matchAll(/<[^>]*data-stop="(\w+)"[^>]*>/g)].map((m) => ({
      id: m[1]!,
      available: m[0].match(/data-available="(\w+)"/)![1]!,
    })),
    alerts: [...html.matchAll(/role="alert">([^<]*)</g)].map((m) =>
      unescape(m[1]!),
    ),
    discardDisabled: disabled(
      tag(html, /<button[^>]*aria-label="Discard recording"[^>]*>/),
    ),
    pauseLabel: text(
      /<button[^>]*class="pr-b"[^>]*aria-label="((?:Pause|Resume) recording)"/,
    ),
    pauseDisabled: disabled(
      tag(
        html,
        /<button[^>]*class="pr-b"[^>]*aria-label="(?:Pause|Resume) recording"[^>]*>/,
      ),
    ),
    doneDisabled: disabled(tag(html, /<button[^>]*class="pr-b main"[^>]*>/)),
    openSettings: html.includes("Open Settings"),
    mustSave: /class="pr-b main" data-emphasis="true"/.test(html),
    inputsMenu: html.includes('class="pr-src-wrap"'),
  };
}

type Controls = ReturnType<typeof useFinalRecorderControls>;

/** What the hook says for the same state, read the way PhoneRecorder lays it out. */
function readHook(controls: Controls): Outputs {
  const { view, choice, speakers } = controls;
  const resume = controls.resume;
  return {
    ring: view.ring,
    pillDot: view.pill.dot,
    pillLabel: view.pill.label,
    timer: view.timer.text,
    status: view.statusLine ?? "",
    modeName: modeShortLabel(
      choice.mode,
      choice.identifySpeakers && !speakers.disabled,
    ),
    selected: choice.stops.find((s) => s.stop.id === choice.mode)!.stop
      .shortName,
    stops: choice.stops.map((s) => ({
      id: s.stop.id,
      available: String(s.available),
    })),
    alerts: controls.alerts.map((a) => a.message),
    discardDisabled: controls.idleDenied
      ? null
      : !(view.controls.discard || controls.discardUnknown),
    pauseLabel: controls.denied
      ? null
      : resume
        ? "Resume recording"
        : "Pause recording",
    pauseDisabled: controls.denied
      ? null
      : !(resume || view.controls.pause),
    doneDisabled: controls.idleDenied
      ? null
      : !(view.controls.stop || controls.stopUnknown),
    openSettings: controls.idleDenied || view.controls.openSettings,
    mustSave: controls.mustSave,
    inputsMenu: !controls.idleDenied && !controls.audio.unsupported,
  };
}

interface Rendered {
  phone: Outputs;
  hook: Outputs;
  controls: Controls;
}

function render(
  patch: Partial<RecorderValue>,
  platform: AppPlatform = "ios",
  options: Partial<FinalRecorderControlsOptions> = {},
): Rendered {
  const value = { ...LIVE, ...patch };
  const wrap = (child: React.ReactNode) => (
    <MemoryRouter>
      <PlatformContext.Provider value={platform}>
        <StaticRecorderProvider value={value}>{child}</StaticRecorderProvider>
      </PlatformContext.Provider>
    </MemoryRouter>
  );
  const phone = readPhone(
    renderToStaticMarkup(
      wrap(
        <PhoneRecorder
          inputs={options.inputs}
          transcriberApi={options.transcriberApi}
        />,
      ),
    ),
  );
  let controls!: Controls;
  function Probe() {
    controls = useFinalRecorderControls({
      notify: options.notify ?? noop,
      inputs: options.inputs,
      transcriberApi: options.transcriberApi,
    });
    return null;
  }
  renderToStaticMarkup(wrap(<Probe />));
  return { phone, hook: readHook(controls), controls };
}

const STATES: [string, Partial<RecorderValue>][] = [
  ["recording", {}],
  [
    "paused",
    { mic: { state: "paused", reason: "user" } },
  ],
  [
    "silenced",
    { mic: { state: "silenced", reason: "no_signal" } },
  ],
  [
    "interrupted",
    { mic: { state: "needs_user", reason: "resume_not_allowed" } },
  ],
  [
    "microphone revoked while recording",
    { mic: { state: "needs_user", reason: "permission_revoked" } },
  ],
  [
    "microphone denied at idle",
    {
      phase: "idle",
      mic: { state: "idle", reason: null },
      permissionDenied: true,
      startedAt: null,
      audioMs: 0,
      elapsedMs: 0,
    },
  ],
  [
    "countdown near the limit",
    {
      startedAt: 1,
      audioMs: 170 * 60_000 + 12_000,
      elapsedMs: 170 * 60_000 + 12_000,
    },
  ],
  ["a rejected control", { error: "Pause did not go through" }],
  [
    "a stop whose outcome is unknown",
    { phase: "stopping", error: "Could not tell if the note was saved" },
  ],
  [
    "a discard whose outcome is unknown",
    { phase: "discarding", error: "Could not tell if it was discarded" },
  ],
  ["private cloud not offered", { transcription: undefined }],
  [
    "signed out",
    {
      signedIn: false,
      transcriber: {
        id: "on-device",
        identifySpeakers: false,
        source: "default",
      },
    },
  ],
  [
    "Audio only",
    {
      transcriber: { id: "off", identifySpeakers: false, source: "recording" },
    },
  ],
  [
    "Powerful with Identify speakers",
    {
      transcriber: {
        id: "assemblyai",
        identifySpeakers: true,
        source: "recording",
      },
    },
  ],
  [
    "Private with Identify speakers",
    {
      transcriber: {
        id: "private-cloud",
        identifySpeakers: true,
        source: "recording",
      },
    },
  ],
];

describe("useFinalRecorderControls gives PhoneRecorder's outputs", () => {
  for (const [name, patch] of STATES) {
    test(`${name}`, () => {
      const { phone, hook } = render(patch);
      expect(hook).toEqual(phone);
    });
  }

  for (const platform of ["ios", "android", "tauri", "web"] as const) {
    test(`the scale's stops on ${platform}`, () => {
      for (const patch of [{}, { signedIn: false }, { transcription: undefined }]) {
        const { phone, hook } = render(patch, platform);
        expect(hook.stops).toEqual(phone.stops);
        expect(hook.selected).toBe(phone.selected);
        expect(hook.modeName).toBe(phone.modeName);
      }
    });
  }

  test("a transcriber API passed in replaces the provider's, as PhoneRecorder's prop does", () => {
    const api: TranscriberApi = {
      transcriber: {
        id: "assemblyai",
        identifySpeakers: true,
        source: "recording",
      },
      setTranscriber: async () => "ok",
      setIdentifySpeakers: async () => "ok",
    };
    const { phone, hook, controls } = render({}, "ios", {
      transcriberApi: api,
    });
    expect(hook).toEqual(phone);
    expect(controls.choice.mode).toBe("powerful");
    expect(controls.choice.identifySpeakers).toBe(true);
  });
});

describe("useFinalRecorderControls talks to the provider's transcriber API", () => {
  test("choosing a stop asks the provider for this recording", () => {
    const setTranscriber = mock(async () => "ok" as const);
    const { controls } = render({ setTranscriber });
    expect(controls.actions.choose("skip")).toBeNull();
    expect(setTranscriber).toHaveBeenCalledWith("off", { scope: "recording" });
  });

  test("Identify speakers goes to the provider for this recording", async () => {
    const setIdentifySpeakers = mock(async () => "ok" as const);
    const { controls } = render({ setIdentifySpeakers });
    await controls.choice.setIdentifySpeakers(true);
    expect(setIdentifySpeakers).toHaveBeenCalledWith(true, "recording");
  });

  test("signed out, only Local can be chosen and the refusal is the reason", () => {
    const setTranscriber = mock(async () => "ok" as const);
    const notify = mock((_message: string) => {});
    const { controls } = render({ signedIn: false, setTranscriber }, "ios", {
      notify,
    });
    expect(controls.actions.choose("private")).toBe(SIGNED_OUT);
    expect(notify).toHaveBeenCalledWith(SIGNED_OUT);
    expect(setTranscriber).not.toHaveBeenCalled();
  });
});
