import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSetting, setSetting, useLocalThreadStorage } from "../threadStore";
import { readDefaultUploadEngine, writeDefaultUploadEngine } from "../audioUpload";
import { RECORDING_SETTING_KEY } from "./recordingSettings";
import { attachRecordingSettingsSync, syncRecordingSettings } from "./recordingSettingsSync";
import { adoptSyncedFields, readStopAfterPreference, readTranscriberPreference, setStopAfterPreference } from "./transcriberPreference";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests } from "./nativeVoiceNotes";

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

test("a device that picked Powerful keeps it when the document holds a synced mode", async () => {
  const tcw = space();
  await setSetting(tcw, RECORDING_SETTING_KEY, JSON.stringify({ v: 1, updatedAt: 5, transcriber: "private-cloud", stopAfter: "120" }));
  const phone = device({ "exo.voiceNotes.transcriber": "assemblyai" });
  phone.use();
  await syncRecordingSettings(tcw);
  expect(phone.values.get("exo.voiceNotes.transcriber")).toBe("assemblyai");
  expect(readStopAfterPreference()).toBe("120");
  expect(await remoteDoc(tcw)).toMatchObject({ transcriber: "private-cloud" });
});

const ACCOUNT_A = "did:pkh:eip155:1:0xaaa";
const ACCOUNT_B = "did:pkh:eip155:1:0xbbb";

test("another account on the same device never sees the first account's values and never uploads them", async () => {
  const spaceA = space(ACCOUNT_A);
  const spaceB = space(ACCOUNT_B);
  const shared = device({ "exo.voiceNotes.stopAfter": "30", "exo.voiceNotes.uploadAudio": "1", "exo.transcriber.uploadEngine": "assemblyai" });
  shared.use();
  await syncRecordingSettings(spaceA);
  expect(await remoteDoc(spaceA)).toMatchObject({ stopAfter: "30", uploadAudio: true, uploadEngine: "assemblyai" });

  // A signs out; a choice made while signed out stays attributed to A.
  setStopAfterPreference("15");
  expect(JSON.parse(shared.values.get("exo.voiceNotes.recordingSettings.sync")!).owner).toBe(ACCOUNT_A);

  // B signs in: A's values are gone from the cache before anything syncs, and B's space gets none of them.
  const detach = attachRecordingSettingsSync(spaceB);
  expect(readStopAfterPreference()).toBe("60");
  expect(readDefaultUploadEngine()).toBe("private-cloud");
  await syncRecordingSettings(spaceB);
  detach();
  expect(await remoteDoc(spaceB)).toBeNull();
  expect(shared.values.has("exo.voiceNotes.uploadAudio")).toBe(false);

  // B's first edit writes only what B edited.
  const again = attachRecordingSettingsSync(spaceB);
  setStopAfterPreference("120");
  await syncRecordingSettings(spaceB);
  again();
  expect(await remoteDoc(spaceB)).toEqual({ v: 1, updatedAt: expect.any(Number), stopAfter: "120" });
  // A's own document is untouched by any of it.
  expect(await remoteDoc(spaceA)).toMatchObject({ stopAfter: "30" });
});

test("signed out, or before there is a space, nothing is written to any space", async () => {
  const tcw = space(ACCOUNT_A);
  device().use();
  setStopAfterPreference("15");
  await syncRecordingSettings({} as TinyCloudWeb);
  expect(await remoteDoc(tcw)).toBeNull();
});

test("adopting one field leaves keys nobody set unset, and never replaces an edit still waiting to sync", async () => {
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    const phone = device();
    phone.use();
    await adoptSyncedFields({ transcriber: "off" });
    expect(phone.values.get("exo.voiceNotes.transcriber")).toBe("off");
    expect(phone.values.has("exo.voiceNotes.identifySpeakers")).toBe(false);
    expect(phone.values.has("exo.voiceNotes.uploadAudio")).toBe(false);

    setStopAfterPreference("15");
    await adoptSyncedFields({ stopAfter: "120", transcriber: "private-cloud" });
    expect(readStopAfterPreference()).toBe("15");
    expect(phone.values.get("exo.voiceNotes.transcriber")).toBe("private-cloud");
  } finally {
    __setVoiceNotesForTests(null, { available: null });
  }
});
