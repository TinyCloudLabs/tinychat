import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { act, createElement, Fragment, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { PlatformContext } from "@/lib/platform";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { transcriptionProps } from "@/capture/recorder/transcriptionProps";
import { ActivityNoteSection } from "@/capture/activity/ActivityPanel";
import { activityForNote } from "@/capture/activity/activitySelector";
import { NoteDetailView } from "@/capture/library/NoteDetailView";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import { __setVoiceNotesForTests } from "./nativeVoiceNotes";
import { localStorageVoiceNotePendingStore, localStorageVoiceNoteConsentStore, localStorageVoiceNotePrivateChoiceStore,
  prepareVoiceNoteTranscript, voiceNoteTranscriberFor, type VoiceNoteTranscriber } from "./voiceNoteTranscription";
import { loadVoiceNoteAudio, saveVoiceNote, saveVoiceNoteTranscript, voiceNoteAudioSourceFromBase64 } from "./voiceNoteStore";
import { readTranscriptCommit } from "./voiceNoteCommits";
import { resolveVoiceNoteRow } from "./voiceNoteRows";
import { memoryLocks, openWebStore, recordingFromSession } from "./web/webStore";
import { newIdbEnv } from "./web/testing/idb";
import { useNotePipeline, type NotePipelineView } from "./useNotePipeline";
import { __setInstalledEngineForTests, captureCapabilities } from "./captureEngine";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const [dir, backend, stage, mode, did] = process.argv.slice(2) as [string, string, string, string, string];
const audio = { mimeType: "audio/wav", base64: "AQIDBA==" };
const bytes = new Uint8Array([1, 2, 3, 4]);
const readJson = (path: string) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
const localFile = `${dir}/local.json`;
const local = {
  getItem: (key: string) => readJson(localFile)[key] ?? null,
  setItem(key: string, value: string) { writeFileSync(localFile, JSON.stringify({ ...readJson(localFile), [key]: value })); },
  removeItem(key: string) { const values = readJson(localFile); delete values[key]; writeFileSync(localFile, JSON.stringify(values)); },
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
process.env.VITE_EXO_PTX_UPLOAD_ORIGIN = "https://127.0.0.1";
const sqlite = new Database(`${dir}/space.sqlite`);
const sqlResult = <T,>(operation: () => T) => {
  try { return { ok: true, data: operation() }; }
  catch { return { ok: false, error: { code: "SQL", message: "Synthetic SQL operation failed" } }; }
};
const kvFile = `${dir}/kv.json`;
const tcw = { did, spaceId: "synthetic-space",
  sql: { db: () => ({
    query: async (sql: string, args: never[] = []) => sqlResult(() => ({ rows: sqlite.query(sql).values(...args) })),
    execute: async (sql: string, args: never[] = []) => sqlResult(() => { sqlite.query(sql).run(...args); return { rows: [] }; }),
  }) },
  kv: {
    get: async (key: string) => {
      const row = readJson(kvFile)[key];
      return row ? { ok: true, data: { data: row.bytes ? new Uint8Array(row.data) : row.data, headers: { etag: row.etag } } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    put: async (key: string, value: string | Uint8Array, options?: { ifNoneMatch?: string; ifMatch?: string }) => {
      const values = readJson(kvFile);
      if (options?.ifNoneMatch === "*" && values[key] || options?.ifMatch && options.ifMatch !== values[key]?.etag)
        return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "etag changed" } };
      const etag = String(Number(values[key]?.etag ?? 0) + 1);
      values[key] = { bytes: value instanceof Uint8Array, data: value instanceof Uint8Array ? [...value] : value, etag };
      writeFileSync(kvFile, JSON.stringify(values));
      return { ok: true, data: { headers: { etag } } };
    },
    list: async ({ path }: { path: string }) => ({ ok: true, data: { keys: Object.keys(readJson(kvFile)).filter((key) => key.startsWith(path)) } }),
  },
} as unknown as TinyCloudWeb;

const idb = newIdbEnv();
Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: idb.factory });
Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: idb.keyRange });
const store = await openWebStore({ env: idb, dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null });
await store.setCaptureDefaults({ ...(await store.getCaptureDefaults()), accountDid: did, transitionGen: 1, transcriber: "assemblyai" });
async function nativeNote(id: string, handle: string) {
  await store.beginSession({ id, startedAt: 1, source: "in_app", owner: did, transitionGen: 1,
    options: { transcriber: "assemblyai", identifySpeakers: false, uploadAudio: true }, mimeType: audio.mimeType, input: null, maxDurationMs: 60000 });
  await store.appendChunk(id, bytes, { audioMs: 2000 });
  await store.commitSession(id, (session, size) => recordingFromSession(session, size, {
    endedAt: 2001, durationMs: 2000, recovered: false, endedUnexpectedly: false, exitReason: null }));
  const recording = (await store.listPending()).recordings.find((note) => note.id === id)!;
  await store.updateLedger({ id, did, rev: recording.rev ?? 0, patch: { remote: [{ opId: `synthetic-${id}`,
    provider: "assemblyai", mode: "hosted", kind: "hosted_submit", stage: "submitted", uploadId: null, uploadUrl: null, jobId: handle, cleanup: "none" }] } });
  return (await store.listPending()).recordings.find((note) => note.id === id)!;
}
const recording = await nativeNote("note", "old-handle");
const retired = signal();
__setVoiceNotesForTests({ ...createFakeVoiceNotes().plugin, listPending: store.listPending, getTranscript: store.getTranscript,
  readAudioChunk: store.readAudioChunk, getCaptureDefaults: store.getCaptureDefaults, localAudioSize: async () => ({ size: bytes.length }),
  updateLedger: async (args) => {
    const result = await store.updateLedger(args);
    if (args.id === "note" && args.patch.remote?.every((entry) => entry.mode !== "hosted" || entry.stage === "done")) retired.resolve();
    return result;
  },
}, { available: false });
__setInstalledEngineForTests("web", { ...captureCapabilities(), localTranscription: false, desktopWhisper: false, nativeFileUpload: false });

const actualFetch = globalThis.fetch;
let resultHeaders = signal();
globalThis.fetch = (async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, backend, "Fixture permits owned loopback requests only");
  const response = await actualFetch(input, init);
  if (url.pathname.includes("/private-cloud/") && url.pathname.endsWith("/result")) resultHeaders.resolve();
  return response;
}) as typeof fetch;
const subscriptions = new Set<() => void>();
function reached(transcriber: VoiceNoteTranscriber, predicate: () => boolean) {
  const gate = signal();
  const changed = () => { if (predicate()) gate.resolve(); };
  const stop = transcriber.subscribe(changed);
  subscriptions.add(stop);
  changed();
  return gate.promise.finally(() => { stop(); subscriptions.delete(stop); });
}
let root: Root | undefined;
let restoreDom: (() => void) | undefined;
try {
  const pending = localStorageVoiceNotePendingStore(did, local);
  const choices = localStorageVoiceNotePrivateChoiceStore(did, local);
  if (stage === "warm") {
    assert.equal((await saveVoiceNote(tcw, recording, voiceNoteAudioSourceFromBase64(audio), "web")).ok, true);
    localStorageVoiceNoteConsentStore(did, local).set(true);
    local.setItem(`exo.voiceNotes.powerfulConsent:${did}`, "1");
    pending.write("note", { attemptId: "older-private", transcriptionId: null, failure: "cancelled" });
    await tcw.kv.put("exo/voiceNotes/hostedJobs/note", JSON.stringify({ version: 1, status: "submitted", token: "old-attempt", handle: "old-handle" }));
  } else {
    const other = await nativeNote("other", "other-handle");
    assert.equal((await saveVoiceNote(tcw, other, voiceNoteAudioSourceFromBase64(audio), "web")).ok, true);
    await tcw.kv.put("exo/voiceNotes/hostedJobs/other", JSON.stringify({ version: 1, status: "submitted", token: "other-attempt", handle: "other-handle" }));
    const key = `exo.voiceNotes.powerfulJobs:${did}`;
    local.setItem(key, JSON.stringify({ ...JSON.parse(local.getItem(key) ?? "{}"), other: { handle: "other-handle", recording: other } }));
  }
  const transcriber = voiceNoteTranscriberFor(tcw, backend, { getToken: () => "synthetic-session", isExpired: () => false })!;
  assert.equal(transcriber.providerFor!("note"), "private");
  assert.equal(transcriber.snapshot().jobs.get("note")?.kind, "cancelled");
  if (stage === "warm") {
    await transcriber.check();
    const oldFailed = reached(transcriber, () => transcriber.providerFor!("note") === "powerful" && transcriber.snapshot().jobs.get("note")?.kind === "failed");
    transcriber.transcribe("note");
    await oldFailed;
    if (mode === "committed") {
      const previous = prepareVoiceNoteTranscript({ text: "Previous synthetic transcript", segments: [{ channel: 0, start: 0, end: 1, text: "Previous synthetic transcript" }] }, "2026-01-01T00:00:00Z", 1);
      assert.equal((await saveVoiceNoteTranscript(tcw, "note", previous)).ok, true);
    }
    const commit = await readTranscriptCommit(tcw, "note");
    const body = commit ? (await tcw.kv.get(commit.bodyKey)) : null;
    writeFileSync(`${dir}/expected.json`, JSON.stringify({ commit, body }));
    const accepted = mode === "committed" ? await transcriber.transcribeAgain!("note", "private-cloud") : transcriber.transcribePrivately("note", 2, bytes.length);
    assert.equal(accepted, null);
    await resultHeaders.promise;
    assert.equal(transcriber.providerFor!("note"), "private");
    assert.equal(transcriber.snapshot().jobs.get("note")?.kind, "active");
    await transcriber.cancel!("note");
  } else {
    if (mode === "fresh") {
      assert.equal(choices.has("note"), true);
      assert.equal(pending.read("note")?.failure, "cancelled");
      assert.equal(pending.read("note")?.transcriptionId, null);
    }
    const otherFailed = reached(transcriber, () => transcriber.snapshot().jobs.get("other")?.kind === "failed");
    await transcriber.check();
    transcriber.noteSaved(recording);
    await otherFailed;
    if (mode === "committed") await retired.promise;
    assert.equal(transcriber.providerFor!("other"), "powerful");
  }
  const expected = readJson(`${dir}/expected.json`);
  async function preserved() {
    assert.deepEqual(await readTranscriptCommit(tcw, "note"), expected.commit);
    if (expected.commit) assert.deepEqual(await tcw.kv.get(expected.commit.bodyKey), expected.body);
    assert.deepEqual(await loadVoiceNoteAudio(tcw, "note"), { ok: true, data: audio });
    assert.deepEqual((await store.readNoteAudio("note")).bytes, bytes);
  }
  await preserved();
  assert.equal(transcriber.providerFor!("note"), "private");
  assert.equal(transcriber.snapshot().jobs.get("note")?.kind, "cancelled");
  if (mode === "fresh") {
    assert.equal(choices.has("note"), true);
    assert.equal(pending.read("note")?.failure, "cancelled");
    assert.equal(pending.read("note")?.transcriptionId, null);
  }
  restoreDom = installDom();
  const metadata = (await resolveVoiceNoteRow(tcw, "note"))!.metadata;
  const source = { tcw: null, rowExists: true, audioSaved: true, metadata, durationSecs: 2 };
  const item = { id: "row-note", source: "exo-voice-note", sourceId: "note", title: "Synthetic", startedAt: null, durationSecs: 2 };
  let view: NotePipelineView | null = null;
  const viewProvider = () => view?.provider;
  const viewReady = signal();
  const noop = () => {};
  function Probe() {
    view = useNotePipeline("note", source);
    if (view) viewReady.resolve();
    return view ? createElement(Fragment, null,
      createElement(ActivityNoteSection, { item, jobs: activityForNote(view, "web"), onOpenNote: noop, onClose: noop }),
      createElement(NoteDetailView, { item, listStatus: "ready", metadata: { status: "ok", metadata }, transcript: { status: "ok", sentences: [] },
        audio: null, copyState: "idle", onCopy: noop, onRetry: noop, onBack: noop, pushed: false, platform: "web", activityView: view })) : null;
  }
  function Surface() {
    const snapshot = useSyncExternalStore(transcriber.subscribe, transcriber.snapshot, transcriber.snapshot);
    return createElement(MemoryRouter, null, createElement(PlatformContext.Provider, { value: "web" },
      createElement(StaticRecorderProvider, { value: { tcw: null, signIn: null, transcription: transcriptionProps(transcriber, snapshot) } },
        createElement(Probe))));
  }
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(Surface)));
  await viewReady.promise;
  await act(async () => {});
  const selectors = ['[data-testid="activity-transcription-status"] button', '[data-testid="transcription-status"] button'];
  function cancelledActions() {
    assert.equal(viewProvider(), "private");
    for (const selector of selectors) {
      const button = host.querySelector<HTMLButtonElement>(selector)!;
      assert.equal(button.textContent, "Transcribe now");
      assert.equal(button.disabled, false);
    }
  }
  cancelledActions();
  if (stage === "cold") {
    for (const [restart, cancel] of [selectors, [...selectors].reverse()]) {
      resultHeaders = signal();
      await act(async () => { host.querySelector<HTMLButtonElement>(restart!)!.click(); await resultHeaders.promise; });
      assert.equal(transcriber.providerFor!("note"), "private");
      assert.equal(transcriber.snapshot().jobs.get("note")?.kind, "active");
      const cancelled = reached(transcriber, () => {
        const job = transcriber.snapshot().jobs.get("note");
        return job?.kind === "cancelled" && !job.pending;
      });
      await act(async () => { host.querySelector<HTMLButtonElement>(cancel!)!.click(); await cancelled; });
      cancelledActions();
      await preserved();
    }
  }
  console.log("RECOVERY_RESULT", JSON.stringify({ stage, mode, pid: process.pid, provider: transcriber.providerFor!("note"),
    kind: transcriber.snapshot().jobs.get("note")?.kind, viewProvider: viewProvider(), bothActionsEnabled: true }));
} finally {
  for (const stop of subscriptions) stop();
  if (root) await act(async () => root!.unmount());
  restoreDom?.();
  globalThis.fetch = actualFetch;
  sqlite.close();
}
// This child models application shutdown; the long-lived factory retains background maintenance timers.
process.exit(0);
