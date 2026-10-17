import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSetting, setSetting, useLocalThreadStorage } from "../threadStore";
import { readDefaultUploadEngine, writeDefaultUploadEngine } from "../audioUpload";
import { RECORDING_SETTING_KEY } from "./recordingSettings";
import { attachRecordingSettingsSync, syncRecordingSettings } from "./recordingSettingsSync";
import { readStopAfterPreference, readTranscriberPreference, setStopAfterPreference } from "./transcriberPreference";

const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const space = (did = "did:pkh:eip155:1:0xme") => useLocalThreadStorage({ did } as unknown as TinyCloudWeb);

/** Each device has its own localStorage; the space is shared. */
function device(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, use: () => Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } }) };
}
const remoteDoc = async (tcw: TinyCloudWeb) => JSON.parse((await getSetting(tcw, RECORDING_SETTING_KEY)) ?? "null");

beforeEach(() => {
  // attach() listens to the page; a bare runtime has neither.
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" } });
  if (typeof globalThis.addEventListener !== "function") {
    Object.defineProperty(globalThis, "addEventListener", { configurable: true, value() {} });
    Object.defineProperty(globalThis, "removeEventListener", { configurable: true, value() {} });
  }
});
afterEach(() => {
  if (saved) Object.defineProperty(globalThis, "localStorage", saved);
  else Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "document");
});

test("a per-device Stop-after seeds the space, a second device adopts it, and an unset key never overwrites", async () => {
  const tcw = space();
  const phone = device({ "exo.voiceNotes.stopAfter": "30" });
  phone.use();
  await syncRecordingSettings(tcw);
  expect(await remoteDoc(tcw)).toMatchObject({ v: 1, stopAfter: "30" });
  expect(await remoteDoc(tcw)).not.toHaveProperty("uploadAudio");

  const laptop = device();
  laptop.use();
  expect(readStopAfterPreference()).toBe("60");
  await syncRecordingSettings(tcw);
  expect(readStopAfterPreference()).toBe("30");
  // The laptop set nothing else, so nothing else was written for it.
  expect(laptop.values.has("exo.voiceNotes.uploadAudio")).toBe(false);
  expect(await remoteDoc(tcw)).toMatchObject({ stopAfter: "30" });
});

test("an edit on one device reaches the space and the other device; the newest edit wins", async () => {
  const tcw = space();
  const phone = device();
  const laptop = device();
  phone.use();
  const detach = attachRecordingSettingsSync(tcw);
  setStopAfterPreference("15");
  // The edit queued its own sync; this one runs behind it.
  await syncRecordingSettings(tcw);
  detach();
  expect((await remoteDoc(tcw)).stopAfter).toBe("15");

  laptop.use();
  await syncRecordingSettings(tcw);
  expect(readStopAfterPreference()).toBe("15");
  writeDefaultUploadEngine("assemblyai");
  setStopAfterPreference("120");
  await syncRecordingSettings(tcw);
  expect(await remoteDoc(tcw)).toMatchObject({ stopAfter: "120", uploadEngine: "assemblyai" });

  phone.use();
  await syncRecordingSettings(tcw);
  expect(readStopAfterPreference()).toBe("120");
  expect(readDefaultUploadEngine()).toBe("assemblyai");
});

test("offline: a failed sync leaves the cache and the pending edit, and the next sync pushes it", async () => {
  const phone = device();
  phone.use();
  const did = "did:pkh:eip155:1:0xme";
  const offline = Object.defineProperty({ did }, "sql", { get() { throw new Error("offline"); } }) as unknown as TinyCloudWeb;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  setStopAfterPreference("15");
  await expect(syncRecordingSettings(offline)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
  expect(readStopAfterPreference()).toBe("15");
  expect(JSON.parse(phone.values.get("exo.voiceNotes.recordingSettings.sync")!).dirty).toEqual(["stopAfter"]);

  const tcw = space(did);
  await syncRecordingSettings(tcw);
  expect((await remoteDoc(tcw)).stopAfter).toBe("15");
  expect(JSON.parse(phone.values.get("exo.voiceNotes.recordingSettings.sync")!).dirty).toEqual([]);
});

test("Powerful as the recording default stays on its device", async () => {
  const tcw = space();
  device({ "exo.voiceNotes.transcriber": "assemblyai", "exo.voiceNotes.stopAfter": "30" }).use();
  await syncRecordingSettings(tcw);
  expect(await remoteDoc(tcw)).not.toHaveProperty("transcriber");
  expect(readTranscriberPreference().transcriber).toBe("assemblyai");
});

test("a document from a newer app is left exactly as written", async () => {
  const tcw = space();
  const raw = JSON.stringify({ v: 2, updatedAt: 1, stopAfter: "15" });
  await setSetting(tcw, RECORDING_SETTING_KEY, raw);
  device({ "exo.voiceNotes.stopAfter": "30" }).use();
  await syncRecordingSettings(tcw);
  expect(await getSetting(tcw, RECORDING_SETTING_KEY)).toBe(raw);
  expect(readStopAfterPreference()).toBe("30");
});
