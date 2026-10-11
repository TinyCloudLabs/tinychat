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
    expect(guide.reason).toBe("Downloading the model: 50% of 602 MB");
    expect(guide.action).toBeUndefined();
  });

  test("a model the phone is still verifying says so and offers nothing to press", () => {
    const guide = localModelGuide(status({}, { state: "checking" }), download().download);
    expect(guide).toEqual({ reason: "Checking the downloaded model…" });
  });

  test("a failed model says why and offers the download again", () => {
    const guide = localModelGuide(status({}, { state: "failed", error: "disk full" }), download().download);
    expect(guide.reason).toBe("Couldn't download the model: disk full");
    expect(guide.action?.label).toBe("Try the download again");
  });

  test("a failed download state is not 'not downloaded'", () => {
    const guide = localModelGuide(status({ download: { policy: "wifi", state: "failed" } }), download().download);
    expect(guide.reason).toBe("Couldn't download the model");
    expect(guide.action).toBeDefined();
  });

  test("a download that could not start shows that reason, with Try again", () => {
    const guide = localModelGuide(status(), download("Could not start the download: no network plugin").download);
    expect(guide.reason).toBe("Could not start the download: no network plugin");
    expect(guide.action?.label).toBe("Try the download again");
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
    expect(waitingForModelSentence(model, guide)).toBe("Transcribe on this phone — needs a 602 MB download");
    expect(modelActionLabel(guide.action!)).toBe("Get model");
  });

  test("with no size known it still names what is needed", () => {
    const model = status({}, { totalBytes: 0 });
    model.models[1]!.totalBytes = 0;
    expect(waitingForModelSentence(model, localModelGuide(model, download().download))).toBe("Transcribe on this phone — needs the on-device model");
  });

  test("a download underway, a failure or a pause is the guide's own line, and a retry keeps its label", () => {
    const running = status({ download: { policy: "wifi", state: "running" } }, { state: "downloading", bytes: 301 * MB });
    expect(waitingForModelSentence(running, localModelGuide(running, download().download))).toBe("Downloading the model: 50% of 602 MB");
    const failed = localModelGuide(status(), download("No space left").download);
    expect(waitingForModelSentence(status(), failed)).toBe("No space left");
    expect(modelActionLabel(failed.action!)).toBe("Try the download again");
    const checking = status({}, { state: "checking" });
    expect(waitingForModelSentence(checking, localModelGuide(checking, download().download))).toBe("Checking the downloaded model…");
  });
});
