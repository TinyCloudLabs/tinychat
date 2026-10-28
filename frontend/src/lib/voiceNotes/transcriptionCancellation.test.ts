import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { _resetConnectorSchemaMemoForTests } from "../connectors/connectorStore";
import { createPrivateCloudApi, type PrivateCloudCreated } from "../privateCloud";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNoteRecording } from "./nativeVoiceNotes";
import { createFetchPtxPut, createVoiceNoteCloud, createVoiceNoteTranscriber,
  localStorageVoiceNoteHoldStore, localStorageVoiceNotePendingStore, prepareVoiceNoteTranscript, transcribeVoiceNote,
  type NoteTranscriptionState, type VoiceNoteTranscriber } from "./voiceNoteTranscription";
import { loadVoiceNoteAudio, saveVoiceNote, saveVoiceNoteTranscript, voiceNoteAudioSourceFromBase64 } from "./voiceNoteStore";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { bytesToBase64 } from "./voiceNoteAudio";

const CAPS = { max_bytes: 1_000_000, max_duration_seconds: 100, content_types: ["audio/wav"], admission: "open" as const };
const OLD = "trn_aaaaaaaaaaaaaaaa";
const NEW = "trn_bbbbbbbbbbbbbbbb";
const text = (value: string) => ({ text: value, segments: [{ channel: 0, start: 0, end: 1, text: value }] });
const json = (body: unknown) => Response.json(body);

function syntheticSpace() {
  _resetConnectorSchemaMemoForTests();
  const sqlite = new Database(":memory:");
  const values = new Map<string, string | Uint8Array>();
  const run = <T>(operation: () => T) => {
    try { return { ok: true, data: operation() }; }
    catch (error) { return { ok: false, error: { code: "SQL", message: String(error) } }; }
  };
  const tcw = { did: `did:test:${crypto.randomUUID()}`, spaceId: crypto.randomUUID(),
    sql: { db: () => ({
      query: async (sql: string, args: never[] = []) => run(() => ({ rows: sqlite.query(sql).values(...args) })),
      execute: async (sql: string, args: never[] = []) => run(() => { sqlite.query(sql).run(...args); return { rows: [] }; }),
    }) },
    kv: {
      get: async (key: string) => values.has(key) ? { ok: true, data: { data: values.get(key) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } },
      put: async (key: string, value: string | Uint8Array, options?: { ifNoneMatch?: string }) => {
        if (options?.ifNoneMatch === "*" && values.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "exists" } };
        values.set(key, value); return { ok: true, data: { headers: {} } };
      },
      list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)) } }),
    },
  } as unknown as TinyCloudWeb;
  return { tcw, sqlite, values };
}

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

function stateReached(transcriber: VoiceNoteTranscriber, id: string, kind: NoteTranscriptionState["kind"]) {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (transcriber.snapshot().jobs.get(id)?.kind === kind) resolve();
  else {
    const stop = transcriber.subscribe(() => {
      if (transcriber.snapshot().jobs.get(id)?.kind === kind) { stop(); resolve(); }
    });
  }
  return promise;
}

test("Private cancel interrupts the producer, persists across reload, preserves a rerun base, and fences late old completion after restart", async () => {
  const space = syntheticSpace();
  const previousNative = VoiceNotes;
  __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: false });
  const kv = storage();
  const pending = localStorageVoiceNotePendingStore(space.tcw.did, kv);
  const holds = localStorageVoiceNoteHoldStore(space.tcw.did, kv);
  const resultStarted = Promise.withResolvers<void>();
  const lateResult = Promise.withResolvers<Response>();
  const oldRunSettled = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const producer = new AbortController();
  let producerRunning = true;
  producer.signal.addEventListener("abort", () => { producerRunning = false; stopped.resolve(); }, { once: true });
  const cancellations: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      expect(request.headers.get("Authorization")).toBe("Bearer synthetic-session");
      if (path.endsWith("/capabilities")) return json(CAPS);
      if (path.endsWith("/cancel")) {
        cancellations.push(path); producer.abort(); return json({ id: OLD, status: "cancelled" });
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (path.endsWith(`${OLD}/result`)) { resultStarted.resolve(); return lateResult.promise; }
      if (path.endsWith(`${NEW}/result`)) return json(text("Replacement transcript"));
      return json({ id: path.endsWith(OLD) ? OLD : NEW, status: "completed" });
    },
  });
  const attempts: string[] = [];
  const api = createPrivateCloudApi(server.url.origin, { sessionStore: {
    getToken: () => "synthetic-session", isExpired: () => false,
  }, fetchImpl: ((input, init) => String(input).endsWith(`${OLD}/result`)
    ? fetch(input, { ...init, signal: undefined }) : fetch(input, init)) as typeof fetch });
  const cloud = () => createVoiceNoteCloud({ origin: server.url.origin, api, pending,
    create: async ({ attemptId }) => { attempts.push(attemptId); return { id: NEW, status: "completed", upload: null }; },
    put: async () => { throw new Error("A completed test job must not upload audio"); },
  });
  const makeTranscriber = () => createVoiceNoteTranscriber({ cloud: cloud(), holds,
    consent: { get: () => true, set() {} }, tcw: () => space.tcw,
    runNote: async (args) => {
      try { return await transcribeVoiceNote(args); }
      finally { if (args.signal?.aborted) oldRunSettled.resolve(); }
    },
  });
  const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  const audio = { mimeType: "audio/wav", base64: bytesToBase64(bytes) };
  const recording = { id: "note", source: "in_app", startedAt: 1, durationMs: 2000, mimeType: "audio/wav", sizeBytes: bytes.length,
    options: { transcriber: "private-cloud", identifySpeakers: false, uploadAudio: true } } as VoiceNoteRecording;
  try {
    expect((await saveVoiceNote(space.tcw, recording, voiceNoteAudioSourceFromBase64(audio), "web")).ok).toBe(true);
    expect((await saveVoiceNoteTranscript(space.tcw, "note", prepareVoiceNoteTranscript(text("Previous transcript"), "2026-01-01T00:00:00Z", 1))).ok).toBe(true);
    const prior = await readTranscriptCommit(space.tcw, "note");
    const transcriber = makeTranscriber();
    await transcriber.check();
    pending.write("note", { attemptId: "old-attempt", transcriptionId: OLD });
    await transcriber.transcribeAgain!("note", "private-cloud");
    await resultStarted.promise;
    await transcriber.cancel!("note");
    await stopped.promise;
    expect(producerRunning).toBe(false);
    expect(cancellations).toEqual([`/api/transcriber/private-cloud/transcriptions/${OLD}/cancel`]);
    expect(await readTranscriptCommit(space.tcw, "note")).toEqual(prior);
    expect(await loadVoiceNoteAudio(space.tcw, "note")).toMatchObject({ ok: true, data: audio });
    const reloaded = makeTranscriber();
    await reloaded.check();
    expect(reloaded.snapshot().jobs.get("note")?.kind).toBe("cancelled");
    expect(attempts).toEqual([]);
    const completed = stateReached(reloaded, "note", "done");
    await reloaded.transcribeAgain!("note", "private-cloud");
    await completed;
    lateResult.resolve(json(text("Obsolete late transcript")));
    await oldRunSettled.promise;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).not.toBe("old-attempt");
    const committed = await readTranscriptCommit(space.tcw, "note");
    expect(committed?.rev).toBe(2);
    expect(JSON.parse(String(space.values.get(committed!.bodyKey))).map((sentence: { text: string }) => sentence.text)).toEqual(["Replacement transcript"]);
    expect(await loadVoiceNoteAudio(space.tcw, "note")).toMatchObject({ ok: true, data: audio });
  } finally {
    lateResult.resolve(json(text("Obsolete late transcript")));
    await server.stop(true);
    __setVoiceNotesForTests(previousNative, { available: null });
    space.sqlite.close();
  }
});

test("queued Private cancel cannot consume a rapid replacement enqueue or restart automatically", async () => {
  const space = syntheticSpace();
  const pending = localStorageVoiceNotePendingStore(space.tcw.did, storage());
  const first = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const starts: string[] = [];
  const cloud = createVoiceNoteCloud({ origin: "https://unused.example", pending,
    api: { capabilities: async () => CAPS } as never, create: async () => { throw new Error("unexpected create"); }, put: async () => { throw new Error("unexpected upload"); } });
  const transcriber = createVoiceNoteTranscriber({ cloud, tcw: () => space.tcw,
    consent: { get: () => true, set() {} }, holds: localStorageVoiceNoteHoldStore(space.tcw.did, storage()),
    runNote: async ({ sourceId }) => { starts.push(sourceId); if (sourceId === "first") { first.resolve(); await release.promise; } return "no_speech"; },
  });
  try {
    await transcriber.check();
    transcriber.transcribe("first");
    await first.promise;
    transcriber.transcribe("waiting");
    await transcriber.cancel!("waiting");
    expect(transcriber.snapshot().jobs.get("waiting")?.kind).toBe("cancelled");
    const completed = stateReached(transcriber, "waiting", "done");
    transcriber.transcribe("waiting");
    release.resolve();
    await completed;
    expect(starts).toEqual(["first", "waiting"]);
  } finally { release.resolve(); space.sqlite.close(); }
});

test("reload can finish cancelling an unacknowledged create using its original idempotency key", async () => {
  const pending = localStorageVoiceNotePendingStore("did:test:reload", storage());
  const body = { content_type: "audio/wav", byte_size: 8, sha256: "a".repeat(64), language: "en",
    channel_mode: "mixed" as const, channel_labels: ["You"] };
  pending.write("note", { attemptId: "unacknowledged", transcriptionId: null, failure: "cancelled", createBody: body });
  const replayed: string[] = [];
  const cancelled: string[] = [];
  const cloud = createVoiceNoteCloud({ pending, origin: "https://unused.example",
    create: async ({ attemptId }) => { replayed.push(attemptId); return { id: OLD, status: "awaiting_upload", upload: null } satisfies PrivateCloudCreated; },
    api: { cancel: async (id: string) => { cancelled.push(id); } } as never,
    put: async () => { throw new Error("Cancelling must not send audio"); },
  });
  await cloud.cancel!("note");
  expect(replayed).toEqual(["unacknowledged"]);
  expect(cancelled).toEqual([OLD]);
  expect(cloud.cancellationPending!("note")).toBe(false);
  expect(pending.read("note")?.failure).toBe("cancelled");
});

test("browser Private upload abort interrupts an actual local HTTP request", async () => {
  const entered = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      await request.arrayBuffer();
      request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true });
      entered.resolve();
      return response.promise;
    },
  });
  const controller = new AbortController();
  const upload = createFetchPtxPut()( { url: server.url.href, capability: "synthetic-capability", contentType: "audio/wav",
    base64: "AQIDBA==", correlationId: "synthetic-upload", signal: controller.signal }).catch((error: unknown) => error);
  try {
    await entered.promise;
    controller.abort();
    await disconnected.promise;
    expect(await upload).toMatchObject({ code: "upload_outcome_unknown" });
  } finally { response.resolve(new Response(null, { status: 204 })); await server.stop(true); }
});
