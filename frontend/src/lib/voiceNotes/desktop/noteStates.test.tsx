// Every state of a Mac voice note between Stop and "transcript readable and note saved", with the TinyCloud space
// reachable and unreachable, and what four places say in each: the Recent row on Capture, the In progress card, the
// note page's header line and its Transcript section. Each says the step the app is really in, as one status line;
// a step on this Mac never claims to wait for the space. A reload at any state shows the same state again, and the
// work goes on without loss or repeat. The real desktop engine, Whisper queue, recorder controller, save pipeline
// and note pipeline run here; the native commands, the Whisper server and the space are fakes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { act, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { RecentView } from "@/capture/home/desktop/DesktopCaptureHome";
import { homePlace } from "@/capture/home/desktop/desktopCopy";
import { pendingNote } from "@/capture/home/desktop/desktopRecent";
import type { LibraryItem } from "@/capture/library/LibraryRow";
import { readLocalTranscript } from "@/capture/library/NoteDetail";
import { Transcript } from "@/capture/library/NoteDetailView";
import { withOnPhone } from "@/capture/library/onPhone";
import { savedNoteStatusLine } from "@/capture/library/savedNote/SavedNote";
import { NotePipelineContext } from "@/capture/pipeline/NotePipelineContext";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { createVoiceNoteRecorderController } from "@/capture/recorder/voiceNoteRecorderController";
import type { TranscriptionEvent } from "@/lib/anarlog/transcription.gen";
import { CONNECTORS_SQL_DB_NAME } from "@/lib/connectors/connectorStore";
import { PlatformContext } from "@/lib/platform";
import { installDom } from "@/test/dom";
import { currentAccountGeneration } from "../accountContext";
import { __resetCaptureEngineForTests, __setInstalledEngineForTests } from "../captureEngine";
import { installVoiceNotesEngine, VoiceNotes, type LocalTranscript, type VoiceNoteRecording } from "../nativeVoiceNotes";
import { pendingStore } from "../recorderSaves";
import { useNotePipeline, type NotePipelineSource } from "../useNotePipeline";
import { createVoiceNotePipeline } from "../voiceNotePipeline";
import { ensureVoiceNoteIdentity } from "../voiceNoteRows";
import { VOICE_NOTE_SOURCE } from "../voiceNoteStore";
import { newIdbEnv } from "../web/testing/idb";
import { memoryLocks } from "../web/webStore";
import type { IdbEnv } from "../web/idb";
import { openDesktopVoiceNotes, type DesktopBridge } from "./desktopVoiceNotes";
import { registerDesktopWhisperQueue, type DesktopWhisperBridge } from "./desktopWhisper";

const NODE_DOWN = { code: "NODE_NOT_RESPONDING", message: "The place your data is stored isn't responding right now. Please try again." };
const SPOKEN = "Book the venue for Friday";
const MODEL = "QuantizedTinyEn";
const SLOW = 30_000;
const TIMING = { retryDelaysMs: [], saveRetryDelaysMs: [25], drainProbeBackoffMs: 25, drainProbeTimeoutMs: 500 };

/** A held step: `hold()` makes the next call wait until `release()`. */
function gate() {
  let open: (() => void) | null = null;
  let promise: Promise<void> | null = null;
  return {
    hold() { promise = new Promise<void>((resolve) => { open = resolve; }); },
    release() { open?.(); promise = null; open = null; },
    wait: () => promise ?? Promise.resolve(),
    get held() { return promise !== null; },
  };
}

let spaces = 0;
/** The space: answers like the real one, or fails every call as the SDK does while the node is down. Audio puts can be held. */
function space() {
  const sqlite = new Database(":memory:");
  const values = new Map<string, string>();
  const did = `did:test:note-states-${++spaces}`;
  const state = { down: false, refused: 0 };
  const audioPut = gate();
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
      if (key.includes("/audio/")) await audioPut.wait();
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
  const rows = (table: string, id: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE source_id = ?`).get(id) as { n: number }).n;
  const row = (id: string): LibraryItem | null => {
    const found = sqlite.prepare("SELECT id, metadata FROM connector_meeting WHERE source_id = ?").get(id) as { id: string; metadata: string } | null;
    return found ? { id: found.id, source: VOICE_NOTE_SOURCE, sourceId: id, title: null, startedAt: new Date().toISOString(),
      durationSecs: 8, metadata: JSON.parse(found.metadata) as Record<string, unknown> } : null;
  };
  return { tcw, did, state, audioPut, rows, row };
}

/** The Tauri commands, over in-memory files. Stop and finishing can be held; recovery after a reload can be held. */
class FakeBridge implements DesktopBridge {
  files = new Map<string, Uint8Array>();
  current: string | null = null;
  state: "idle" | "recording" = "idle";
  elapsed = 0;
  now = Date.now();
  selectedModel: string | null = MODEL;
  stopped: { id: string; startedAt: number; recordedMs: number; pausedMs: number; maxDurationMs: number }[] = [];
  stop = gate();
  finish = gate();
  recover = gate();
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
      case "recorder_models_get": result = this.selectedModel; break;
      case "recorder_models_list": result = this.selectedModel ? [{ id: this.selectedModel, downloaded: true }] : []; break;
      case "recorder_recover": await this.recover.wait(); result = { journal: null, stopped: this.stopped, quarantined: [] }; break;
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
        await this.stop.wait();
        if (this.current) this.stopped.push({ id: this.current, startedAt: this.now, recordedMs: this.elapsed, pausedMs: 0,
          maxDurationMs: 3 * 60 * 60_000 });
        // falls through
      case "recorder_stop":
        result = { ...this.status(), state: "idle", intent: "stopped", reason: null };
        this.state = "idle"; this.current = null; this.elapsed = 0;
        this.emit("exo://recorder-mic-state", this.status()); break;
      case "recorder_finish": await this.finish.wait(); result = this.files.get(id)?.length ?? 0; break;
      case "audio_file_size": case "finalize_audio_file": result = this.files.get(id)?.length ?? 0; break;
      case "read_audio_chunk":
        result = (this.files.get(id) ?? new Uint8Array()).slice(Number(args.offset), Number(args.offset) + Number(args.len)); break;
      case "recorder_whisper_stage_audio": this.files.set(String(args.stageId), (this.files.get(id) ?? new Uint8Array()).slice()); break;
      case "recorder_whisper_cleanup_stages":
        for (const key of [...this.files.keys()]) if (key.startsWith("whisper-")) this.files.delete(key);
        result = 0; break;
      case "delete_audio_file": this.files.delete(id); break;
      default: throw new Error(`Unexpected command ${command}`);
    }
    return result as T;
  }
}

/** The local Whisper server. It answers when told to; it outlives a page reload, as the Rust side does. */
class FakeWhisper implements DesktopWhisperBridge {
  serverScope = {};
  starts: string[] = [];
  listeners = new Set<(event: TranscriptionEvent) => void>();
  async startServer() { return "http://127.0.0.1:0"; }
  async stopServer() {}
  async onTranscription(cb: (event: TranscriptionEvent) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  async startTranscription(params: { id: string }) { this.starts.push(params.id); }
  async stopTranscription(id: string) { this.emit({ type: "stopped", session_id: id } as TranscriptionEvent); }
  progress(id: string, fraction: number) {
    this.emit({ type: "progress", session_id: id, event: { type: "progress", percentage: fraction } } as unknown as TranscriptionEvent);
  }
  complete(id: string) {
    this.emit({ type: "completed", session_id: id, mode: "direct",
      response: { metadata: null, results: { channels: [{ alternatives: [{ transcript: SPOKEN, confidence: 1 }] }] } } } as TranscriptionEvent);
  }
  emit(event: TranscriptionEvent) { for (const cb of [...this.listeners]) cb(event); }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await act(async () => { await Bun.sleep(5); });
  }
  return false;
}

/** What the four places say. `recent` is the Recent row's state line; `control` the button beside it; `alert` its "!". */
interface Places { recent: string | null; control: string | null; alert: boolean; card: string | null; header: string | null; transcript: string | null }

/** The four places, wired as CaptureSurface wires them: the pending store, the note pipeline, the Whisper queue, the local transcript. */
function PlacesView(props: { id: string; tcw: TinyCloudWeb; row: () => LibraryItem | null }) {
  const pending = useSyncExternalStore(pendingStore.subscribe, pendingStore.snapshot, pendingStore.snapshot);
  const note = pending.notes?.find((entry) => entry.id === props.id) ?? null;
  const spaceRow = note ? null : props.row();
  const item: LibraryItem | null = note ? withOnPhone([], [note])[0]! : spaceRow;
  const metadata = item?.onPhone ? {} : item?.metadata ?? {};
  const source = useMemo<NotePipelineSource>(() => ({ tcw: props.tcw, rowExists: item !== null && !item.onPhone,
    audioSaved: item !== null && !item.onPhone, metadata, durationSecs: 8 }), [props.tcw, item?.onPhone, JSON.stringify(metadata)]);
  const view = useNotePipeline(item ? props.id : null, source);
  const [local, setLocal] = useState<{ transcript: LocalTranscript | null; readError: "timeout" | "failed" | null } | undefined>();
  useEffect(() => {
    let live = true;
    const read = () => void readLocalTranscript(props.id).then((result) => { if (live) setLocal(result); });
    read();
    const timer = setInterval(read, 20);
    return () => { live = false; clearInterval(timer); };
  }, [props.id]);
  const count = pending.listing.state === "ok" ? pending.listing.count : 0;
  return (
    <MemoryRouter>
      <div data-place="recent">
        {item && <RecentView status="ready" items={[item]} issues={{}} filter="all" pipelines={view ? new Map([[props.id, view.pipeline]]) : undefined}
          onFilter={() => {}} onRetry={() => {}} onDismiss={() => true} onOpenIssue={() => {}} now={new Date()} />}
      </div>
      <div data-place="card">{count > 0 ? pendingNote({}, pending.lastError, homePlace("tauri"), pending.running) : null}</div>
      <div data-place="header">{item ? savedNoteStatusLine(view, "tauri") : null}</div>
      <div data-place="transcript">
        {item && (
          <NotePipelineContext.Provider value={view}>
            <Transcript item={item} listStatus="ready" metadata={{ status: "ok", metadata }} transcript={{ status: "absent" }}
              localTranscript={local?.transcript} localTranscriptRead={local?.readError ?? null}
              audio={{ load: async () => null, onPhone: true }} activityView={view ?? undefined} platform="tauri"
              copyState="idle" onCopy={() => {}} onRetry={() => {}} pushed onBack={() => {}} />
          </NotePipelineContext.Provider>
        )}
      </div>
    </MemoryRouter>
  );
}

function readPlaces(host: HTMLElement): Places {
  const place = (name: string) => host.querySelector(`[data-place="${name}"]`)!;
  const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() || null;
  const row = place("recent").querySelector('[data-testid="recent-item"]');
  const transcript = place("transcript").cloneNode(true) as Element;
  for (const heading of transcript.querySelectorAll("h2, button")) heading.remove();
  return {
    recent: text(row?.querySelector(".soft-row-meta")),
    control: text(row?.querySelector(".dch-dismiss")),
    alert: row?.querySelector('[data-failed="true"]') != null,
    card: text(place("card")),
    header: text(place("header")),
    transcript: text(transcript),
  };
}

/** One page of the Mac app over the stores that outlive it (IndexedDB, the native files, the Whisper server, the space). */
async function openPage(world: World) {
  const engine = await openDesktopVoiceNotes({ bridge: world.bridge, whisper: world.whisper, now: () => world.bridge.now,
    storeOptions: { env: world.env, dbName: world.dbName, locks: memoryLocks(), decodeCheck: null } });
  installVoiceNotesEngine(engine.plugin);
  __setInstalledEngineForTests("tauri", engine.plugin.capabilities);
  pendingStore.setAccount(world.space.did);
  // As installDesktopEngine does at launch: recover, then resume the Whisper queue. Not awaited: recovery may be held.
  const booted = (async () => { await engine.recoverInterrupted(); await engine.whisper?.resume(); })();
  const pipeline = createVoiceNotePipeline(world.space.tcw, TIMING);
  const recorder = createVoiceNoteRecorderController({ tcw: world.space.tcw, available: true, transcriber: null, pipeline, onDeviceReady: () => true });
  const detach = recorder.attach();
  // The app's save pass when it opens (PendingVoiceNotesSaver): not awaited, as the app does not.
  const ctx = { did: world.space.did, spaceId: world.space.did, generation: currentAccountGeneration() };
  void booted.then(() => pipeline.reconcileAll(ctx, "reconcile")).catch(() => undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  return { engine, pipeline, recorder, detach, host, root, booted,
    async close() {
      await act(async () => root.unmount());
      host.remove();
      detach(); pipeline.cancelAll(); engine.dispose();
      registerDesktopWhisperQueue(null);
      pendingStore.setAccount(null);
    } };
}

interface World {
  space: ReturnType<typeof space>;
  bridge: FakeBridge;
  whisper: FakeWhisper;
  env: IdbEnv;
  dbName: string;
  page: Awaited<ReturnType<typeof openPage>>;
}

async function world(spaceDown: boolean): Promise<World> {
  const w = { space: space(), bridge: new FakeBridge(), whisper: new FakeWhisper(), env: newIdbEnv(), dbName: crypto.randomUUID() } as World;
  // Signed in from before: the account and the space's identity are known on this Mac.
  const boot = await openDesktopVoiceNotes({ bridge: w.bridge, whisper: w.whisper, now: () => w.bridge.now,
    storeOptions: { env: w.env, dbName: w.dbName, locks: memoryLocks(), decodeCheck: null } });
  await boot.plugin.setCaptureDefaults({ accountDid: w.space.did, transitionGen: 1, transcriber: "on-device", identifySpeakers: false, uploadAudio: true });
  boot.dispose();
  registerDesktopWhisperQueue(null);
  expect((await ensureVoiceNoteIdentity(w.space.tcw)).status).toBe("established");
  w.space.state.down = spaceDown;
  w.page = await openPage(w);
  expect(await waitFor(() => w.page.recorder.getState().ready)).toBe(true);
  return w;
}

async function show(w: World, id: string): Promise<void> {
  await act(async () => w.page.root.render(
    <PlatformContext.Provider value="tauri">
      <StaticRecorderProvider value={{ tcw: w.space.tcw, signIn: null, transcription: undefined }}>
        <PlacesView id={id} tcw={w.space.tcw} row={() => w.space.row(id)} />
      </StaticRecorderProvider>
    </PlatformContext.Provider>,
  ));
}

/** Waits until the four places match `expected` (a string must be equal, a RegExp must match), and returns what they say. */
async function expectPlaces(w: World, expected: { [K in keyof Places]?: Places[K] | RegExp }): Promise<Places> {
  const matches = (places: Places) => Object.entries(expected).every(([key, want]) => {
    const got = places[key as keyof Places];
    return want instanceof RegExp ? typeof got === "string" && want.test(got) : got === want;
  });
  await waitFor(() => matches(readPlaces(w.page.host)), 3_000);
  const places = readPlaces(w.page.host);
  for (const [key, want] of Object.entries(expected)) {
    const got = places[key as keyof Places];
    if (want instanceof RegExp) expect({ [key]: got }).toEqual({ [key]: expect.stringMatching(want) });
    else expect({ [key]: got }).toEqual({ [key]: want });
  }
  // The rule for every state: no raw error codes, and no "waits for the space" for a transcript made on this Mac.
  for (const text of Object.values(places)) {
    if (typeof text !== "string") continue;
    expect(text).not.toContain("NODE_NOT_RESPONDING");
    expect(text).not.toMatch(/(?:saved to|once this note is in) your space/);
  }
  return places;
}

/** Record and Stop through the real controller; Stop is held at the native durable stop until `release`. */
async function record(w: World, options: { holdStop?: boolean; holdFinish?: boolean } = {}): Promise<{ id: string; stopped: Promise<void> }> {
  if (options.holdStop) w.bridge.stop.hold();
  if (options.holdFinish) w.bridge.finish.hold();
  // The receipt of the last recording is closed first, as Record needs.
  w.page.recorder.dismissOutcome();
  await w.page.recorder.record();
  const id = w.bridge.current!;
  expect(id).toBeTruthy();
  w.bridge.files.set(id, Uint8Array.from({ length: 64 }, (_, index) => index));
  w.bridge.elapsed = 8_000;
  const stopped = w.page.recorder.stop().then(() => undefined);
  return { id, stopped };
}

/** A page reload: every app-side object goes, and a new page opens over the same stores. */
async function reload(w: World, options: { holdRecovery?: boolean } = {}): Promise<void> {
  if (options.holdRecovery) w.bridge.recover.hold();
  await w.page.close();
  w.page = await openPage(w);
}

const pendingOf = async (id: string): Promise<VoiceNoteRecording | undefined> =>
  (await VoiceNotes.listPending()).recordings.find((note) => note.id === id);

let cleanDom: (() => void) | undefined;
let current: World | null = null;
beforeEach(() => {
  cleanDom = installDom({});
  // The audio goes to the space too, so the upload is a step of its own.
  localStorage.setItem("exo.voiceNotes.uploadAudio", "1");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {
    metadata: { currentWindow: { label: "main" } }, transformCallback: () => 1, invoke: async () => 1 } });
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { configurable: true, value: { unregisterListener: () => undefined } });
});
afterEach(async () => {
  if (current) await current.page.close();
  current = null;
  __resetCaptureEngineForTests();
  cleanDom?.();
});

const RETRYING = /^Your TinyCloud space is slow to answer · trying again in \d+ s$/;
const TRANSCRIPT = new RegExp(SPOKEN);
type Expected = { [K in keyof Places]?: Places[K] | RegExp };

/**
 * The state table: what the four places say in each state, with the space reachable or not. `recent` is the Recent row's
 * state line, `control` the button beside it, `alert` its "!"; `card` the In progress card; `header` the note page's
 * header line; `transcript` its Transcript section.
 */
const STATES = {
  /** The native stop is still writing: the note is not listed yet (the recorder shows it finishing). */
  finalizing: () => ({ recent: null, card: null, header: null, transcript: null }),
  /** The audio is being finished on this Mac; the Whisper job and the upload wait for it. */
  preparing: () => ({ recent: "Finishing the recording…", control: null, alert: false, card: "Not in your space yet",
    header: "Finishing the recording…", transcript: "Waiting to transcribe" }),
  /** A recording is live: Record has priority, the job waits. */
  recordingLive: () => ({ recent: "Waiting to transcribe on this Mac", control: null, alert: false, transcript: /^Waiting to transcribe/ }),
  /** Another note is being transcribed first. */
  behindAnother: () => ({ recent: "Waiting to transcribe on this Mac", control: null, alert: false, transcript: "Waiting to transcribe · 1 note ahead" }),
  /** No Whisper model is selected or downloaded: the note waits for one, with Get model. */
  noModel: () => ({ recent: "Waiting for the on-device model", control: "Get model", alert: false,
    transcript: "Transcripts on this Mac need the on-device model." }),
  /** Whisper runs, with its progress; the save runs beside it. */
  transcribing: (spaceDown: boolean, percent: number): Expected => ({ recent: `Transcribing on this Mac · ${percent}%`, control: null, alert: false,
    transcript: /^Transcribing on this Mac/, ...(spaceDown ? { card: "Not in your space yet", header: RETRYING }
      : { card: "Saving to your TinyCloud space…", header: /^Uploading audio to your TinyCloud space/ }) }),
  /** The transcript is done on this Mac and readable; the space cannot be reached, so the save waits and retries. */
  doneNotSaved: () => ({ recent: /On this Mac/, control: null, alert: false, card: "Not in your space yet", header: RETRYING, transcript: TRANSCRIPT }),
  /** Saved: the note has left this Mac's pending list and reads as the space's row. */
  saved: () => ({ card: null, alert: false, control: null, transcript: TRANSCRIPT }),
} satisfies Record<string, (...args: never[]) => Expected>;

/** After a reload the interrupted job starts again from the beginning: its progress is not yet known. */
const transcribingAgain = (spaceDown: boolean): Expected => ({ ...STATES.transcribing(spaceDown, 0), recent: /^Transcribing on this Mac/, card: undefined, header: undefined });
const defined = (expected: Expected): Expected => Object.fromEntries(Object.entries(expected).filter(([, value]) => value !== undefined)) as Expected;

for (const spaceDown of [false, true]) {
  const where = spaceDown ? "space unreachable" : "space reachable";
  describe(`a Mac voice note, ${where}`, () => {
    test("each step from Stop to a readable, saved transcript is told as it is", async () => {
      const w = current = await world(spaceDown);
      if (!spaceDown) w.space.audioPut.hold();
      const { id, stopped } = await record(w, { holdStop: true, holdFinish: true });
      await show(w, id);
      await expectPlaces(w, STATES.finalizing());
      w.bridge.stop.release();
      await stopped;
      await expectPlaces(w, STATES.preparing());
      w.bridge.finish.release();
      expect(await waitFor(() => w.whisper.starts.includes(id))).toBe(true);
      await act(async () => w.whisper.progress(id, 0.37));
      await expectPlaces(w, STATES.transcribing(spaceDown, 37));
      await act(async () => w.whisper.complete(id));
      if (spaceDown) {
        await expectPlaces(w, STATES.doneNotSaved());
        w.space.state.down = false;
      } else w.space.audioPut.release();
      expect(await waitFor(async () => (await pendingOf(id))?.ledger?.audio.state === "saved")).toBe(true);
      expect(await waitFor(() => w.space.rows("voice_note_transcript", id) === 1)).toBe(true);
      await expectPlaces(w, STATES.saved());
      expect(w.space.rows("connector_meeting", id)).toBe(1);
      expect(w.whisper.starts).toEqual([id]);
    }, SLOW);

    test("waiting while a recording is live, and behind another note's transcription", async () => {
      const w = current = await world(spaceDown);
      const first = await record(w);
      await first.stopped;
      expect(await waitFor(() => w.whisper.starts.includes(first.id))).toBe(true);
      const second = await record(w);
      await show(w, first.id);
      await expectPlaces(w, STATES.recordingLive());
      await second.stopped;
      expect(await waitFor(() => w.whisper.starts.filter((started) => started === first.id).length === 2)).toBe(true);
      await show(w, second.id);
      await expectPlaces(w, STATES.behindAnother());
      await act(async () => w.whisper.complete(first.id));
      expect(await waitFor(() => w.whisper.starts.includes(second.id))).toBe(true);
      await expectPlaces(w, defined(transcribingAgain(spaceDown)));
      await act(async () => w.whisper.complete(second.id));
      await expectPlaces(w, { alert: false, control: null, transcript: TRANSCRIPT });
      expect(w.whisper.starts.filter((started) => started === second.id)).toHaveLength(1);
    }, SLOW);

    test("no Whisper model yet: the note waits for one, offers Get model, and transcribes once one is chosen", async () => {
      const w = current = await world(spaceDown);
      w.bridge.selectedModel = null;
      const { id, stopped } = await record(w);
      await stopped;
      await show(w, id);
      await expectPlaces(w, STATES.noModel());
      await reload(w);
      await show(w, id);
      await expectPlaces(w, STATES.noModel());
      w.bridge.selectedModel = MODEL;
      await act(async () => w.bridge.emit("exo://recorder-model-selection", MODEL));
      expect(await waitFor(() => w.whisper.starts.includes(id))).toBe(true);
      await expectPlaces(w, defined(transcribingAgain(spaceDown)));
      await act(async () => w.whisper.complete(id));
      await expectPlaces(w, { alert: false, control: null, transcript: TRANSCRIPT });
      expect(w.whisper.starts).toEqual([id]);
    }, SLOW);

    test("a reload while finishing, while transcribing and after the transcript shows the same state, and the work goes on once", async () => {
      const w = current = await world(spaceDown);
      const { id, stopped } = await record(w, { holdFinish: true });
      await stopped;
      await show(w, id);
      await expectPlaces(w, STATES.preparing());
      // The new page's recovery is slow, as on the owner's Mac: the same state shows meanwhile.
      await reload(w, { holdRecovery: true });
      await show(w, id);
      await expectPlaces(w, STATES.preparing());
      w.bridge.recover.release();
      expect(await waitFor(() => w.whisper.starts.includes(id))).toBe(true);
      await act(async () => w.whisper.progress(id, 0.5));
      await expectPlaces(w, defined({ ...STATES.transcribing(spaceDown, 50), card: undefined, header: undefined }));
      // The interrupted job starts again, and nothing else does.
      await reload(w);
      await show(w, id);
      expect(await waitFor(() => w.whisper.starts.filter((started) => started === id).length === 2)).toBe(true);
      await expectPlaces(w, defined(transcribingAgain(spaceDown)));
      await act(async () => w.whisper.complete(id));
      if (spaceDown) {
        await expectPlaces(w, STATES.doneNotSaved());
        await reload(w);
        await show(w, id);
        await expectPlaces(w, defined({ ...STATES.doneNotSaved(), header: undefined }));
        w.space.state.down = false;
      }
      expect(await waitFor(async () => (await pendingOf(id))?.ledger?.audio.state === "saved")).toBe(true);
      expect(await waitFor(() => w.space.rows("voice_note_transcript", id) === 1)).toBe(true);
      await expectPlaces(w, STATES.saved());
      await Bun.sleep(100);
      expect(w.space.rows("connector_meeting", id)).toBe(1);
      expect(w.space.rows("voice_note_transcript", id)).toBe(1);
      expect(w.whisper.starts.filter((started) => started === id)).toHaveLength(2);
      expect((await readLocalTranscript(id)).transcript?.segments.map((segment) => segment.text).join(" ")).toBe(SPOKEN);
    }, SLOW);
  });
}
