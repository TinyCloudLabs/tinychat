import { afterEach, describe, expect, test } from "bun:test";
import { LOCAL_WHISPER_MODELS } from "@/lib/localTranscriber";
import {
  getDesktopCaptureExtras,
  registerDesktopCaptureExtras,
} from "./desktopCaptureExtras";
import { createFakeDesktopCaptureExtras } from "./fakeDesktopCaptureExtras";

afterEach(() => registerDesktopCaptureExtras(null));

describe("getDesktopCaptureExtras", () => {
  test("is null until something registers one: the app never falls back to the fake", () => {
    expect(getDesktopCaptureExtras()).toBeNull();
    const { extras } = createFakeDesktopCaptureExtras();
    registerDesktopCaptureExtras(extras);
    expect(getDesktopCaptureExtras()).toBe(extras);
  });
});

describe("the fake", () => {
  test("lists every Whisper model with the sizes the app quotes", async () => {
    const { extras } = createFakeDesktopCaptureExtras({
      downloaded: ["QuantizedLargeTurbo"],
      selected: "QuantizedLargeTurbo",
    });
    const models = await extras.models.list();
    expect(models.map((m) => m.id)).toEqual(LOCAL_WHISPER_MODELS.map((m) => m.id));
    const turbo = models.find((m) => m.id === "QuantizedLargeTurbo");
    expect(turbo).toMatchObject({ sizeBytes: 874_000_000, downloaded: true, selected: true });
    expect(models.filter((m) => m.downloaded)).toHaveLength(1);
    expect(await extras.models.get()).toBe("QuantizedLargeTurbo");
  });

  test("select rejects a model that is not downloaded", async () => {
    const { extras } = createFakeDesktopCaptureExtras();
    await expect(extras.models.select("QuantizedTiny")).rejects.toThrow(
      "not downloaded",
    );
  });

  test("a download reports progress, then makes the model selectable", async () => {
    const fake = createFakeDesktopCaptureExtras();
    const seen: number[] = [];
    const off = fake.extras.models.onProgress((p) => seen.push(p.fraction));
    const done = fake.extras.models.download("QuantizedSmall");
    fake.emitProgress("QuantizedSmall", 0.4);
    off();
    fake.emitProgress("QuantizedSmall", 0.8);
    fake.finishDownload("QuantizedSmall");
    await done;
    expect(seen).toEqual([0.4]);
    await fake.extras.models.select("QuantizedSmall");
    expect(await fake.extras.models.get()).toBe("QuantizedSmall");
  });

  test("a download can fail, and an unknown one cannot be settled", async () => {
    const fake = createFakeDesktopCaptureExtras();
    const done = fake.extras.models.download("QuantizedBase");
    fake.failDownload("QuantizedBase", "Network lost");
    await expect(done).rejects.toThrow("Network lost");
    expect(() => fake.finishDownload("QuantizedBase")).toThrow("No download in flight");
  });

  test("failNext fails one call, once", async () => {
    const fake = createFakeDesktopCaptureExtras();
    fake.failNext("systemAudio.set", "Permission refused");
    await expect(fake.extras.systemAudio.set(true)).rejects.toThrow("Permission refused");
    await fake.extras.systemAudio.set(true);
    expect(await fake.extras.systemAudio.get()).toBe(true);
    expect(fake.calls).toEqual(["systemAudio.set:true", "systemAudio.set:true", "systemAudio.get"]);
  });
});
