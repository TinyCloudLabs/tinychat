import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Window } from "happy-dom";
import { IDBFactory } from "fake-indexeddb";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { useLibrary } from "./useLibrary";
import { NoteDetail } from "./NoteDetail";
import { captureEvents } from "../captureEvents";
import { ensureSchema } from "@/lib/connectors/connectorStore";
import { readTranscriptCommit } from "@/lib/voiceNotes/voiceNoteCommits";
import { saveVoiceNoteTranscript, type VoiceNoteTranscriptSave } from "@/lib/voiceNotes/voiceNoteStore";
import { VoiceNotes, __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";

const SOURCE = "exo-voice-note";
const SOURCE_ID = "synthetic-recording";
const NOTE_ID = "synthetic-row";
const fail = (code: string) => ({ ok: false, error: { code, message: "synthetic storage response" } });
const good = (data: unknown) => ({ ok: true, data: { data } });
const noop = () => {};

let dom: Window;
let root: Root | null = null;
let host: HTMLElement;
let dbToClose: Database | null = null;
const saved = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
  indexedDB: globalThis.indexedDB,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
const originalVoiceNotes = VoiceNotes;

function Detail({ tcw }: { tcw: TinyCloudWeb }) {
  const library = useLibrary(tcw, { visible: true, noteId: NOTE_ID });
  return <MemoryRouter><NoteDetail library={library} tcw={tcw} pushed={false} onBack={noop} transcription={undefined} platform="web" /></MemoryRouter>;
}

beforeAll(() => {
  dom = new Window({ url: "https://synthetic.invalid" });
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    MutationObserver: dom.MutationObserver,
    indexedDB: new IDBFactory(),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  __setVoiceNotesForTests({ listPending: async () => ({ recordings: [] }), getTranscript: async () => ({ transcript: null }), localAudioSize: async () => ({ size: 0 }) } as never, { available: false });
});

afterAll(() => {
  __setVoiceNotesForTests(originalVoiceNotes, { available: null });
  Object.assign(globalThis, saved);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  dbToClose?.close();
  dbToClose = null;
});

function transcript(rev: number): VoiceNoteTranscriptSave {
  const text = `Synthetic body revision ${rev}`;
  return {
    rev,
    sentences: [{ index: 0, text, speaker_name: null, start_time: 0, end_time: 0 }],
    speakers: [],
    metadata: {
      transcription_outcome: "transcribed",
      transcript_text: text,
      transcription_engine: "private-cloud",
      transcript_provider: "tinycloud-private-transcription",
      transcribed_at: "2026-10-15T00:00:00Z",
    },
  };
}

async function turn() {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

async function drain() {
  for (let i = 0; i < 10; i++) await turn();
}

test("Try again re-reads the current committed body after an absent read", async () => {
  const db = new Database(":memory:");
  dbToClose = db;
  const kv = new Map<string, string>();
  let injectMissing = false;
  const bodyKeys: string[] = [];
  const tcw = {
    did: "did:test:retry",
    spaceId: "retry-test",
    sql: { db: () => ({
      query: async (sql: string, params?: unknown[]) => {
        try { return { ok: true, data: { rows: db.query(sql).values(...(params ?? []) as never[]) } }; }
        catch (error) { throw new Error(`synthetic SQL query failed: ${String(error)}`, { cause: error }); }
      },
      execute: async (sql: string, params?: unknown[]) => {
        try { return { ok: true, data: { ...db.query(sql).run(...(params ?? []) as never[]), rows: [] } }; }
        catch (error) { throw new Error(`synthetic SQL execute failed: ${String(error)}`, { cause: error }); }
      },
    }) },
    kv: {
      put: async (key: string, value: string, options?: { ifNoneMatch?: string }) => {
        if (options?.ifNoneMatch === "*" && kv.has(key)) return fail("KV_PRECONDITION_FAILED");
        kv.set(key, value);
        return { ok: true, data: { headers: {} } };
      },
      get: async (key: string) => {
        if (key.includes("/transcript-rev/")) {
          bodyKeys.push(key);
          if (injectMissing) {
            injectMissing = false;
            return fail("KV_NOT_FOUND");
          }
        }
        return kv.has(key) ? good(kv.get(key)) : fail("KV_NOT_FOUND");
      },
    },
  } as unknown as TinyCloudWeb;

  expect((await ensureSchema(tcw)).ok).toBe(true);
  db.query(`INSERT INTO connector_meeting (id, source, source_id, title, started_at, duration_secs, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(NOTE_ID, SOURCE, SOURCE_ID, "Synthetic title", "2026-10-15T00:00:00Z", 30,
      JSON.stringify({ audio: { stored: false }, capture: { platform: "web" } }), "2026-10-15T00:00:00Z", "2026-10-15T00:00:00Z");
  await saveVoiceNoteTranscript(tcw, SOURCE_ID, transcript(1));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Detail tcw={tcw} />));
  await drain();
  expect(host.textContent).toContain("Synthetic body revision 1");

  let injectAfterCommit = false;
  const off = captureEvents.on("library-changed", (detail) => {
    if (detail?.source === SOURCE && detail.sourceId === SOURCE_ID && injectAfterCommit) injectMissing = true;
  });
  injectAfterCommit = true;
  await act(async () => { await saveVoiceNoteTranscript(tcw, SOURCE_ID, transcript(2)); });
  await drain();
  injectAfterCommit = false;
  off();

  const committed = await readTranscriptCommit(tcw, SOURCE_ID);
  expect(committed?.rev).toBe(2);
  expect(kv.has(committed!.bodyKey)).toBe(true);
  expect(host.querySelector('[data-testid="voice-note-transcript-missing"]')).not.toBeNull();
  const readsBeforeRetry = bodyKeys.length;
  const retry = host.querySelector('[data-testid="voice-note-transcript-missing"] button') as HTMLElement;
  await act(async () => retry.click());
  await drain();

  expect(bodyKeys.length).toBe(readsBeforeRetry + 1);
  expect(bodyKeys.at(-1)).toBe(committed?.bodyKey);
  expect(host.textContent).toContain("Synthetic body revision 2");
});
