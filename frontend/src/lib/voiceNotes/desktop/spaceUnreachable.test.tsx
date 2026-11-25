// A Mac recording while the TinyCloud space cannot be reached (the node is down: every space call fails as the SDK
// fails it, NODE_NOT_RESPONDING). The recording is transcribed on the Mac, the user can open and read it, Retry runs
// on the Mac, nothing is lost, no raw error code reaches the screen, and the save to the space happens later by itself,
// once. The real desktop engine, Whisper queue, recorder controller and save pipeline run here; only the native
// commands, the Whisper server and the space are fakes.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { DesktopCaptureHome } from "@/capture/home/desktop/DesktopCaptureHome";
import type { InProgressRowsViewProps } from "@/capture/InProgressRows";
import { readLocalTranscript } from "@/capture/library/NoteDetail";
import { NoteDetailView } from "@/capture/library/NoteDetailView";
import { withOnPhone } from "@/capture/library/onPhone";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { createVoiceNoteRecorderController } from "@/capture/recorder/voiceNoteRecorderController";
import type { TranscriptionEvent } from "@/lib/anarlog/transcription.gen";
import { CONNECTORS_SQL_DB_NAME } from "@/lib/connectors/connectorStore";
import { PlatformContext } from "@/lib/platform";
import { currentAccountGeneration } from "../accountContext";
import { __setVoiceNotesForTests, VoiceNotes, type VoiceNoteRecording } from "../nativeVoiceNotes";
import { pendingStore } from "../recorderSaves";
import { createVoiceNotePipeline } from "../voiceNotePipeline";
import { ensureVoiceNoteIdentity } from "../voiceNoteRows";
import { newIdbEnv } from "../web/testing/idb";
import { memoryLocks } from "../web/webStore";
import { openDesktopVoiceNotes, type DesktopBridge } from "./desktopVoiceNotes";
import { registerDesktopWhisperQueue, type DesktopWhisperBridge } from "./desktopWhisper";
import { activityForNote, noteStatus } from "@/capture/activity/activitySelector";
import { activityNotes } from "@/capture/activity/ActivityPanel";
import { failureNotifications } from "@/capture/activity/failureNotifications";
import type { LibraryItem } from "@/capture/library/LibraryRow";
import { captureAccountContext } from "../accountContext";
import { notePipeline } from "../notePipeline";
import { installTranscriptSyncRetries, onDeviceTranscriptSyncState, syncOnDeviceTranscript, transcriptSyncForPipeline } from "../onDeviceTranscriber";
import { buildNotePipelineInput, type NotePipelineView } from "../useNotePipeline";

const originalVoiceNotes = VoiceNotes;
afterEach(() => {
  __setVoiceNotesForTests(originalVoiceNotes, { available: null });
  registerDesktopWhisperQueue(null);
  pendingStore.setAccount(null);
});

/** What the SDK returns for every space call while the node is down. */
const NODE_DOWN = { code: "NODE_NOT_RESPONDING", message: "The place your data is stored isn't responding right now. Please try again." };
const SPOKEN = "Book the venue for Friday";
/** Fast retries. A space call abandoned at its deadline earlier (another suite's) makes a retry wait for a drain probe first. */
const PIPELINE_TIMING = { retryDelaysMs: [], saveRetryDelaysMs: [25], drainProbeBackoffMs: 25, drainProbeTimeoutMs: 500 };
/** The real engine, queue and pipeline run on real timers here. */
const SLOW = 30_000;

let spaces = 0;
/** A space that answers like the real one until `down` is set; then every call fails as the SDK fails it. */
function space() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:space-unreachable-${++spaces}`;
  const state = { down: false, refused: 0 };
  const refuse = () => { state.refused++; return { ok: false as const, error: { ...NODE_DOWN } }; };
  const sql = {
    db(name: string) {
      expect(name).toBe(CONNECTORS_SQL_DB_NAME);
      return {
        async query(statement: string, params: unknown[] = []) {
          if (state.down) return refuse();
          try { return { ok: true, data: { rows: sqlite.prepare(statement).all(...params as never[]).map((r) => Object.values(r as object)) } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
        async execute(statement: string, params: unknown[] = []) {
          if (state.down) return refuse();
          try { return { ok: true, data: { changes: sqlite.prepare(statement).run(...params as never[]).changes } }; }
          catch (e) { return { ok: false, error: { code: "SQL_ERROR", message: String(e) } }; }
        },
      };
    },
  };
  const kv = {
    async put(key: string, value: string, options?: { ifNoneMatch?: string }) {
      if (state.down) return refuse();
      if (options?.ifNoneMatch === "*" && values.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "412" } };
      values.set(key, value);
      return { ok: true, data: {} };
    },
    async get(key: string) {
      if (state.down) return refuse();
      return values.has(key) ? { ok: true, data: { data: values.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
    },
    async list({ path }: { path: string }) {
      if (state.down) return refuse();
      return { ok: true, data: { keys: [...values.keys()].filter((key) => key.startsWith(path)), truncated: false } };
    },
  };
  const tcw = { did, spaceId: did, sql, kv } as unknown as TinyCloudWeb;
  const rows = (table: string, id: string) =>
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE source_id = ?`).get(id) as { n: number }).n;
  return { tcw, did, state, rows };
}

/** The Tauri commands the recorder and the Whisper queue use, over in-memory files. */
class FakeBridge implements DesktopBridge {
  files = new Map<string, Uint8Array>();
  current: string | null = null;
  state: "idle" | "recording" = "idle";
  elapsed = 0;
  now = Date.now();
  stopped: { id: string; startedAt: number; recordedMs: number; pausedMs: number; maxDurationMs: number }[] = [];
  listeners = new Map<string, Set<(payload: never) => void>>();
  emit(event: string, payload: unknown) { for (const callback of this.listeners.get(event) ?? []) callback(payload as never); }
  status() {
    return { state: this.state, reason: null, id: this.current, startedAt: this.current ? this.now : null,
      elapsedMs: this.elapsed, audioMs: this.elapsed, channels: 1, pausedMs: 0, maxDurationMs: 3 * 60 * 60_000,
      intent: this.state === "idle" ? "stopped" : "recording", availability: "available", at: this.now, elapsedAt: this.now,
      spans: [], captureSourceUnconfirmed: false, discardCleanupPending: false };
  }
  async listen<T>(event: string, callback: (payload: T) => void): Promise<() => void> {
    const set = this.listeners.get(event) ?? new Set();
    set.add(callback as (payload: never) => void);
    this.listeners.set(event, set);
    return () => set.delete(callback as (payload: never) => void);
  }
  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = String(args.id ?? "");
    let result: unknown = null;
    switch (command) {
      case "recorder_models_get": result = "QuantizedTinyEn"; break;
      case "recorder_models_list": result = [{ id: "QuantizedTinyEn", downloaded: true }]; break;
      case "recorder_recover": result = { journal: null, stopped: this.stopped, quarantined: [] }; break;
      case "recorder_stopped_list": result = this.stopped.map((entry) => entry.id); break;
      case "recorder_failed_list": result = []; break;
      case "recorder_acknowledge": this.stopped = this.stopped.filter((entry) => entry.id !== id); break;
      case "recorder_status": result = this.status(); break;
      case "recorder_list_inputs": result = { inputs: [{ id: "mic-1", name: "Fixture microphone", kind: "built_in" }],
        selectedId: null, activeId: "mic-1", selectedMissing: null }; break;
      case "recorder_set_max_duration": case "recorder_select_input": break;
      case "recorder_start":
        this.current = id; this.state = "recording"; result = this.status();
        this.emit("exo://recorder-mic-state", result); break;
      case "recorder_stop_durable":
        if (this.current) this.stopped.push({ id: this.current, startedAt: this.now, recordedMs: this.elapsed, pausedMs: 0,
          maxDurationMs: 3 * 60 * 60_000 });
        // falls through
      case "recorder_stop":
        result = { ...this.status(), state: "idle", intent: "stopped", reason: null };
        this.state = "idle"; this.current = null; this.elapsed = 0;
        this.emit("exo://recorder-mic-state", this.status()); break;
      case "recorder_finish": case "audio_file_size": case "finalize_audio_file": result = this.files.get(id)?.length ?? 0; break;
      case "read_audio_chunk":
        result = (this.files.get(id) ?? new Uint8Array()).slice(Number(args.offset), Number(args.offset) + Number(args.len)); break;
      case "recorder_whisper_stage_audio":
        this.files.set(String(args.stageId), (this.files.get(id) ?? new Uint8Array()).slice()); break;
      case "recorder_whisper_cleanup_stages":
        for (const key of [...this.files.keys()]) if (key.startsWith("whisper-")) this.files.delete(key);
        result = 0; break;
      case "delete_audio_file": this.files.delete(id); break;
      default: throw new Error(`Unexpected command ${command}`);
    }
    return result as T;
  }
}

/** The local Whisper server: it answers with SPOKEN, or fails while `fail` is set. */
class FakeWhisper implements DesktopWhisperBridge {
  serverScope = {};
  fail = false;
  starts: string[] = [];
  listeners = new Set<(event: TranscriptionEvent) => void>();
  async startServer() { return "http://127.0.0.1:0"; }
  async stopServer() {}
  async onTranscription(cb: (event: TranscriptionEvent) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  async startTranscription(params: { id: string }) {
    this.starts.push(params.id);
    queueMicrotask(() => this.emit(this.fail
      ? { type: "failed", session_id: params.id, code: "unknown", error: "fixture failed" }
      : { type: "completed", session_id: params.id, mode: "direct",
        response: { metadata: null, results: { channels: [{ alternatives: [{ transcript: SPOKEN, confidence: 1 }] }] } } } as TranscriptionEvent));
  }
  async stopTranscription(id: string) { this.emit({ type: "stopped", session_id: id } as TranscriptionEvent); }
  emit(event: TranscriptionEvent) { for (const cb of this.listeners) cb(event); }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return true; await Bun.sleep(5); }
  return false;
}

/** A signed-in Mac whose space worked once (identity established, as on the owner's Mac) and is now down. */
async function mac(options: { identityEstablished?: boolean } = {}) {
  const s = space();
  const bridge = new FakeBridge();
  const whisper = new FakeWhisper();
  const engine = await openDesktopVoiceNotes({ bridge, whisper, now: () => bridge.now,
    storeOptions: { env: newIdbEnv(), dbName: crypto.randomUUID(), locks: memoryLocks(), decodeCheck: null } });
  __setVoiceNotesForTests(engine.plugin, { available: true });
  await engine.plugin.setCaptureDefaults({ accountDid: s.did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false, uploadAudio: true });
  pendingStore.setAccount(s.did);
  if (options.identityEstablished !== false) expect((await ensureVoiceNoteIdentity(s.tcw)).status).toBe("established");
  s.state.down = true;
  const pipeline = createVoiceNotePipeline(s.tcw, PIPELINE_TIMING);
  const recorder = createVoiceNoteRecorderController({ tcw: s.tcw, available: true, transcriber: null, pipeline, onDeviceReady: () => true });
  const detach = recorder.attach();
  expect(await waitFor(() => recorder.getState().ready)).toBe(true);
  const recordAndStop = async (): Promise<string> => {
    await recorder.record();
    const id = bridge.current!;
    expect(id).toBeTruthy();
    bridge.files.set(id, Uint8Array.from({ length: 64 }, (_, index) => index));
    bridge.elapsed = 8_000;
    await recorder.stop();
    return id;
  };
  const dispose = () => { detach(); pipeline.cancelAll(); engine.dispose(); };
  return { ...s, bridge, whisper, engine, pipeline, recorder, recordAndStop, dispose };
}

const pendingOf = async (id: string): Promise<VoiceNoteRecording | undefined> =>
  (await VoiceNotes.listPending()).recordings.find((note) => note.id === id);

/** What the desktop Capture home shows, rendered as CaptureSurface renders it from the pending store and this Mac's notes. */
function captureHome() {
  const pending = pendingStore.snapshot();
  const inProgress: InProgressRowsViewProps = {
    upload: null, paused: null, meetings: [], busyId: null,
    voice: { listing: pending.listing, saving: pending.running, online: pending.online, pendingNotes: pending.notes ?? [],
      lastError: pending.lastError, limitNotice: null, onSaveNow: () => {} },
    onOpenUpload: () => {}, onContinue: () => {}, onOpenMeeting: () => {}, onEnd: () => {},
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PlatformContext.Provider value="tauri">
        <StaticRecorderProvider value={{}}>
          <DesktopCaptureHome tcw={{} as TinyCloudWeb} backendUrl="http://localhost" sessionStore={{} as SessionStore}
            layout="desktop" inProgress={inProgress} recent={{ status: "failed", items: withOnPhone([], pending.notes ?? []) }}
            onRetryRecent={() => {}} onUpload={() => {}} now={new Date()} />
        </StaticRecorderProvider>
      </PlatformContext.Provider>
    </MemoryRouter>,
  );
  const text = (fragment: string | undefined) => fragment?.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim() ?? null;
  return {
    html,
    /** The In progress card's second line. */
    card: text(/data-testid="voice-note-pending-note">(.*?)<\/span>/.exec(html)?.[1]),
    /** The Recent row's visible words. */
    row: text(/data-testid="recent-item"[^>]*>(.*?)<\/li>/.exec(html)?.[1]),
    retry: html.includes('data-testid="recent-whisper-retry"'),
    failedTile: /data-testid="recent-item".*?data-failed="true"/.test(html),
  };
}

/** The open note as NoteDetail shows a note that is only on this Mac (useLibrary's stand-in reads). */
async function openNote(id: string): Promise<string> {
  const note = pendingStore.snapshot().notes?.find((entry) => entry.id === id);
  expect(note).toBeDefined();
  const [item] = withOnPhone([], [note!]);
  const local = await readLocalTranscript(id);
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PlatformContext.Provider value="tauri">
        <NoteDetailView item={item!} listStatus="failed" metadata={{ status: "ok", metadata: {} }}
          transcript={{ status: "absent" }} localTranscript={local.transcript} localTranscriptRead={local.readError}
          audio={{ load: async () => null, onPhone: true }} desktopWhisper copyState="idle" onCopy={() => {}} onRetry={() => {}}
          pushed onBack={() => {}} platform="tauri" />
      </PlatformContext.Provider>
    </MemoryRouter>,
  );
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

/** The note and its transcript reach the space once, with no user action, after the node comes back. */
async function savedOnceWhenBack(m: Awaited<ReturnType<typeof mac>>, id: string, whisperRuns = 1): Promise<void> {
  m.state.down = false;
  expect(await waitFor(async () => (await pendingOf(id))?.ledger?.audio.state === "saved")).toBe(true);
  expect(await waitFor(() => m.rows("voice_note_transcript", id) === 1)).toBe(true);
  await Bun.sleep(150);
  expect(m.rows("connector_meeting", id)).toBe(1);
  expect(m.rows("voice_note_transcript", id)).toBe(1);
  expect(m.whisper.starts.filter((started) => started === id)).toHaveLength(whisperRuns);
  expect(pendingStore.snapshot().notes?.some((note) => note.id === id)).toBe(false);
}

describe("a Mac recording while the TinyCloud space is unreachable", () => {
  test("Stop transcribes on the Mac, the note opens with its text, and the save retries by itself and lands once", async () => {
    const m = await mac();
    try {
      const id = await m.recordAndStop();
      // Transcribed on this Mac, whatever the space does.
      expect(await waitFor(() => m.engine.whisper!.snapshot().get(id)?.state === "done")).toBe(true);
      expect((await readLocalTranscript(id)).transcript?.segments.map((segment) => segment.text).join(" ")).toContain(SPOKEN);
      // The first save met the dead node; the recording is kept on this Mac and not marked saved.
      expect(await waitFor(() => m.state.refused > 0 && !pendingStore.snapshot().running)).toBe(true);
      expect(await waitFor(() => pendingStore.snapshot().notes?.some((note) => note.id === id) === true)).toBe(true);
      expect((await pendingOf(id))?.ledger?.audio.state).not.toBe("saved");
      // Capture: the card says the note is not in the space yet, in words; the Recent row is a normal row on this Mac.
      const home = captureHome();
      expect(home.card).toBe("Not in your space yet");
      expect(home.row).toContain("On this Mac");
      expect(home.row).not.toContain("Couldn’t transcribe");
      expect(home.retry).toBe(false);
      expect(home.failedTile).toBe(false);
      expect(home.html).not.toContain("NODE_NOT_RESPONDING");
      // Opening the note shows the transcript made on this Mac.
      const page = await openNote(id);
      expect(page).toContain(SPOKEN);
      expect(page).not.toContain("NODE_NOT_RESPONDING");
      // With no action by the user, the save is tried again while the node stays down.
      const refusedBefore = m.state.refused;
      expect(await waitFor(() => m.state.refused > refusedBefore, 1_500)).toBe(true);
      expect(captureHome().html).not.toContain("NODE_NOT_RESPONDING");
      await savedOnceWhenBack(m, id);
    } finally { m.dispose(); }
  }, SLOW);

  test("a Mac that never reached its space before keeps retrying the save by itself", async () => {
    const m = await mac({ identityEstablished: false });
    try {
      const id = await m.recordAndStop();
      expect(await waitFor(() => m.engine.whisper!.snapshot().get(id)?.state === "done")).toBe(true);
      expect(await waitFor(() => m.state.refused > 0 && !pendingStore.snapshot().running)).toBe(true);
      expect(captureHome().card).toBe("Not in your space yet");
      const refusedBefore = m.state.refused;
      expect(await waitFor(() => m.state.refused > refusedBefore, 1_500)).toBe(true);
      await savedOnceWhenBack(m, id);
    } finally { m.dispose(); }
  }, SLOW);

  test("after a relaunch, a note left on this Mac is retried by itself once the open's save pass meets the dead node", async () => {
    const m = await mac({ identityEstablished: false });
    try {
      const id = await m.recordAndStop();
      expect(await waitFor(() => m.engine.whisper!.snapshot().get(id)?.state === "done")).toBe(true);
      expect(await waitFor(() => m.state.refused > 0 && !pendingStore.snapshot().running)).toBe(true);
      // The app closes (its retries end with it) and opens again: only the open's save pass knows about the note.
      m.pipeline.cancelAll();
      const reopened = createVoiceNotePipeline(m.tcw, PIPELINE_TIMING);
      try {
        const ctx = { did: m.did, spaceId: m.did, generation: currentAccountGeneration() };
        const refusedAtOpen = m.state.refused;
        // The pass may wait for the node to drain calls abandoned earlier; it is not awaited, as the app does not.
        const pass = reopened.reconcileAll(ctx, "reconcile").catch(() => undefined);
        expect(await waitFor(() => m.state.refused > refusedAtOpen)).toBe(true);
        await Bun.sleep(50);
        expect(captureHome().html).not.toContain("NODE_NOT_RESPONDING");
        const refusedBefore = m.state.refused;
        expect(await waitFor(() => m.state.refused > refusedBefore, 1_500)).toBe(true);
        await savedOnceWhenBack(m, id);
        await pass;
      } finally { reopened.cancelAll(); }
    } finally { m.dispose(); }
  }, SLOW);

  test("Retry on a failed Mac transcription runs on the Mac while the space is down", async () => {
    const m = await mac();
    try {
      m.whisper.fail = true;
      const id = await m.recordAndStop();
      expect(await waitFor(() => m.engine.whisper!.snapshot().get(id)?.state === "failed")).toBe(true);
      expect(captureHome().retry).toBe(true);
      m.whisper.fail = false;
      await m.engine.whisper!.retry(id);
      expect(await waitFor(() => m.engine.whisper!.snapshot().get(id)?.state === "done")).toBe(true);
      expect(m.state.down).toBe(true);
      expect(await openNote(id)).toContain(SPOKEN);
      const home = captureHome();
      expect(home.retry).toBe(false);
      expect(home.failedTile).toBe(false);
      expect(home.html).not.toContain("NODE_NOT_RESPONDING");
      expect(m.rows("connector_meeting", id)).toBe(0);
      await savedOnceWhenBack(m, id, 2);
    } finally { m.dispose(); }
  }, SLOW);
});

describe("a saved Mac note when the app opens while the TinyCloud space is down", () => {
  const item = (id: string): LibraryItem => ({ id: `vn-${id}`, source: "exo-voice-note", sourceId: id, title: "A voice note", startedAt: null, durationSecs: 8 });
  /** The note as the app shows it, from what this Mac knows: its space row (with the transcript), its Whisper job, its transcript write. */
  const shown = (m: Awaited<ReturnType<typeof mac>>, id: string) => {
    const input = buildNotePipelineInput({ id, device: "mac", online: true, saved: true, localNote: null, native: null, pending: null,
      rowMetadata: { audio: { stored: true }, capture: { options: { transcriber: "on-device" } }, transcript_text: SPOKEN },
      capture: { finalizing: false, issue: null }, lane: { busy: false, depth: 0 }, onDeviceStatus: null, cloudJob: null,
      desktopJob: m.engine.whisper!.snapshot().get(id) ?? null, transcriptSync: transcriptSyncForPipeline(m.tcw, id),
      noteSync: { syncing: false, failed: false, skip: null, syncedAt: null, attempting: false } });
    const view: NotePipelineView = { input, pipeline: notePipeline(input), provider: "local", route: input.route,
      onAction: () => {}, onRetryStep: () => {}, actionError: null };
    const views = new Map([[id, view]]);
    return {
      jobs: activityForNote(view, "tauri"),
      /** The notes the Activity panel lists (and counts on its button). */
      activity: activityNotes([item(id)], views, "tauri"),
      /** The Library row's status line. */
      rowStatus: noteStatus(activityForNote(view, "tauri"), view.pipeline),
      notifications: failureNotifications([item(id)], views, "tauri"),
    };
  };
  const nothingShown = { jobs: [], activity: [], rowStatus: null, notifications: [] };

  test("Activity has no line for it, its row status is empty, and the check settles by itself when the space answers", async () => {
    const m = await mac();
    // As PendingVoiceNotesSaver runs them for the signed-in account; spaced out for the test.
    const stopRetries = installTranscriptSyncRetries({ delaysMs: [40] });
    try {
      // A note recorded and transcribed on this Mac, saved with its transcript once the space answered.
      const id = await m.recordAndStop();
      expect(await waitFor(() => m.engine.whisper!.snapshot().get(id)?.state === "done")).toBe(true);
      await savedOnceWhenBack(m, id);
      expect(await waitFor(() => onDeviceTranscriptSyncState(m.tcw, id)?.state === "synced")).toBe(true);
      expect(shown(m, id)).toEqual(nothingShown);
      // The node goes down. The app opens again: its saver hands every finished Mac transcript back to the write, which
      // first checks the space against this Mac's record that the transcript is saved. The check cannot reach the space.
      m.state.down = true;
      const refusedBefore = m.state.refused;
      const note = await pendingOf(id);
      expect(note?.ledger?.transcriptSync?.state).toBe("saved");
      await syncOnDeviceTranscript(m.tcw, note!, captureAccountContext(m.tcw));
      expect(m.state.refused).toBeGreaterThan(refusedBefore);
      // Nothing of the user's waits: no Activity line or count, no row status, no notification.
      expect(shown(m, id)).toEqual(nothingShown);
      // While the node stays down the check is tried again, by itself, and still shows nothing.
      const refusedWhileDown = m.state.refused;
      expect(await waitFor(() => m.state.refused > refusedWhileDown, 1_500)).toBe(true);
      expect(shown(m, id)).toEqual(nothingShown);
      // The node comes back: the check settles with no action, and nothing is written twice or transcribed again.
      m.state.down = false;
      expect(await waitFor(() => onDeviceTranscriptSyncState(m.tcw, id)?.state === "synced")).toBe(true);
      expect(shown(m, id)).toEqual(nothingShown);
      expect(m.rows("voice_note_transcript", id)).toBe(1);
      expect(m.whisper.starts.filter((started) => started === id)).toHaveLength(1);
    } finally { stopRetries(); m.dispose(); }
  }, SLOW);
});
