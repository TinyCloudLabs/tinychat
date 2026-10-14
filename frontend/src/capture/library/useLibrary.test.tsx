// useLibrary, mounted (TC-761, plan §4.11): one list read at a time, asks that
// arrive meanwhile merged into one read after it (never a read thrown away),
// the two-minute rule for coming back to Capture, a note not listed yet
// waiting for the read that is out, and never two storage calls in flight.
//
// There is no DOM in this workspace: react-dom/client mounts the hook on a
// stub container (as useMeetingBot.test.tsx does). The space is a fake whose
// reads stay out until the test answers them, counting what is in flight.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { saveNote } from "@/lib/voiceNotes/recordingNotes";
import { VoiceNotes, __setVoiceNotesForTests, type VoiceNotesPlugin } from "@/lib/voiceNotes/nativeVoiceNotes";
import { clearDiscarded, markDiscarded, unmarkDiscarded, type PendingNote } from "@/lib/voiceNotes/recorderSaves";
import { syncTranscriberLibrary } from "@/chat/useTranscriberLibrarySync";
import type { TranscriberClient } from "@/lib/transcriberApi";
import { captureEvents } from "../captureEvents";
import { RELIST_AFTER_MS, useLibrary, type Library } from "./useLibrary";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { NoteDetail } from "./NoteDetail";
import { hasPrivateCloudTimingProvenance, transcriptMarkdown, transcriptWithTimestamps } from "./transcriptSegments";

const saved = { window: (globalThis as { window?: unknown }).window, act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});

type Row = [string, string, string, string, string, number];
const SOURCE = "exo-upload";
const row = (id: string): Row => [id, SOURCE, `rec-${id}`, `Recording ${id}`, "2026-10-06T09:28:00.000Z", 42];

let spaces = 0;
/** A space whose reads wait for the test; `kinds` is the order they went out in. */
function fakeSpace(options: {
  voiceCommit?: boolean;
  previews?: [string, string][];
  commitProvenance?: [string | null, string | null];
  commitReads?: { rev: number; engine: string | null; provider: string | null }[];
} = {}) {
  const previews = options.previews ?? [];
  const out: Array<{ kind: string; answer: (value: unknown) => void }> = [];
  const kinds: string[] = [];
  let commitReadCount = 0;
  const transcriptKeys: string[] = [];
  let inFlight = 0;
  let most = 0;
  const call = (kind: string) =>
    new Promise((resolve) => {
      kinds.push(kind);
      inFlight += 1;
      most = Math.max(most, inFlight);
      out.push({
        kind,
        answer: (value) => {
          inFlight -= 1;
          resolve(value);
        },
      });
    });
  spaces += 1;
  const tcw = {
    did: `did:test:library-${spaces}`,
    spaceId: `library-${spaces}`,
    sql: { db: () => ({ query: (sql: string) => {
      if (sql.includes("sqlite_schema")) return Promise.resolve({ ok: true, data: { rows: options.voiceCommit || previews.length > 0 ? [[1]] : [] } });
      if (sql.includes("WHERE source IN")) return call("list");
      if (sql.includes("SELECT metadata FROM connector_meeting WHERE id = ?")) return call("metadata");
      if (sql.includes("SELECT source_id, preview FROM voice_note_transcript")) return Promise.resolve({ ok: true, data: { rows: previews } });
      if (sql.includes("FROM voice_note_transcript")) {
        const selected = options.commitReads?.[Math.min(commitReadCount++, options.commitReads.length - 1)];
        const [engine, provider] = selected ? [selected.engine, selected.provider] : options.commitProvenance ?? [null, null];
        const rev = selected?.rev ?? 1;
        const bodyKey = selected ? `committed/transcript/${rev}` : "committed/transcript";
        return Promise.resolve({ ok: true, data: { rows: [
          ["rec-a", rev, "hash", bodyKey, "transcribed", "Preview", engine, provider, null, null, null, null, null],
        ] } });
      }
      if (sql.includes("FROM connector_meeting g")) return Promise.resolve({ ok: true, data: { rows: [] } });
      return call("metadata");
    } }) },
    kv: { get: (key: string) => {
      transcriptKeys.push(key);
      return call("transcript");
    } },
  } as unknown as TinyCloudWeb;
  return {
    tcw,
    kinds,
    transcriptKeys,
    most: () => most,
    outstanding: () => out.length,
    /** Answers the oldest read still out (it must be of `kind`). */
    async answer(kind: string, value: unknown) {
      const next = out.shift();
      expect(next?.kind).toBe(kind);
      await act(async () => next!.answer(value));
      await act(async () => {});
    },
  };
}
const listed = (...ids: string[]) => ({ ok: true, data: { rows: ids.map(row) } });
const voiceRow = (id: string): Row => [id, "exo-voice-note", `rec-${id}`, `Voice note ${id}`, "2026-10-06T09:28:00.000Z", 42];
const listedVoice = (...ids: string[]) => ({ ok: true, data: { rows: ids.map(voiceRow) } });

function Probe(props: { tcw: TinyCloudWeb; visible: boolean; noteId: string | null; now: () => number; seen: Library[]; onPhone?: readonly PendingNote[] | null }) {
  props.seen.push(useLibrary(props.tcw, { visible: props.visible, noteId: props.noteId, now: props.now, onPhone: props.onPhone }));
  return null;
}
const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});
async function render(props: Parameters<typeof Probe>[0]) {
  root ??= createRoot(container);
  await act(async () => root!.render(<Probe {...props} />));
  await act(async () => {});
}

describe("useLibrary, mounted", () => {
  test("one read at a time: asks during a read become one more read after it, and the first is kept", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: null, now: () => 0, seen });
    expect(space.kinds).toEqual(["list"]);
    expect(seen.at(-1)!.listing).toBe(true);

    // Two things land while the first read is out: no second read goes out beside it.
    await act(async () => {
      captureEvents.emit("library-changed");
      captureEvents.emit("library-changed");
    });
    expect(space.outstanding()).toBe(1);

    // The first read lands and is kept; exactly one more read covers both asks.
    await space.answer("list", listed("a"));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["a"]);
    expect(space.kinds).toEqual(["list", "list"]);
    expect(seen.at(-1)!.listing).toBe(true);
    await space.answer("list", listed("b", "a"));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["b", "a"]);
    expect(seen.at(-1)!.listing).toBe(false);
    expect(space.outstanding()).toBe(0);
    expect(space.most()).toBe(1);
  });

  test("a completed notetaker import re-lists the open Library without a manual refresh", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: null, now: () => 0, seen });
    await space.answer("list", listed());
    const client = {
      list: async () => ({ status: "ok", value: { meetings: [{ id: "new", status: "completed" }] } }),
      transcript: async () => ({ status: "ok", value: { status: "ready", transcript: {} } }),
    } as unknown as TranscriberClient;
    let succeeds = false;
    const saver = {
      listSaved: async () => ({ ok: true, data: [] }),
      save: async () => ({ ok: succeeds }),
    };
    await act(async () => syncTranscriberLibrary({ tcw: space.tcw, client, saver }));
    expect(space.kinds).toEqual(["list"]);
    succeeds = true;
    await act(async () => syncTranscriberLibrary({ tcw: space.tcw, client, saver }));
    expect(space.kinds).toEqual(["list", "list"]);
    await space.answer("list", listed("new"));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["new"]);
  });

  test("coming back to Capture re-reads only after more than two minutes away", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    let now = 0;
    const props = { tcw: space.tcw, noteId: null, now: () => now, seen };
    await render({ ...props, visible: true });
    await space.answer("list", listed("a"));

    // Away for a minute: no read.
    await render({ ...props, visible: false });
    now += 60_000;
    await render({ ...props, visible: true });
    expect(space.kinds).toEqual(["list"]);

    // Away for longer than two minutes: one read.
    await render({ ...props, visible: false });
    now += RELIST_AFTER_MS + 1;
    await render({ ...props, visible: true });
    expect(space.kinds).toEqual(["list", "list"]);
    await space.answer("list", listed("a"));
    expect(space.outstanding()).toBe(0);
  });

  test("a note not listed yet waits for the read that is out; its reads follow it on the one chain", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "b", now: () => 0, seen });
    // Not in the list yet, and a read is out: the note is waiting, not absent.
    expect(seen.at(-1)!.note.item).toBeNull();
    expect(seen.at(-1)!.listing).toBe(true);

    await space.answer("list", listed("b", "a"));
    expect(seen.at(-1)!.note.item?.id).toBe("b");
    // Something lands while the note's metadata is out: the list read waits its turn.
    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-b" }));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ capture: { platform: "ios" } })]] } });
    await space.answer("list", listed("b", "a"));
    expect(space.kinds).toEqual(["list", "metadata", "list", "metadata"]);
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ capture: { platform: "ios" } })]] } });
    await space.answer("transcript", { ok: false, error: { code: "KV_NOT_FOUND", message: "none" } });
    expect(seen.at(-1)!.note.reads.metadata?.status).toBe("ok");
    expect(seen.at(-1)!.note.reads.transcript?.transcript.status).toBe("absent");
    expect(space.most()).toBe(1);
  });

  async function expectRowOutcome(outcome: "failed" | "skipped") {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listedVoice("a"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({
      transcription_outcome: outcome,
      ...(outcome === "failed" ? { transcription_error_code: "service_busy" } : {}),
    })]] } });
    expect(seen.at(-1)!.note.reads.metadata).toMatchObject({
      status: "ok",
      metadata: { transcription_outcome: outcome },
    });
  }

  test("the Library retains the row's failed outcome when no transcript commit exists", async () => {
    await expectRowOutcome("failed");
  });

  test("the Library retains the row's skipped outcome when no transcript commit exists", async () => {
    await expectRowOutcome("skipped");
  });

  test("a matching save during an in-flight note read rechecks it after a failed list read", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listed("a"));
    expect(space.kinds).toEqual(["list", "metadata"]);

    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-a" }));
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    expect(seen.at(-1)!.note.reads).toEqual({});
    await space.answer("list", { ok: false, error: { code: "NETWORK", message: "offline" } });
    expect(space.kinds).toEqual(["list", "metadata", "list", "metadata"]);
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Saved during read" }]) } });
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({
      transcript: { status: "ok", sentences: [{ text: "Saved during read" }] },
    });
    expect(space.outstanding()).toBe(0);
  });

  test("a matching save re-reads an already open note even when the list fails", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Old" }]) } });

    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-a" }));
    await space.answer("list", { ok: false, error: { code: "NETWORK", message: "offline" } });
    expect(space.kinds).toEqual(["list", "metadata", "transcript", "list", "metadata"]);
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "New" }]) } });
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ transcript: { status: "ok", sentences: [{ text: "New" }] } });
    expect(space.outstanding()).toBe(0);
  });

  test("a save re-reads an already open note's cached transcript", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: false, error: { code: "KV_NOT_FOUND", message: "none" } });
    expect(seen.at(-1)!.note.reads.transcript?.transcript.status).toBe("absent");

    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-a" }));
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "New transcript" }]) } });
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ transcript: { status: "ok", sentences: [{ text: "New transcript" }] } });
    expect(space.kinds).toEqual(["list", "metadata", "transcript", "list", "metadata", "transcript"]);
  });

  test("voice-note revalidation follows the committed transcript locator", async () => {
    const space = fakeSpace({ voiceCommit: true });
    const seen: Library[] = [];
    const voiceRow = ["a", "exo-voice-note", "rec-a", "Voice note a", "2026-10-06T09:28:00.000Z", 42] as Row;
    const voiceList = { ok: true, data: { rows: [voiceRow] } };
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", voiceList);
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Old" }]) } });
    expect(space.transcriptKeys).toEqual(["committed/transcript"]);
    expect(seen.at(-1)!.note.reads.metadata).toMatchObject({
      status: "ok", metadata: { transcription_outcome: "transcribed", transcript_text: null },
    });
    const before = seen.at(-1)!.note.reads.transcript;

    await act(async () => captureEvents.emit("library-changed", { source: "exo-voice-note", sourceId: "rec-a" }));
    expect(seen.at(-1)!.note.reads.transcript).toBe(before);
    await space.answer("list", voiceList);
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Committed" }]) } });
    expect(space.transcriptKeys).toEqual(["committed/transcript", "committed/transcript"]);
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ transcript: { status: "ok", sentences: [{ text: "Committed" }] } });
  });
  test("a committed transcript's provenance overrides stale row markers", async () => {
    const space = fakeSpace({ voiceCommit: true, commitProvenance: ["whispercpp", "whispercpp"] });
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listedVoice("a"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({
      transcription_engine: "private-cloud", transcript_provider: "tinycloud-private-transcription",
    })]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Committed local body" }]) } });
    expect(seen.at(-1)!.note.reads.transcript?.provenance).toEqual({
      engine: "whispercpp", provider: "whispercpp",
    });
    expect(seen.at(-1)!.note.reads.metadata).toMatchObject({
      status: "ok",
      metadata: { transcription_engine: "whispercpp", transcript_provider: "whispercpp" },
    });
  });
  test("cached body provenance survives metadata flip, failed retry, and close/reopen", async () => {
    const sentences = [
      { index: 0, speaker_name: "You", text: "Synthetic first.", start_time: 0, end_time: 45 },
      { index: 1, speaker_name: "You", text: "Synthetic second.", start_time: 60, end_time: 105 },
    ];
    const voiceList = listedVoice("a");
    const voiceMetadata = (privateCloud: boolean) => ({
      ok: true,
      data: { rows: [[JSON.stringify({
        audio: { stored: true, base: "audio/a" },
        transcription_engine: privateCloud ? "private-cloud" : "whispercpp",
        transcript_provider: privateCloud ? "tinycloud-private-transcription" : "whispercpp",
      })]] },
    });
    const failure = { ok: false, error: { code: "NETWORK", message: "offline" } };

    async function scenario(initiallyPrivate: boolean) {
      const first = initiallyPrivate
        ? { rev: 4, engine: "private-cloud", provider: "tinycloud-private-transcription" }
        : { rev: 4, engine: "whispercpp", provider: "whispercpp" };
      const flipped = initiallyPrivate
        ? { rev: 5, engine: "whispercpp", provider: "whispercpp" }
        : { rev: 5, engine: "private-cloud", provider: "tinycloud-private-transcription" };
      const space = fakeSpace({ voiceCommit: true, commitReads: [first, flipped, flipped, flipped] });
      const seen: Library[] = [];
      const props = { tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen };
      await render(props);
      await space.answer("list", voiceList);
      expect(seen.at(-1)!.note.item).toMatchObject({ source: "exo-voice-note", sourceId: "rec-a" });
      expect(seen.at(-1)!.note.item?.onPhone).not.toBe(true);
      expect(space.kinds).toEqual(["list", "metadata"]);
      await space.answer("metadata", voiceMetadata(initiallyPrivate));
      await space.answer("transcript", { ok: true, data: { data: JSON.stringify(sentences) } });

      const assertSelectedBody = (expectedPrivate: boolean) => {
        const library = seen.at(-1)!;
        const transcript = library.note.reads.transcript;
        const body = transcript?.transcript.status === "ok" ? transcript.transcript.sentences : [];
        const metadata = library.note.reads.metadata?.status === "ok" ? library.note.reads.metadata.metadata : null;
        const privateCloud = hasPrivateCloudTimingProvenance(metadata, transcript?.provenance);
        const html = renderToStaticMarkup(<MemoryRouter><NoteDetail
          library={library}
          pushed
          onBack={() => {}}
          transcription={undefined}
        /></MemoryRouter>);
        const timestampCopy = transcriptWithTimestamps(body, privateCloud);
        const markdown = transcriptMarkdown("Synthetic", null, body, privateCloud);
        expect(privateCloud).toBe(expectedPrivate);
        expect(html.includes('aria-label="Play from 1:00"')).toBe(expectedPrivate);
        expect(html.match(/aria-label="Play from /g)?.length ?? 0).toBe(expectedPrivate ? 2 : 0);
        expect(html.includes("Copy with timestamps")).toBe(expectedPrivate);
        expect(timestampCopy.includes("[01:00]")).toBe(expectedPrivate);
        expect(markdown.includes("[01:00]")).toBe(expectedPrivate);
      };

      assertSelectedBody(initiallyPrivate);
      await act(async () => captureEvents.emit("library-changed", { source: "exo-voice-note", sourceId: "rec-a" }));
      await space.answer("list", voiceList);
      await space.answer("metadata", voiceMetadata(!initiallyPrivate));
      await space.answer("transcript", failure);
      assertSelectedBody(initiallyPrivate);

      await act(async () => seen.at(-1)!.retry());
      await space.answer("transcript", failure);
      assertSelectedBody(initiallyPrivate);

      await render({ ...props, noteId: null });
      await render(props);
      await space.answer("transcript", failure);
      assertSelectedBody(initiallyPrivate);
      expect(space.outstanding()).toBe(0);
    }

    await scenario(false);
    await act(async () => root!.unmount());
    root = null;
    await scenario(true);
  });


  test("an unrelated or list-only save keeps open audio and transcript mounted", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listed("a", "b"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" } })]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Listening" }]) } });
    const original = seen.at(-1)!.note;
    expect(original.audio).toMatchObject({ load: expect.any(Function) });

    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-b" }));
    expect(seen.at(-1)!.note.reads).toBe(original.reads);
    expect(seen.at(-1)!.note.audio).toBe(original.audio);
    await space.answer("list", listed("a", "b"));
    await act(async () => captureEvents.emit("library-changed"));
    expect(seen.at(-1)!.note.reads).toBe(original.reads);
    expect(seen.at(-1)!.note.audio).toBe(original.audio);
    await space.answer("list", listed("a", "b"));
    // A matching sourceId from a different source is not the open note.
    await act(async () => captureEvents.emit("library-changed", { source: "exo-local", sourceId: "rec-a" }));
    await space.answer("list", listed("a", "b"));
    expect(seen.at(-1)!.note.reads).toBe(original.reads);
    expect(seen.at(-1)!.note.audio).toBe(original.audio);
    expect(space.kinds).toEqual(["list", "metadata", "transcript", "list", "list", "list"]);
  });

  test("an affected open note keeps audio and transcript visible while its reads refresh", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" } })]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Old" }]) } });
    const before = seen.at(-1)!.note;

    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-a" }));
    expect(seen.at(-1)!.note.reads).toBe(before.reads);
    expect(seen.at(-1)!.note.audio).toBe(before.audio);
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" } })]] } });
    expect(seen.at(-1)!.note.audio).toBe(before.audio);
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Updated" }]) } });
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ transcript: { status: "ok", sentences: [{ text: "Updated" }] } });
    expect(seen.at(-1)!.note.audio).toBe(before.audio);
  });

  test("failed revalidation retains settled metadata, transcript and the playing audio loader", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" } })]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Still playing" }]) } });
    const before = seen.at(-1)!.note;
    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-a" }));
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: false, error: { code: "NETWORK", message: "offline" } });
    expect(seen.at(-1)!.note.reads.metadata).toBe(before.reads.metadata);
    expect(seen.at(-1)!.note.audio).toBe(before.audio);
    await space.answer("transcript", { ok: false, error: { code: "NETWORK", message: "offline" } });
    expect(seen.at(-1)!.note.reads.transcript).toBe(before.reads.transcript);
    expect(seen.at(-1)!.note.audio).toBe(before.audio);
    expect(space.kinds).toEqual(["list", "metadata", "transcript", "list", "metadata", "transcript"]);
    expect(space.outstanding()).toBe(0); // Failure does not start a busy retry loop.

    await act(async () => seen.at(-1)!.retry());
    expect(space.kinds).toEqual(["list", "metadata", "transcript", "list", "metadata", "transcript", "metadata"]);
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" } })]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Recovered" }]) } });
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({
      transcript: { status: "ok", sentences: [{ text: "Recovered" }] },
    });
    expect(seen.at(-1)!.note.audio).toBe(before.audio);
    expect(space.outstanding()).toBe(0);
  });

  test("Try again re-reads only failed metadata when the transcript refresh succeeded", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" } })]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Old" }]) } });
    const oldMeta = seen.at(-1)!.note.reads.metadata;
    const audio = seen.at(-1)!.note.audio;
    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-a" }));
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: false, error: { code: "NETWORK", message: "offline" } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "New" }]) } });
    const newTranscript = seen.at(-1)!.note.reads.transcript;
    expect(seen.at(-1)!.note.reads.metadata).toBe(oldMeta);
    expect(seen.at(-1)!.note.audio).toBe(audio);
    expect(space.outstanding()).toBe(0);

    await act(async () => seen.at(-1)!.retry());
    expect(space.kinds).toEqual(["list", "metadata", "transcript", "list", "metadata", "transcript", "metadata"]);
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" }, revision: 2 })]] } });
    expect(seen.at(-1)!.note.reads.metadata).toMatchObject({ status: "ok", metadata: { revision: 2 } });
    expect(seen.at(-1)!.note.reads.transcript).toBe(newTranscript);
    expect(seen.at(-1)!.note.audio).toBe(audio);
    expect(space.outstanding()).toBe(0);
  });

  test("reopening a note re-reads only its failed transcript after a successful metadata refresh", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    const props = { tcw: space.tcw, visible: true, now: () => 0, seen };
    await render({ ...props, noteId: "a" });
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" } })]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Old" }]) } });
    const oldTranscript = seen.at(-1)!.note.reads.transcript;
    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-a" }));
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" }, revision: 2 })]] } });
    const newMeta = seen.at(-1)!.note.reads.metadata;
    const audio = seen.at(-1)!.note.audio;
    await space.answer("transcript", { ok: false, error: { code: "NETWORK", message: "offline" } });
    expect(seen.at(-1)!.note.reads.transcript).toBe(oldTranscript);
    expect(seen.at(-1)!.note.reads.metadata).toBe(newMeta);
    expect(seen.at(-1)!.note.audio).toBe(audio);
    expect(space.outstanding()).toBe(0);

    await render({ ...props, noteId: null });
    await render({ ...props, noteId: "a" });
    expect(space.kinds).toEqual(["list", "metadata", "transcript", "list", "metadata", "transcript", "transcript"]);
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "New" }]) } });
    expect(seen.at(-1)!.note.reads.metadata).toBe(newMeta);
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ transcript: { status: "ok", sentences: [{ text: "New" }] } });
    expect(seen.at(-1)!.note.audio).toMatchObject({ load: expect.any(Function) });
    expect(space.outstanding()).toBe(0);

  });

  test("an open stand-in route follows its saved row's transcript refresh even when the list refresh fails", async () => {
    const space = fakeSpace({ voiceCommit: true });
    const seen: Library[] = [];
    const base = { tcw: space.tcw, visible: true, now: () => 0, seen, noteId: "on-phone:rec-a" };
    await render({ ...base, onPhone: [{ id: "rec-a", startedAt: Date.parse("2026-10-06T10:00:00.000Z"), durationMs: 14_000 }] });
    await space.answer("list", listedVoice("a"));
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Old" }]) } });
    expect(seen.at(-1)!.note.item?.id).toBe("a");
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ transcript: { status: "ok", sentences: [{ text: "Old" }] } });

    await act(async () => captureEvents.emit("library-changed", { source: "exo-voice-note", sourceId: "rec-a" }));
    await space.answer("list", { ok: false, error: { code: "NETWORK", message: "offline" } });
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "New" }]) } });
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ transcript: { status: "ok", sentences: [{ text: "New" }] } });
    expect(seen.at(-1)!.note.item?.id).toBe("a");
  });

  test("a closed note whose transcript was absent is re-read on reopening after its save", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    const props = { tcw: space.tcw, visible: true, now: () => 0, seen };
    await render({ ...props, noteId: "a" });
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: false, error: { code: "KV_NOT_FOUND", message: "none" } });
    await render({ ...props, noteId: null });

    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-a" }));
    await space.answer("list", listed("a"));
    await render({ ...props, noteId: "a" });
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Arrived" }]) } });
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ transcript: { status: "ok", sentences: [{ text: "Arrived" }] } });
    expect(space.kinds).toEqual(["list", "metadata", "transcript", "list", "metadata", "transcript"]);
  });
});

describe("useLibrary, notes still on this browser", () => {
  const phoneNote = (id: string, startedAt = "2026-10-06T10:00:00.000Z"): PendingNote => ({ id, startedAt: Date.parse(startedAt), durationMs: 14_000 });
  const props = (space: ReturnType<typeof fakeSpace>, seen: Library[], extra: Partial<Parameters<typeof Probe>[0]> = {}) =>
    ({ tcw: space.tcw, visible: true, noteId: null, now: () => 0, seen, ...extra });

  test("a note with no row is listed first as a stand-in that opens from the phone, with nothing read from the space", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    const onPhone = [phoneNote("rec-p1")];
    await render(props(space, seen, { onPhone, noteId: "on-phone:rec-p1" }));
    await space.answer("list", listedVoice("a"));
    const library = seen.at(-1)!;
    expect(library.items.map((item) => item.id)).toEqual(["on-phone:rec-p1", "a"]);
    expect(library.items[0]).toMatchObject({ onPhone: true, sourceId: "rec-p1", durationSecs: 14 });
    expect(library.note.item?.id).toBe("on-phone:rec-p1");
    expect(library.note.reads).toEqual({
      metadata: { status: "ok", metadata: {} },
      transcript: { transcript: { status: "absent" }, provenance: null },
    });
    expect(library.note.audio).toHaveProperty("localUrl");
    expect(space.kinds).toEqual(["list"]);
  });

  test("once its row exists the note is that row (saving), never two items, and an open stand-in's sheet follows it", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    const onPhone = [phoneNote("rec-p1")];
    await render(props(space, seen, { onPhone, noteId: "on-phone:rec-p1" }));
    await space.answer("list", listedVoice("a"));
    await act(async () => captureEvents.emit("library-changed"));
    await space.answer("list", listedVoice("p1", "a"));
    const library = seen.at(-1)!;
    expect(library.items.map((item) => item.id)).toEqual(["p1", "a"]);
    expect(library.items[0]).toMatchObject({ saving: true });
    expect(library.items.some((item) => item.onPhone)).toBe(false);
    expect(library.note.item?.id).toBe("p1");
  });

  test("a note that leaves the phone keeps its stand-in until a list read that began after it left has come back", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render(props(space, seen, { onPhone: [phoneNote("rec-p1")] }));
    // This read began while the note was still on the phone.
    await render(props(space, seen, { onPhone: [] }));
    await space.answer("list", listedVoice("a"));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["on-phone:rec-p1", "a"]);
    // The read that began after it left has the row.
    expect(space.kinds).toEqual(["list", "list"]);
    await space.answer("list", listedVoice("p1", "a"));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["p1", "a"]);
    expect(seen.at(-1)!.items[0].saving).toBeUndefined();
  });

  test("other accounts' notes never show: no notes known means no stand-ins, and leaving that state lingers nothing", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render(props(space, seen, { onPhone: [phoneNote("rec-p1")] }));
    await space.answer("list", listedVoice("a"));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["on-phone:rec-p1", "a"]);
    // The account changed: the notes are not known (null), then the other account's are listed.
    await render(props(space, seen, { onPhone: null }));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["a"]);
    await render(props(space, seen, { onPhone: [phoneNote("rec-other")] }));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["on-phone:rec-other", "a"]);
    expect(space.kinds).toEqual(["list"]);
  });

  test("a row is titled by its first moment on this browser, else its transcript preview", async () => {
    await saveNote("rec-p1", "- **0:01**\n- **0:03** Call the landlord\n- **0:09** second");
    const space = fakeSpace({ previews: [["rec-a", "  The quarterly numbers look   good this time and we should send them to everyone before the end of the day tomorrow  "]] });
    const seen: Library[] = [];
    await render(props(space, seen, { onPhone: [phoneNote("rec-p1")] }));
    await space.answer("list", listedVoice("a", "b"));
    await act(async () => {});
    const byId = Object.fromEntries(seen.at(-1)!.items.map((item) => [item.id, item.snippet]));
    expect(byId["on-phone:rec-p1"]).toBe("Call the landlord");
    expect(byId.a).toBe("The quarterly numbers look good this time and we should send them to…");
    expect(byId.b).toBeUndefined();
  });

  test("a departure never commits a render without the note: the stand-in is kept in the very render that drops it", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    const open = { noteId: "on-phone:rec-hand" };
    await render(props(space, seen, { ...open, onPhone: [phoneNote("rec-hand")] }));
    await space.answer("list", listedVoice("a"));
    const before = seen.length;
    await render(props(space, seen, { ...open, onPhone: [] }));
    const renders = seen.slice(before);
    expect(renders.length).toBeGreaterThan(0);
    for (const library of renders) {
      expect(library.note.item?.id).toBe("on-phone:rec-hand");
      expect(library.items.map((item) => item.id)).toContain("on-phone:rec-hand");
    }
  });

  test("a note whose discard went through is gone, not kept as if it had uploaded; a failed discard is not a discard", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render(props(space, seen, { onPhone: [phoneNote("rec-tossed"), phoneNote("rec-kept")] }));
    await space.answer("list", listedVoice("a"));
    // rec-tossed: marked, deleted, marker retired, then the phone lists it no more.
    markDiscarded("rec-tossed");
    clearDiscarded("rec-tossed");
    // rec-kept: marked, the discard failed (the recording stays), then it uploads.
    markDiscarded("rec-kept");
    unmarkDiscarded("rec-kept");
    await render(props(space, seen, { onPhone: [] }));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["on-phone:rec-kept", "a"]);
  });

  test("when the phone's notes become unknown, notes still waiting for the list are dropped and do not come back", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render(props(space, seen, { onPhone: [phoneNote("rec-p1")] }));
    await render(props(space, seen, { onPhone: [] }));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["on-phone:rec-p1"]);
    await render(props(space, seen, { onPhone: null }));
    expect(seen.at(-1)!.items).toEqual([]);
    await render(props(space, seen, { onPhone: [] }));
    expect(seen.at(-1)!.items).toEqual([]);
  });

  test("notes waiting for the list belong to their space: another space never lists them", async () => {
    const space = fakeSpace();
    const other = fakeSpace();
    const seen: Library[] = [];
    await render(props(space, seen, { onPhone: [phoneNote("rec-p1")] }));
    await render(props(space, seen, { onPhone: [] }));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["on-phone:rec-p1"]);
    await render(props(other, seen, { onPhone: [] }));
    expect(seen.at(-1)!.items).toEqual([]);
  });

  test("a note that is on the phone again after leaving is one item, not its stand-in twice", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render(props(space, seen, { onPhone: [phoneNote("rec-p1")] }));
    await render(props(space, seen, { onPhone: [] }));
    await render(props(space, seen, { onPhone: [phoneNote("rec-p1")] }));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["on-phone:rec-p1"]);
  });

  test("closing a saved row re-reads its first moment: an edited one retitles it, a removed one drops the title", async () => {
    await saveNote("rec-ed", "- **0:01** Original words");
    const space = fakeSpace();
    const seen: Library[] = [];
    const base = props(space, seen);
    await render({ ...base, noteId: null });
    await space.answer("list", { ok: true, data: { rows: [["ed", "exo-voice-note", "rec-ed", "Voice note", "2026-10-06T10:00:00.000Z", 14]] } });
    expect(seen.at(-1)!.items[0].snippet).toBe("Original words");
    await render({ ...base, noteId: "ed" });
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await saveNote("rec-ed", "- **0:01** Updated words", { savedEdit: true });
    await render({ ...base, noteId: null });
    expect(seen.at(-1)!.items[0].snippet).toBe("Updated words");
    await render({ ...base, noteId: "ed" });
    await saveNote("rec-ed", "just a note, no moments", { savedEdit: true });
    await render({ ...base, noteId: null });
    expect(seen.at(-1)!.items[0].snippet).toBeUndefined();
  });
});

describe("useLibrary, which audio a note on the phone plays", () => {
  const phoneNote: PendingNote = { id: "rec-play", startedAt: Date.parse("2026-10-06T10:00:00.000Z"), durationMs: 14_000 };
  async function withLocalAudio(run: (counts: { local: () => number; remote: () => number; fetches: () => number; setAvailable: (available: boolean) => void }, space: ReturnType<typeof fakeSpace>) => Promise<void>) {
    const space = fakeSpace();
    let remoteReads = 0;
    let localReads = 0;
    let fetches = 0;
    const realFetch = globalThis.fetch;
    // The WKWebView scheme handler answers a fetch of a local file with status 0; nothing here may fetch it.
    globalThis.fetch = (async () => { fetches++; return new Response(null, { status: 0 as never }); }) as unknown as typeof fetch;
    space.tcw.kv.get = (async () => {
      remoteReads++;
      return { ok: false, error: { code: "KV_NOT_FOUND", message: "Upload is not finished" } };
    }) as typeof space.tcw.kv.get;
    const localUrl = URL.createObjectURL(new Blob(["local bytes"], { type: "audio/mp4" }));
    let localAvailable = true;
    const original = VoiceNotes;
    __setVoiceNotesForTests({
      listPending: async () => ({ recordings: localAvailable ? [{ id: "rec-play", owner: space.tcw.did }] : [] }),
      localAudioUrl: async () => { localReads++; return { url: localUrl }; },
    } as VoiceNotesPlugin, { available: true });
    try {
      await run({ local: () => localReads, remote: () => remoteReads, fetches: () => fetches,
        setAvailable: (available) => { localAvailable = available; } }, space);
    } finally {
      globalThis.fetch = realFetch;
      __setVoiceNotesForTests(original, { available: null });
      URL.revokeObjectURL(localUrl);
    }
  }
  const localUrlOf = (library: Library) => {
    const audio = library.note.audio;
    if (!audio || !("localUrl" in audio)) throw new Error("expected the phone's own audio");
    return audio.localUrl();
  };
  const playFromSpace = (library: Library) => {
    const audio = library.note.audio;
    if (!audio || !("load" in audio)) throw new Error("expected the space's audio");
    return audio.load(new AbortController().signal, () => {});
  };

  test("a note still on the phone plays from the phone's copy once its row exists, whatever the row's metadata holds", async () => {
    await withLocalAudio(async (counts, space) => {
      const seen: Library[] = [];
      const base = { tcw: space.tcw, visible: true, now: () => 0, seen, onPhone: [phoneNote] };
      await render({ ...base, noteId: "on-phone:rec-play" });
      expect(await localUrlOf(seen.at(-1)!)).toMatch(/^blob:/);
      // The row is made before the audio is uploaded; its metadata is empty or not yet read.
      await space.answer("list", listedVoice("play"));
      expect(seen.at(-1)!.note.item).toMatchObject({ saving: true, sourceId: "rec-play" });
      const before = { local: counts.local(), remote: counts.remote() };
      expect(await localUrlOf(seen.at(-1)!)).toMatch(/^blob:/);
      await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
      expect(await localUrlOf(seen.at(-1)!)).toMatch(/^blob:/);
      expect({ local: counts.local() - before.local, remote: counts.remote() - before.remote, fetched: counts.fetches() }).toEqual({ local: 2, remote: 0, fetched: 0 });
      await render({ ...base, onPhone: [], noteId: "play" });
      expect(seen.at(-1)!.note.item?.hasLocalAudio).toBe(true);
      expect(await localUrlOf(seen.at(-1)!)).toMatch(/^blob:/);
    });
  });

  test("the phone's URL is resolved when Play is tapped, not when the note opens", async () => {
    await withLocalAudio(async (counts, space) => {
      const seen: Library[] = [];
      await render({ tcw: space.tcw, visible: true, now: () => 0, seen, onPhone: [phoneNote], noteId: "on-phone:rec-play" });
      expect(counts.local()).toBe(0);
      await localUrlOf(seen.at(-1)!);
      expect(counts.local()).toBe(1);
    });
  });

  test("a phone copy that cannot be opened rejects with the real reason, never the space", async () => {
    const space = fakeSpace();
    const original = VoiceNotes;
    __setVoiceNotesForTests({ listPending: async () => ({ recordings: [] }),
      localAudioUrl: async () => { throw new Error("no such recording"); } } as unknown as VoiceNotesPlugin, { available: true });
    try {
      const seen: Library[] = [];
      await render({ tcw: space.tcw, visible: true, now: () => 0, seen, onPhone: [phoneNote], noteId: "on-phone:rec-play" });
      await expect(localUrlOf(seen.at(-1)!)).rejects.toThrow("Could not open audio on this browser: no such recording");
      expect(space.kinds).not.toContain("audio");
    } finally {
      __setVoiceNotesForTests(original, { available: null });
    }
  });

  test("once the local file is gone, its row plays from the space", async () => {
    await withLocalAudio(async (counts, space) => {
      const seen: Library[] = [];
      const base = { tcw: space.tcw, visible: true, now: () => 0, seen, noteId: "play" };
      await render({ ...base, onPhone: [phoneNote] });
      await space.answer("list", listedVoice("play"));
      await space.answer("metadata", { ok: true, data: { rows: [["{\"audio\":{\"stored\":true}}"]] } });
      counts.setAvailable(false);
      await render({ ...base, onPhone: [] });
      await space.answer("list", listedVoice("play"));
      expect(seen.at(-1)!.note.item?.saving).toBeUndefined();
      const localBefore = counts.local();
      await playFromSpace(seen.at(-1)!).catch(() => null);
      expect({ local: counts.local() - localBefore, remoteAsked: counts.remote() > 0 }).toEqual({ local: 0, remoteAsked: true });
    });
  });

  test("a local-only row on another device has no player", async () => {
    await withLocalAudio(async (counts, space) => {
      counts.setAvailable(false);
      const seen: Library[] = [];
      await render({ tcw: space.tcw, visible: true, now: () => 0, seen, onPhone: [], noteId: "play" });
      await space.answer("list", listedVoice("play"));
      await space.answer("metadata", { ok: true, data: { rows: [["{\"audio\":{\"stored\":false}}"]] } });
      expect(seen.at(-1)!.note.audio).toBeNull();
      expect(counts.remote()).toBe(0);
    });
  });
});
