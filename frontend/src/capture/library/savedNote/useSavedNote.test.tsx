import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSavedNote, type SavedNote } from "./useSavedNote";
import type { SavedNoteRecord, SavedNoteStore } from "./savedNoteStore";

const container = () =>
  ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;
const saved = {
  window: (globalThis as { window?: unknown }).window,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
let root: Root | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

async function show(node: ReactNode) {
  root ??= createRoot(container());
  await act(async () => root!.render(node));
}

let note: SavedNote;
function Probe({ id, store }: { id: string; store: SavedNoteStore }) {
  note = useSavedNote(id, store);
  return null;
}

const record = (md: string): SavedNoteRecord => ({ md, editedAt: "2026-10-09T10:00:00Z" });

function fakeStore(over: Partial<SavedNoteStore> = {}): SavedNoteStore {
  return {
    load: async () => record("saved"),
    save: async (_id, md) => ({ record: record(md), synced: Promise.resolve() }),
    ...over,
  };
}

describe("useSavedNote", () => {
  test("reads the note, then shows what was saved and that the space has it", async () => {
    const store = fakeStore();
    await show(<Probe id="r" store={store} />);
    expect(note.load).toEqual({ status: "ready", record: record("saved") });
    let ok = false;
    await act(async () => {
      ok = await note.save("edited");
    });
    expect(ok).toBe(true);
    expect(note.load).toEqual({ status: "ready", record: record("edited") });
    expect(note.saveError).toBeNull();
    expect(note.sync).toBe("synced");
  });

  test("a recording with no note loads as null", async () => {
    await show(<Probe id="r" store={fakeStore({ load: async () => null })} />);
    expect(note.load).toEqual({ status: "ready", record: null });
  });

  test("a read that fails is shown, and Retry reads again", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const store = fakeStore({
      load: async () => {
        if (fail) throw new Error("device store unavailable");
        return record("back");
      },
    });
    await show(<Probe id="r" store={store} />);
    expect(note.load).toEqual({ status: "failed", message: "device store unavailable" });
    fail = false;
    await act(async () => note.retryLoad());
    expect(note.load).toEqual({ status: "ready", record: record("back") });
    error.mockRestore();
  });

  test("a save that fails reports false, shows the error and keeps the saved text", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const store = fakeStore({
      save: async () => {
        throw new Error("disk full");
      },
    });
    await show(<Probe id="r" store={store} />);
    let ok = true;
    await act(async () => {
      ok = await note.save("edited");
    });
    expect(ok).toBe(false);
    expect(note.saveError).toBe("disk full");
    expect(note.saving).toBe(false);
    expect(note.load).toEqual({ status: "ready", record: record("saved") });
    error.mockRestore();
  });

  test("a save that works clears an earlier error", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const store = fakeStore({
      save: async (_id, md) => {
        if (fail) throw new Error("disk full");
        return { record: record(md), synced: Promise.resolve() };
      },
    });
    await show(<Probe id="r" store={store} />);
    await act(async () => void (await note.save("x")));
    expect(note.saveError).toBe("disk full");
    fail = false;
    await act(async () => void (await note.save("x")));
    expect(note.saveError).toBeNull();
    error.mockRestore();
  });

  test("saved on the device but not yet in the space: sync fails without failing the save", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const store = fakeStore({
      save: async (_id, md) => ({ record: record(md), synced: Promise.reject(new Error("offline")) }),
    });
    await show(<Probe id="r" store={store} />);
    let ok = false;
    await act(async () => {
      ok = await note.save("edited");
    });
    expect(ok).toBe(true);
    expect(note.sync).toBe("failed");
    expect(note.saveError).toBeNull();
    error.mockRestore();
  });
});
