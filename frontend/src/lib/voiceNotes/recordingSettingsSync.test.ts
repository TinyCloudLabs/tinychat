import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSetting, setSetting, useLocalThreadStorage } from "../threadStore";
import * as threadStore from "../threadStore";
import { readDefaultUploadEngine, writeDefaultUploadEngine } from "../audioUpload";
import { DEFAULT_STOP_AFTER, RECORDING_FIELDS, RECORDING_SETTING_KEY } from "./recordingSettings";
import { attachRecordingSettingsSync, syncRecordingSettings } from "./recordingSettingsSync";
import { adoptSyncedFields, readStopAfterPreference, readTranscriberPreference, setDefaultIdentifySpeakers, setDefaultTranscriber, setStopAfterPreference } from "./transcriberPreference";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests } from "./nativeVoiceNotes";
import { __resetAccountsForTests, takeCacheFor } from "./recordingSettingsLocal";

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
  // The preferences also live in module memory for storage-less runs: leave the defaults for later test files.
  __resetAccountsForTests();
  setStopAfterPreference(DEFAULT_STOP_AFTER);
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

test("per-device values survive a sync untouched, and only synced fields are read from or written to the document", async () => {
  const tcw = space(ACCOUNT_A);
  const consent = { [`exo.voiceNotes.privateCloudConsent:${ACCOUNT_A}`]: "2", [`exo.voiceNotes.powerfulConsent:${ACCOUNT_A}`]: "1" };
  const local = { "exo.voiceNotes.transcriber": "assemblyai", "exo.voiceNotes.uploadAudio": "1", "exo_recorder.microphone": "usb", "exo_recorder.systemAudioV2": "0", "exo_recorder.selectedModel": "base" };
  await setSetting(tcw, RECORDING_SETTING_KEY, JSON.stringify({ v: 1, updatedAt: 5, transcriber: "private-cloud", identifySpeakers: false, mic: "x", consent: true }));
  const phone = device({ ...consent, ...local });
  phone.use();
  setStopAfterPreference("30");
  await syncRecordingSettings(tcw);
  await syncRecordingSettings(tcw);
  // Powerful mode, consents, mic, Mac audio and local model are exactly as they were.
  for (const [key, value] of Object.entries({ ...consent, ...local })) expect(phone.values.get(key)).toBe(value);
  // What reached the document is only synced fields (plus the keys another app version put there, kept as found).
  const written = await remoteDoc(tcw);
  const synced = new Set<string>(["v", "updatedAt", ...RECORDING_FIELDS, "mic", "consent"]);
  expect(Object.keys(written).filter((key) => !synced.has(key))).toEqual([]);
  expect(written).toMatchObject({ transcriber: "private-cloud", stopAfter: "30", uploadAudio: true, mic: "x", consent: true });
});

const ACCOUNT_A = "did:pkh:eip155:1:0xaaa";
const ACCOUNT_B = "did:pkh:eip155:1:0xbbb";

test("another account on the same device never sees the first account's values and never uploads them", async () => {
  const spaceA = space(ACCOUNT_A);
  const spaceB = space(ACCOUNT_B);
  const shared = device({ "exo.voiceNotes.stopAfter": "30", "exo.voiceNotes.uploadAudio": "1", "exo.transcriber.uploadEngine": "assemblyai" });
  shared.use();
  // Tab 1 is signed in as A, syncs, then signs out.
  attachRecordingSettingsSync(spaceA)();
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
    await adoptSyncedFields({ transcriber: "off" }, () => true);
    expect(phone.values.get("exo.voiceNotes.transcriber")).toBe("off");
    expect(phone.values.has("exo.voiceNotes.identifySpeakers")).toBe(false);
    expect(phone.values.has("exo.voiceNotes.uploadAudio")).toBe(false);

    setStopAfterPreference("15");
    await adoptSyncedFields({ stopAfter: "120", transcriber: "private-cloud" }, () => true);
    expect(readStopAfterPreference()).toBe("15");
    expect(phone.values.get("exo.voiceNotes.transcriber")).toBe("private-cloud");
  } finally {
    // The engine-backed defaults also live in module memory; put them back while the engine is still installed.
    await setDefaultTranscriber("on-device");
    await setDefaultIdentifySpeakers(true);
    __setVoiceNotesForTests(null, { available: null });
  }
});

/** Lets the microtasks that reach `reached` run; the tests hold the engine or the space open at a known point. */
async function until(reached: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !reached(); turn++) await Promise.resolve();
  expect(reached()).toBe(true);
}

test("two tabs, two accounts: a cycle waiting on the space never writes what the other account just edited", async () => {
  const spaceA = space(ACCOUNT_A);
  const spaceB = space(ACCOUNT_B);
  device().use();
  const gate = Promise.withResolvers<void>();
  let entered = false;
  const original = threadStore.getSetting;
  const spy = spyOn(threadStore, "getSetting").mockImplementationOnce(async (tcw, key) => {
    entered = true;
    await gate.promise;
    return original(tcw, key);
  });
  try {
    const detachA = attachRecordingSettingsSync(spaceA);
    await until(() => entered);
    // The other tab signs in as B and edits; A's tab is still attached and still waiting on its read.
    const detachB = attachRecordingSettingsSync(spaceB);
    setStopAfterPreference("15");
    gate.resolve();
    await syncRecordingSettings(spaceB);
    await syncRecordingSettings(spaceA);
    detachA();
    detachB();
    expect(await remoteDoc(spaceA)).toBeNull();
  } finally {
    spy.mockRestore();
  }
});

test("an adopt still in the engine when the account changes writes nothing for the new account", async () => {
  const spaceA = space(ACCOUNT_A);
  const spaceB = space(ACCOUNT_B);
  await setSetting(spaceA, RECORDING_SETTING_KEY, JSON.stringify({ v: 1, updatedAt: 5, transcriber: "off" }));
  const shared = device();
  shared.use();
  const fake = createFakeVoiceNotes();
  const gate = Promise.withResolvers<void>();
  let entered = false;
  const plugin = { ...fake.plugin, getCaptureDefaults: async () => {
    if (!entered) { entered = true; await gate.promise; }
    return fake.plugin.getCaptureDefaults();
  } };
  __setVoiceNotesForTests(plugin, { available: true });
  try {
    const detachA = attachRecordingSettingsSync(spaceA);
    await until(() => entered);
    detachA();
    const detachB = attachRecordingSettingsSync(spaceB);
    // B edits on the cache while A's adopt is still inside the engine: the cache is B's now.
    setStopAfterPreference("15");
    gate.resolve();
    await syncRecordingSettings(spaceB);
    detachB();
    // A's adopted mode never reached this device's cache for B, and B's space got only what B chose.
    expect(shared.values.get("exo.voiceNotes.transcriber")).toBeUndefined();
    expect(await remoteDoc(spaceB)).toEqual({ v: 1, updatedAt: expect.any(Number), stopAfter: "15" });
    expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("on-device");
  } finally {
    await setDefaultTranscriber("on-device");
    await setDefaultIdentifySpeakers(true);
    __setVoiceNotesForTests(null, { available: null });
  }
});

test("an edit in a tab that missed another tab's sign-in as a different account never carries that account's values", async () => {
  const spaceA = space(ACCOUNT_A);
  // Each read of the clock is later than the last, so the edit is newer than the first sync by construction.
  let clock = 1_000_000;
  const now = spyOn(Date, "now").mockImplementation(() => (clock += 10));
  const shared = device({ "exo.voiceNotes.stopAfter": "30" });
  shared.use();
  // Tab 1 is signed in as A and has synced.
  const detachA = attachRecordingSettingsSync(spaceA);
  await syncRecordingSettings(spaceA);
  // Tab 2 (same localStorage) signs in as B and leaves B's choices in the cache; tab 1 never hears about it.
  expect(takeCacheFor(ACCOUNT_B)).toBe(true);
  shared.values.set("exo.voiceNotes.transcriber", "private-cloud");
  shared.values.set("exo.transcriber.uploadEngine", "assemblyai");
  shared.values.set("exo.voiceNotes.uploadAudio", "1");
  // Tab 1's user edits Stop recording after.
  setStopAfterPreference("15");
  await syncRecordingSettings(spaceA);
  detachA();
  now.mockRestore();
  expect(await remoteDoc(spaceA)).toEqual({ v: 1, updatedAt: expect.any(Number), stopAfter: "15" });
  expect(shared.values.has("exo.voiceNotes.transcriber")).toBe(false);
  expect(shared.values.has("exo.transcriber.uploadEngine")).toBe(false);
});

test("an engine write still in flight when another tab hands the cache to a different account never lands on its values", async () => {
  const spaceA = space(ACCOUNT_A);
  const shared = device();
  shared.use();
  const fake = createFakeVoiceNotes();
  const gate = Promise.withResolvers<void>();
  let entered = false;
  const plugin = { ...fake.plugin, getCaptureDefaults: async () => {
    if (!entered) { entered = true; await gate.promise; }
    return fake.plugin.getCaptureDefaults();
  } };
  __setVoiceNotesForTests(plugin, { available: true });
  try {
    const detachA = attachRecordingSettingsSync(spaceA);
    await syncRecordingSettings(spaceA);
    // A's user picks a mode; the engine write is held open.
    const edit = setDefaultTranscriber("off");
    await until(() => entered);
    // Another tab signs in as B and leaves B's choices in the cache.
    expect(takeCacheFor(ACCOUNT_B)).toBe(true);
    shared.values.set("exo.voiceNotes.stopAfter", "120");
    shared.values.set("exo.transcriber.uploadEngine", "assemblyai");
    gate.resolve();
    await edit;
    await syncRecordingSettings(spaceA);
    detachA();
    const doc = await remoteDoc(spaceA);
    expect(doc).toMatchObject({ transcriber: "off" });
    expect(doc).not.toHaveProperty("stopAfter");
    expect(doc).not.toHaveProperty("uploadEngine");
  } finally {
    await setDefaultTranscriber("on-device");
    await setDefaultIdentifySpeakers(true);
    __setVoiceNotesForTests(null, { available: null });
  }
});

test("a signed-out edit in a tab belongs to the account that tab was signed in as, never to one another tab signed in", async () => {
  const spaceA = space(ACCOUNT_A);
  const shared = device({ "exo.voiceNotes.stopAfter": "30" });
  shared.use();
  attachRecordingSettingsSync(spaceA)();
  await syncRecordingSettings(spaceA);
  // Another tab signs in as B and leaves its choices; this tab is signed out and its user edits.
  expect(takeCacheFor(ACCOUNT_B)).toBe(true);
  shared.values.set("exo.transcriber.uploadEngine", "assemblyai");
  setStopAfterPreference("15");
  expect(JSON.parse(shared.values.get("exo.voiceNotes.recordingSettings.sync")!).owner).toBe(ACCOUNT_A);
  expect(shared.values.has("exo.transcriber.uploadEngine")).toBe(false);
});
