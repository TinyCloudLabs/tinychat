import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import * as threadStore from "../threadStore";
import { getSetting, setSetting, useLocalThreadStorage } from "../threadStore";
import { readDefaultUploadEngine, writeDefaultUploadEngine } from "../audioUpload";
import { DEFAULT_STOP_AFTER, RECORDING_FIELDS, RECORDING_SETTING_KEY, type StopAfter } from "./recordingSettings";
import { attachRecordingSettingsSync, syncRecordingSettings } from "./recordingSettingsSync";
import {
  adoptSyncedFields, readStopAfterPreference, readTranscriberPreference, readUploadAudioPreference, setDefaultIdentifySpeakers,
  setDefaultTranscriber, setStopAfterPreference, setUploadAudioPreference,
} from "./transcriberPreference";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests } from "./nativeVoiceNotes";
import { __resetActiveAccountForTests, readStored } from "./recordingSettingsLocal";

const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const ACCOUNT_A = "did:pkh:eip155:1:0xaaa";
const ACCOUNT_B = "did:pkh:eip155:1:0xbbb";
const space = (did = ACCOUNT_A) => useLocalThreadStorage({ did } as unknown as TinyCloudWeb);

/** One browser profile's localStorage, shared by every tab; the spaces are separate per account. */
function device(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, use: () => Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } }) };
}
const remoteDoc = async (tcw: TinyCloudWeb) => JSON.parse((await getSetting(tcw, RECORDING_SETTING_KEY)) ?? "null");
const cacheKeyOf = (account: string) => `exo.voiceNotes.recording:${account}`;
const cacheOf = (values: Map<string, string>, account: string) => JSON.parse(values.get(cacheKeyOf(account)) ?? "null");

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
  __resetActiveAccountForTests();
  setStopAfterPreference(DEFAULT_STOP_AFTER);
  if (saved) Object.defineProperty(globalThis, "localStorage", saved);
  else Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "document");
});

/** Signs this tab in as the account and syncs once; returns the sign-out. */
async function signIn(tcw: TinyCloudWeb): Promise<() => void> {
  const signOut = attachRecordingSettingsSync(tcw);
  await syncRecordingSettings(tcw);
  return signOut;
}

test("a per-device Stop-after seeds the first account's space once, a second device adopts it, and an unset key never overwrites", async () => {
  const tcw = space();
  const phone = device({ "exo.voiceNotes.stopAfter": "30" });
  phone.use();
  (await signIn(tcw))();
  expect(await remoteDoc(tcw)).toMatchObject({ v: 1, stopAfter: "30" });
  expect(await remoteDoc(tcw)).not.toHaveProperty("uploadAudio");
  // The values moved into the account's own cache; the device keys are gone, so no other account can take them.
  expect(phone.values.has("exo.voiceNotes.stopAfter")).toBe(false);
  expect(cacheOf(phone.values, ACCOUNT_A).stored).toEqual({ stopAfter: "30" });

  const laptop = device();
  laptop.use();
  const signOut = await signIn(tcw);
  expect(readStopAfterPreference()).toBe("30");
  // The laptop set nothing else, so nothing else was written for it.
  expect(cacheOf(laptop.values, ACCOUNT_A).stored).toEqual({ stopAfter: "30" });
  signOut();
});

test("an edit on one device reaches the space and the other device; the newest edit wins", async () => {
  const tcw = space();
  const phone = device();
  const laptop = device();
  phone.use();
  let signOut = await signIn(tcw);
  setStopAfterPreference("15");
  // The edit queued its own sync; this one runs behind it.
  await syncRecordingSettings(tcw);
  signOut();
  expect((await remoteDoc(tcw)).stopAfter).toBe("15");

  laptop.use();
  signOut = await signIn(tcw);
  expect(readStopAfterPreference()).toBe("15");
  writeDefaultUploadEngine("assemblyai");
  setStopAfterPreference("120");
  await syncRecordingSettings(tcw);
  signOut();
  expect(await remoteDoc(tcw)).toMatchObject({ stopAfter: "120", uploadEngine: "assemblyai" });

  phone.use();
  signOut = await signIn(tcw);
  expect(readStopAfterPreference()).toBe("120");
  expect(readDefaultUploadEngine()).toBe("assemblyai");
  signOut();
});

test("offline: a failed sync leaves the cache and the pending edit, and the next sync pushes it", async () => {
  const phone = device();
  phone.use();
  const offline = Object.defineProperty({ did: ACCOUNT_A }, "sql", { get() { throw new Error("offline"); } }) as unknown as TinyCloudWeb;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const signOut = attachRecordingSettingsSync(offline);
  setStopAfterPreference("15");
  await expect(syncRecordingSettings(offline)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
  expect(readStopAfterPreference()).toBe("15");
  expect(cacheOf(phone.values, ACCOUNT_A).dirty).toEqual(["stopAfter"]);
  signOut();

  const tcw = space();
  await syncRecordingSettings(tcw);
  expect((await remoteDoc(tcw)).stopAfter).toBe("15");
  expect(cacheOf(phone.values, ACCOUNT_A).dirty).toEqual([]);
});

test("a document from a newer app is left exactly as written", async () => {
  const tcw = space();
  const raw = JSON.stringify({ v: 2, updatedAt: 1, stopAfter: "15" });
  await setSetting(tcw, RECORDING_SETTING_KEY, raw);
  device({ "exo.voiceNotes.stopAfter": "30" }).use();
  const signOut = await signIn(tcw);
  expect(await getSetting(tcw, RECORDING_SETTING_KEY)).toBe(raw);
  expect(readStopAfterPreference()).toBe("30");
  signOut();
});

test("a device that picked Powerful keeps it when the document holds a synced mode", async () => {
  const tcw = space();
  await setSetting(tcw, RECORDING_SETTING_KEY, JSON.stringify({ v: 1, updatedAt: 5, transcriber: "private-cloud", stopAfter: "120" }));
  const phone = device({ "exo.voiceNotes.transcriber": "assemblyai" });
  phone.use();
  const signOut = await signIn(tcw);
  expect(readTranscriberPreference().transcriber).toBe("assemblyai");
  expect(readStopAfterPreference()).toBe("120");
  expect(await remoteDoc(tcw)).toMatchObject({ transcriber: "private-cloud" });
  signOut();
});

test("per-device values survive a sync untouched, and only synced fields are read from or written to the document", async () => {
  const tcw = space(ACCOUNT_A);
  const perDevice = {
    [`exo.voiceNotes.privateCloudConsent:${ACCOUNT_A}`]: "2", [`exo.voiceNotes.powerfulConsent:${ACCOUNT_A}`]: "1",
    "exo_recorder.microphone": "usb", "exo_recorder.systemAudioV2": "0", "exo_recorder.selectedModel": "base",
  };
  await setSetting(tcw, RECORDING_SETTING_KEY, JSON.stringify({ v: 1, updatedAt: 5, transcriber: "private-cloud", identifySpeakers: false, mic: "x", consent: true }));
  const phone = device({ ...perDevice, "exo.voiceNotes.transcriber": "assemblyai", "exo.voiceNotes.uploadAudio": "1" });
  phone.use();
  const signOut = attachRecordingSettingsSync(tcw);
  setStopAfterPreference("30");
  await syncRecordingSettings(tcw);
  await syncRecordingSettings(tcw);
  for (const [key, value] of Object.entries(perDevice)) expect(phone.values.get(key)).toBe(value);
  expect(readTranscriberPreference().transcriber).toBe("assemblyai");
  const written = await remoteDoc(tcw);
  const synced = new Set<string>(["v", "updatedAt", ...RECORDING_FIELDS, "mic", "consent"]);
  expect(Object.keys(written).filter((key) => !synced.has(key))).toEqual([]);
  expect(written).toMatchObject({ transcriber: "private-cloud", stopAfter: "30", uploadAudio: true, mic: "x", consent: true });
  signOut();
});

test("another account on the same device never sees the first account's values and never uploads them", async () => {
  const spaceA = space(ACCOUNT_A);
  const spaceB = space(ACCOUNT_B);
  const shared = device({ "exo.voiceNotes.stopAfter": "30", "exo.voiceNotes.uploadAudio": "1", "exo.transcriber.uploadEngine": "assemblyai" });
  shared.use();
  (await signIn(spaceA))();
  expect(await remoteDoc(spaceA)).toMatchObject({ stopAfter: "30", uploadAudio: true, uploadEngine: "assemblyai" });

  // B signs in on the same device: A's values are not B's to read, and B's space gets none of them.
  let signOut = await signIn(spaceB);
  expect(readStopAfterPreference()).toBe(DEFAULT_STOP_AFTER);
  expect(readUploadAudioPreference()).toBe(false);
  expect(readDefaultUploadEngine()).toBe("private-cloud");
  expect(await remoteDoc(spaceB)).toBeNull();
  setStopAfterPreference("120");
  await syncRecordingSettings(spaceB);
  expect(await remoteDoc(spaceB)).toEqual({ v: 1, updatedAt: expect.any(Number), stopAfter: "120" });
  signOut();

  // A's cache and A's space were never touched by any of it.
  expect(cacheOf(shared.values, ACCOUNT_A).stored).toEqual({ stopAfter: "30", uploadAudio: true, uploadEngine: "assemblyai" });
  expect(await remoteDoc(spaceA)).toMatchObject({ stopAfter: "30" });
  signOut = await signIn(spaceA);
  expect(readStopAfterPreference()).toBe("30");
  signOut();
});

test("a choice made while signed out stays on the device: an account that already has its cache never takes it", async () => {
  const spaceA = space(ACCOUNT_A);
  const shared = device({ "exo.voiceNotes.stopAfter": "30" });
  shared.use();
  (await signIn(spaceA))();
  // Signed out: the edit goes to the device's own keys.
  setStopAfterPreference("15");
  expect(shared.values.get("exo.voiceNotes.stopAfter")).toBe("15");
  expect(cacheOf(shared.values, ACCOUNT_A).stored).toEqual({ stopAfter: "30" });
  // A signs back in: its own cache is its own; the signed-out choice is not applied to it or written to its space.
  const signOut = await signIn(spaceA);
  expect(readStopAfterPreference()).toBe("30");
  expect(await remoteDoc(spaceA)).toMatchObject({ stopAfter: "30" });
  signOut();
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
    const tcw = space();
    const signOut = attachRecordingSettingsSync(tcw);
    await adoptSyncedFields(ACCOUNT_A, { transcriber: "off" });
    expect(cacheOf(phone.values, ACCOUNT_A).stored).toEqual({ transcriber: "off" });

    setStopAfterPreference("15");
    await adoptSyncedFields(ACCOUNT_A, { stopAfter: "120", transcriber: "private-cloud" });
    expect(readStopAfterPreference()).toBe("15");
    expect(cacheOf(phone.values, ACCOUNT_A).stored).toEqual({ transcriber: "private-cloud", stopAfter: "15" });
    signOut();
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

test("a cycle waiting on the space for account A is unaffected by B signing in and editing meanwhile", async () => {
  const spaceA = space(ACCOUNT_A);
  const spaceB = space(ACCOUNT_B);
  const shared = device({ "exo.voiceNotes.stopAfter": "30" });
  shared.use();
  const gate = Promise.withResolvers<void>();
  let entered = false;
  const original = threadStore.getSetting;
  const spy = spyOn(threadStore, "getSetting").mockImplementationOnce(async (tcw, key) => {
    entered = true;
    await gate.promise;
    return original(tcw, key);
  });
  try {
    const signOutA = attachRecordingSettingsSync(spaceA);
    await until(() => entered);
    // The other tab signs in as B and edits; A's cycle is still waiting on its read.
    const signOutB = attachRecordingSettingsSync(spaceB);
    setStopAfterPreference("15");
    gate.resolve();
    await syncRecordingSettings(spaceB);
    await syncRecordingSettings(spaceA);
    signOutA();
    signOutB();
    // A's space holds only what A's cache held (seeded from the device); B's edit went to B's cache and B's space.
    expect(await remoteDoc(spaceA)).toMatchObject({ stopAfter: "30" });
    expect(await remoteDoc(spaceB)).toMatchObject({ stopAfter: "15" });
    expect(cacheOf(shared.values, ACCOUNT_B).stored).toEqual({ stopAfter: "15" });
  } finally {
    spy.mockRestore();
  }
});

/** A seeded generator, so a failing interleaving can be replayed. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every value an account can choose comes from a set no other account uses, so a value found under A's key or in A's
// space that belongs to B's set has crossed.
const CHOICES = {
  [ACCOUNT_A]: { stopAfter: ["15", "30"] as StopAfter[], transcriber: "off" as const, uploadEngine: "private-cloud" as const, identifySpeakers: false, uploadAudio: true },
  [ACCOUNT_B]: { stopAfter: ["120", "off"] as StopAfter[], transcriber: "private-cloud" as const, uploadEngine: "assemblyai" as const, identifySpeakers: true, uploadAudio: false },
};
const ACCOUNTS = [ACCOUNT_A, ACCOUNT_B] as const;

test("property: with two accounts signing in and out at any await point, no value ever crosses keys or spaces", async () => {
  const trials = 150;
  for (let seed = 1; seed <= trials; seed++) {
    const random = mulberry32(seed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const yields = async () => { for (let turn = Math.floor(random() * 6); turn > 0; turn--) await Promise.resolve(); };
    const shared = device(random() < 0.5 ? { "exo.voiceNotes.stopAfter": "device" } : {});
    shared.use();
    const spaces = { [ACCOUNT_A]: space(ACCOUNT_A), [ACCOUNT_B]: space(ACCOUNT_B) };
    // The engine is slow and uneven, so edits and adopts straddle sign-ins.
    const fake = createFakeVoiceNotes();
    const plugin = { ...fake.plugin, getCaptureDefaults: async () => { await yields(); return fake.plugin.getCaptureDefaults(); },
      setCaptureDefaults: async (next: Parameters<typeof fake.plugin.setCaptureDefaults>[0]) => { await yields(); return fake.plugin.setCaptureDefaults(next); } };
    __setVoiceNotesForTests(plugin, { available: true });
    const pending: Promise<unknown>[] = [];
    let current: { account: (typeof ACCOUNTS)[number]; signOut: () => void } | null = null;
    const log: string[] = [];
    try {
      for (let step = 0; step < 14; step++) {
        const op = pick(["edit", "edit", "edit", "switch", "signout", "sync", "sync"] as const);
        log.push(op);
        if (op === "switch" || op === "signout") {
          current?.signOut();
          current = null;
          if (op === "switch") {
            const account = pick(ACCOUNTS);
            current = { account, signOut: attachRecordingSettingsSync(spaces[account]) };
          }
        } else if (op === "sync") {
          pending.push(syncRecordingSettings(spaces[pick(ACCOUNTS)]));
        } else if (current) {
          // Signed-in edits only: a signed-out edit belongs to the device, which seeds an account at most once.
          const choice = CHOICES[current.account];
          const field = pick(["stopAfter", "transcriber", "uploadEngine", "identifySpeakers", "uploadAudio"] as const);
          if (field === "stopAfter") setStopAfterPreference(pick(choice.stopAfter));
          else if (field === "transcriber") pending.push(setDefaultTranscriber(choice.transcriber));
          else if (field === "uploadEngine") writeDefaultUploadEngine(choice.uploadEngine);
          else if (field === "identifySpeakers") pending.push(setDefaultIdentifySpeakers(choice.identifySpeakers));
          else pending.push(setUploadAudioPreference(choice.uploadAudio));
        }
        await yields();
      }
      current?.signOut();
      await Promise.allSettled(pending);
      for (const account of ACCOUNTS) await syncRecordingSettings(spaces[account]);
      for (const account of ACCOUNTS) {
        const other = CHOICES[account === ACCOUNT_A ? ACCOUNT_B : ACCOUNT_A];
        const mine = CHOICES[account];
        const where = `seed ${seed} (${log.join(",")}) account ${account === ACCOUNT_A ? "A" : "B"}`;
        const foreign = (stored: Record<string, unknown> | undefined | null) => {
          if (!stored) return;
          expect(other.stopAfter as unknown[], `${where}: stopAfter ${String(stored.stopAfter)}`).not.toContain(stored.stopAfter);
          if (stored.transcriber !== undefined) expect(stored.transcriber, `${where}: transcriber`).toBe(mine.transcriber);
          if (stored.uploadEngine !== undefined) expect(stored.uploadEngine, `${where}: uploadEngine`).toBe(mine.uploadEngine);
          if (stored.identifySpeakers !== undefined) expect(stored.identifySpeakers, `${where}: identifySpeakers`).toBe(mine.identifySpeakers);
          if (stored.uploadAudio !== undefined) expect(stored.uploadAudio, `${where}: uploadAudio`).toBe(mine.uploadAudio);
        };
        foreign(cacheOf(shared.values, account)?.stored);
        foreign(await remoteDoc(spaces[account]));
      }
    } finally {
      current?.signOut();
      await Promise.allSettled(pending);
      __setVoiceNotesForTests(null, { available: null });
      __resetActiveAccountForTests();
    }
  }
});

test("reading a scope never looks at another scope's key", () => {
  const shared = device({ [cacheKeyOf(ACCOUNT_A)]: JSON.stringify({ v: 1, at: 1, dirty: [], stored: { stopAfter: "30" } }) });
  shared.use();
  expect(readStored(ACCOUNT_B)).toEqual({});
  expect(readStored(null)).toEqual({});
  expect(readStored(ACCOUNT_A).stopAfter).toBe("30");
});
