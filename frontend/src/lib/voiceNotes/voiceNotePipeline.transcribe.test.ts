// Notes that reach the space through reconcileAll (relaunch, the sign-in claim, Save now) are handed
// to the transcriber once, with their committed options, exactly as a note saved on Stop is.

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { memoryHoldStore } from "@/harness/memoryHoldStore";
import { CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";
import { createPrivateCloudApi, PrivateCloudError, type PrivateCloudCapabilities } from "../privateCloud";
import type { SessionStore } from "../session";
import { advanceAccountGeneration, currentAccountGeneration } from "./accountContext";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { createVoiceNotePipeline } from "./voiceNotePipeline";
import { pendingStore, whenVoiceNoteSavesIdle } from "./recorderSaves";
import { createVoiceNoteRecorderController } from "@/capture/recorder/voiceNoteRecorderController";
import { createVoiceNoteCloud, createVoiceNoteTranscriber, transcribeSavedNote, type VoiceNoteCloud } from "./voiceNoteTranscription";

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
    fake.plugin.setCaptureDefaults({ accountDid, transitionGen: ++transitionGen, transcriber, identifySpeakers: false, uploadAudio: true });
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

  test("a Local note stays private without upload approval; a consented Local note is not sent to the cloud", async () => {
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
    expect(states).toContainEqual([signedOut.id, "pending"]);
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

const PRIVATE_NOTE = { durationMs: 1000, source: "in_app" as const, options: { transcriber: "private-cloud" as const, identifySpeakers: false } };

test("a generation superseded while the hand-off's check is in flight resumes none of A's pending jobs with B's bearer", async () => {
  let account = "A";
  let answer: (response: Response) => void = () => {};
  const requests: string[] = [];
  const cleared: string[] = [];
  let pendingJob: { attemptId: string; transcriptionId: string } | null = { attemptId: "attempt-A", transcriptionId: "trn_A" };
  const api = createPrivateCloudApi("https://backend.example", {
    sessionStore: { getToken: () => account, isExpired: () => false } as unknown as SessionStore,
    fetchImpl: (async (url: string, init: RequestInit) => {
      requests.push(`${init.method}:${new Headers(init.headers).get("Authorization")}`);
      if (url.endsWith("/capabilities")) return new Promise<Response>((resolve) => { answer = resolve; });
      return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const cloud = createVoiceNoteCloud({ api, origin: "https://ptx.example",
    pending: { read: () => pendingJob, write() {}, clear: (id) => { cleared.push(id); pendingJob = null; }, sourceIds: () => pendingJob ? ["old-A-job"] : [] },
    create: async () => { throw new Error("unexpected create"); }, put: async () => { throw new Error("unexpected upload"); },
  });
  const transcriber = createVoiceNoteTranscriber({ cloud, holds: memoryHoldStore(), tcw: () => ({ did: "A" }) as TinyCloudWeb,
    consent: { get: () => true, set() {} },
    runNote: async (args) => {
      await cloud.transcribe({ sourceId: args.sourceId, capabilities: args.capabilities, allowed: args.allowed,
        loadAudio: async () => { throw new Error("unexpected audio read"); } }, args.report);
      return "no_speech";
    },
  });
  const generation = currentAccountGeneration();
  transcribeSavedNote(transcriber, { id: "new-A-note", ...PRIVATE_NOTE }, () => generation === currentAccountGeneration());
  account = "B";
  advanceAccountGeneration();
  answer(new Response(JSON.stringify(CAPS), { status: 200, headers: { "Content-Type": "application/json" } }));
  await tick();
  expect({ afterSwitch: requests.filter((request) => request.endsWith("Bearer B")), cleared }).toEqual({ afterSwitch: [], cleared: [] });
});

test("a hand-off for a generation that is already superseded does not even start a check", async () => {
  const checks: unknown[] = [];
  const transcriber = { check: (options: unknown) => { checks.push(options); return Promise.resolve(); }, noteSaved: () => { throw new Error("must not hand over"); } };
  transcribeSavedNote(transcriber, { id: "stale", ...PRIVATE_NOTE }, () => false);
  await tick();
  expect(checks).toEqual([]);
});

test("a hand-off's cached check leaves an earlier failed job waiting for Retry after an identity-paused job", async () => {
  let current = true;
  let interrupt: (error: unknown) => void = () => {};
  const runs: string[] = [];
  const cloud = { capabilities: async () => CAPS, pendingSourceIds: () => ["failed-note", "interrupted-note"] } as unknown as VoiceNoteCloud;
  const transcriber = createVoiceNoteTranscriber({ cloud, holds: memoryHoldStore(), tcw: () => ({}) as TinyCloudWeb,
    consent: { get: () => true, set() {} },
    runNote: async (args) => {
      runs.push(args.sourceId);
      if (args.sourceId === "failed-note") throw new PrivateCloudError("service_busy", "busy");
      if (args.sourceId === "interrupted-note" && runs.filter((id) => id === "interrupted-note").length === 1)
        return new Promise((_, reject) => { interrupt = reject; });
      return "no_speech";
    },
  });
  await transcriber.check({ current: () => current });
  await tick();
  expect(transcriber.snapshot().jobs.get("failed-note")?.kind).toBe("failed");
  current = false;
  interrupt(new PrivateCloudError("account_changed", "account left"));
  await tick();
  current = true;
  transcribeSavedNote(transcriber, { id: "saved-on-return", ...PRIVATE_NOTE }, () => current);
  await tick();
  expect(runs.filter((id) => id === "failed-note")).toEqual(["failed-note"]);
  expect(runs).toContain("saved-on-return");
  transcriber.transcribe("failed-note");
  await tick();
  expect(runs.filter((id) => id === "failed-note")).toEqual(["failed-note", "failed-note"]);
});

describe("the recorder's hand-off and reconcile's while the first availability check is still pending", () => {
  const delayed = (s: Awaited<ReturnType<typeof setup>>) => {
    let answer: (caps: PrivateCloudCapabilities) => void = () => {};
    const runs: string[] = [];
    const cloud = { capabilities: () => new Promise<PrivateCloudCapabilities>((resolve) => { answer = resolve; }), pendingSourceIds: () => [] } as unknown as VoiceNoteCloud;
    const transcriber = createVoiceNoteTranscriber({ cloud, holds: memoryHoldStore(), tcw: () => s.tcw,
      consent: { get: () => true, set() {} }, runNote: async (args) => { runs.push(args.sourceId); return "no_speech"; } });
    return { transcriber, runs, answer: (caps = CAPS) => answer(caps) };
  };

  test("recorder first (the controller's landed): the note still gets exactly one job", async () => {
    const s = await setup("private-cloud");
    const note = await s.recordFor(s.tcw.did);
    const d = delayed(s);
    const checking = d.transcriber.check();
    await s.pipeline.process(s.ctx(), note.id);
    const generation = currentAccountGeneration();
    transcribeSavedNote(d.transcriber, note, () => generation === currentAccountGeneration());
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", (saved) => transcribeSavedNote(d.transcriber, saved, () => true));
    d.answer();
    await checking;
    await tick();
    expect(d.runs).toEqual([note.id]);
  });

  test("reconcile first: the note still gets exactly one job when the recorder's hand-off follows", async () => {
    const s = await setup("private-cloud");
    const note = await s.recordFor(s.tcw.did);
    const d = delayed(s);
    const checking = d.transcriber.check();
    await s.pipeline.reconcileAll(s.ctx(), "reconcile", (saved) => transcribeSavedNote(d.transcriber, saved, () => true));
    await s.pipeline.process(s.ctx(), note.id);
    transcribeSavedNote(d.transcriber, note, () => true);
    d.answer();
    await checking;
    await tick();
    expect(d.runs).toEqual([note.id]);
  });
});

test("a recorder stop queued behind reconcile waits for the owning save before hand-off", async () => {
  const s = await setup("private-cloud");
  const first = await s.recordFor(s.tcw.did);
  const queued = await s.recordFor(s.tcw.did);
  const readAudioChunk = s.fake.plugin.readAudioChunk.bind(s.fake.plugin);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.fake.plugin.readAudioChunk = (async (options: Parameters<typeof readAudioChunk>[0]) => {
    if (options.id === first.id) { entered(); await gate; }
    return readAudioChunk(options);
  }) as typeof s.fake.plugin.readAudioChunk;

  let autoStopped: (event: unknown) => void = () => { throw new Error("autoStopped listener not installed"); };
  const addListener = s.fake.plugin.addListener.bind(s.fake.plugin);
  s.fake.plugin.addListener = ((event: string, callback: (event: unknown) => void) => {
    if (event === "autoStopped") autoStopped = callback;
    return (addListener as (event: string, callback: (event: unknown) => void) => unknown)(event, callback);
  }) as typeof s.fake.plugin.addListener;
  const recorder = createVoiceNoteRecorderController({ tcw: s.tcw, available: true, transcriber: s.transcriber,
    pipeline: s.pipeline, onDeviceReady: () => true });
  const detach = recorder.attach();
  const handed: string[] = [];
  const reconcile = s.pipeline.reconcileAll(s.ctx(), "reconcile", (note) => {
    handed.push(note.id);
    s.handOver()(note);
  });
  try {
    await started;
    autoStopped({ reason: "max_duration", maxDurationMs: 60_000, at: Date.now(), recording: queued });
    for (let i = 0; i < 5; i++) await tick();
    expect((await s.fake.plugin.listPending()).recordings.find((note) => note.id === queued.id)?.ledger?.audio.state).toBe("pending");
    expect(recorder.getState().localUpload).toBe("in-flight");
    expect(s.runs).toEqual([]);

    release();
    await reconcile;
    await tick();
    expect((await s.fake.plugin.listPending()).recordings.find((note) => note.id === queued.id)?.ledger?.audio.state).toBe("saved");
    expect(handed).toEqual([first.id, queued.id]);
  } finally {
    release();
    detach();
    await reconcile.catch(() => undefined);
  }
});

describe("a recorder save that finishes after the account changed never transcribes", () => {
  afterEach(async () => {
    pendingStore.setAccount(null);
    await pendingStore.refresh(null);
  });

  // The final native ledger acknowledgement is held while the account leaves; the old controller then lands A's note.
  const lateSave = async (variant: "stopped" | "background" | "no-pipeline") => {
    const s = await setup("private-cloud");
    // The no-pipeline save remembers saved ids for the whole process, and every fake numbers its notes from 1: use a high id.
    if (variant === "no-pipeline") for (let i = 0; i < 49; i++) { await s.recordFor(s.tcw.did); }
    const note = await s.recordFor(s.tcw.did);
    const original = s.fake.plugin.updateLedger.bind(s.fake.plugin);
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    s.fake.plugin.updateLedger = async (request) => {
      const result = await original(request);
      if (request.id === note.id && request.patch.audio?.state === "saved") { entered(); await gate; }
      return result;
    };
    let autoStopped: (event: unknown) => void = () => { throw new Error("autoStopped listener not installed"); };
    const add = s.fake.plugin.addListener.bind(s.fake.plugin);
    s.fake.plugin.addListener = ((event: string, callback: (event: unknown) => void) => {
      if (event === "autoStopped") autoStopped = callback;
      return (add as (event: string, callback: (event: unknown) => void) => unknown)(event, callback);
    }) as typeof s.fake.plugin.addListener;
    const switchAccount = async () => {
      await started;
      advanceAccountGeneration();
      s.pipeline.cancelAll();
      release();
      for (let i = 0; i < 8; i++) await tick();
      await whenVoiceNoteSavesIdle();
    };
    const attach = (transcriber: ReturnType<typeof createVoiceNoteTranscriber>) => {
      const recorder = createVoiceNoteRecorderController({ tcw: s.tcw, available: true, transcriber,
        pipeline: variant === "no-pipeline" ? undefined : s.pipeline, onDeviceReady: () => true });
      return { recorder, detach: recorder.attach() };
    };
    const fire = async (recorder: ReturnType<typeof attach>["recorder"]) => {
      if (variant === "background") await recorder.record();
      autoStopped({ reason: "max_duration", maxDurationMs: 60000, at: Date.now(), recording: note });
    };
    return { s, note, attach, fire, switchAccount };
  };

  for (const variant of ["stopped", "background", "no-pipeline"] as const) {
    test(`${variant}: A's note starts no job once the generation has moved on, even though B's guard is the current one`, async () => {
      const { s, attach, fire, switchAccount } = await lateSave(variant);
      let account = "A";
      const runs: string[] = [];
      const cloud = { capabilities: async () => CAPS, pendingSourceIds: () => [] } as unknown as VoiceNoteCloud;
      const transcriber = createVoiceNoteTranscriber({ cloud, holds: memoryHoldStore(), tcw: () => s.tcw,
        consent: { get: () => true, set() {} },
        runNote: async (args) => { runs.push(`${args.sourceId}:${account}:${args.allowed!("account")}`); return "no_speech"; } });
      await transcriber.check({ current: () => account === "A" });
      const { recorder, detach } = attach(transcriber);
      await tick();
      await fire(recorder);
      account = "B";
      await switchAccount();
      detach();
      expect(runs).toEqual([]);
    });
  }

  test("A's persisted job sends no request with B's bearer and its pending record is not cleared", async () => {
    const { s, note, attach, fire, switchAccount } = await lateSave("stopped");
    let account = "A";
    const requests: string[] = [];
    const cleared: string[] = [];
    let pendingJob: { attemptId: string; transcriptionId: string } | null = null;
    const api = createPrivateCloudApi("https://backend.example", {
      sessionStore: { getToken: () => account, isExpired: () => false } as unknown as SessionStore,
      fetchImpl: (async (url: string, init: RequestInit) => {
        requests.push(`${init.method}:${new Headers(init.headers).get("Authorization")}`);
        return new Response(JSON.stringify(url.endsWith("/capabilities") ? CAPS : {}),
          { status: url.endsWith("/capabilities") ? 200 : 404, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });
    const cloud = createVoiceNoteCloud({ api, origin: "https://ptx.example",
      pending: { read: () => pendingJob, write() {}, clear: (id) => { cleared.push(id); pendingJob = null; }, sourceIds: () => pendingJob ? [note.id] : [] },
      create: async () => { throw new Error("unexpected create"); }, put: async () => { throw new Error("unexpected upload"); },
      decode: async () => { throw new Error("injected decoder stops after the wrong-account GET"); },
    });
    const transcriber = createVoiceNoteTranscriber({ cloud, holds: memoryHoldStore(), tcw: () => s.tcw, consent: { get: () => true, set() {} } });
    await transcriber.check({ current: () => account === "A" });
    const { recorder, detach } = attach(transcriber);
    await tick();
    await fire(recorder);
    pendingJob = { attemptId: "attempt-A", transcriptionId: "trn_A" };
    account = "B";
    await switchAccount();
    detach();
    expect({ afterSwitch: requests.filter((request) => request.endsWith("Bearer B")), cleared }).toEqual({ afterSwitch: [], cleared: [] });
  });
});
