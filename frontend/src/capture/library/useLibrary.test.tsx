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
import type { PendingNote } from "@/lib/voiceNotes/recorderSaves";
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
const row = (id: string): Row => [id, "exo-voice-note", `rec-${id}`, `Voice note ${id}`, "2026-10-06T09:28:00.000Z", 42];

let spaces = 0;
/** A space whose reads wait for the test; `kinds` is the order they went out in. */
function fakeSpace(previews: [string, string][] = []) {
  const out: Array<{ kind: string; answer: (value: unknown) => void }> = [];
  const kinds: string[] = [];
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
    sql: { db: () => ({ query: (sql: string) => sql.includes("FROM voice_note_transcript")
      ? Promise.resolve({ ok: true, data: { rows: previews } })
      : sql.includes("sqlite_schema") ? Promise.resolve({ ok: true, data: { rows: previews.length > 0 ? [[1]] : [] } })
      : sql.includes("FROM connector_meeting g")
      ? Promise.resolve({ ok: true, data: { rows: [] } })
      : call(sql.includes("WHERE source IN") ? "list" : "metadata") }) },
    kv: { get: () => call("transcript") },
  } as unknown as TinyCloudWeb;
  return {
    tcw,
    kinds,
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
    await act(async () => captureEvents.emit("library-changed"));
    await space.answer("metadata", { ok: true, data: { rows: [[JSON.stringify({ capture: { platform: "ios" } })]] } });
    await space.answer("list", listed("b", "a"));
    expect(space.kinds).toEqual(["list", "metadata", "list"]);
    expect(seen.at(-1)!.note.reads.metadata?.status).toBe("ok");
    expect(seen.at(-1)!.note.reads.transcript?.status).toBe("absent");
    expect(space.most()).toBe(1);
  });
});

describe("useLibrary, notes still on this phone", () => {
  const phoneNote = (id: string, startedAt = "2026-10-06T10:00:00.000Z"): PendingNote => ({ id, startedAt: Date.parse(startedAt), durationMs: 14_000 });
  const props = (space: ReturnType<typeof fakeSpace>, seen: Library[], extra: Partial<Parameters<typeof Probe>[0]> = {}) =>
    ({ tcw: space.tcw, visible: true, noteId: null, now: () => 0, seen, ...extra });

  test("a note with no row is listed first as a stand-in that opens from the phone, with nothing read from the space", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    const onPhone = [phoneNote("rec-p1")];
    await render(props(space, seen, { onPhone, noteId: "on-phone:rec-p1" }));
    await space.answer("list", listed("a"));
    const library = seen.at(-1)!;
    expect(library.items.map((item) => item.id)).toEqual(["on-phone:rec-p1", "a"]);
    expect(library.items[0]).toMatchObject({ onPhone: true, sourceId: "rec-p1", durationSecs: 14 });
    expect(library.note.item?.id).toBe("on-phone:rec-p1");
    expect(library.note.reads).toEqual({ metadata: { status: "ok", metadata: {} }, transcript: { status: "absent" } });
    expect(library.note.loadAudio).not.toBeNull();
    expect(space.kinds).toEqual(["list"]);
  });

  test("once its row exists the note is that row (saving), never two items, and an open stand-in's sheet follows it", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    const onPhone = [phoneNote("rec-p1")];
    await render(props(space, seen, { onPhone, noteId: "on-phone:rec-p1" }));
    await space.answer("list", listed("a"));
    await act(async () => captureEvents.emit("library-changed"));
    await space.answer("list", listed("p1", "a"));
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
    await space.answer("list", listed("a"));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["on-phone:rec-p1", "a"]);
    // The read that began after it left has the row.
    expect(space.kinds).toEqual(["list", "list"]);
    await space.answer("list", listed("p1", "a"));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["p1", "a"]);
    expect(seen.at(-1)!.items[0].saving).toBeUndefined();
  });

  test("other accounts' notes never show: no notes known means no stand-ins, and leaving that state lingers nothing", async () => {
    const space = fakeSpace();
    const seen: Library[] = [];
    await render(props(space, seen, { onPhone: [phoneNote("rec-p1")] }));
    await space.answer("list", listed("a"));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["on-phone:rec-p1", "a"]);
    // The account changed: the notes are not known (null), then the other account's are listed.
    await render(props(space, seen, { onPhone: null }));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["a"]);
    await render(props(space, seen, { onPhone: [phoneNote("rec-other")] }));
    expect(seen.at(-1)!.items.map((item) => item.id)).toEqual(["on-phone:rec-other", "a"]);
    expect(space.kinds).toEqual(["list"]);
  });

  test("a row is titled by its first moment on this phone, else its transcript preview", async () => {
    await saveNote("rec-p1", "- **0:01**\n- **0:03** Call the landlord\n- **0:09** second");
    const space = fakeSpace([["rec-a", "  The quarterly numbers look   good this time and we should send them to everyone before the end of the day tomorrow  "]]);
    const seen: Library[] = [];
    await render(props(space, seen, { onPhone: [phoneNote("rec-p1")] }));
    await space.answer("list", listed("a", "b"));
    await act(async () => {});
    const byId = Object.fromEntries(seen.at(-1)!.items.map((item) => [item.id, item.snippet]));
    expect(byId["on-phone:rec-p1"]).toBe("Call the landlord");
    expect(byId.a).toBe("The quarterly numbers look good this time and we should send them to…");
    expect(byId.b).toBeUndefined();
  });
});
