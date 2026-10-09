import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import type { VoiceNoteTranscriptionProps } from "../transcriptionProps";
import type {
  RecorderTranscriberId,
  SetTranscriberResult,
  TranscriberApi,
} from "./transcriberApiStub";
import {
  PRIVATE_UNAVAILABLE,
  SIGNED_OUT,
  SPEAKERS_NEEDS_CONSENT,
  TRANSCRIBER_FOR,
  useTranscriptionChoice,
} from "./useTranscriptionChoice";

const noop = () => {};
const transcription = (
  patch: Partial<VoiceNoteTranscriptionProps> = {},
): VoiceNoteTranscriptionProps => ({
  availability: "available",
  consented: true,
  maxSeconds: 600,
  jobs: new Map(),
  onTranscribe: noop,
  onConsent: noop,
  onTurnOff: noop,
  onRecheck: noop,
  ...patch,
});

const MODEL: OnDeviceSttStatus = {
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

type Call = [string, ...unknown[]];

function fakeApi(
  id: RecorderTranscriberId,
  result: SetTranscriberResult | Error = "ok",
  speakers: SetTranscriberResult | Error = "ok",
) {
  const calls: Call[] = [];
  const api: TranscriberApi = {
    transcriber: { id, identifySpeakers: false, source: "recording" },
    setTranscriber: async (next, options) => {
      calls.push(["setTranscriber", next, options]);
      if (result instanceof Error) throw result;
      return result;
    },
    setIdentifySpeakers: async (on, scope) => {
      calls.push(["setIdentifySpeakers", on, scope]);
      if (speakers instanceof Error) throw speakers;
      return speakers;
    },
  };
  return { api, calls };
}

function choice(
  props: VoiceNoteTranscriptionProps | undefined,
  api: TranscriberApi,
  model: OnDeviceSttStatus | null = MODEL,
) {
  const notices: string[] = [];
  let result!: ReturnType<typeof useTranscriptionChoice>;
  function Probe() {
    result = useTranscriptionChoice({
      shell: "phone",
      transcription: props,
      model,
      transcriber: api,
      notify: (message) => void notices.push(message),
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return { result, notices };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useTranscriptionChoice", () => {
  test("the scale has Skip, Local, Private and Powerful; Powerful is disabled", () => {
    const { result } = choice(transcription(), fakeApi("private-cloud").api);
    expect(result.stops.map((s) => s.stop.id)).toEqual([
      "skip",
      "local",
      "private",
      "powerful",
    ]);
    const powerful = result.stops.find((s) => s.stop.id === "powerful")!;
    expect(powerful.available).toBe(false);
    expect(powerful.reason).toBe("Coming with the next update");
  });

  test("the displayed mode is always the provider's transcriber, whatever else is stored or consented", () => {
    for (const [mode, id] of Object.entries(TRANSCRIBER_FOR)) {
      for (const consented of [true, false]) {
        const { result } = choice(
          transcription({ consented }),
          fakeApi(id).api,
        );
        expect(result.mode).toBe(mode as typeof result.mode);
      }
    }
  });

  test("Private is offered only when the account offers it", () => {
    const { result } = choice(
      transcription({
        availability: "unavailable",
      } as Partial<VoiceNoteTranscriptionProps>),
      fakeApi("on-device").api,
    );
    const privateStop = result.stops.find((s) => s.stop.id === "private")!;
    expect(privateStop.available).toBe(false);
    expect(privateStop.reason).toBe(PRIVATE_UNAVAILABLE);
  });

  test("choosing an unavailable stop returns why and asks the provider for nothing", async () => {
    const { api, calls } = fakeApi("private-cloud");
    const { result } = choice(transcription(), api);
    expect(result.select("powerful")).toBe("Coming with the next update");
    await settle();
    expect(calls).toEqual([]);
  });

  test("stepping skips unavailable stops and stops at the ends", () => {
    const { result } = choice(transcription(), fakeApi("private-cloud").api);
    expect(result.step(1)).toBe("private");
    expect(result.step(-1)).toBe("local");
  });

  test("each stop asks for its transcriber for this recording only", async () => {
    for (const [mode, id] of [
      ["skip", "off"],
      ["local", "on-device"],
    ] as const) {
      const { api, calls } = fakeApi("private-cloud");
      const { result } = choice(transcription(), api);
      expect(result.select(mode)).toBeNull();
      await settle();
      expect(calls).toEqual([["setTranscriber", id, { scope: "recording" }]]);
    }
    const { api, calls } = fakeApi("on-device");
    const { result } = choice(transcription(), api);
    expect(result.select("private")).toBeNull();
    await settle();
    expect(calls).toEqual([
      ["setTranscriber", "private-cloud", { scope: "recording" }],
    ]);
  });

  test("Skip is the provider's off, and never the legacy route's onTurnOff", async () => {
    let off = 0;
    const { api, calls } = fakeApi("private-cloud");
    const { result } = choice(
      transcription({ onTurnOff: () => void off++ }),
      api,
    );
    result.select("skip");
    await settle();
    expect(calls).toEqual([["setTranscriber", "off", { scope: "recording" }]]);
    expect(off).toBe(0);
  });

  test("choosing the mode already shown asks for nothing", async () => {
    const { api, calls } = fakeApi("off");
    const { result } = choice(transcription(), api);
    expect(result.select("skip")).toBeNull();
    await settle();
    expect(calls).toEqual([]);
  });

  test("needs_consent does not touch the route until the user agrees", async () => {
    let consents = 0;
    const { api, calls } = fakeApi("on-device", "needs_consent");
    const { result, notices } = choice(
      transcription({ consented: false, onConsent: () => void consents++ }),
      api,
    );
    result.select("private");
    await settle();
    expect(calls).toHaveLength(1);
    expect(consents).toBe(0);
    expect(notices).toEqual([]);
  });

  test("Identify speakers asks for this recording only", async () => {
    const { api, calls } = fakeApi("assemblyai");
    const { result } = choice(transcription(), api);
    await result.setIdentifySpeakers(true);
    expect(calls).toEqual([["setIdentifySpeakers", true, "recording"]]);
  });

  describe("a refused Identify speakers is shown and logged, and the switch stays with the provider", () => {
    const refused = async (result: SetTranscriberResult | Error) => {
      const logged = spyOn(console, "error").mockImplementation(() => {});
      const { api } = fakeApi("assemblyai", "ok", result);
      const { result: scale, notices } = choice(transcription(), api);
      await scale.setIdentifySpeakers(true);
      const errors = logged.mock.calls.map((call) => String(call[0]));
      logged.mockRestore();
      return { notices, errors, shown: scale.identifySpeakers };
    };

    test("each refusal gives a reason and one log", async () => {
      for (const [result, reason] of [
        ["needs_consent", SPEAKERS_NEEDS_CONSENT],
        ["locked_signed_out", SIGNED_OUT],
        ["unavailable", PRIVATE_UNAVAILABLE],
      ] as const) {
        const { notices, errors, shown } = await refused(result);
        expect(notices).toEqual([reason]);
        expect(errors).toHaveLength(1);
        expect(shown).toBe(false);
      }
    });

    test("a rejection is shown and logged with its reason", async () => {
      const { notices, errors } = await refused(new Error("plugin down"));
      expect(notices).toEqual([
        "Could not change Identify speakers: plugin down",
      ]);
      expect(errors).toEqual(["[Recorder] Could not change Identify speakers"]);
    });

    test("ok says nothing", async () => {
      const { notices, errors } = await refused("ok");
      expect(notices).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  describe("results and failures are shown and logged", () => {
    const failure = async (
      result: SetTranscriberResult | Error,
      id: "skip" | "private" = "skip",
    ) => {
      const logged = spyOn(console, "error").mockImplementation(() => {});
      const { api } = fakeApi("on-device", result);
      const { result: scale, notices } = choice(transcription(), api);
      scale.select(id);
      await settle();
      const errors = logged.mock.calls.map((call) => String(call[0]));
      logged.mockRestore();
      return { notices, errors };
    };

    test("unavailable: a toast, a log, and the selection stays with the provider", async () => {
      const { notices, errors } = await failure("unavailable");
      expect(notices).toEqual([PRIVATE_UNAVAILABLE]);
      expect(errors).toHaveLength(1);
    });

    test("locked_signed_out: says why", async () => {
      const { notices } = await failure("locked_signed_out");
      expect(notices).toEqual([SIGNED_OUT]);
    });

    test("a rejected request is shown and logged with its reason", async () => {
      const { notices, errors } = await failure(new Error("plugin down"));
      expect(notices).toEqual([
        "Could not change the transcription mode: plugin down",
      ]);
      expect(errors).toEqual([
        "[Recorder] Could not change the transcription mode",
      ]);
    });
  });
});
