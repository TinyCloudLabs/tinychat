import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { __resetStorageStatusForTests } from "@/lib/storageStatus";
import { CONNECTORS_SQL_DB_NAME, ensureSchema } from "@/lib/connectors/connectorStore";
import { createVoiceNoteRow } from "@/lib/voiceNotes/voiceNoteRows";
import { RecordingRenameProvider, RecordingTitleEditField, RenameRecordingButton, useRecordingTitleEdit } from "./RecordingRename";
import { RecordingTitleEditor } from "./RecordingTitleEditor";

let restore: (() => void) | null = null;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  restore?.();
  restore = null;
  __resetStorageStatusForTests();
});

async function mountNode(node: React.ReactNode) {
  // A test that mounts again first puts the previous DOM globals back.
  if (root) await act(async () => root!.unmount());
  root = null;
  restore?.();
  restore = installDom();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}
const typeInto = async (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")!.set!.call(input, value);
  // happy-dom has no native `input` support, so React reads the change on key events.
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true })); });
};
const press = (el: Element, key: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const blur = (el: HTMLInputElement) => act(async () => { el.blur(); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("RecordingTitleEditor", () => {
  async function mount(initial: string) {
    const saved: string[] = [];
    let cancelled = 0;
    const container = await mountNode(<RecordingTitleEditor initial={initial} onSave={(t) => saved.push(t)} onCancel={() => { cancelled++; }} />);
    return { input: container.querySelector("input") as HTMLInputElement, container, saved, cancelled: () => cancelled };
  }

  test("opens focused with the title selected and its start in view", async () => {
    const e = await mount("Weekly recap");
    expect(e.input.value).toBe("Weekly recap");
    expect(document.activeElement).toBe(e.input);
    expect(e.input.selectionStart).toBe(0);
    expect(e.input.selectionEnd).toBe("Weekly recap".length);
    expect(e.input.scrollLeft).toBe(0);
  });

  test("Enter saves once; Escape cancels and the blur it causes does not save; leaving the field saves", async () => {
    const a = await mount("Weekly recap");
    await typeInto(a.input, "Offsite plan");
    await press(a.input, "Enter");
    await act(async () => { a.input.blur(); });
    expect(a.saved).toEqual(["Offsite plan"]);

    const b = await mount("Weekly recap");
    await typeInto(b.input, "Changed");
    await press(b.input, "Escape");
    await act(async () => { b.input.blur(); });
    expect(b.saved).toEqual([]);
    expect(b.cancelled()).toBe(1);

    const c = await mount("Weekly recap");
    await typeInto(c.input, "Left the field");
    await act(async () => { c.input.blur(); });
    expect(c.saved).toEqual(["Left the field"]);
  });

  test("Cancel does not steal the edit from the field", async () => {
    const e = await mount("A");
    const buttons = [...e.container.querySelectorAll("button")];
    await typeInto(e.input, "B");
    await act(async () => { buttons[1]!.click(); });
    expect(e.saved).toEqual([]);
    expect(e.cancelled()).toBe(1);
  });
});

describe("renaming from a row", () => {
  const DEFAULT_TITLE = "Voice note · Oct 9";
  const AUTO = "Oct 9 · Alice Chen";

  // A real space: the rename path's SQL runs against an in-memory database, so an edit session's
  // reads and writes behave exactly as they do against the app's own connectors store. Each fake
  // space gets its own did so the voice-note identity cache cannot hand one space another's schema.
  let spaceCount = 0;
  function spaceSql(sqlite: Database, fail = false) {
    return { db: (name: string) => {
      expect(name).toBe(CONNECTORS_SQL_DB_NAME);
      return {
        async query(statement: string, params: unknown[] = []) {
          return { ok: true, data: { rows: sqlite.prepare(statement).all(...(params as never[])).map((r) => Object.values(r as object)) } };
        },
        async execute(statement: string, params: unknown[] = []) {
          if (fail) return { ok: false, error: { code: "SQL_ERROR", message: "x" } };
          return { ok: true, data: { changes: sqlite.prepare(statement).run(...(params as never[])).changes } };
        },
      };
    } };
  }
  function spaceFor(sqlite: Database, fail = false) {
    const did = `did:test:ui-${++spaceCount}`;
    return { did, spaceId: did, sql: spaceSql(sqlite, fail), kv: {} } as unknown as TinyCloudWeb;
  }
  async function seededNote(fail = false) {
    const sqlite = new Database(":memory:");
    const tcw = spaceFor(sqlite, fail);
    await ensureSchema(tcw);
    await createVoiceNoteRow(tcw, { id: "rec-1", startedAt: new Date(2026, 9, 9, 10, 30).getTime(),
      durationMs: 1_000, mimeType: "audio/mp4", sizeBytes: 4, silencedMs: 0, silencedEvents: 0, noSignalMs: 0 }, DEFAULT_TITLE);
    const row = sqlite.query("SELECT id, title, metadata FROM connector_meeting WHERE source_id = ?").get("rec-1") as { id: string; title: string | null; metadata: string };
    return { tcw, sqlite, rowId: row.id };
  }
  const storedTitle = (sqlite: Database, rowId: string) => {
    const row = sqlite.query("SELECT title, metadata FROM connector_meeting WHERE id = ?").get(rowId) as { title: string | null; metadata: string };
    return { title: row.title, metadata: JSON.parse(row.metadata) as Record<string, unknown> };
  };

  function Row({ title, rowId }: { title: string; rowId: string }) {
    const edit = useRecordingTitleEdit({ id: rowId, source: "exo-voice-note", sourceId: "rec-1" }, title);
    if (!edit) return <p>no rename</p>;
    return edit.editing ? <RecordingTitleEditField edit={edit} /> : <RenameRecordingButton edit={edit} />;
  }
  function Space({ tcw, title, rowId }: { tcw: TinyCloudWeb; title: string; rowId: string }) {
    return <RecordingRenameProvider tcw={tcw}><Row title={title} rowId={rowId} /></RecordingRenameProvider>;
  }
  const open = async (container: HTMLElement) => { await act(async () => { (container.querySelector("button") as HTMLButtonElement).click(); }); return container.querySelector("input") as HTMLInputElement; };

  test("offers nothing without a space to write to", async () => {
    const c = await mountNode(<Row title={DEFAULT_TITLE} rowId="vn-rec-1" />);
    expect(c.querySelector("button")).toBeNull();
    expect(c.querySelector("input")).toBeNull();
  });

  test("an untouched edit session that sees the title change underneath writes nothing: the new automatic title stands", async () => {
    const { tcw, sqlite, rowId } = await seededNote();
    const c = await mountNode(<Space tcw={tcw} title={DEFAULT_TITLE} rowId={rowId} />);
    const input = await open(c);
    // A commit lands mid-edit: the row's automatic title is replaced under the open editor.
    sqlite.prepare("UPDATE connector_meeting SET title = ? WHERE id = ?").run(AUTO, rowId);
    await act(async () => { root!.render(<Space tcw={tcw} title={AUTO} rowId={rowId} />); });
    // The user never touched the field: leaving it must not write the stale title as a user name.
    await blur(input);
    await settle();
    expect(c.querySelector("input")).toBeNull();
    const stored = storedTitle(sqlite, rowId);
    expect(stored.title).toBe(AUTO);
    expect(stored.metadata).not.toHaveProperty("title_user");
  });

  test("a draft typed before a background title change is what persists on save", async () => {
    const { tcw, sqlite, rowId } = await seededNote();
    const c = await mountNode(<Space tcw={tcw} title={DEFAULT_TITLE} rowId={rowId} />);
    const input = await open(c);
    await typeInto(input, "Chosen name");
    sqlite.prepare("UPDATE connector_meeting SET title = ? WHERE id = ?").run(AUTO, rowId);
    await act(async () => { root!.render(<Space tcw={tcw} title={AUTO} rowId={rowId} />); });
    expect((c.querySelector("input") as HTMLInputElement).value).toBe("Chosen name");
    await press(c.querySelector("input") as HTMLInputElement, "Enter");
    await settle();
    expect(c.querySelector("input")).toBeNull();
    const stored = storedTitle(sqlite, rowId);
    expect(stored.title).toBe("Chosen name");
    expect(stored.metadata.title_user).toBe(true);
  });

  test("a failed write reopens the editor with the rejected draft and shows an error", async () => {
    const { sqlite, rowId } = await seededNote();
    const tcw = spaceFor(sqlite, true);
    const c = await mountNode(<Space tcw={tcw} title={DEFAULT_TITLE} rowId={rowId} />);
    const input = await open(c);
    expect(c.querySelector("[role=alert]")).toBeNull();
    await typeInto(input, "Q4 planning");
    await press(input, "Enter");
    await settle();
    expect(c.querySelector("[role=alert]")).not.toBeNull();
    expect((c.querySelector("input") as HTMLInputElement).value).toBe("Q4 planning");
  });
});
