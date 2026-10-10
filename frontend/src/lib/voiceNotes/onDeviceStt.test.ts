// isOnDeviceReady mirrors TranscriptionQueue.pump()'s exact readiness gate on both platforms:
// the RAM-tier's primary parakeet model ready, and Silero VAD ready.
import { describe, expect, test } from "bun:test";
import { isOnDeviceReady, type OnDeviceSttStatus } from "./onDeviceStt";
import { onDeviceModelLine } from "./onDeviceSttStore";

function status(patch: Partial<OnDeviceSttStatus> = {}): OnDeviceSttStatus {
  return {
    models: [],
    pack: "small",
    autoDownload: false,
    download: { policy: "wifi", state: "idle" },
    engine: "parakeet",
    appleSpeech: "unsupported",
    queue: [],
    ...patch,
  };
}

function model(id: OnDeviceSttStatus["models"][number]["id"], state: OnDeviceSttStatus["models"][number]["state"]) {
  return { id, bytes: 0, totalBytes: 0, error: null, state };
}

describe("isOnDeviceReady", () => {
  test("true once the RAM tier's primary model and Silero VAD are both ready", () => {
    expect(isOnDeviceReady(status({
      pack: "small",
      models: [model("parakeet-tdt-110m-en-int8", "ready"), model("silero-vad", "ready")],
    }))).toBe(true);
  });

  test("false when the primary model isn't ready, even if VAD is", () => {
    expect(isOnDeviceReady(status({
      pack: "small",
      models: [model("parakeet-tdt-110m-en-int8", "downloading"), model("silero-vad", "ready")],
    }))).toBe(false);
  });

  test("false when Silero VAD isn't ready, even if the primary model is", () => {
    expect(isOnDeviceReady(status({
      pack: "small",
      models: [model("parakeet-tdt-110m-en-int8", "ready"), model("silero-vad", "downloading")],
    }))).toBe(false);
  });

  test("false when a model entry is missing entirely", () => {
    expect(isOnDeviceReady(status({ pack: "small", models: [model("parakeet-tdt-110m-en-int8", "ready")] }))).toBe(false);
  });

  test("checks the full-pack model id on a full-RAM-tier device, not the small one", () => {
    const bothReady = [model("parakeet-tdt-0.6b-v3-int8", "ready"), model("parakeet-tdt-110m-en-int8", "ready"), model("silero-vad", "ready")];
    expect(isOnDeviceReady(status({ pack: "full", models: bothReady }))).toBe(true);
    expect(isOnDeviceReady(status({
      pack: "full",
      models: [model("parakeet-tdt-0.6b-v3-int8", "absent"), model("parakeet-tdt-110m-en-int8", "ready"), model("silero-vad", "ready")],
    }))).toBe(false);
  });

  test("false when no model is ready at all (engine none)", () => {
    expect(isOnDeviceReady(status({ engine: "none", models: [] }))).toBe(false);
  });

  test("apple-speech path (if ever wired) is ready purely from appleSpeech, independent of the parakeet models", () => {
    expect(isOnDeviceReady(status({ engine: "apple-speech", appleSpeech: "ready", models: [] }))).toBe(true);
    expect(isOnDeviceReady(status({ engine: "apple-speech", appleSpeech: "asset_missing", models: [] }))).toBe(false);
  });
});

describe("a model the phone is still verifying after launch", () => {
  const checking = status({
    pack: "small",
    models: [model("parakeet-tdt-110m-en-int8", "checking"), model("silero-vad", "checking")],
  });

  test("is not ready, and is described as being checked rather than as missing or downloading", () => {
    expect(isOnDeviceReady(checking)).toBe(false);
    expect(onDeviceModelLine(checking)).toEqual({ text: "Checking the downloaded model…", percent: null });
  });
});
