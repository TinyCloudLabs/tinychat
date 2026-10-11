// Notes that reach the space through reconcileAll (relaunch, the sign-in claim, Save now) are handed
// to the transcriber once, with their committed options, exactly as a note saved on Stop is.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { memoryHoldStore } from "@/harness/memoryHoldStore";
import { CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";
import { PrivateCloudError, type PrivateCloudCapabilities } from "../privateCloud";
import { advanceAccountGeneration, currentAccountGeneration } from "./accountContext";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { createVoiceNotePipeline } from "./voiceNotePipeline";
import { createVoiceNoteTranscriber, transcribeSavedNote, type VoiceNoteCloud } from "./voiceNoteTranscription";

const CAPS: PrivateCloudCapabilities = { max_bytes: 120_960_000, max_duration_seconds: 7_200, content_types: ["audio/wav"] };
const original = VoiceNotes;
afterEach(() => __setVoiceNotesForTests(original, { available: null }));

let count = 0;
function space() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:reconcile-transcribe-${++count}`;
  const sql = {
    db(name: string) {
      expect(name).toBe(CONNECTORS_SQL_DB_NAME);
      return {
        async query(statement: string, params: unknown[] = []) {
          try { return { ok: true, data: { rows: sqlite.prepare(statement).all(...params as never[]).map((r) => Object.values(r as object)) } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
        async execute(statement: string, params: unknown[] = []) {
          try { return { ok: true, data: { changes: sqlite.prepare(statement).run(...params as never[]).changes } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
      };
    },
  };
  const kv = {
    async put(key: string, value: string, options?: { ifNoneMatch?: string }) {
      if (options?.ifNoneMatch === "*" && values.has(key))
        return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "412" } };
      values.set(key, value);
      return { ok: true, data: {} };
    },
    async get(key: string) {
      return values.has(key) ? { ok: true, data: { data: values.get(key) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    async list({ path }: { path: string }) {
      return { ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)), truncated: false } };
    },
  };
  return { tcw: { did, spaceId: did, sql, kv } as unknown as TinyCloudWeb };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function transcriberWithRuns() {
  const cloud: VoiceNoteCloud = {
    capabilities: async () => CAPS,
    pendingSourceIds: () => [],
    transcribe: async () => { throw new Error("runNote is faked"); },
    finish: async () => {},
    releaseUnsent: async () => {},
  };
  const runs: string[] = [];
  const fail: Record<string, (err: unknown) => void> = {};
  const finish: Record<string, () => void> = {};
  const transcriber = createVoiceNoteTranscriber({
    cloud,
    consent: { get: () => true, set: () => {} },
    tcw: () => ({}) as TinyCloudWeb,
    holds: memoryHoldStore(),
    sleep: async () => {},
    runNote: (args) => new Promise((resolve, reject) => { runs.push(args.sourceId); fail[args.sourceId] = reject; finish[args.sourceId] = () => resolve("transcribed"); }),
  });
  return { transcriber, runs, fail, finish };
}

async function setup(transcriberOption: "off" | "on-device" | "private-cloud") {
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  const { tcw } = space();
  const pipeline = createVoiceNotePipeline(tcw, { retryDelaysMs: [] });
  const ctx = () => ({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() });
  let transitionGen = 0;
  const signInAs = (accountDid: string, transcriber = transcriberOption) =>
    fake.plugin.setCaptureDefaults({ accountDid, transitionGen: ++transitionGen, transcriber, identifySpeakers: false });
  const recordFor = async (accountDid: string) => {
    await signInAs(accountDid);
    await fake.plugin.start();
    return fake.plugin.stop();
  };
  const t = transcriberWithRuns();
  await t.transcriber.check();
  const handOver = (generation = currentAccountGeneration()) => (note: VoiceNoteRecording) =>
    transcribeSavedNote(t.transcriber, note, () => generation === currentAccountGeneration());
  return { fake, tcw, pipeline, ctx, recordFor, signInAs, handOver, ...t };
}

describe("a note saved by reconcileAll is handed to the transcriber", () => {
  test("a Private note left on the phone and saved after sign-in gets one Private job, and relaunching does not send it again", async () => {
    const s = await setup("private-cloud");
    const note = await s.recordFor(s.tcw.did);
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    expect(s.runs).toEqual([note.id]);
    expect(s.transcriber.snapshot().jobs.get(note.id)?.kind).toBe("active");
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    expect(s.runs).toEqual([note.id]);
  });

  test("Save now gets one Private job", async () => {
    const s = await setup("private-cloud");
    const note = await s.recordFor(s.tcw.did);
    await s.pipeline.reconcileAll(s.ctx(), "manual", s.handOver());
    await tick();
    expect(s.runs).toEqual([note.id]);
  });

  test("an Off note gets none", async () => {
    const s = await setup("off");
    const note = await s.recordFor(s.tcw.did);
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    expect((await s.fake.plugin.listPending()).recordings.find((entry) => entry.id === note.id)?.ledger?.audio.state).toBe("saved");
    expect(s.runs).toEqual([]);
    expect(s.transcriber.snapshot().jobs.get(note.id)).toBeUndefined();
  });

  test("a Local note, including one claimed from signed out on sign-in, is not sent to the cloud", async () => {
    const s = await setup("private-cloud");
    await s.fake.plugin.start();
    const signedOut = await s.fake.plugin.stop();
    expect(signedOut.owner).toBeNull();
    const cloud = await s.recordFor(s.tcw.did);
    await s.signInAs(s.tcw.did, "on-device");
    await s.fake.plugin.start();
    const onDevice = await s.fake.plugin.stop();
    expect(onDevice.options.transcriber).toBe("on-device");
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    const states = (await s.fake.plugin.listPending()).recordings.map((entry) => [entry.id, entry.ledger?.audio.state]);
    expect(states).toContainEqual([signedOut.id, "saved"]);
    expect(states).toContainEqual([onDevice.id, "saved"]);
    expect(s.runs).toEqual([cloud.id]);
  });

  test("a note the recorder already handed over gets no second job, in either order", async () => {
    const s = await setup("private-cloud");
    const first = await s.recordFor(s.tcw.did);
    s.transcriber.noteSaved(first);
    await tick();
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    expect(s.runs).toEqual([first.id]);
    s.finish[first.id]!();
    await tick();

    const second = await s.recordFor(s.tcw.did);
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    await tick();
    s.transcriber.noteSaved(second);
    await tick();
    expect(s.runs).toEqual([first.id, second.id]);
  });

  test("a note whose job already failed is not sent again by a later hand-off; only Retry does that", async () => {
    const s = await setup("private-cloud");
    const note = await s.recordFor(s.tcw.did);
    s.transcriber.noteSaved(note);
    await tick();
    expect(s.runs).toEqual([note.id]);
    s.fail[note.id]!(new PrivateCloudError("service_busy", "busy"));
    await tick();
    expect(s.transcriber.snapshot().jobs.get(note.id)?.kind).toBe("failed");
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", s.handOver());
    s.transcriber.noteSaved(note);
    await tick();
    expect(s.runs).toEqual([note.id]);
    s.transcriber.transcribe(note.id);
    await tick();
    expect(s.runs).toEqual([note.id, note.id]);
  });

  test("another account's note gets nothing, and neither does a hand-off from a superseded generation", async () => {
    const s = await setup("private-cloud");
    const other = await s.recordFor("did:test:someone-else");
    await s.signInAs(s.tcw.did);
    const stale = s.handOver();
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", stale);
    await tick();
    expect((await s.fake.plugin.listPending()).recordings.find((entry) => entry.id === other.id)?.ledger?.audio.state).toBe("pending");
    expect(s.runs).toEqual([]);

    const mine = await s.recordFor(s.tcw.did);
    const handOver = s.handOver();
    advanceAccountGeneration();
    handOver(mine);
    await tick();
    expect(s.runs).toEqual([]);
  });
});
