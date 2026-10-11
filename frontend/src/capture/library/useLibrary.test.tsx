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

import { syncTranscriberLibrary } from "@/chat/useTranscriberLibrarySync";
import type { TranscriberClient } from "@/lib/transcriberApi";
import { captureEvents } from "../captureEvents";
import { RELIST_AFTER_MS, useLibrary, type Library } from "./useLibrary";

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
function fakeSpace(options: { voiceCommit?: boolean } = {}) {
  const out: Array<{ kind: string; answer: (value: unknown) => void }> = [];
  const kinds: string[] = [];
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
      if (sql.includes("sqlite_schema")) return Promise.resolve({ ok: true, data: { rows: options.voiceCommit ? [[1]] : [] } });
      if (sql.includes("FROM voice_note_transcript")) return Promise.resolve({ ok: true, data: { rows: [
        ["rec-a", 1, "hash", "committed/transcript", "transcribed", "Preview", null, null, null, null, null, null, null],
      ] } });
      if (sql.includes("FROM connector_meeting g")) return Promise.resolve({ ok: true, data: { rows: [] } });
      return call(sql.includes("WHERE source IN") ? "list" : "metadata");
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

function Probe(props: { tcw: TinyCloudWeb; visible: boolean; noteId: string | null; now: () => number; seen: Library[] }) {
  props.seen.push(useLibrary(props.tcw, { visible: props.visible, noteId: props.noteId, now: props.now }));
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
    expect(seen.at(-1)!.note.reads.transcript?.status).toBe("absent");
    expect(space.most()).toBe(1);
  });

  test("a save re-reads an already open note's cached transcript", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: false, error: { code: "KV_NOT_FOUND", message: "none" } });
    expect(seen.at(-1)!.note.reads.transcript?.status).toBe("absent");

    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-a" }));
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [["{}"]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "New transcript" }]) } });
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ status: "ok", sentences: [{ text: "New transcript" }] });
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
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ status: "ok", sentences: [{ text: "Committed" }] });
  });

  test("an unrelated or list-only save keeps open audio and transcript mounted", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render({ tcw: space.tcw, visible: true, noteId: "a", now: () => 0, seen });
    await space.answer("list", listed("a", "b"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" } })]] } });
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Listening" }]) } });
    const original = seen.at(-1)!.note;
    expect(original.loadAudio).toBeFunction();

    await act(async () => captureEvents.emit("library-changed", { source: SOURCE, sourceId: "rec-b" }));
    expect(seen.at(-1)!.note.reads).toBe(original.reads);
    expect(seen.at(-1)!.note.loadAudio).toBe(original.loadAudio);
    await space.answer("list", listed("a", "b"));
    await act(async () => captureEvents.emit("library-changed"));
    expect(seen.at(-1)!.note.reads).toBe(original.reads);
    expect(seen.at(-1)!.note.loadAudio).toBe(original.loadAudio);
    await space.answer("list", listed("a", "b"));
    // A matching sourceId from a different source is not the open note.
    await act(async () => captureEvents.emit("library-changed", { source: "exo-local", sourceId: "rec-a" }));
    await space.answer("list", listed("a", "b"));
    expect(seen.at(-1)!.note.reads).toBe(original.reads);
    expect(seen.at(-1)!.note.loadAudio).toBe(original.loadAudio);
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
    expect(seen.at(-1)!.note.loadAudio).toBe(before.loadAudio);
    await space.answer("list", listed("a"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ audio: { stored: true, base: "audio/a" } })]] } });
    expect(seen.at(-1)!.note.loadAudio).toBe(before.loadAudio);
    await space.answer("transcript", { ok: true, data: { data: JSON.stringify([{ text: "Updated" }]) } });
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ status: "ok", sentences: [{ text: "Updated" }] });
    expect(seen.at(-1)!.note.loadAudio).toBe(before.loadAudio);
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
    expect(seen.at(-1)!.note.loadAudio).toBe(before.loadAudio);
    await space.answer("transcript", { ok: false, error: { code: "NETWORK", message: "offline" } });
    expect(seen.at(-1)!.note.reads.transcript).toBe(before.reads.transcript);
    expect(seen.at(-1)!.note.loadAudio).toBe(before.loadAudio);
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
    expect(seen.at(-1)!.note.reads.transcript).toMatchObject({ status: "ok", sentences: [{ text: "Arrived" }] });
    expect(space.kinds).toEqual(["list", "metadata", "transcript", "list", "metadata", "transcript"]);
  });
});
