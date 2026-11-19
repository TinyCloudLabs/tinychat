import { afterEach, describe, expect, test } from "bun:test";
import { LOCAL_WHISPER_MODELS } from "@/lib/localTranscriber";
import {
  getDesktopCaptureExtras,
  readCallNamesState,
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
    expect((await fake.extras.models.list()).find((m) => m.id === "QuantizedSmall")).toMatchObject({
      downloaded: true,
      downloading: false,
      progress: null,
    });
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

describe("the fake, downloads", () => {
  const row = async (fake: ReturnType<typeof createFakeDesktopCaptureExtras>, id: string) =>
    (await fake.extras.models.list()).find((m) => m.id === id);

  test("list reports a download in flight and its progress", async () => {
    const fake = createFakeDesktopCaptureExtras({ downloading: { QuantizedBase: 0.25 } });
    expect(await row(fake, "QuantizedBase")).toMatchObject({
      downloaded: false,
      downloading: true,
      progress: 0.25,
    });
    fake.emitProgress("QuantizedBase", 0.5);
    expect((await row(fake, "QuantizedBase"))?.progress).toBe(0.5);
  });

  test("an external download ends with a terminal event, and only then is the model on disk", async () => {
    const fake = createFakeDesktopCaptureExtras();
    const events: string[] = [];
    fake.extras.models.onProgress((p) => events.push(`${p.id}:${p.status}`));
    fake.startExternalDownload("QuantizedBase", 0.1);
    expect((await row(fake, "QuantizedBase"))?.downloading).toBe(true);
    fake.finishDownload("QuantizedBase");
    expect(events).toEqual(["QuantizedBase:done"]);
    expect(await row(fake, "QuantizedBase")).toMatchObject({ downloaded: true, downloading: false });
  });

  test("failDownload emits an error event carrying the message, then rejects download()", async () => {
    const fake = createFakeDesktopCaptureExtras();
    const events: { status: string; error?: string }[] = [];
    fake.extras.models.onProgress((p) => events.push({ status: p.status, error: p.error }));
    const done = fake.extras.models.download("QuantizedSmall");
    fake.failDownload("QuantizedSmall", "Disk full");
    await expect(done).rejects.toThrow("Disk full");
    expect(events).toEqual([{ status: "error", error: "Disk full" }]);
    expect(await row(fake, "QuantizedSmall")).toMatchObject({ downloaded: false, downloading: false });
  });
});

describe("the fake's names in the call", () => {
  test("is absent unless asked for, like a build without it", () => {
    expect(createFakeDesktopCaptureExtras().extras.callNames).toBeUndefined();
  });

  test("is off with permission missing by default; turning it on does not grant the permission", async () => {
    const fake = createFakeDesktopCaptureExtras({ callNames: {} });
    const callNames = fake.extras.callNames!;
    expect(await callNames.get()).toEqual({ enabled: false, permission: "missing" });
    await callNames.set(true);
    expect(await callNames.get()).toEqual({ enabled: true, permission: "missing" });
    fake.setCallNamesPermission("granted");
    expect(await callNames.get()).toEqual({ enabled: true, permission: "granted" });
    await callNames.openSettings();
    expect(fake.calls).toEqual(["callNames.get", "callNames.set:true", "callNames.get", "callNames.get", "callNames.openSettings"]);
  });

  test("hands over what each recording's reader stored, until it is cleared", async () => {
    const people = { v: 1, source: "call_window", app: "zoom", truncated: false, people: [{ id: "p1", name: "Alex" }] };
    const fake = createFakeDesktopCaptureExtras({ callNames: { read: { "rec-1": people } } });
    const callNames = fake.extras.callNames!;
    expect(await callNames.read("rec-1")).toEqual(people);
    expect(await callNames.read("rec-2")).toBeNull();
    await callNames.clear("rec-1");
    expect(await callNames.read("rec-1")).toBeNull();
    expect(fake.callNamesRead("rec-1")).toBeUndefined();
    fake.failNext("callNames.read", "reader busy");
    await expect(callNames.read("rec-1")).rejects.toThrow("reader busy");
  });
});

describe("readCallNamesState", () => {
  test("accepts only a boolean and one of the three permissions", () => {
    expect(readCallNamesState({ enabled: true, permission: "granted" })).toEqual({ enabled: true, permission: "granted" });
    expect(readCallNamesState({ enabled: false, permission: "missing", extra: 1 })).toEqual({ enabled: false, permission: "missing" });
    expect(readCallNamesState({ enabled: false, permission: "unsupported" })).toEqual({ enabled: false, permission: "unsupported" });
    for (const answer of [null, undefined, "granted", 1, [], { enabled: "yes", permission: "granted" }, { enabled: true },
      { enabled: true, permission: "maybe" }, { permission: "granted" }])
      expect(readCallNamesState(answer)).toBeNull();
  });
});
