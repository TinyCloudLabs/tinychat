import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import type { VoiceNoteTranscriptionProps } from "../transcriptionProps";
import { PRIVATE_UNAVAILABLE, useTranscriptionChoice, type TranscriptionChoiceStorage } from "./useTranscriptionChoice";

const noop = () => {};
const transcription = (patch: Partial<VoiceNoteTranscriptionProps> = {}): VoiceNoteTranscriptionProps => ({
  availability: "available", consented: true, maxSeconds: 600, jobs: new Map(),
  onTranscribe: noop, onConsent: noop, onTurnOff: noop, onRecheck: noop, ...patch,
});

const MODEL: OnDeviceSttStatus = {
  models: [{ id: "parakeet-tdt-0.6b-v3-int8", state: "ready", bytes: 1, totalBytes: 1, error: null }],
  pack: "full", autoDownload: true, download: { policy: "wifi", state: "idle" },
  engine: "parakeet", appleSpeech: "ready", queue: [],
};

const memory = (initial: Record<string, string> = {}): TranscriptionChoiceStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

function choice(props: VoiceNoteTranscriptionProps | undefined, storage = memory()) {
  let result!: ReturnType<typeof useTranscriptionChoice>;
  function Probe() {
    result = useTranscriptionChoice({ shell: "phone", transcription: props, model: MODEL, storage });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return { result, storage };
}

describe("useTranscriptionChoice", () => {
  test("the scale has Local, Private and Powerful while Skip is off; Powerful is disabled", () => {
    const { result } = choice(transcription());
    expect(result.stops.map((s) => s.stop.id)).toEqual(["local", "private", "powerful"]);
    const powerful = result.stops.find((s) => s.stop.id === "powerful")!;
    expect(powerful.available).toBe(false);
    expect(powerful.reason).toBe("Coming with the next update");
  });

  test("Private is offered only when the account offers it", () => {
    const { result } = choice(transcription({ availability: "unavailable" } as Partial<VoiceNoteTranscriptionProps>));
    const privateStop = result.stops.find((s) => s.stop.id === "private")!;
    expect(privateStop.available).toBe(false);
    expect(privateStop.reason).toBe(PRIVATE_UNAVAILABLE);
    expect(result.mode).not.toBe("powerful");
  });

  test("choosing an unavailable stop returns why and stores nothing", () => {
    const { result, storage } = choice(transcription());
    expect(result.select("powerful")).toBe("Coming with the next update");
    expect(storage.data).toEqual({});
  });

  test("stepping skips unavailable stops and stops at the ends", () => {
    const { result } = choice(transcription({ consented: true }), memory({ "exo.recorder.transcription-mode": "private" }));
    expect(result.mode).toBe("private");
    expect(result.step(1)).toBe("private");
    expect(result.step(-1)).toBe("local");
  });

  test("choosing Local with consent given turns the private route off and stores the choice", () => {
    let off = 0;
    const { result, storage } = choice(transcription({ onTurnOff: () => void off++ }), memory({ "exo.recorder.transcription-mode": "private" }));
    expect(result.select("local")).toBeNull();
    expect(off).toBe(1);
    expect(storage.data["exo.recorder.transcription-mode"]).toBe("local");
  });

  test("Private without consent waits on the consent step", () => {
    const { result, storage } = choice(transcription({ consented: false }), memory({ "exo.recorder.transcription-mode": "local" }));
    expect(result.select("private")).toBeNull();
    expect(storage.data["exo.recorder.transcription-mode"]).toBe("local");
  });
});
