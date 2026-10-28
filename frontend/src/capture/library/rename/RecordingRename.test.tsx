import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { __resetStorageStatusForTests } from "@/lib/storageStatus";
import { captureEvents } from "../../captureEvents";
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
    expect(buttons).toHaveLength(2);
    await typeInto(e.input, "B");
    await act(async () => { buttons[1]!.click(); });
    expect(e.saved).toEqual([]);
    expect(e.cancelled()).toBe(1);
  });
});

describe("renaming from a row", () => {
  const item = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1" };
  function stubSpace(rows: unknown[][], fail = false) {
    const calls: string[] = [];
    const db = {
      async query(sql: string) { calls.push(sql); return { ok: true, data: { rows } }; },
      async execute(sql: string) { calls.push(sql); return fail ? { ok: false, error: { code: "SQL_ERROR", message: "x" } } : { ok: true, data: { changes: 1 } }; },
    };
    return { tcw: { did: "did:test:ui", spaceId: "did:test:ui", sql: { db: () => db }, kv: {} } as unknown as TinyCloudWeb, calls };
  }
  const row = ["Voice note · Oct 9", "{}", "2026-10-09T10:30:00.000Z", "exo-voice-note", "2026-10-09T10:30:00.000Z", "[]"];
  const open = async (container: HTMLElement) => { await act(async () => { (container.querySelector("button") as HTMLButtonElement).click(); }); return container.querySelector("input") as HTMLInputElement; };

  function Row({ title }: { title: string }) {
    const edit = useRecordingTitleEdit(item, title);
    if (!edit) return <p>no rename</p>;
    return edit.editing ? <RecordingTitleEditField edit={edit} /> : <RenameRecordingButton edit={edit} />;
  }

  test("offers nothing without a space to write to", async () => {
    const c = await mountNode(<Row title="Voice note · Oct 9" />);
    expect(c.textContent).toBe("no rename");
  });

  test("a changed title is written and the Library is told; an unchanged one writes nothing", async () => {
    const { tcw, calls } = stubSpace([row]);
    const changed: unknown[] = [];
    const off = captureEvents.on("library-changed", (d) => changed.push(d));
    const c = await mountNode(<RecordingRenameProvider tcw={tcw}><Row title="Voice note · Oct 9" /></RecordingRenameProvider>);
    let input = await open(c);
    await press(input, "Enter");
    expect(calls.filter((s) => !s.startsWith("SELECT id"))).toEqual([]);
    expect(c.querySelector("input")).toBeNull();

    input = await open(c);
    await typeInto(input, "  Q4 planning  ");
    await press(input, "Enter");
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.some((s) => s.startsWith("UPDATE connector_meeting"))).toBe(true);
    expect(changed).toEqual([{ source: "exo-voice-note", sourceId: "rec-1" }]);
    expect(c.querySelector("input")).toBeNull();
    off();
  });

  test("a background title change while editing keeps what is being typed", async () => {
    const { tcw } = stubSpace([row]);
    function Refreshable({ title }: { title: string }) {
      return <RecordingRenameProvider tcw={tcw}><Row title={title} /></RecordingRenameProvider>;
    }
    const c = await mountNode(<Refreshable title="Voice note · Oct 9" />);
    await open(c);
    const editor = c.querySelector("input") as HTMLInputElement;
    await typeInto(editor, "Half typed");
    // The Library re-reads the row under the open editor: a different automatic title arrives.
    await act(async () => { root!.render(<Refreshable title="Oct 9 · Alice Chen" />); });
    const after = c.querySelector("input") as HTMLInputElement;
    expect(after).toBe(editor); // same element: no remount
    expect(after.value).toBe("Half typed");
    await press(after, "Enter");
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    // Saving still goes through with the typed title.
    expect(c.querySelector("input")).toBeNull();
  });

  test("a failed write reopens the editor with what was typed and says so", async () => {
    const { tcw } = stubSpace([row], true);
    const c = await mountNode(<RecordingRenameProvider tcw={tcw}><Row title="Voice note · Oct 9" /></RecordingRenameProvider>);
    const input = await open(c);
    await typeInto(input, "Q4 planning");
    await press(input, "Enter");
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const reopened = c.querySelector("input") as HTMLInputElement;
    expect(reopened).not.toBe(input); // a fresh mount seeded with the rejected value
    expect(reopened.value).toBe("Q4 planning");
    expect(c.querySelector("[role=alert]")?.textContent).toBeTruthy();
  });
});
