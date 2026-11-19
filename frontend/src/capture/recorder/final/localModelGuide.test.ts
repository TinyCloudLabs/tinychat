import { describe, expect, test } from "bun:test";
import type { OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import { localModelGuide, modelActionLabel, waitingForModelSentence } from "./localModelGuide";

const MB = 1024 * 1024;
const status = (patch: Partial<OnDeviceSttStatus> = {}, primary: Partial<OnDeviceSttStatus["models"][number]> = {}): OnDeviceSttStatus => ({
  models: [
    { id: "parakeet-tdt-0.6b-v3-int8", state: "absent", bytes: 0, totalBytes: 600 * MB, error: null, ...primary },
    { id: "silero-vad", state: "absent", bytes: 0, totalBytes: 2 * MB, error: null },
  ],
  pack: "full", autoDownload: false,
  download: { policy: "wifi", state: "idle" },
  engine: "none", appleSpeech: "unsupported", queue: [],
  ...patch,
});
const download = (error: string | null = null) => {
  const calls = { start: 0 };
  return { calls, download: { start: () => void calls.start++, error } };
};

describe("localModelGuide", () => {
  test("an absent model is an actionable control with the size, and it starts the download", () => {
    const { calls, download: d } = download();
    const guide = localModelGuide(status(), d);
    expect(guide.reason).toContain("602 MB");
    expect(guide.action?.label).toBe("Get the on-device model");
    guide.action!.run();
    expect(calls.start).toBe(1);
  });

  test("a running download shows its progress and offers nothing to press", () => {
    const guide = localModelGuide(
      status({ download: { policy: "wifi", state: "running" } }, { state: "downloading", bytes: 301 * MB }),
      download().download,
    );
    expect(guide.reason).toBe("Downloading on-device model · 50%");
    expect(guide.action).toBeUndefined();
  });

  test("a model the phone is still verifying says so and offers nothing to press", () => {
    const guide = localModelGuide(status({}, { state: "checking" }), download().download);
    expect(guide).toEqual({ reason: "Checking the on-device model…" });
  });

  test("a failed model says why and offers the download again", () => {
    const guide = localModelGuide(status({}, { state: "failed", error: "disk full" }), download().download);
    expect(guide.reason).toBe("Couldn't download the on-device model");
    expect(guide.action?.label).toBe("Try again");
  });

  test("a failed download state is not 'not downloaded'", () => {
    const guide = localModelGuide(status({ download: { policy: "wifi", state: "failed" } }), download().download);
    expect(guide.reason).toBe("Couldn't download the on-device model");
    expect(guide.action).toBeDefined();
  });

  test("a download that could not start shows that reason, with Try again", () => {
    const guide = localModelGuide(status(), download("Could not start the download: no network plugin").download);
    expect(guide.reason).toBe("Couldn't download the on-device model: Could not start the download: no network plugin");
    expect(guide.action?.label).toBe("Try again");
  });

  test("waiting for Wi-Fi and Low Data Mode say so", () => {
    expect(localModelGuide(status({ download: { policy: "wifi", state: "waiting_for_network" } }), download().download).reason).toContain("Waiting for Wi-Fi");
    expect(localModelGuide(status({ download: { policy: "wifi", state: "low_data_mode" } }), download().download).reason).toContain("Low Data Mode");
  });

  test("a ready model with the voice detector missing still gets the download", () => {
    const guide = localModelGuide(status({}, { state: "ready", bytes: 600 * MB }), download().download);
    expect(guide.action?.label).toBe("Get the on-device model");
  });

  test("without a status there is only the plain reason", () => {
    expect(localModelGuide(null, download().download)).toEqual({ reason: "Get the on-device model" });
  });
});

describe("the waiting-for-model copy", () => {
  test("a model not yet downloaded is one sentence with its size, and the control reads Get model", () => {
    const model = status();
    const guide = localModelGuide(model, download().download);
    expect(waitingForModelSentence(model, guide)).toBe("Transcribe on this browser — needs a 602 MB download");
    expect(modelActionLabel(guide.action!)).toBe("Get model");
  });

  test("with no size known it still names what is needed", () => {
    const model = status({}, { totalBytes: 0 });
    model.models[1]!.totalBytes = 0;
    expect(waitingForModelSentence(model, localModelGuide(model, download().download))).toBe("Transcribe on this browser — needs the on-device model");
  });

  test("a download underway, a failure or a pause is the guide's own line, and a retry keeps its label", () => {
    const running = status({ download: { policy: "wifi", state: "running" } }, { state: "downloading", bytes: 301 * MB });
    expect(waitingForModelSentence(running, localModelGuide(running, download().download))).toBe("Downloading on-device model · 50%");
    const failed = localModelGuide(status(), download("No space left").download);
    expect(waitingForModelSentence(status(), failed)).toBe("Couldn't download the on-device model: No space left");
    expect(modelActionLabel(failed.action!)).toBe("Try again");
    const checking = status({}, { state: "checking" });
    expect(waitingForModelSentence(checking, localModelGuide(checking, download().download))).toBe("Checking the on-device model…");
  });
});

describe("localModelGuide on iOS's built-in speech", () => {
  const apple = (appleSpeech: OnDeviceSttStatus["appleSpeech"], state: OnDeviceSttStatus["download"]["state"] = "idle"): OnDeviceSttStatus =>
    status({ engine: "apple-speech", appleSpeech, models: [], download: { policy: "system", state } });

  test("missing speech assets offer Get speech from iOS with no size, and it starts the install", () => {
    const { calls, download: d } = download();
    const guide = localModelGuide(apple("asset_missing"), d);
    expect(guide.reason).toBe("Speech from iOS isn't on this iPhone yet");
    expect(guide.reason).not.toContain("MB");
    expect(guide.action?.label).toBe("Get speech from iOS");
    guide.action!.run();
    expect(calls.start).toBe(1);
  });

  test("an install underway says so and offers nothing to press", () => {
    expect(localModelGuide(apple("asset_missing", "running"), download().download)).toEqual({ reason: "Getting speech from iOS…" });
  });

  test("a failed install says so and offers Try again", () => {
    const guide = localModelGuide(apple("asset_missing", "failed"), download().download);
    expect(guide.reason).toBe("Couldn't get speech from iOS");
    expect(guide.action?.label).toBe("Try again");
  });

  test("an iPhone or language iOS cannot do is a calm reason with nothing to press", () => {
    expect(localModelGuide(apple("unsupported"), download().download)).toEqual({ reason: "On-device transcription isn't available on this iPhone" });
    expect(localModelGuide(apple("locale_unsupported"), download().download)).toEqual({ reason: "On-device transcription doesn't support this language yet" });
  });
});
