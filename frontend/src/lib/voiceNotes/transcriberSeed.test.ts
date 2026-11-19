// TC-3045: a phone whose WebView storage is new (the origin move) has no stored recording settings, while the engine
// still holds the user's. seedPreferenceFromEngine takes them before RecorderProvider's account write would push the
// stored defaults (on-device) over them.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes } from "./nativeVoiceNotes";
import { readTranscriberPreference, seedPreferenceFromEngine, writeAccountDefaults } from "./transcriberPreference";

const DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
});
afterEach(() => {
  __setVoiceNotesForTests(VoiceNotes, { available: null });
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

async function engine(defaults: { signedIn: boolean; transcriber: "private-cloud" | "on-device" | "assemblyai" | "off" }) {
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  if (defaults.signedIn) {
    await fake.plugin.setCaptureDefaults({ accountDid: DID, transitionGen: 1, transcriber: defaults.transcriber, identifySpeakers: false, uploadAudio: true });
  }
  return fake;
}

test("with nothing stored, the engine's choice is taken and survives the account write that follows", async () => {
  const fake = await engine({ signedIn: true, transcriber: "private-cloud" });

  await seedPreferenceFromEngine();
  expect(readTranscriberPreference()).toEqual({ transcriber: "private-cloud", identifySpeakers: false, uploadAudio: true });

  await writeAccountDefaults((native) => ({ accountDid: native.accountDid, transitionGen: native.transitionGen }));
  expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("private-cloud");
});

test("Powerful is taken the same way and survives the account write", async () => {
  const fake = await engine({ signedIn: true, transcriber: "assemblyai" });

  await seedPreferenceFromEngine();
  expect(readTranscriberPreference()).toEqual({ transcriber: "assemblyai", identifySpeakers: false, uploadAudio: true });

  await writeAccountDefaults((native) => ({ accountDid: native.accountDid, transitionGen: native.transitionGen }));
  expect((await fake.plugin.getCaptureDefaults()).transcriber).toBe("assemblyai");
});

test("a stored choice is kept", async () => {
  await engine({ signedIn: true, transcriber: "private-cloud" });
  values.set("exo.voiceNotes.transcriber", "on-device");

  await seedPreferenceFromEngine();

  expect(readTranscriberPreference().transcriber).toBe("on-device");
  expect(values.has("exo.voiceNotes.uploadAudio")).toBe(false);
});

test("signed out, the engine's default is not a choice and nothing is stored", async () => {
  await engine({ signedIn: false, transcriber: "private-cloud" });

  await seedPreferenceFromEngine();

  expect(values.size).toBe(0);
});

test("an engine that can't answer stores nothing and doesn't throw", async () => {
  const fake = await engine({ signedIn: true, transcriber: "private-cloud" });
  fake.plugin.getCaptureDefaults = async () => { throw new Error("bridge gone"); };

  await seedPreferenceFromEngine();

  expect(values.size).toBe(0);
});
